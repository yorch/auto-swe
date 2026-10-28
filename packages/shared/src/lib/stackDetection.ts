import type { DetectedStack, RepoGateCommands } from '../types/api.js';
import { packageManagerPins } from './lockfileAllowlist.js';

export type Stack = 'node' | 'python' | 'jvm' | 'go';

/**
 * Fixed precedence for `primary` when a repository presents several stacks:
 * node, then python, then jvm, then go. The order favours the stacks whose
 * curated executor image (`defaults/Dockerfile.<stack>`) is most likely to
 * carry the repo's other toolchains — a polyglot repo still lists every stack
 * in `stacks`; `primary` only picks the one the suggestions key on.
 */
const PRECEDENCE: readonly Stack[] = ['node', 'python', 'jvm', 'go'];

/** Root filenames that evidence each stack. */
const SIGNALS: Record<Stack, string[]> = {
  go: ['go.mod'],
  jvm: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  node: ['package.json'],
  python: ['pyproject.toml', 'requirements.txt', 'setup.py'],
};

const NODE_LOCKFILES: Array<{ file: string; pm: NodePackageManager }> = [
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
];

/** The script names a `package.json` text declares; none for text that is not one. */
function scriptsOf(packageJson: string | undefined): string[] {
  try {
    const parsed = JSON.parse(packageJson ?? '') as { scripts?: unknown };
    return parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [];
  } catch {
    return [];
  }
}

function nodeGateCommands(present: Set<string>, scripts: Set<string>): RepoGateCommands {
  const pm = NODE_LOCKFILES.find((l) => present.has(l.file))?.pm ?? 'npm';
  const run = pm === 'npm' ? 'npm run' : pm;
  // Only scripts the root package.json actually declares — a guessed script
  // name would run in every gate as `missing script: lint`.
  const commands: RepoGateCommands = {};
  if (scripts.has('lint')) {
    commands.runLint = `${run} lint`;
  }
  if (scripts.has('test')) {
    commands.runTests = pm === 'npm' ? 'npm test' : `${pm} test`;
  }
  if (scripts.has('typecheck')) {
    commands.runTypecheck = `${run} typecheck`;
  }
  return commands;
}

/**
 * Gate commands a stack runs when nothing else names one — the run-time fallback
 * for a repository whose root is not a Node project, and the source of the
 * suggestions above, so the two cannot disagree.
 *
 * Static on purpose: the commands come from this table, never from a stored
 * detection row, because a gate command runs in the agent workspace and setting
 * one is an admin-gated change (docs/repositories.md). A gate absent here has no
 * unambiguous command for the stack; the caller reports it as unconfigured
 * rather than substituting another ecosystem's command. `node` has no entry:
 * the built-in `yarn` gates are its defaults.
 *
 * `rootFiles` (names of the root directory's files) picks the JVM build tool.
 */
export function stackGateDefaults(
  stack: Stack | null,
  rootFiles: ReadonlySet<string>
): RepoGateCommands {
  switch (stack) {
    case 'python':
      return { runTests: 'python -m pytest' };
    case 'jvm':
      return rootFiles.has('pom.xml')
        ? { runBuild: 'mvn -B -q -DskipTests package', runTests: 'mvn -B -q test' }
        : {
            runBuild: './gradlew build -x test --no-daemon',
            runTests: './gradlew test --no-daemon',
          };
    case 'go':
      return { runBuild: 'go build ./...', runLint: 'go vet ./...', runTests: 'go test ./...' };
    default:
      return {};
  }
}

type NodePackageManager = 'npm' | 'yarn' | 'pnpm';
type YarnFlavor = 'berry' | 'classic';

/**
 * The built-in Node gate commands: Yarn 4 (Berry), what the platform has always assumed. The
 * worker's `DEFAULT_COMMANDS` is this table plus `runPerfBench: null`, so there is one copy;
 * a Node root on Yarn Berry, or on an unknown manager, resolves to these without a lookup.
 */
export const YARN_GATE_DEFAULTS: Readonly<
  Record<'runBuild' | 'runLint' | 'runTests' | 'runTypecheck' | 'runVulnScan', string>
> = Object.freeze({
  runBuild: 'yarn build',
  runLint: 'yarn lint',
  runTests: 'yarn test',
  runTypecheck: 'yarn typecheck',
  runVulnScan: 'yarn npm audit --severity high',
});

/**
 * Gate commands by Node package manager. A script the repository does not declare fails as
 * `missing script`, exactly as the built-in `yarn lint` does.
 *
 * Yarn Classic has no `runVulnScan`. `yarn npm audit` does not exist in Yarn 1, and `yarn audit`
 * posts to a hard-coded `https://registry.yarnpkg.com` — Yarn 1 ignores the configured registry
 * for it — so it can never go through the registry proxy, carries no registry credential, and
 * sends every package name in the lockfile, private ones included, to a public host. The
 * proxy refuses exactly that for the other managers, so no default is better than that one;
 * the gate resolves as unconfigured and an admin may set `runVulnScan` deliberately.
 */
