import { z } from 'zod';
import { globMatch } from '../../lib/ciTrigger.js';
import { isPlatformWorkBranch } from '../../lib/gitRef.js';
import { type InputSchema, validateInputPayload } from '../../lib/inputSchema.js';
import { sha256Hex } from '../sha256.js';
import type { EventSource } from '../types.js';
import { visibleIssueText } from './issueLabeled.js';
import { PR_FEEDBACK } from './prFeedback.js';
import { WORKFLOW_RUN_FAILED } from './workflowRunFailed.js';

/** The source key stored on an automation that reacts to commits pushed to a branch. */
export const GITHUB_PUSH = 'github.push';

/** Most changed files a push's facts carry. */
export const MAX_PUSH_FILES = 300;
/** The head commit's message, kept bounded: it is written by whoever pushed. */
export const MAX_PUSH_MESSAGE_CHARS = 2_000;
/**
 * GitHub documents a maximum of 2048 commits in a push webhook's `commits` array. What a payload
 * holds above that, and whether a commit's file lists are cut, is not documented, so a push this
 * size may hold more than it lists.
 */
export const GITHUB_PUSH_COMMIT_LIMIT = 2048;

const MAX_PATTERN_CHARS = 200;
const Sha = z.string().regex(/^[0-9a-f]{40,64}$/);

const PatternSchema = z.string().trim().min(1).max(MAX_PATTERN_CHARS);
const noExclusions = (list: string[]) => list.every((p) => !p.startsWith('!'));

export const PushFiltersSchema = z.object({
  /**
   * Branch names or globs (`*` stays within a path segment, `**` crosses them). Required, and
   * never defaulted: which branches start work is an explicit choice. The platform's own work
   * branches (`<branch prefix>/…`) are never selected, whatever is listed here — see `ignore`.
   */
  branches: z
    .array(PatternSchema)
    .min(1)
    .max(20)
    .refine(noExclusions, 'a "!" exclusion is not supported here')
    .transform((l) => [...new Set(l)]),
  /** Globs over changed file paths; when set, one changed file must match. Empty: any push. */
  paths: z
    .array(PatternSchema)
    .max(50)
    .refine(noExclusions, 'a "!" exclusion is not supported here')
    .default([])
    .transform((l) => [...new Set(l)]),
});
export type PushFilters = z.infer<typeof PushFiltersSchema>;

/** Commits pushed to a branch, from the signed webhook alone. */
export const PushFactsSchema = z.object({
  after: Sha,
  before: Sha,
  branch: z.string().min(1).max(250),
  commitCount: z.number().int().min(1).max(GITHUB_PUSH_COMMIT_LIMIT),
  compareUrl: z.string().max(500),
  /** Changed paths across the push's commits, de-duplicated and cut at `MAX_PUSH_FILES`. */
  files: z.array(z.string().min(1).max(500)).max(MAX_PUSH_FILES),
  /** The list may be incomplete: GitHub caps the commits it sends, and the list is capped too. */
  filesTruncated: z.boolean(),
  /** The head commit's message: untrusted text, possibly a pull request author's. */
  message: z.string().max(MAX_PUSH_MESSAGE_CHARS),
  /** Who pushed: GitHub's numeric account id and login. */
  senderId: z.string().regex(/^\d{1,20}$/),
  senderLogin: z.string().min(1).max(100),
});
export type PushFacts = z.infer<typeof PushFactsSchema>;

/** A branch name fit for a stable id: short, and carrying none of the name's own characters. */
function branchId(branch: string): string {
  return sha256Hex(branch).slice(0, 16);
}

/** A glob that would select the branch, turned into a name it selects (for samples). */
function sampleFrom(pattern: string | undefined, fallback: string): string {
  const name = (pattern ?? '').replace(/\*+/g, 'x').replace(/\?/g, 'x');
  return name.length > 0 ? name : fallback;
}

const SAMPLE_SHA_BEFORE = 'a'.repeat(40);
const SAMPLE_SHA_AFTER = 'b'.repeat(40);

function sample(branch: string, files: string[]): PushFacts {
  return {
    after: SAMPLE_SHA_AFTER,
    before: SAMPLE_SHA_BEFORE,
    branch,
    commitCount: 1,
    compareUrl: 'https://github.com/acme/api/compare/aaaaaaaaaaaa...bbbbbbbbbbbb',
    files,
    filesTruncated: false,
    message: 'Update the health check',
    senderId: '1',
    senderLogin: 'octocat',
  };
}

/**
 * Commits pushed to a branch of this repository: start a template on them. There is no default
 * template: what a push should start is the automation's to say. Only for a person who is an
 * active platform user and a member of the repository (`actor`).
 *
 * Loop safety has two parts, and neither covers everything alone:
 * - The platform's own runs push `<branch prefix>/…` branches, so a push to one is never acted
 *   on (`ignore`, answered before any filter or query, and so not something a branch pattern can
 *   reach). It follows the prefix configured now: a branch made under an earlier prefix is not
 *   guarded by it.
 * - CI-fix and PR-feedback runs also fast-forward a person's own pull-request branch, which is
 *   not under the prefix. That commit is recognised only as the platform's own output
 *   (`ownOutputFrom`): the subject is the raw `after` sha, which those runs record as the
 *   commit they produced.
 * The commit message is untrusted text: it is written by whoever pushed, and after a squash
 * merge it is the pull request's own title and body, whose author may be outside the repository.
 */
