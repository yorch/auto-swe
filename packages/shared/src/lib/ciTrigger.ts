import { z } from 'zod';
import { BaseBranchSchema } from './gitRef.js';
import { type InputSchema, isInputSchema, validateInputPayload } from './inputSchema.js';

/** Name of the built-in template a CI-failure trigger starts by default. */
export const CI_TRIAGE_TEMPLATE_NAME = 'ci-triage-and-fix';

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

/** Diagnose only, or also attempt a fix when the diagnosis allows it. */
export const CI_TRIAGE_MODES = ['triage', 'fix'] as const;
export type CiTriageMode = (typeof CI_TRIAGE_MODES)[number];

/**
 * Diagnoses a code change in the repository can fix. `flaky`, `infrastructure` and
 * `unknown` are never fixed whatever a trigger says; a trigger can only narrow this set.
 */
export const CI_FIXABLE_CATEGORIES = [
  'regression',
  'test_bug',
  'configuration',
  'dependency',
] as const;
export type CiFixableCategory = (typeof CI_FIXABLE_CATEGORIES)[number];

/**
 * How a fix for a `pull_request` failure reaches the pull request: a draft pull request into
 * its branch, or a commit pushed onto its branch. `push` is a request, not a grant: the worker
 * pushes only where an admin allows it (`github.ciFixPushToPullRequestEnabled`), fast-forward,
 * to a branch that is not the default, protected or listed in `github.ciFixNeverPushBranches`,
 * and otherwise opens the draft. A `push` failure (`main`, a release branch) always gets a
 * draft pull request.
 */
export const CI_PULL_REQUEST_DELIVERIES = ['draft_pr', 'push'] as const;
export type CiPullRequestDelivery = (typeof CI_PULL_REQUEST_DELIVERIES)[number];

/** Defaults of the options a trigger may set, applied wherever the payload omits one. */
export const CI_TRIAGE_DEFAULTS = {
  commentOnPullRequest: true,
  fixCategories: [...CI_FIXABLE_CATEGORIES],
  maxCiFixAttempts: 2,
  minFixConfidence: 0.6,
  mode: 'triage',
  pullRequestDelivery: 'draft_pr',
} as const satisfies {
  commentOnPullRequest: boolean;
  fixCategories: CiFixableCategory[];
  maxCiFixAttempts: number;
  minFixConfidence: number;
  mode: CiTriageMode;
  pullRequestDelivery: CiPullRequestDelivery;
};

/** Bounds of the numeric options. */
export const CI_FIX_CONFIDENCE_RANGE = { max: 1, min: 0.3 } as const;
export const CI_FIX_ATTEMPTS_RANGE = { max: 5, min: 0 } as const;

/**
 * Payload keys a trigger fills from the failing run itself. A trigger's own inputs may not
 * name them, and at fire time the run's values always win.
 */
export const CI_EVENT_INPUT_KEYS = [
  'baseBranch',
  'connectionId',
  'description',
  'githubRunId',
  'pullRequestNumber',
  'runAttempt',
  'ticketId',
] as const;

/**
 * The run payload of the CI triage template. It names the failing run by id —
 * never by URL — so the worker reads the run, its logs and its commit from the
 * run's own repository, and nothing in the payload can point the platform
 * credential anywhere else. `baseBranch` is the branch that failed (a push) or
 * the pull request's head branch: a fix is cut from it and opened into it.
 *
 * The rest are the options a trigger sets (its `inputs`), each defaulted here, so this
 * parse is the authority on their bounds whatever validated them before.
 */
export const CiTriagePayloadSchema = z.object({
  baseBranch: BaseBranchSchema,
  commentOnPullRequest: z.boolean().default(CI_TRIAGE_DEFAULTS.commentOnPullRequest),
  connectionId: z.string().uuid(),
  description: z.string().max(4000).optional(),
  fixCategories: z
    .array(z.enum(CI_FIXABLE_CATEGORIES))
    .min(1)
    .max(CI_FIXABLE_CATEGORIES.length)
    .default([...CI_TRIAGE_DEFAULTS.fixCategories]),
  githubRunId: GitHubRunIdSchema,
  maxCiFixAttempts: z
    .number()
    .int()
    .min(CI_FIX_ATTEMPTS_RANGE.min)
    .max(CI_FIX_ATTEMPTS_RANGE.max)
    .default(CI_TRIAGE_DEFAULTS.maxCiFixAttempts),
  minFixConfidence: z
    .number()
    .min(CI_FIX_CONFIDENCE_RANGE.min)
    .max(CI_FIX_CONFIDENCE_RANGE.max)
    .default(CI_TRIAGE_DEFAULTS.minFixConfidence),
  mode: z.enum(CI_TRIAGE_MODES).default(CI_TRIAGE_DEFAULTS.mode),
  pullRequestDelivery: z
    .enum(CI_PULL_REQUEST_DELIVERIES)
    .default(CI_TRIAGE_DEFAULTS.pullRequestDelivery),
  pullRequestNumber: z.number().int().positive().optional(),
  runAttempt: z.number().int().min(1).max(1000),
  ticketId: z.string().max(200).optional(),
});
export type CiTriagePayload = z.infer<typeof CiTriagePayloadSchema>;

