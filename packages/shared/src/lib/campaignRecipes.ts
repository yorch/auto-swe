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
}

export const CAMPAIGN_RECIPES = {
  'go-module@1': {
    ecosystem: 'go',
    image: 'golang:1.26-alpine',
    summary: 'Raise a required module in go.mod to an exact version and tidy.',
    timeoutMs: 600_000,
  },
  'npm-dependency@1': {
    ecosystem: 'npm',
    image: 'node:24-alpine',
    summary: 'Raise a dependency in the root package.json and npm lockfile to an exact version.',
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
  'npm-dependency@1': NpmParamsSchema,
};

export function isCampaignRecipeRef(ref: unknown): ref is CampaignRecipeRef {
  return typeof ref === 'string' && Object.hasOwn(CAMPAIGN_RECIPES, ref);
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