export const pushSource: EventSource<PushFilters, PushFacts> = {
  actor: (x) => ({ id: x.senderId, login: x.senderLogin }),
  // The branch is part of the occurrence's identity, so each branch's delivery is recorded and
  // redelivered on its own. The decision is not per branch: the subject is the commit alone, so
  // one commit reaching two branches starts at most one run per repository.
  dedupeKey: (ownerKey, x) => `${ownerKey}#push-${branchId(x.branch)}/${x.after}`.toLowerCase(),
  // Nothing is selected until someone chooses branches, like an inbound endpoint's.
  defaultFilters: { branches: [], paths: [] } as unknown as PushFilters,
  defaultTemplate: null,
  describe: (f) =>
    `pushes to ${f.branches.join(', ')}${f.paths.length > 0 ? ` · ${f.paths.join(', ')}` : ''}`,
  describeOccurrence(f) {
    const text = (k: string) =>
      typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '?';
    return `${text('branch')} · ${text('commitCount')} commit(s) by ${text('senderLogin')} · ${text('after').slice(0, 8)}`;
  },
  eventInputKeys: [],
  facts: PushFactsSchema,
  filterFields: [
    {
      hint: 'Branch names or globs, comma-separated. * stays within a path segment, ** crosses them. Required. Branches the platform itself creates are never selected.',
      key: 'branches',
      kind: 'globs',
      label: 'Branches',
    },
    {
      hint: 'Optional globs over changed file paths. When set, at least one file changed by the push must match. A match is made only against the files the platform keeps: at most 300 changed files, from the at most 2048 commits GitHub sends, so it can be incomplete for a very large push.',
      key: 'paths',
      kind: 'globs',
      label: 'Changed paths',
    },
  ],
  filters: PushFiltersSchema,
  // Never a work branch of the platform (`<prefix>` or `<prefix>/…`), compared without case so a
  // differently-cased spelling is no way round it. Runs before every filter.
  ignore: (x, ctx) =>
    ctx.branchPrefix.length > 0 &&
    isPlatformWorkBranch(x.branch.toLowerCase(), ctx.branchPrefix.toLowerCase())
      ? `'${x.branch}' is one of the platform's own work branches`
      : null,
  // The branch is the scope, so a second push while a run on it is open is in flight; a run can
  // wait days for review.
  inFlightLookbackMs: 14 * 24 * 60 * 60 * 1000,
  key: GITHUB_PUSH,
  // The raw sha, as a commit a CI-fix or feedback run pushed is recorded (`producedKey`).
  keys: (x) => ({ scope: `push-${branchId(x.branch)}`, subject: x.after }),
  killSwitch: 'github.pushAutomationsEnabled',
  label: 'When commits are pushed to a branch',
  mismatch(f, x) {
    if (!f.branches.some((p) => globMatch(p, x.branch))) {
      return `the branch '${x.branch}' is not one of ${f.branches.join(', ')}`;
    }
    if (f.paths.length === 0) {
      return null;
    }
    if (x.files.some((file) => f.paths.some((p) => globMatch(p, file)))) {
      return null;
    }
    return x.filesTruncated
      ? 'no listed file matches the paths, and the push is too large to list every changed file'
      : `no changed file matches ${f.paths.join(', ')}`;
  },
  // A commit a CI-fix or feedback run fast-forwarded onto a person's branch is the platform's
  // output: a push automation must not answer it with more work.
  ownOutputFrom: [PR_FEEDBACK, WORKFLOW_RUN_FAILED],
  run: (x) => ({
    description: [
      visibleIssueText(x.message).trim(),
      `Commits pushed to ${x.branch} by ${x.senderLogin} (${x.commitCount}${x.commitCount >= GITHUB_PUSH_COMMIT_LIMIT ? '+' : ''} commit(s), now ${x.after.slice(0, 12)}): ${x.compareUrl}`,
    ]
      .filter((p) => p.length > 0)
      .join('\n\n'),
    fields: {},
    ticketId: `push-${x.after.slice(0, 8)}`,
    ticketIsSynthetic: true,
  }),
  samples: (f) => [
    sample(
      sampleFrom(f.branches[0], 'main'),
      f.paths.length > 0 ? f.paths.map((p) => sampleFrom(p, 'file.txt')) : ['README.md']
    ),
  ],
  summary: 'Commits are pushed to a branch you name: start a template on them.',
  target: 'repository',
  templateCompatible(schema: InputSchema) {
    const runFields: Record<string, unknown> = {
      connectionId: '00000000-0000-4000-8000-000000000000',
      description: 'Update the health check',
      ticketId: 'push-aaaaaaaa',
    };
    if (!Object.keys(runFields).every((k) => k in schema.properties)) {
      return false;
    }
    return validateInputPayload(
      { ...schema, required: (schema.required ?? []).filter((k) => k in runFields) },
      runFields
    ).ok;
  },
  tester: {
    facts: (v) =>
      sample(
        (v.branch ?? '').trim() || 'main',
        (v.file ?? '').trim() ? [(v.file ?? '').trim()] : []
      ),
    fields: [
      { initial: 'main', key: 'branch', label: 'Branch pushed to' },
      { initial: '', key: 'file', label: 'A file changed (optional)' },
    ],
  },
  workflowId: { part: (x) => x.after.slice(0, 12), prefix: 'push' },
};