const NODE_PM_GATE_DEFAULTS: Record<'npm' | 'pnpm' | 'yarn-classic', RepoGateCommands> = {
  npm: {
    runBuild: 'npm run build',
    runLint: 'npm run lint',
    runTests: 'npm test',
    runTypecheck: 'npm run typecheck',
    runVulnScan: 'npm audit --audit-level=high',
  },
  pnpm: {
    runBuild: 'pnpm run build',
    runLint: 'pnpm run lint',
    runTests: 'pnpm test',
    runTypecheck: 'pnpm run typecheck',
    runVulnScan: 'pnpm audit --audit-level high',
  },
  'yarn-classic': {
    runBuild: YARN_GATE_DEFAULTS.runBuild,
    runLint: YARN_GATE_DEFAULTS.runLint,
    runTests: YARN_GATE_DEFAULTS.runTests,
    runTypecheck: YARN_GATE_DEFAULTS.runTypecheck,
  },
};

/** A directory in a stored detection: a few plain path segments, never absolute, `..` or an option. */
const COMPONENT_PATH_RE = /^[A-Za-z0-9_@][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9_@][A-Za-z0-9._@-]*){0,3}$/;

/** Where a repository's gates and test loop run, and on which stack, per its stored detection. */
export interface DetectedTarget {
  /** `''` for the repository root, else a validated relative directory. */
  dir: string;
  stack: Stack;
  packageManager?: NodePackageManager;
  yarnFlavor?: YarnFlavor;
  /** The names of the files directly in `dir` that evidenced a stack; picks the JVM build tool. */
  rootFiles: ReadonlySet<string>;
}

const isStack = (v: unknown): v is Stack =>
  v === 'node' || v === 'python' || v === 'jvm' || v === 'go';
const isPm = (v: unknown): v is NodePackageManager => v === 'npm' || v === 'yarn' || v === 'pnpm';
const isFlavor = (v: unknown): v is YarnFlavor => v === 'berry' || v === 'classic';

/**
 * Resolve a stored detection to the one place a repository's defaults apply, or say why not:
 *
 * - the **root**, when it has a stack signal (a polyglot root resolves by the fixed
 *   precedence, so node wins);
 * - else the **only component**, when exactly one directory has a signal and the listing was
 *   complete — never when `treeTruncated` or `componentsTruncated` is set, because "only one
 *   seen" is not "only one";
 * - `'ambiguous'` when several directories have signals and the root has none: no single
 *   place is right, so the caller reports the gates as unconfigured;
 * - `null` when there is nothing to go on (no detection, an unusable shape, an unlisted
 *   tree), which keeps the built-in behaviour.
 *
 * The input is a JSON column written by the worker, but nothing about its shape is assumed:
 * a component path is re-validated here, and a record from before `components` existed is
 * read by its root-only `primary`.
 */
export function detectedTarget(detected: unknown): DetectedTarget | 'ambiguous' | null {
  if (!detected || typeof detected !== 'object') {
    return null;
  }
  const d = detected as Partial<DetectedStack>;
  const evidence = Array.isArray(d.evidence)
    ? d.evidence.filter((f): f is string => typeof f === 'string')
    : [];
  const filesIn = (dir: string) =>
    new Set(
      evidence
        .filter((f) =>
          dir === ''
            ? !f.includes('/')
            : f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/')
        )
        .map((f) => f.slice(dir === '' ? 0 : dir.length + 1))
    );
  if (!Array.isArray(d.components)) {
    return isStack(d.primary)
      ? {
          dir: '',
          packageManager: isPm(d.packageManager) ? d.packageManager : undefined,
          rootFiles: filesIn(''),
          stack: d.primary,
          yarnFlavor: isFlavor(d.yarnFlavor) ? d.yarnFlavor : undefined,
        }
      : null;
  }
  const comps = d.components.filter(
    (c): c is NonNullable<DetectedStack['components']>[number] =>
      !!c && typeof c === 'object' && typeof c.path === 'string' && Array.isArray(c.stacks)
  );
  const root = comps.find((c) => c.path === '');
  const pick = (c: (typeof comps)[number]): DetectedTarget | null => {
    const stack = c.stacks.find(isStack);
    if (!stack || (c.path !== '' && !COMPONENT_PATH_RE.test(c.path))) {
      return null;
    }
    const own = c.path === '' ? d : c;
    return {
      dir: c.path,
      packageManager: isPm(own.packageManager) ? own.packageManager : undefined,
      rootFiles: filesIn(c.path),
      stack,
      yarnFlavor: isFlavor(own.yarnFlavor) ? own.yarnFlavor : undefined,
    };
  };
  if (root) {
    return pick(root);
  }
  if (d.treeTruncated || d.componentsTruncated || comps.length === 0) {
    return null;
  }
  return comps.length === 1 ? pick(comps[0] as (typeof comps)[number]) : 'ambiguous';
}

