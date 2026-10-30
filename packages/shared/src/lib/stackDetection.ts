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
  // `settings.gradle*` marks a Gradle multi-project root: its subprojects' `build.gradle*` are not
  // the place to run the root's `./gradlew`.
  jvm: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
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
        ? { runBuild: 'mvn -B -q -DskipTests package', runTests: 'mvn -B -ntp test' }
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
 *   place is right ({@link detectedGateDefaults} says which gates a composite still covers);
 * - `null` when there is nothing to go on (no detection, an unusable shape, an unlisted
 *   tree), which keeps the built-in behaviour.
 *
 * The input is a JSON column written by the worker, but nothing about its shape is assumed:
 * a component path is re-validated here, and a record from before `components` existed is
 * read by its root-only `primary`.
 */
export function detectedTarget(detected: unknown): DetectedTarget | 'ambiguous' | null {
  return resolveTarget(detected).target;
}

/**
 * Every stack a detection uses, or null when it is absent or unusable — "unknown", which a caller
 * must not read as "uses none". A component whose stored path fails validation contributes
 * nothing, as it does for {@link detectedTarget}; a record from before `components` existed is
 * read by its root-only `primary`. Unlike the target, this is the union over all components, so
 * a Go module beside a Node root is seen. A detection whose listing was truncated is unknown
 * too: a stack past the truncation is not in it, and "uses none of these" would be a guess.
 */
export function detectedStacks(detected: unknown): Stack[] | null {
  if (!detected || typeof detected !== 'object') {
    return null;
  }
  const d = detected as Partial<DetectedStack>;
  if (d.treeTruncated || d.componentsTruncated) {
    return null;
  }
  const found = new Set<Stack>();
  if (!Array.isArray(d.components)) {
    if (isStack(d.primary)) {
      found.add(d.primary);
    }
  } else {
    for (const c of d.components) {
      if (
        c &&
        typeof c === 'object' &&
        typeof c.path === 'string' &&
        Array.isArray(c.stacks) &&
        (c.path === '' || COMPONENT_PATH_RE.test(c.path))
      ) {
        for (const s of c.stacks) {
          if (isStack(s)) {
            found.add(s);
          }
        }
      }
    }
  }
  return found.size > 0 ? [...found] : null;
}

/** The most components a composite gate covers; more is left unconfigured. */
const MAX_COMPOSITE_COMPONENTS = 8;

/**
 * {@link detectedTarget}'s answer, plus — for an `'ambiguous'` layout of 2..8 components that
 * all validate — the components themselves, which the composite gates run in.
 */
function resolveTarget(detected: unknown): {
  target: DetectedTarget | 'ambiguous' | null;
  components?: DetectedTarget[];
} {
  if (!detected || typeof detected !== 'object') {
    return { target: null };
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
    return {
      target: isStack(d.primary)
        ? {
            dir: '',
            packageManager: isPm(d.packageManager) ? d.packageManager : undefined,
            rootFiles: filesIn(''),
            stack: d.primary,
            yarnFlavor: isFlavor(d.yarnFlavor) ? d.yarnFlavor : undefined,
          }
        : null,
    };
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
    return { target: pick(root) };
  }
  if (d.treeTruncated || d.componentsTruncated || comps.length === 0) {
    return { target: null };
  }
  if (comps.length === 1) {
    return { target: pick(comps[0] as (typeof comps)[number]) };
  }
  const valid = comps.map(pick).filter((t): t is DetectedTarget => t !== null);
  return {
    components:
      comps.length <= MAX_COMPOSITE_COMPONENTS && valid.length === comps.length
        ? valid.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
        : undefined,
    target: 'ambiguous',
  };
}

/** The directory the test loop and gates run in: a validated component, else `''` (the root). */
export function detectedTargetDir(detected: unknown): string {
  const t = detectedTarget(detected);
  return t !== null && t !== 'ambiguous' ? t.dir : '';
}

/**
 * `cd '<dir>' && <command>` for a component; the command unchanged at the root. The directory
 * is pre-validated. The result is for a shell of its own, as every gate and the test loop get:
 * chained in one shell, the first `cd` would move the second command's starting point.
 */
export function inDir(dir: string, command: string): string {
  return dir === '' ? command : `cd '${dir}' && ${command}`;
}

/** The text before the directory in a composite command's per-component marker line. */
const COMPONENT_MARKER_PREFIX = '== auto-swe component: ';

/**
 * A composite command's marker line for `dir`, as it appears in the output: a runner can print
 * `== a ==`; it will not print this.
 */
export const componentMarker = (dir: string): string => `${COMPONENT_MARKER_PREFIX}${dir} ==`;

/** Matches one marker line in a composite command's output; capture 1 is the directory. Global: use `matchAll`. */
export const COMPONENT_MARKER_RE = /^== auto-swe component: (.+) ==$/gm;

