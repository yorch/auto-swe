/**
 * The campaign recipe catalogue: code-owned, versioned, deterministic upgrade scripts.
 *
 * A recipe is named by a versioned ref (`npm-dependency@1`) and takes two parameters, a package
 * (or Go module) and an exact target version. Both reach a shell on the worker, so they are
 * validated here by a strict allowlist of shapes (the gateway at launch, the worker again before it
 * builds a command), and the worker quotes each one as well. Neither check stands in for the other.
 *
 * The catalogue is deliberately not extensible by an admin or a bundle: a recipe is a script the
 * platform runs against many repositories, so adding one is a code change that is reviewed.
 *
 * Pure: no I/O, so the gateway and the worker share one definition.
 */
import { z } from 'zod';

/** Longest npm package name (the registry's own limit). */
const NPM_NAME_MAX = 214;
/** Longest Go module path the validator accepts. */
const GO_MODULE_MAX = 255;
/** Longest version string either ecosystem accepts. */
const VERSION_MAX = 128;

/**
 * A registry package name: an optional `@scope/` and a name of URL-safe characters. The first
 * character is never `-` (it would be read as an option) and there is no `:`, so a name cannot
 * be a `git:`, `github:`, `file:` or `npm:` specifier, which `npm install` would otherwise accept
 * in place of a registry package.
 */
export const NPM_PACKAGE_NAME_PATTERN = '(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*';

/** An exact semantic version, with an optional pre-release. Ranges and tags are refused. */
export const NPM_VERSION_PATTERN = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';

/** A Go module path: a lower-case host starting with a letter or digit, then path elements. */
export const GO_MODULE_PATTERN = '[a-z0-9][a-z0-9.-]*(?:/[A-Za-z0-9._~][A-Za-z0-9._~-]*)+';

/** An exact Go module version, `v`-prefixed. */
export const GO_VERSION_PATTERN = 'v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+incompatible)?';

const anchored = (pattern: string): RegExp => new RegExp(`^${pattern}$`);

const NpmParamsSchema = z
  .object({
    packageName: z
      .string()
      .max(NPM_NAME_MAX)
      .regex(anchored(NPM_PACKAGE_NAME_PATTERN), 'not a registry package name'),
    targetVersion: z
      .string()
      .max(VERSION_MAX)
      .regex(anchored(NPM_VERSION_PATTERN), 'not an exact version such as 1.2.3'),
  })
  .strict();

const GoParamsSchema = z
  .object({
    packageName: z
      .string()
      .max(GO_MODULE_MAX)
      .regex(anchored(GO_MODULE_PATTERN), 'not a Go module path')
      // `.` and `..` elements are valid characters and not valid paths.
      .refine((m) => m.split('/').every((part) => !/^\.+$/.test(part)), 'not a Go module path'),
    targetVersion: z
      .string()
      .max(VERSION_MAX)
      .regex(anchored(GO_VERSION_PATTERN), 'not an exact version such as v1.2.3'),
  })
  .strict();

export interface CampaignRecipeDefinition {
  /** Which toolchain the recipe drives. */
  ecosystem: 'npm' | 'go';
  /** The shell-step image it runs in. Must be in `BUILTIN_SHELL_IMAGES`. */
  image: string;
  /** Wall-clock bound for the one command, in milliseconds. */
  timeoutMs: number;
  /** One line for the docs. */
  summary: string;
  /**
   * Whether the ref defines a read-only `check` beside `apply` (campaign spec §5). `@1` refs are
   * apply-only: a campaign launched with one has no check and no discovery.
   */
  supportsCheck: boolean;
}