/**
 * The run-input contract of the CI triage template, declared on it so the gateway validates a
 * launch — and a trigger's options — against it. The failing run is named by id; the worker
 * reads everything else about it from the repository itself. The options carry titles,
 * defaults and bounds, so the trigger form is rendered from this declaration.
 */
export const CI_TRIAGE_INPUT_SCHEMA: InputSchema = {
  properties: {
    baseBranch: { type: 'string' },
    commentOnPullRequest: {
      default: CI_TRIAGE_DEFAULTS.commentOnPullRequest,
      description: 'Post the diagnosis, and any fix, as a comment on the failing pull request.',
      title: 'Comment on the pull request',
      type: 'boolean',
    },
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    fixCategories: {
      default: [...CI_TRIAGE_DEFAULTS.fixCategories],
      description:
        'Only these diagnoses are fixed. Flaky tests, infrastructure and unknown causes never are.',
      items: { enum: [...CI_FIXABLE_CATEGORIES], type: 'string' },
      maxItems: CI_FIXABLE_CATEGORIES.length,
      minItems: 1,
      title: 'Fix these kinds of failure',
      type: 'array',
    },
    githubRunId: { type: 'string' },
    maxCiFixAttempts: {
      default: CI_TRIAGE_DEFAULTS.maxCiFixAttempts,
      description: "How many times a fix may be revised when its own pull request's CI fails.",
      integer: true,
      maximum: CI_FIX_ATTEMPTS_RANGE.max,
      minimum: CI_FIX_ATTEMPTS_RANGE.min,
      title: 'Revisions of a failing fix',
      type: 'number',
    },
    minFixConfidence: {
      default: CI_TRIAGE_DEFAULTS.minFixConfidence,
      description: "A fix is attempted only when the diagnosis' confidence is at least this.",
      maximum: CI_FIX_CONFIDENCE_RANGE.max,
      minimum: CI_FIX_CONFIDENCE_RANGE.min,
      title: 'Minimum confidence to fix',
      type: 'number',
    },
    mode: {
      default: CI_TRIAGE_DEFAULTS.mode,
      description: 'Diagnose only, or also attempt a fix when the diagnosis allows it.',
      enum: [...CI_TRIAGE_MODES],
      title: 'Mode',
      type: 'string',
    },
    pullRequestDelivery: {
      default: CI_TRIAGE_DEFAULTS.pullRequestDelivery,
      description:
        'How a fix for a failing pull request reaches it: a draft pull request into its branch, or a commit pushed onto its branch where an admin allows it (never the default branch, a protected branch or a listed one; anything refused becomes a draft). A failure on a pushed branch always gets a draft pull request.',
      enum: [...CI_PULL_REQUEST_DELIVERIES],
      title: 'Pull request fix delivery',
      type: 'string',
    },
    pullRequestNumber: { type: 'number' },
    runAttempt: { type: 'number' },
    ticketId: { type: 'string' },
  },
  required: ['connectionId', 'githubRunId', 'runAttempt', 'baseBranch'],
  type: 'object',
};

/**
 * The options a template lets a trigger set: its declared properties minus the keys the
 * failing run fills. Empty for a template that declares none.
 */
export function triggerOptionKeys(schema: InputSchema): string[] {
  const reserved = new Set<string>(CI_EVENT_INPUT_KEYS);
  return Object.keys(schema.properties).filter((k) => !reserved.has(k));
}

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

const MAX_TRIGGER_INPUTS_JSON = 4_000;

/**
 * A trigger's options as the API accepts them: a flat object of template inputs that names
 * none of the keys the failing run fills, and stays small. Whether the values fit the
 * template is checked against its declared input schema, by the caller.
 */
export const TriggerInputsSchema = z
  .record(
    z.string().min(1).max(64),
    // A null would skip the template's validation of the key entirely.
    z.unknown().refine((v) => v !== null && v !== undefined, 'may not be null')
  )
  .refine((o) => !CI_EVENT_INPUT_KEYS.some((k) => k in o), {
    message: `may not set ${CI_EVENT_INPUT_KEYS.join(', ')}: the failing run fills them`,
  })
  .refine((o) => JSON.stringify(o).length <= MAX_TRIGGER_INPUTS_JSON, {
    message: `must serialise to at most ${MAX_TRIGGER_INPUTS_JSON} characters`,
  });