/** How many components a command runs, by its `echo` of the marker: 0 for anything but a composite. */
export function compositeComponentCount(command: string): number {
  return command.split(`echo '${COMPONENT_MARKER_PREFIX}`).length - 1;
}

/** pytest's exit status when it collected no tests: the runner ran, and there was nothing to run. */
export const PYTEST_NO_TESTS_STATUS = 5;

/**
 * One `sh` command (dash, busybox ash and bash alike) that runs each part in its own directory
 * and fails if any part fails. A part that fails with a status other than 126, 127 or 5 is a real
 * failure and the first one's status is the command's; 126 and 127 (not runnable) and 5 (pytest
 * collected nothing: {@link PYTEST_NO_TESTS_STATUS}) count only when no part really failed, and
 * then the last of them is. These are the statuses the TDD loop stops on rather than iterates
 * on, so a missing tool or an untested Python component cannot hide another component's failing
 * test from the loop. Every part runs, in the order given, under
 * a {@link componentMarker} line so the output says which directory a failure belongs to. Each
 * `cd` is in a subshell: a bare one would carry into the next part, and a missing directory is a
 * real failure. Each part's stderr is merged into its stdout, so a gate summary that shows only
 * one stream still carries the markers. The directories are pre-validated ({@link COMPONENT_PATH_RE}) and quoted.
 */
export function compositeCommand(parts: ReadonlyArray<{ dir: string; command: string }>): string {
  return [
    'rc=0',
    'ur=0',
    'ck() { if [ "$1" -ne 0 ]; then if [ "$1" -eq 126 ] || [ "$1" -eq 127 ] || [ "$1" -eq 5 ]; then ur=$1; elif [ "$rc" -eq 0 ]; then rc=$1; fi; fi; }',
    ...parts.map(
      // The bare `echo` ends a previous part's output that lacks a trailing newline, so the
      // marker is always a line of its own (the parser reads it line-anchored).
      ({ dir, command }) =>
        `echo; echo '${componentMarker(dir)}'; (cd '${dir}' && ${command}) 2>&1; ck $?`
    ),
    'if [ "$rc" -ne 0 ]; then exit $rc; fi',
    'exit $ur',
  ].join('; ');
}

/**
 * The one stack every component of a composite layout (an ambiguous one of 2..8 valid
 * components) has as its first, when that stack is not Node — Node has no image of its own — or
 * null for anything else.
 */
export function compositeSharedStack(detected: unknown): Stack | null {
  const { target, components } = resolveTarget(detected);
  const first = components?.[0]?.stack;
  return target === 'ambiguous' &&
    first !== undefined &&
    first !== 'node' &&
    components?.every((c) => c.stack === first)
    ? first
    : null;
}

/**
 * The composite gates for several components: a gate every component has a command for, run in
 * all of them. A gate any component lacks is left out — running it in only some would verify part
 * of the repository and read as a pass.
 */
function compositeGateDefaults(components: DetectedTarget[]): RepoGateCommands {
  const perComponent = components.map((t) => ({ commands: targetCommands(t) ?? {}, dir: t.dir }));
  const gates = Object.keys(perComponent[0]?.commands ?? {}) as Array<keyof RepoGateCommands>;
  const result: RepoGateCommands = {};
  for (const gate of gates) {
    const parts = perComponent.map(({ commands, dir }) => ({ command: commands[gate], dir }));
    if (parts.every((p): p is { command: string; dir: string } => typeof p.command === 'string')) {
      result[gate] = compositeCommand(parts);
    }
  }
  return result;
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
  if (t.dir === '') {
    // Yarn Berry, or a manager nobody recorded: the root keeps the built-ins, which are this table.
    return null;
  }
  // A component spells them out, because they must run in its directory. One whose directory
  // has no lockfile at all gets npm's, not Yarn 4's: Yarn 4 refuses a directory that is not
  // part of a project, and `npm run` works without a lockfile. (Its audit then fails honestly,
  // as `npm audit` needs one.) One with a `yarn.lock` is Yarn, Berry unless it says Classic, and
  // one with several lockfiles is unknown like an unknown root — the built-in Yarn commands —
  // rather than a guess at which of them is live.
  const hasLockfile = NODE_LOCKFILES.some((l) => t.rootFiles.has(l.file));
  return t.packageManager === undefined && !hasLockfile
    ? { ...NODE_PM_GATE_DEFAULTS.npm }
    : { ...YARN_GATE_DEFAULTS };
}

/**
 * Stack-derived fallback commands for a repository's stored detection (see
 * {@link detectedTarget}), or null when the built-in gates apply: nothing detected, or a Node
 * root on Yarn Berry or with no recorded manager. A non-null result may be sparse — a gate it
 * lacks has no unambiguous command for the stack, and the caller must not substitute another
 * ecosystem's. An ambiguous layout of 2..8 components gets one composite command per gate that
 * every component has a command for ({@link compositeCommand}); a larger one, or one with an
 * invalid path, gets an empty result. A component's commands carry their `cd`; the stack
 * defaults are the only commands that get one, never an admin's.
 */