export const CAMPAIGN_RECIPES = {
  'go-module@1': {
    ecosystem: 'go',
    image: 'golang:1.26-alpine',
    summary: 'Raise a required module in go.mod to an exact version and tidy.',
    supportsCheck: false,
    timeoutMs: 600_000,
  },
  'go-module@2': {
    ecosystem: 'go',
    image: 'golang:1.26-alpine',
    summary:
      'Raise a required module in go.mod to an exact version and tidy, or check that it is at or above it.',
    supportsCheck: true,
    timeoutMs: 600_000,
  },
  'npm-dependency@1': {
    ecosystem: 'npm',
    image: 'node:24-alpine',
    summary: 'Raise a dependency in the root package.json and npm lockfile to an exact version.',
    supportsCheck: false,
    timeoutMs: 600_000,
  },
  'npm-dependency@2': {
    ecosystem: 'npm',
    image: 'node:24-alpine',
    summary:
      'Raise a dependency in the root package.json and npm lockfile to an exact version, or check that it is at or above it.',
    supportsCheck: true,
    timeoutMs: 600_000,
  },
} as const satisfies Record<string, CampaignRecipeDefinition>;

export type CampaignRecipeRef = keyof typeof CAMPAIGN_RECIPES;

export const CAMPAIGN_RECIPE_REFS = Object.keys(CAMPAIGN_RECIPES) as CampaignRecipeRef[];

/** The validated parameters of every recipe in the first catalogue. */
export interface CampaignRecipeParams {
  /** The npm package, or the Go module path. */
  packageName: string;
  /** The exact version to raise it to. */
  targetVersion: string;
}

const PARAM_SCHEMAS: Record<CampaignRecipeRef, z.ZodType<CampaignRecipeParams>> = {
  'go-module@1': GoParamsSchema,
  'go-module@2': GoParamsSchema,
  'npm-dependency@1': NpmParamsSchema,
  'npm-dependency@2': NpmParamsSchema,
};

export function isCampaignRecipeRef(ref: unknown): ref is CampaignRecipeRef {
  return typeof ref === 'string' && Object.hasOwn(CAMPAIGN_RECIPES, ref);
}

/** True when the ref is in the catalogue and defines a read-only `check` (the `@2` refs). */
export function recipeSupportsCheck(ref: unknown): boolean {
  return isCampaignRecipeRef(ref) && CAMPAIGN_RECIPES[ref].supportsCheck;
}

export type ParsedRecipe =
  | { ok: true; ref: CampaignRecipeRef; params: CampaignRecipeParams }
  | { ok: false; error: string };

/**
 * Validate a recipe ref and its parameters. The error is a fixed-shape message that never echoes
 * the rejected value back (it is shown to the caller and stored on a target).
 */