/** The stack a stored detection puts at the repository root, or null. Assumes no shape. */
export function detectedRootStack(detected: unknown): Stack | null {
  const t = detectedTarget(detected);
  return t !== null && t !== 'ambiguous' && t.dir === '' ? t.stack : null;
}

/** The directory the test loop and gates run in: a validated component, else `''` (the root). */
export function detectedTargetDir(detected: unknown): string {
  const t = detectedTarget(detected);
  return t !== null && t !== 'ambiguous' ? t.dir : '';
}

/** `cd '<dir>' && <command>` for a component; the command unchanged at the root. Dir is pre-validated. */
export function inDir(dir: string, command: string): string {
  return dir === '' ? command : `cd '${dir}' && ${command}`;
}

/** The default commands for a target, before any `cd`, or null where the built-in gates are exactly them. */
function targetCommands(t: DetectedTarget): RepoGateCommands | null {
  if (t.stack !== 'node') {
    return stackGateDefaults(t.stack, t.rootFiles);
  }
  if (t.packageManager === 'npm' || t.packageManager === 'pnpm') {
    return { ...NODE_PM_GATE_DEFAULTS[t.packageManager] };
  }
  if (t.packageManager === 'yarn' && t.yarnFlavor === 'classic') {
    return { ...NODE_PM_GATE_DEFAULTS['yarn-classic'] };
  }
  // Yarn Berry, or a manager nobody recorded: the root keeps the built-ins (which are this
  // table), and a component needs them spelled out because they must run in its directory.
  return t.dir === '' ? null : { ...YARN_GATE_DEFAULTS };
}

/**
 * Stack-derived fallback commands for a repository's stored detection (see
 * {@link detectedTarget}), or null when the built-in gates apply: nothing detected, or a Node
 * root on Yarn Berry or with no recorded manager. A non-null result may be sparse — a gate it
 * lacks has no unambiguous command for the stack, and the caller must not substitute another
 * ecosystem's — and is empty for an ambiguous layout. A component's commands carry their
 * `cd`; the stack defaults are the only commands that get one, never an admin's.
 */
export function detectedGateDefaults(detected: unknown): RepoGateCommands | null {
  const t = detectedTarget(detected);
  if (t === null) {
    return null;
  }
  if (t === 'ambiguous') {
    return {};
  }
  const commands = targetCommands(t);
  if (commands === null || t.dir === '') {
    return commands;
  }
  return Object.fromEntries(
    Object.entries(commands).map(([gate, cmd]) => [gate, inDir(t.dir, cmd as string)])
  ) as RepoGateCommands;
}

/**
 * Detect a repository's stack(s) from the root files that are present —
 * `presentFiles` is a list of repo-root filenames (existence only; contents
 * are not needed). Returns every detected stack, the primary one by the fixed
 * precedence above, conservative suggested gate commands (keyed on
 * `Connection.gateCommands` / `REPO_GATE_COMMAND_KEYS`), the curated
 * `defaults/Dockerfile.<stack>` to build (null when no stack was found), and
 * the filenames read as evidence.
 *
 * Suggestions are deliberately conservative — lint/typecheck commands are only
 * suggested where the ecosystem names them unambiguously; tests always are.
 */
const IGNORED_SEGMENTS = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'target']);
const MAX_DEPTH = 4;
const MAX_COMPONENTS = 50;

/** Whether a repo path can carry a stack signal: shallow, outside vendored/generated trees. */
function usable(path: string): boolean {
  const segments = path.split('/');
  return segments.length <= MAX_DEPTH + 1 && !segments.some((seg) => IGNORED_SEGMENTS.has(seg));
}