export function detectedGateDefaults(detected: unknown): RepoGateCommands | null {
  const { target: t, components } = resolveTarget(detected);
  if (t === null) {
    return null;
  }
  if (t === 'ambiguous') {
    return components ? compositeGateDefaults(components) : {};
  }
  const commands = targetCommands(t);
  if (commands === null || t.dir === '') {
    return commands;
  }
  return Object.fromEntries(
    Object.entries(commands).map(([gate, cmd]) => [gate, inDir(t.dir, cmd as string)])
  ) as RepoGateCommands;
}

/** The most components {@link uncoveredComponents} lists; past it the list is capped, not an error. */
const MAX_UNCOVERED_COMPONENTS = 20;

/**
 * The components a root target's default gates do not cover: every other valid component whose
 * first stack differs from the root's, sorted by path, at most {@link MAX_UNCOVERED_COMPONENTS}.
 * A component that shares the root's first stack (a workspace package under a Node root) is run
 * by the root's own tooling and is not listed.
 *
 * Empty unless the target is the root. A single component or an ambiguous layout already runs its
 * own gates or has nothing to say, and with no target there is nothing to measure against.
 *
 * Derived live from the stored detection, never stored. A truncated detection still lists the
 * components it saw: a partial answer is more useful to an admin than silence, so the truncation
 * flags are not consulted here, unlike {@link detectedStacks}.
 */
export function uncoveredComponents(detected: unknown): Array<{ path: string; stacks: Stack[] }> {
  const { target } = resolveTarget(detected);
  if (target === null || target === 'ambiguous' || target.dir !== '') {
    return [];
  }
  const d = detected as Partial<DetectedStack>;
  if (!Array.isArray(d.components)) {
    return [];
  }
  const uncovered: Array<{ path: string; stacks: Stack[] }> = [];
  for (const c of d.components) {
    if (
      !c ||
      typeof c.path !== 'string' ||
      c.path === '' ||
      !Array.isArray(c.stacks) ||
      !COMPONENT_PATH_RE.test(c.path)
    ) {
      continue;
    }
    const stacks = c.stacks.filter(isStack);
    if (stacks[0] !== undefined && stacks[0] !== target.stack) {
      uncovered.push({ path: c.path, stacks });
    }
  }
  return uncovered
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_UNCOVERED_COMPONENTS);
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
    /** The first ~2 KB of the root `yarn.lock`: its header tells Yarn Classic from Berry. */
    yarnLockHead?: string;
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
  // Only directories that carry a stack signal are components, and the cap counts those: every
  // directory of a large tree holds files, and capping before the filter drops real components
  // behind a hundred directories of docs — and, since a truncated list is what stops the
  // only-component rule from firing, would switch that rule off for most real repositories.
  const withSignals = [...byDir.keys()]
    .sort()
    .map((dir) => ({
      dir,
      stacks: PRECEDENCE.filter((stack) => SIGNALS[stack].some((f) => byDir.get(dir)?.has(f))),
    }))
    .filter((c) => c.stacks.length > 0);
  // A JVM project is a tree: Maven modules and Gradle subprojects sit under a parent that builds
  // them, and the parent's wrapper or `mvn` is where the build runs. A JVM signal below another
  // JVM signal is therefore that parent's, not a second component; counting it would make a plain
  // `server/` (a `settings.gradle.kts` and an `app/build.gradle.kts`) look like two.
  const jvmDirs = withSignals.filter((c) => c.stacks.includes('jvm')).map((c) => c.dir);
  const underJvmParent = (dir: string) =>
    jvmDirs.some((p) => p !== dir && (p === '' || dir.startsWith(`${p}/`)));
  const signalDirs = withSignals
    .map((c) =>
      c.stacks.includes('jvm') && underJvmParent(c.dir)
        ? { ...c, stacks: c.stacks.filter((s) => s !== 'jvm') }
        : c
    )
    .filter((c) => c.stacks.length > 0);
  const componentsTruncated = signalDirs.length > MAX_COMPONENTS;
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
  const components = signalDirs.slice(0, MAX_COMPONENTS).map(({ dir, stacks }) => ({
    path: dir,
    stacks,
    ...(stacks[0] === 'node' ? pmOf(dir) : {}),
  }));

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

  // Suggestions are root-only: a repo with no root stack gets none, because its run-time defaults
  // already apply and a suggestion applied through the form would freeze into `gateCommands`.
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
  // The lockfile header is the last resort: a pin or a `.yarnrc.yml` already decided the flavour.
  if (packageManager === 'yarn' && !yarnFlavor && opts?.yarnLockHead) {
    if (opts.yarnLockHead.includes('# yarn lockfile v1')) {
      yarnFlavor = 'classic';
    } else if (opts.yarnLockHead.includes('__metadata:')) {
      yarnFlavor = 'berry';
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
