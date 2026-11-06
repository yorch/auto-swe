import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { type DetectedTarget, detectedTarget } from './stackDetection.js';

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

/**
 * A cache key file: a path inside the checkout, or a glob over the tracked files (`*` within a
 * segment, `**` across segments, `?` one character), such as every subproject's build file.
 */
const KeyFilePatternSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_@+.*?][A-Za-z0-9_@+\-./*?]*$/, 'must be a relative path or glob of plain characters')
  .refine((p) => !hasTraversal(p.replace(/\/+$/, '')), 'must not contain "." or ".." segments')
  .refine((p) => !p.includes('//'), 'must not contain empty segments');

/** True when a cache key file entry is a glob rather than a literal path. */
export function isKeyFileGlob(entry: string): boolean {
  return /[*?]/.test(entry);
}

/** Most tracked files the key file globs of one definition may match together. */
export const MAX_KEY_FILE_GLOB_MATCHES = 500;

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
    keyFiles: z.array(KeyFilePatternSchema).max(20).optional(),
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

const GRADLE_SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'] as const;

/** Every project's build file, the root's and each subproject's. */
const GRADLE_BUILD_GLOBS = ['**/build.gradle', '**/build.gradle.kts'] as const;

interface StackInstall {
  run: string;
  /** Files hashed into the cache key, relative to the target directory. */
  keyFiles: string[];
  /** Cached paths: relative to the target directory, or `~/…` under the home directory. */
  paths: string[];
}

/** The install a detected target gets, from the lockfile or build file in its directory. */
function stackInstall(target: DetectedTarget): StackInstall | null {
  const has = (f: string) => target.rootFiles.has(f);
  switch (target.stack) {
    case 'node': {
      const pm =
        target.packageManager === 'yarn'
          ? `yarn-${target.yarnFlavor ?? 'berry'}`
          : (target.packageManager ?? null);
      const install = pm ? NODE_INSTALL[pm] : undefined;
      return install && has(install.keyFile)
        ? { keyFiles: [install.keyFile], paths: ['node_modules'], run: install.run }
        : null;
    }
    case 'python':
      if (has('uv.lock')) {
        return { keyFiles: ['uv.lock'], paths: ['.venv'], run: 'uv sync --frozen' };
      }
      return has('requirements.txt')
        ? {
            keyFiles: ['requirements.txt'],
            paths: ['.venv'],
            run: 'python -m venv .venv && .venv/bin/pip install -r requirements.txt',
          }
        : null;
    case 'go':
      return has('go.sum')
        ? { keyFiles: ['go.mod', 'go.sum'], paths: ['~/go/pkg/mod'], run: 'go mod download' }
        : null;
    case 'jvm':
      if (has('pom.xml')) {
        return {
          keyFiles: ['pom.xml'],
          paths: ['~/.m2/repository'],
          run: 'mvn -B -q dependency:go-offline',
        };
      }
      return has('gradlew')
        ? {
            keyFiles: [
              ...GRADLE_SETTINGS_FILES.filter(has),
              ...GRADLE_BUILD_GLOBS,
              'gradle/libs.versions.toml',
              'gradle/wrapper/gradle-wrapper.properties',
            ],
            paths: ['~/.gradle/caches', '~/.gradle/wrapper'],
            run: './gradlew --no-daemon dependencies',
          }
        : null;
    default:
      return null;
  }
}

/**
 * The setup a repository gets from its stored stack detection when it configures none and
 * the `workspace.repoSetupStackDefaults` setting is on: the lockfile-faithful install for the
 * root or single component, cached by its lockfile or build files. Node installs with its
 * package manager's frozen install, Python with `uv sync --frozen` (else a `.venv` from
 * `requirements.txt`), Go with `go mod download`, Maven with `dependency:go-offline` and
 * Gradle through its wrapper. Null when there is no single, unambiguous target, or its
 * directory has none of the files its install needs: a guessed command would fail setup.
 */
export function stackDefaultSetup(detectedStack: unknown): RepoSetup | null {
  const target = detectedTarget(detectedStack);
  if (!target || target === 'ambiguous') {
    return null;
  }
  const install = stackInstall(target);
  if (!install) {
    return null;
  }
  const inDir = (p: string) => (p.startsWith('~/') || !target.dir ? p : `${target.dir}/${p}`);
  return {
    cache: { keyFiles: install.keyFiles.map(inDir), paths: install.paths.map(inDir) },
    steps: [
      {
        name: 'install dependencies',
        run: install.run,
        ...(target.dir ? { workdir: target.dir } : {}),
      },
    ],
  };
}

/** What a repository starts from when it has no setup: an empty definition to fill in. */
export const EMPTY_REPO_SETUP: RepoSetup = { steps: [] };

/**
 * A starting `.auto-swe/setup.yml` for a repository: its stack default when the stored
 * detection names one, else a single placeholder step to edit.
 */
export function starterRepoSetup(detectedStack: unknown): RepoSetup {
  return (
    stackDefaultSetup(detectedStack) ?? {
      steps: [{ name: 'install dependencies', run: 'echo "replace with your install command"' }],
    }
  );
}

const SETUP_KEY_ORDER = ['submodules', 'lfs', 'env', 'steps', 'cache'] as const;
const STEP_KEY_ORDER = ['name', 'run', 'workdir', 'timeoutSeconds'] as const;

/**
 * A setup definition as `.auto-swe/setup.yml` text, keys in the documented order, under a
 * header naming the file and where its schema is described. Parses back to the same value.
 */
export function repoSetupToYaml(setup: RepoSetup): string {
  const ordered: Record<string, unknown> = {};
  for (const key of SETUP_KEY_ORDER) {
    const value = setup[key];
    if (value === undefined) {
      continue;
    }
    ordered[key] =
      key === 'steps'
        ? (value as RepoSetupStep[]).map((step) =>
            Object.fromEntries(
              STEP_KEY_ORDER.filter((k) => step[k] !== undefined).map((k) => [k, step[k]])
            )
          )
        : value;
  }
  return [
    `# ${REPO_SETUP_FILE}: run in every auto-swe workspace after the checkout.`,
    '# Fields: submodules, lfs, env, steps[name, run, workdir, timeoutSeconds],',
    '# cache[paths, keyFiles]. See docs/repositories.md, "Workspace setup".',
    stringifyYaml(ordered, { lineWidth: 0 }).trimEnd(),
    '',
  ].join('\n');
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
