/**
 * The `github.push` event source's webhook side: a `push` delivery normalized into an occurrence
 * for the engine. Everything that is never acted on is ignored here, before any query: a tag, a
 * branch deletion, a push with no commits, a bot. Whether the branch is one the platform itself
 * pushes (`<branch prefix>/…`) needs the configured prefix, so the engine answers that through
 * the source's `ignore`, before any filter.
 *
 * A force push to a new commit is NOT ignored: it moves the branch to a commit that is a new
 * occurrence (the subject is the `after` commit), and a person who force-pushed a branch an
 * automation names asked for the work as much as one who pushed normally. One that only moves
 * the branch back to an ancestor carries no commits and is ignored with the other empty pushes.
 */
import {
  GITHUB_PUSH_COMMIT_LIMIT,
  MAX_PUSH_FILES,
  MAX_PUSH_MESSAGE_CHARS,
  type PushFacts,
  visibleIssueText,
} from '@auto-swe/shared/automation';
import { z } from 'zod';
import type { Occurrence } from './engine.js';

const BRANCH_REF = 'refs/heads/';
const ZERO_SHA = /^0+$/;

const Paths = z.array(z.string()).nullish();

const PushWebhookSchema = z.object({
  after: z.string(),
  before: z.string(),
  commits: z.array(z.object({ added: Paths, modified: Paths, removed: Paths })).nullish(),
  compare: z.string().optional(),
  deleted: z.boolean().optional(),
  head_commit: z.object({ message: z.string() }).nullish(),
  ref: z.string(),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
  sender: z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() }),
});

export type PushEvent =
  | ({ type: 'push' } & Occurrence<PushFacts>)
  | { type: 'unrecognized' }
  | { type: 'ignored'; reason: string };

/** Pure mapping from a `push` webhook body to the push an automation may act on. */
export function normalizePushEvent(body: unknown): PushEvent {
  const parsed = PushWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const {
    after,
    before,
    commits,
    compare,
    head_commit: head,
    ref,
    repository,
    sender,
  } = parsed.data;
  if (!ref.startsWith(BRANCH_REF)) {
    return { reason: 'the push is not to a branch', type: 'ignored' };
  }
  const branch = ref.slice(BRANCH_REF.length);
  if (parsed.data.deleted === true || ZERO_SHA.test(after)) {
    return { reason: 'the branch was deleted', type: 'ignored' };
  }
  if (!commits || commits.length === 0) {
    return { reason: 'the push has no commits', type: 'ignored' };
  }
  // A bot or an App (the platform's own included) is never a person who pushed.
  if (sender.type !== 'User') {
    return { reason: `pushed by a ${sender.type}, not a person`, type: 'ignored' };
  }
  const shaOk = /^[0-9a-f]{40,64}$/;
  if (!branch || branch.length > 250 || !shaOk.test(after) || !shaOk.test(before)) {
    return { reason: 'the push does not name a usable branch and commits', type: 'ignored' };
  }
  const [org, repoName] = repository.full_name.split('/');
  if (!org || !repoName) {
    return { type: 'unrecognized' };
  }
  const files = new Set<string>();
  for (const c of commits) {
    for (const f of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]) {
      if (f.length > 0 && f.length <= 500) {
        files.add(f);
      }
    }
  }
  const list = [...files];
  return {
    facts: {
      after,
      before,
      branch,
      commitCount: Math.min(commits.length, GITHUB_PUSH_COMMIT_LIMIT),
      compareUrl: (compare ?? '').slice(0, 500),
      files: list.slice(0, MAX_PUSH_FILES),
      // The list is what the platform kept: at most MAX_PUSH_FILES files, from the at most 2048
      // commits GitHub documents per payload, so a push of that size may hold more than it lists.
      filesTruncated: list.length > MAX_PUSH_FILES || commits.length >= GITHUB_PUSH_COMMIT_LIMIT,
      // Hidden HTML comments (a squash-merged pull request body's) are dropped before the cut.
      message: visibleIssueText(head?.message ?? '').slice(0, MAX_PUSH_MESSAGE_CHARS),
      senderId: String(sender.id),
      senderLogin: sender.login.slice(0, 100),
    },
    org,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
    repoName,
    type: 'push',
  };
}