export function parseRecipeParams(ref: unknown, params: unknown): ParsedRecipe {
  if (!isCampaignRecipeRef(ref)) {
    return { error: `unknown recipe (known: ${CAMPAIGN_RECIPE_REFS.join(', ')})`, ok: false };
  }
  const parsed = PARAM_SCHEMAS[ref].safeParse(params);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'params'}: ${i.message}`)
      .join('; ');
    return { error: `invalid parameters for ${ref}: ${detail}`.slice(0, 300), ok: false };
  }
  return { ok: true, params: parsed.data, ref };
}

// ── The check result ──────────────────────────────────────────────────────────────────────────────

/** Exit code of a check: the repository satisfies the goal. */
export const CHECK_EXIT_SATISFIED = 0;
/** Exit code of a check: the repository does not satisfy the goal. */
export const CHECK_EXIT_NOT_SATISFIED = 1;

/** Marks the one evidence line a check script prints (the last such line on stdout counts). */
export const CHECK_EVIDENCE_PREFIX = 'CAMPAIGN_CHECK';

/**
 * What a check found. `declared-at-target` and `not-declared` are the two ways to be satisfied (a
 * repository that was fixed, and one that was never affected); `below-target` is the one way to be
 * not satisfied; `cannot-check` accompanies an exit code of 2 or more.
 */
export type CampaignCheckEvidenceKind =
  | 'declared-at-target'
  | 'not-declared'
  | 'below-target'
  | 'cannot-check';

export interface CampaignCheckEvidence {
  kind: CampaignCheckEvidenceKind;
  /** A short fixed token naming the branch taken, such as `no-root-manifest` or `workspaces`. */
  detail: string | null;
  /** The version the manifest declares (a range's floor for npm), when the check read one. */
  declared: string | null;
  /** The version the lockfile resolves, when the check read one (npm only). */
  resolved: string | null;
}

/**
 * The typed outcome of one check. `could-not-run` is never satisfied; `reason` is a fixed-shape
 * string safe to store and show (it never carries repository text).
 */
export type CampaignCheckResult =
  | { status: 'satisfied'; exitCode: 0; evidence: CampaignCheckEvidence }
  | { status: 'not-satisfied'; exitCode: 1; evidence: CampaignCheckEvidence }
  | {
      status: 'could-not-run';
      exitCode: number | null;
      reason: string;
      evidence: CampaignCheckEvidence | null;
    };

export interface CampaignCheckOutput {
  /** The script's exit code; null when it was killed (timeout, signal) or never ran. */
  exitCode: number | null;
  stdout: string;
}

const EVIDENCE_TOKEN = /^[A-Za-z0-9._+~@/-]{1,128}$/;
const EVIDENCE_KINDS: readonly CampaignCheckEvidenceKind[] = [
  'declared-at-target',
  'not-declared',
  'below-target',
  'cannot-check',
];

function evidenceValue(fields: Map<string, string>, key: string): string | null {
  const v = fields.get(key);
  return v !== undefined && v !== '-' && EVIDENCE_TOKEN.test(v) ? v : null;
}

/** The evidence of the last well-formed evidence line in `stdout`, or null. */
export function parseCheckEvidence(stdout: string): CampaignCheckEvidence | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    if (!line.startsWith(`${CHECK_EVIDENCE_PREFIX} `)) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const part of line.slice(CHECK_EVIDENCE_PREFIX.length + 1).split(' ')) {
      const eq = part.indexOf('=');
      if (eq > 0) {
        fields.set(part.slice(0, eq), part.slice(eq + 1));
      }
    }
    const kind = fields.get('evidence');
    if (!EVIDENCE_KINDS.includes(kind as CampaignCheckEvidenceKind)) {
      return null;
    }
    return {
      declared: evidenceValue(fields, 'declared'),
      detail: evidenceValue(fields, 'detail'),
      kind: kind as CampaignCheckEvidenceKind,
      resolved: evidenceValue(fields, 'resolved'),
    };
  }
  return null;
}

/**
 * Turn a check script's exit code and stdout into a result. Fails safe: an exit code of 0 counts as
 * satisfied only with matching evidence (`declared-at-target` or `not-declared`), and 1 as not
 * satisfied only with `below-target`; a tool that crashed with status 1 therefore reads as
 * could-not-run, never as a verdict.
 */
export function parseCheckResult(out: CampaignCheckOutput): CampaignCheckResult {
  const evidence = parseCheckEvidence(out.stdout);
  const { exitCode } = out;
  if (exitCode === null) {
    return {
      evidence,
      exitCode: null,
      reason: 'the check did not finish',
      status: 'could-not-run',
    };
  }
  if (exitCode === CHECK_EXIT_SATISFIED) {
    if (evidence && (evidence.kind === 'declared-at-target' || evidence.kind === 'not-declared')) {
      return { evidence, exitCode: 0, status: 'satisfied' };
    }
    return {
      evidence,
      exitCode,
      reason: 'the check exited 0 without satisfied evidence',
      status: 'could-not-run',
    };
  }
  if (exitCode === CHECK_EXIT_NOT_SATISFIED) {
    if (evidence && evidence.kind === 'below-target') {
      return { evidence, exitCode: 1, status: 'not-satisfied' };
    }
    return {
      evidence,
      exitCode,
      reason: 'the check exited 1 without not-satisfied evidence',
      status: 'could-not-run',
    };
  }
  const detail = evidence?.kind === 'cannot-check' && evidence.detail ? `: ${evidence.detail}` : '';
  return {
    evidence,
    exitCode,
    reason: `the check could not run (exit ${exitCode})${detail}`,
    status: 'could-not-run',
  };
}
