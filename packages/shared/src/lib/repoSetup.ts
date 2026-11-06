import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { detectedTarget } from './stackDetection.js';

/** Where a repository checks its setup definition in, read from the base (or pinned) commit. */
export const REPO_SETUP_FILE = '.auto-swe/setup.yml';

/** Largest `.auto-swe/setup.yml` the platform reads. */
export const REPO_SETUP_FILE_MAX_BYTES = 64 * 1024;

/** Longest a single step may run when it sets no `timeoutSeconds`. */
export const DEFAULT_SETUP_STEP_TIMEOUT_SECONDS = 600;

const MAX_STEP_TIMEOUT_SECONDS = 3600;

const EnvironmentSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000))
  .refine((env) => Object.keys(env).length <= 50, 'must contain at most 50 keys');

const hasTraversal = (p: string): boolean => p.split('/').some((s) => s === '..' || s === '.');

/** A path inside the checkout: relative, no `..` or `.` segments, no shell-special characters. */
const RepoRelativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_@+.][A-Za-z0-9_@+\-./]*$/, 'must be a relative path of plain characters')
  .refine((p) => !hasTraversal(p.replace(/\/+$/, '')), 'must not contain "." or ".." segments')
  .refine((p) => !p.includes('//'), 'must not contain empty segments');

/** A cached path: inside the checkout, or under the workspace user's home as `~/…`. */
const CachePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => {
    const rel = p.startsWith('~/') ? p.slice(2) : p;
    return RepoRelativePathSchema.safeParse(rel).success;
  }, 'must be a relative path inside the checkout, or ~/<path> under the home directory');

export const RepoSetupStepSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    run: z
      .string()
      .max(4000)
      .refine((s) => s.trim().length > 0, 'must not be empty'),
    timeoutSeconds: z.number().int().min(1).max(MAX_STEP_TIMEOUT_SECONDS).optional(),
    workdir: RepoRelativePathSchema.optional(),
  })
  .strict();

export const RepoSetupCacheSchema = z
  .object({
    keyFiles: z.array(RepoRelativePathSchema).max(20).optional(),
    paths: z.array(CachePathSchema).min(1).max(10),
  })
  .strict();

/**
 * How a workspace is prepared after the checkout: submodules and LFS objects the platform
 * fetches, then shell steps run as the workspace user, with an optional dependency cache.
 * The repository field (`Connection.setup`) and `.auto-swe/setup.yml` share this schema.
 */
export const RepoSetupSchema = z
  .object({
    cache: RepoSetupCacheSchema.optional(),
    env: EnvironmentSchema.optional(),
    lfs: z.boolean().optional(),
    steps: z.array(RepoSetupStepSchema).max(20).optional(),
    submodules: z.union([z.boolean(), z.literal('recursive')]).optional(),
  })
  .strict();

export type RepoSetup = z.infer<typeof RepoSetupSchema>;
export type RepoSetupStep = z.infer<typeof RepoSetupStepSchema>;

export type RepoSetupSource = 'repository' | 'file' | 'stack';

/** True when the definition asks for nothing at all. */
export function isEmptyRepoSetup(setup: RepoSetup): boolean {
  return !setup.submodules && !setup.lfs && !setup.steps?.length;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

/** Validate a stored or submitted value against {@link RepoSetupSchema}. */
export function parseRepoSetup(
  value: unknown
): { ok: true; setup: RepoSetup } | { ok: false; error: string } {
  const parsed = RepoSetupSchema.safeParse(value);
  return parsed.success
    ? { ok: true, setup: parsed.data }
    : { error: formatIssues(parsed.error), ok: false };
}

/** Parse the text of a `.auto-swe/setup.yml`. An empty file is an empty definition. */
export function parseRepoSetupYaml(
  text: string
): { ok: true; setup: RepoSetup } | { ok: false; error: string } {
  if (Buffer.byteLength(text, 'utf8') > REPO_SETUP_FILE_MAX_BYTES) {
    return { error: `exceeds ${REPO_SETUP_FILE_MAX_BYTES} bytes`, ok: false };
  }
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 50 });
  } catch (err) {
    return {
      error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }
  return parseRepoSetup(doc ?? {});
}

const NODE_INSTALL: Record<string, { run: string; keyFile: string }> = {
  npm: { keyFile: 'package-lock.json', run: 'npm ci' },
  pnpm: { keyFile: 'pnpm-lock.yaml', run: 'pnpm install --frozen-lockfile' },
  'yarn-berry': { keyFile: 'yarn.lock', run: 'yarn install --immutable' },
  'yarn-classic': { keyFile: 'yarn.lock', run: 'yarn install --frozen-lockfile' },
};

/**
 * The setup a repository gets from its stored stack detection when it configures none and
 * the `workspace.repoSetupStackDefaults` setting is on: the lockfile-faithful install for a
 * Node root or single component, cached by its lockfile. Null when there is no single,
 * unambiguous Node target with a known package manager; other stacks get none, because
 * their dependency caches live outside the checkout and a guessed command fails setup.
 */
export function stackDefaultSetup(detectedStack: unknown): RepoSetup | null {
  const target = detectedTarget(detectedStack);
  if (!target || target === 'ambiguous' || target.stack !== 'node') {
    return null;
  }
  const pm =
    target.packageManager === 'yarn'
      ? `yarn-${target.yarnFlavor ?? 'berry'}`
      : (target.packageManager ?? null);
  const install = pm ? NODE_INSTALL[pm] : undefined;
  if (!install || !target.rootFiles.has(install.keyFile)) {
    return null;
  }
  const prefix = target.dir ? `${target.dir}/` : '';
  return {
    cache: { keyFiles: [`${prefix}${install.keyFile}`], paths: [`${prefix}node_modules`] },
    steps: [
      {
        name: 'install dependencies',
        run: install.run,
        ...(target.dir ? { workdir: target.dir } : {}),
      },
    ],
  };
}

export type ResolvedRepoSetup =
  | { source: RepoSetupSource; setup: RepoSetup }
  | { source: null; setup: null };

/**
 * Pick the definition a workspace runs: the repository field, else the checked-in file,
 * else (when enabled) the stack defaults. A present but invalid source is an error, never a
 * silent fall-through to the next one.
 */
export function resolveRepoSetup(input: {
  repositoryField: unknown;
  fileText: string | null;
  detectedStack?: unknown;
  stackDefaults: boolean;
}): { ok: true; resolved: ResolvedRepoSetup } | { ok: false; error: string } {
  if (input.repositoryField !== null && input.repositoryField !== undefined) {
    const parsed = parseRepoSetup(input.repositoryField);
    return parsed.ok
      ? { ok: true, resolved: { setup: parsed.setup, source: 'repository' } }
      : { error: `the repository's setup is invalid: ${parsed.error}`, ok: false };
  }
  if (input.fileText !== null) {
    const parsed = parseRepoSetupYaml(input.fileText);
    return parsed.ok
      ? { ok: true, resolved: { setup: parsed.setup, source: 'file' } }
      : { error: `${REPO_SETUP_FILE} is invalid: ${parsed.error}`, ok: false };
  }
  const stack = input.stackDefaults ? stackDefaultSetup(input.detectedStack) : null;
  return {
    ok: true,
    resolved: stack ? { setup: stack, source: 'stack' } : { setup: null, source: null },
  };
}
