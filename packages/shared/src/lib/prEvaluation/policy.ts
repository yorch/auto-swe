import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  countGlobStars,
  DEFAULT_SENSITIVE_PATHS,
  globCost,
  isValidGlob,
  MAX_GLOB_EXPANSIONS,
  MAX_GLOB_LENGTH,
  MAX_GLOB_STARS,
} from './paths.js';
import type { EffectivePolicy, PolicyFloor, PolicyThresholds, RepoPolicyFile } from './types.js';

export const DEFAULT_THRESHOLDS: PolicyThresholds = {
  highApprovers: 2,
  highLines: 1000,
  lowApprovers: 1,
  maxLowDirs: 5,
  maxLowFiles: 15,
  maxLowLines: 400,
  standardApprovers: 1,
};

export const MAX_POLICY_FILE_BYTES = 64 * 1024;
/** Most globs one repository file may carry across its three glob lists. */
export const MAX_FILE_GLOBS = 200;
/** Most globs in force after the file, the registry and the defaults are combined. */
export const MAX_EFFECTIVE_GLOBS = 400;
/** Per-path work (tokens over every brace alternative) all of a file's globs may add up to. */
export const MAX_FILE_GLOB_COST = 1000;
const GLOB_LIST_KEYS = ['sensitivePaths', 'highRiskPaths', 'ignoredFromSkim'] as const;

/** Keys that try to switch a rule off. Accepted so they can be reported, never applied. */
const RELAXATION_KEYS = [
  'mode',
  'autoMerge',
  'autoMergeAllowed',
  'exclusions',
  'disableExclusions',
  'disabledExclusions',
  'allowPaths',
  'allowedPaths',
] as const;

const glob = z
  .string()
  .min(1)
  .max(MAX_GLOB_LENGTH)
  .refine(
    isValidGlob,
    `not a valid glob (unclosed or nested braces, more than ${MAX_GLOB_EXPANSIONS} alternatives)`
  )
  .refine((g) => countGlobStars(g) <= MAX_GLOB_STARS, `more than ${MAX_GLOB_STARS} * tokens`);
const globs = z.array(glob).max(MAX_FILE_GLOBS);
const count = z.number().int().min(0).max(1_000_000);
const approvers = z.number().int().min(1).max(10);
const relaxationShape = Object.fromEntries(
  RELAXATION_KEYS.map((key) => [key, z.unknown().optional()])
);

const RepoPolicyFileSchema = z
  .object({
    highApprovers: approvers.optional(),
    highLines: count.optional(),
    highRiskPaths: globs.optional(),
    ignoredFromSkim: globs.optional(),
    lowApprovers: approvers.optional(),
    maxLowDirs: count.optional(),
    maxLowFiles: count.optional(),
    maxLowLines: count.optional(),
    sensitivePaths: globs.optional(),
    standardApprovers: approvers.optional(),
    version: z.literal(1),
    ...relaxationShape,
  })
  .strict();

const MAX_ERRORS = 20;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Own keys at any depth, so a pollution attempt is refused wherever it is nested. */
function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || typeof value !== 'object' || value === null) {
    return false;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return true;
    }
    if (hasForbiddenKey((value as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

/** Parses `.auto-swe/pr-policy.yml`. Never throws; every failure is an entry in `errors`. */
export function parsePolicyFile(text: string): { policy?: RepoPolicyFile; errors: string[] } {
  try {
    if (typeof text !== 'string') {
      return { errors: ['policy file is not text'] };
    }
    if (new TextEncoder().encode(text).length > MAX_POLICY_FILE_BYTES) {
      return { errors: [`policy file is larger than ${MAX_POLICY_FILE_BYTES / 1024} KiB`] };
    }
    let raw: unknown;
    try {
      // No aliases at all: they are the way to build a small file that expands hugely.
      raw = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true });
    } catch {
      return { errors: ['policy file is not valid YAML (aliases and duplicate keys are refused)'] };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { errors: ['policy file must be a YAML mapping'] };
    }
    if (hasForbiddenKey(raw)) {
      return { errors: ['policy file uses a reserved key (__proto__, constructor, prototype)'] };
    }
    // Counted before validation so a flood of globs is refused without compiling any of them.
    const rawLists = GLOB_LIST_KEYS.map((key) => (raw as Record<string, unknown>)[key]);
    const total = rawLists.reduce<number>(
      (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
      0
    );
    if (total > MAX_FILE_GLOBS) {
      return { errors: [`policy file has ${total} globs; the limit is ${MAX_FILE_GLOBS}`] };
    }
    const parsed = RepoPolicyFileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        errors: parsed.error.issues
          .slice(0, MAX_ERRORS)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      };
    }
    const cost = GLOB_LIST_KEYS.reduce(
      (sum, key) => sum + (parsed.data[key] ?? []).reduce((s, g) => s + globCost(g), 0),
      0
    );
    if (cost > MAX_FILE_GLOB_COST) {
      return {
        errors: [
          `policy file globs are too expensive to evaluate (${cost} > ${MAX_FILE_GLOB_COST})`,
        ],
      };
    }
    return { errors: [], policy: splitRelaxations(parsed.data as Record<string, unknown>) };
  } catch {
    return { errors: ['policy file could not be read'] };
  }
}