/**
 * A stored trigger's options, read defensively: anything that is not a plain object reads as
 * none, and a key the run fills is dropped (the run's value always wins anyway).
 */
export function storedTriggerInputs(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const reserved = new Set<string>(CI_EVENT_INPUT_KEYS);
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !reserved.has(k)));
}

/** What a trigger takes from the failing run, as it goes into the payload. */
export interface CiTriggerEventFields {
  baseBranch: string;
  connectionId: string;
  description: string;
  githubRunId: string;
  pullRequestNumber: number | null;
  runAttempt: number;
  ticketId: string;
}

/** A failing run's fields for checking a trigger's options before any run has failed. */
export const SAMPLE_CI_EVENT_FIELDS: CiTriggerEventFields = {
  baseBranch: 'main',
  connectionId: '00000000-0000-4000-8000-000000000000',
  description: 'Fix the failing workflow',
  githubRunId: '1',
  pullRequestNumber: 1,
  runAttempt: 1,
  ticketId: 'ci-1-1',
};

export type CiTriggerPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * The run payload a trigger sends — the one place it is built, for the save-time check and
 * the fire alike:
 *
 *   1. every option the template declares, at its declared `default`;
 *   2. over that, the trigger's own options — only keys the template declares;
 *   3. over that, what the failing run fills (`CI_EVENT_INPUT_KEYS`), which always wins.
 *
 * The result must pass the template's declared input schema AND the CI payload contract
 * (`CiTriagePayloadSchema`), which is what the worker parses: a payload the worker would
 * refuse is refused here, before a run is spent on it. An option the template does not
 * declare is an error, not ignored, so a typo is not silently a default.
 */
export function buildCiTriggerPayload(
  inputSchema: unknown,
  inputs: unknown,
  event: CiTriggerEventFields
): CiTriggerPayloadResult {
  if (!isInputSchema(inputSchema)) {
    return { errors: ['the template declares no input schema'], ok: false };
  }
  const options = new Set(triggerOptionKeys(inputSchema));
  const given = storedTriggerInputs(inputs);
  const unknown = Object.keys(given).filter((k) => !options.has(k));
  if (unknown.length > 0) {
    return {
      errors: unknown.map((k) => `'${k}' is not an option of this template`),
      ok: false,
    };
  }
  const defaults: Record<string, unknown> = {};
  for (const key of options) {
    const d = inputSchema.properties[key]?.default;
    if (d !== undefined) {
      defaults[key] = Array.isArray(d) ? [...d] : d;
    }
  }
  const payload: Record<string, unknown> = {
    ...defaults,
    ...given,
    baseBranch: event.baseBranch,
    connectionId: event.connectionId,
    description: event.description,
    githubRunId: event.githubRunId,
    ...(event.pullRequestNumber !== null ? { pullRequestNumber: event.pullRequestNumber } : {}),
    runAttempt: event.runAttempt,
    ticketId: event.ticketId,
  };
  const declared = validateInputPayload(inputSchema, payload);
  if (!declared.ok) {
    return { errors: declared.errors, ok: false };
  }
  const contract = CiTriagePayloadSchema.safeParse(payload);
  if (!contract.success) {
    return {
      errors: contract.error.issues.map((i) => `'${i.path.join('.')}' ${i.message}`),
      ok: false,
    };
  }
  return { ok: true, payload };
}

/** The fields of a trigger the matcher reads. */
export interface CiTriggerRule {
  enabled: boolean;
  events: readonly string[];
  branchPatterns: readonly string[];
  workflowPatterns: readonly string[];
}

/** The parts of a failed run a trigger is matched on. */
export interface CiRunFacts {
  event: string;
  branch: string;
  /** The workflow FILE path, e.g. `.github/workflows/ci.yml` — never its display name. */
  workflowPath: string;
}

/**
 * Why `rule` does not react to a failed run, or null when it does. The one matcher: the
 * gateway acts on a null, and the trigger form explains a non-null to the person writing it.
 */
export function ciTriggerMismatch(rule: CiTriggerRule, run: CiRunFacts): string | null {
  if (!rule.enabled) {
    return 'the trigger is switched off';
  }
  if (!rule.events.includes(run.event)) {
    return `it does not react to ${run.event === 'pull_request' ? 'pull requests' : `'${run.event}'`}`;
  }
  if (!matchesPatterns(rule.branchPatterns, run.branch)) {
    return `the branch '${run.branch}' is not selected by its branch patterns`;
  }
  if (!matchesPatterns(rule.workflowPatterns, run.workflowPath)) {
    return `the workflow file '${run.workflowPath}' is not selected by its workflow patterns`;
  }
  return null;
}
