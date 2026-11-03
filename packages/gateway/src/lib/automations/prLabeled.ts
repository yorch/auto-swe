/**
 * The `github.pull_request.labeled` event source's webhook side: a `pull_request` delivery
 * normalized into an occurrence for the engine. Everything that is never acted on is ignored
 * here, before any query: another action, a closed pull request, a pull request from a fork, a
 * bot. A fork's title, body and branch are written by someone outside the repository, who could
 * not otherwise start a run by asking a member to label the pull request.
 */
import { type PrLabeledFacts, visibleIssueText } from '@auto-swe/shared/automation';
import { z } from 'zod';
import type { Occurrence } from './engine.js';

const RepoRef = z.object({ full_name: z.string() });

const PullRequestLabeledWebhookSchema = z.object({
  action: z.string(),
  label: z.object({ name: z.string() }).optional(),
  pull_request: z.object({
    base: z.object({ ref: z.string(), repo: RepoRef.nullish() }),
    body: z.string().nullish(),
    head: z.object({ ref: z.string(), repo: RepoRef.nullish(), sha: z.string() }),
    html_url: z.string(),
    number: z.number().int().positive(),
    state: z.string(),
    title: z.string(),
    updated_at: z.string(),
  }),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
  sender: z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() }),
});

export type PrLabeledEvent =
  | ({ type: 'labeled' } & Occurrence<PrLabeledFacts>)
  | { type: 'unrecognized' }
  | { type: 'ignored'; reason: string };

/** Pure mapping from a `pull_request` webhook body to the labelling an automation may act on. */
export function normalizePrLabeledEvent(body: unknown): PrLabeledEvent {
  const parsed = PullRequestLabeledWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { type: 'unrecognized' };
  }
  const { action, label, pull_request: pr, repository, sender } = parsed.data;
  if (action !== 'labeled' || !label) {
    return { reason: `action ${action}`, type: 'ignored' };
  }
  if (pr.state !== 'open') {
    return { reason: 'the pull request is not open', type: 'ignored' };
  }
  // A fork (or a deleted fork, whose head repository is null) is outside the repository.
  const headRepo = pr.head.repo?.full_name.toLowerCase();
  if (!headRepo || headRepo !== repository.full_name.toLowerCase()) {
    return { reason: 'the pull request is from a fork', type: 'ignored' };
  }
  // A bot or an App (the platform's own included) is never a person who asked.
  if (sender.type !== 'User') {
    return { reason: `labelled by a ${sender.type}, not a person`, type: 'ignored' };
  }
  const name = label.name.trim();
  if (name.length === 0 || name.length > 50) {
    return { reason: 'the label name is not usable', type: 'ignored' };
  }
  const [org, repoName] = repository.full_name.split('/');
  if (!org || !repoName) {
    return { type: 'unrecognized' };
  }
  return {
    facts: {
      baseRef: pr.base.ref.slice(0, 250),
      // What the labeller could see: hidden comments are dropped before the text is bounded.
      body: visibleIssueText(pr.body ?? '').slice(0, 4_000),
      headRef: pr.head.ref.slice(0, 250),
      headSha: pr.head.sha.slice(0, 64),
      htmlUrl: pr.html_url.slice(0, 500),
      label: name,
      prNumber: pr.number,
      senderId: String(sender.id),
      senderLogin: sender.login.slice(0, 100),
      title: visibleIssueText(pr.title).slice(0, 256),
      updatedAt: pr.updated_at.slice(0, 40),
    },
    org,
    repoFullName: repository.full_name,
    repoHtmlUrl: repository.html_url,
    repoName,
    type: 'labeled',
  };
}