function splitRelaxations(data: Record<string, unknown>): RepoPolicyFile {
  const relaxations: string[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if ((RELAXATION_KEYS as readonly string[]).includes(key)) {
      relaxations.push(key);
    } else if (value !== undefined) {
      rest[key] = value;
    }
  }
  if (relaxations.length > 0) {
    rest.relaxations = relaxations;
  }
  return rest as RepoPolicyFile;
}

const LOWER_ONLY = ['maxLowLines', 'maxLowFiles', 'maxLowDirs', 'highLines'] as const;
const RAISE_ONLY = ['lowApprovers', 'standardApprovers', 'highApprovers'] as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Applies a repository's file over the operator's floor. The file can add
 * paths, lower size thresholds and raise approver counts; anything that would
 * loosen a rule is ignored and named in `warnings`.
 */
export function mergePolicy(
  floor: PolicyFloor,
  file?: RepoPolicyFile
): { effective: EffectivePolicy; warnings: string[]; fileRejected: boolean } {
  const effective: EffectivePolicy = {
    ...floor,
    highRiskPaths: unique(floor.highRiskPaths ?? []),
    ignoredFromSkim: [],
    sensitivePaths: unique(floor.sensitivePaths),
  };
  const warnings: string[] = [];
  const floorEffective = { ...effective };
  if (file && !applyFile(effective, floor, file, warnings)) {
    warnings.length = 0;
    warnings.push(
      `policy-file-too-large: more than ${MAX_EFFECTIVE_GLOBS} globs in force; the repository file was rejected as a whole`
    );
    Object.assign(effective, floorEffective);
    normaliseApprovers(effective, warnings);
    return { effective, fileRejected: true, warnings };
  }
  normaliseApprovers(effective, warnings);
  return { effective, fileRejected: false, warnings };
}

/** Counts must be at least 1 and never fall as the class rises. */
function normaliseApprovers(effective: EffectivePolicy, warnings: string[]): void {
  const whole = (n: number): number => (Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1);
  const low = whole(effective.lowApprovers);
  const standard = Math.max(whole(effective.standardApprovers), low);
  const high = Math.max(whole(effective.highApprovers), standard);
  if (
    low !== effective.lowApprovers ||
    standard !== effective.standardApprovers ||
    high !== effective.highApprovers
  ) {
    warnings.push(
      `approver counts raised to ${low}/${standard}/${high} (low/standard/high): each class needs at least one approval and no fewer than the class below`
    );
  }
  effective.lowApprovers = low;
  effective.standardApprovers = standard;
  effective.highApprovers = high;
}

/** Applies the file to `effective`; false when the combined glob count is over the ceiling. */
function applyFile(
  effective: EffectivePolicy,
  floor: PolicyFloor,
  file: RepoPolicyFile,
  warnings: string[]
): boolean {
  effective.sensitivePaths = unique([...effective.sensitivePaths, ...(file.sensitivePaths ?? [])]);
  effective.highRiskPaths = unique([...effective.highRiskPaths, ...(file.highRiskPaths ?? [])]);
  effective.ignoredFromSkim = unique(file.ignoredFromSkim ?? []);
  const inForce =
    unique([...DEFAULT_SENSITIVE_PATHS, ...effective.sensitivePaths]).length +
    effective.highRiskPaths.length +
    effective.ignoredFromSkim.length;
  if (inForce > MAX_EFFECTIVE_GLOBS) {
    return false;
  }

  for (const key of LOWER_ONLY) {
    const wanted = file[key];
    if (wanted === undefined) {
      continue;
    }
    if (wanted > floor[key]) {
      warnings.push(`${key}: ${wanted} would raise the threshold above ${floor[key]}; ignored`);
    } else {
      effective[key] = wanted;
    }
  }
  for (const key of RAISE_ONLY) {
    const wanted = file[key];
    if (wanted === undefined) {
      continue;
    }
    if (wanted < floor[key]) {
      warnings.push(
        `${key}: ${wanted} would lower the approver count below ${floor[key]}; ignored`
      );
    } else {
      effective[key] = wanted;
    }
  }
  for (const key of file.relaxations ?? []) {
    warnings.push(`${key}: a repository file cannot change or disable platform rules; ignored`);
  }
  return true;
}