export function detectStack(
  presentFiles: string[],
  opts?: {
    /** The root `package.json` text: its scripts feed the suggestions and its `packageManager` pin names the manager. */
    packageJson?: string;
    packageJsonScripts?: string[];
    treeTruncated?: boolean;
  }
): DetectedStack {
  const filtered = presentFiles.filter(usable);
  // Group by containing directory: '' for root files, 'a/b' for nested.
  const byDir = new Map<string, Set<string>>();
  for (const path of filtered) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const base = path.split('/').pop() ?? path;
    const set = byDir.get(dir) ?? new Set<string>();
    set.add(base);
    byDir.set(dir, set);
  }
  const dirs = [...byDir.keys()].sort();
  const componentsTruncated = dirs.length > MAX_COMPONENTS;
  // A directory's Node package manager comes from its own lockfile names alone (a component's
  // package.json is not fetched): exactly one lockfile names it, none or several leave it unknown.
  const pmOf = (dir: string): { packageManager?: NodePackageManager; yarnFlavor?: YarnFlavor } => {
    const files = byDir.get(dir);
    const locks = NODE_LOCKFILES.filter((l) => files?.has(l.file));
    const packageManager = locks.length === 1 ? locks[0]?.pm : undefined;
    return {
      ...(packageManager ? { packageManager } : {}),
      ...(packageManager === 'yarn' && files?.has('.yarnrc.yml')
        ? { yarnFlavor: 'berry' as const }
        : {}),
    };
  };
  const components = dirs
    .slice(0, MAX_COMPONENTS)
    .map((dir) => {
      const stacks = PRECEDENCE.filter((stack) =>
        SIGNALS[stack].some((f) => byDir.get(dir)?.has(f))
      );
      return { path: dir, stacks, ...(stacks[0] === 'node' ? pmOf(dir) : {}) };
    })
    .filter((c) => c.stacks.length > 0);

  const present = new Set(byDir.get('') ?? []);
  const stacks = PRECEDENCE.filter((stack) => components.some((c) => c.stacks.includes(stack)));
  // Root's own primary when the root has signals; otherwise the stack with
  // the most components, ties broken by the fixed precedence.
  const rootStacks = PRECEDENCE.filter((s) => SIGNALS[s].some((f) => present.has(f)));
  const primary =
    rootStacks[0] ??
    (components.length === 0
      ? null
      : (PRECEDENCE.map((s) => ({
          count: components.filter((c) => c.stacks.includes(s)).length,
          stack: s,
        })).sort(
          (a, b) => b.count - a.count || PRECEDENCE.indexOf(a.stack) - PRECEDENCE.indexOf(b.stack)
        )[0]?.stack ?? null));

  const evidence = stacks.flatMap((stack) =>
    filtered.filter((f) => SIGNALS[stack].includes(f.split('/').pop() ?? ''))
  );
  for (const { file } of NODE_LOCKFILES) {
    for (const f of filtered) {
      if (f.split('/').pop() === file) {
        evidence.push(f);
      }
    }
  }

  // Suggestions stay root-only: a repo with no root stack gets none.
  const rootStack = rootStacks[0] ?? null;
  const suggestedGateCommands: RepoGateCommands =
    rootStack === 'node'
      ? nodeGateCommands(present, new Set(opts?.packageJsonScripts ?? scriptsOf(opts?.packageJson)))
      : { ...stackGateDefaults(rootStack, present) };
  // Python's lint is a suggestion only: `ruff` is not in the curated image, so it
  // is not a run-time default (a missing binary would fail the gate with 127).
  if (rootStack === 'python' && present.has('pyproject.toml')) {
    suggestedGateCommands.runLint = 'ruff check';
  }

  // The root's manager: the `packageManager` pin when there is one — Corepack enforces it, so
  // it outranks a lockfile — else the lockfile when exactly one exists (two, a stale one beside
  // the live one, leave it unknown). An unknown manager keeps the built-in gates instead of
  // guessing one that could differ from what the repo runs. Yarn's flavour comes from the pin's
  // major version, else from a `.yarnrc.yml` (Berry's config file).
  let packageManager: NodePackageManager | undefined;
  let yarnFlavor: YarnFlavor | undefined;
  if (rootStack === 'node') {
    const pin = opts?.packageJson ? packageManagerPins(opts.packageJson)[0] : undefined;
    if (pin?.name === 'npm' || pin?.name === 'pnpm') {
      packageManager = pin.name;
    } else if (pin?.name === 'yarn' || pin?.name === '@yarnpkg/cli-dist') {
      packageManager = 'yarn';
      yarnFlavor = pin.name === 'yarn' ? 'classic' : 'berry';
    } else {
      const own = pmOf('');
      packageManager = own.packageManager;
      yarnFlavor = own.yarnFlavor;
    }
  }
  // The root component carries the same answer, so a reader that looks only at components agrees.
  const rootComponent = components.find((c) => c.path === '') as
    | (DetectedStack['components'] & object)[number]
    | undefined;
  if (rootComponent && packageManager) {
    rootComponent.packageManager = packageManager;
    if (yarnFlavor) {
      rootComponent.yarnFlavor = yarnFlavor;
    }
  }

  return {
    ...(components.length > 0 ? { components } : {}),
    ...(componentsTruncated ? { componentsTruncated } : {}),
    evidence,
    ...(packageManager ? { packageManager } : {}),
    ...(yarnFlavor ? { yarnFlavor } : {}),
    primary,
    stacks,
    suggestedDockerfile: primary,
    suggestedGateCommands,
    ...(opts?.treeTruncated ? { treeTruncated: true } : {}),
  };
}
