import { z } from 'zod';
import { BaseBranchSchema } from './gitRef.js';
import type { InputSchema } from './inputSchema.js';

/** Name of the built-in template a CI-failure trigger starts by default. */
export const CI_TRIAGE_TEMPLATE_NAME = 'ci-triage-and-fix';

/** What a triggered run may do: diagnose only, or also open a draft fix PR. */
export const CI_TRIGGER_MODES = ['TRIAGE_ONLY', 'FIX'] as const;
export type CiTriggerMode = (typeof CI_TRIGGER_MODES)[number];

/**
 * The GitHub Actions events a trigger can react to. Anything else is never
 * acted on: `pull_request_target` and `workflow_run` run with the base
 * repository's secrets on behalf of someone else's code, `schedule` and
 * `workflow_dispatch` have no change to blame, and `merge_group` branches are
 * transient.
 */
export const CI_TRIGGER_EVENTS = ['push', 'pull_request'] as const;
export type CiTriggerEvent = (typeof CI_TRIGGER_EVENTS)[number];

/** A GitHub run id: decimal digits, exact as a JavaScript number. Carried as a string. */
export const GitHubRunIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, 'must be a GitHub run id')
  .refine((s) => Number.isSafeInteger(Number(s)), 'must be a GitHub run id');

/**
 * The run payload of the CI triage template. It names the failing run by id —
 * never by URL — so the worker reads the run, its logs and its commit from the
 * run's own repository, and nothing in the payload can point the platform
 * credential anywhere else. `baseBranch` is the branch that failed (a push) or
 * the pull request's head branch: a fix is cut from it and opened into it.
 */
export const CiTriagePayloadSchema = z.object({
  baseBranch: BaseBranchSchema,
  commentOnPullRequest: z.boolean().optional(),
  connectionId: z.string().uuid(),
  description: z.string().max(4000).optional(),
  githubRunId: GitHubRunIdSchema,
  mode: z.enum(['triage', 'fix']),
  pullRequestNumber: z.number().int().positive().optional(),
  runAttempt: z.number().int().min(1).max(1000),
  ticketId: z.string().max(200).optional(),
});
export type CiTriagePayload = z.infer<typeof CiTriagePayloadSchema>;

/**
 * The run-input contract of the CI triage template, declared on it so the gateway validates a
 * launch against it. The failing run is named by id; the worker reads
 * everything else about it from the repository itself.
 */
export const CI_TRIAGE_INPUT_SCHEMA: InputSchema = {
  properties: {
    baseBranch: { type: 'string' },
    commentOnPullRequest: { type: 'boolean' },
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    githubRunId: { type: 'string' },
    mode: { enum: ['triage', 'fix'], type: 'string' },
    pullRequestNumber: { type: 'number' },
    runAttempt: { type: 'number' },
    ticketId: { type: 'string' },
  },
  required: ['connectionId', 'githubRunId', 'runAttempt', 'baseBranch', 'mode'],
  type: 'object',
};

const MAX_PATTERN_LENGTH = 200;

/**
 * Whether `value` matches the glob `pattern`. `**` matches anything, slashes
 * included; `*` matches anything but a slash; `?` one character that is not a
 * slash. Everything else is literal. Linear: the pattern compiles to a regular
 * expression with no nested quantifiers.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return false;
  }
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${re}$`).test(value);
}

/**
 * Whether `value` is selected by a list of globs. A `!`-prefixed pattern
 * excludes. With no positive pattern nothing is selected — an empty list never
 * means "everything", so a rule cannot be saved that reacts to every branch by
 * accident. The last matching pattern wins, as in `.gitignore`.
 */
export function matchesPatterns(patterns: readonly string[], value: string): boolean {
  let selected = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (globMatch(pattern, value)) {
      selected = !negated;
    }
  }
  return selected;
}

/** A glob list as a rule stores it: non-empty, at least one positive pattern, bounded. */
export const GlobListSchema = z
  .array(z.string().trim().min(1).max(MAX_PATTERN_LENGTH))
  .min(1)
  .max(50)
  .refine(
    (list) => list.some((p) => !p.startsWith('!')),
    'needs at least one pattern that is not a "!" exclusion'
  );
