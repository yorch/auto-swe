import type { DetectedStack, RepoGateCommands } from '../types/api.js';

type Stack = 'node' | 'python' | 'jvm' | 'go';

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

/**
 * Gate commands for a Node root whose lockfile names npm or pnpm. Yarn has no
 * entry: the built-in gates are `yarn` commands, so a Yarn root (or one whose
 * manager is unknown) keeps them. A script the repository does not declare fails
 * as `missing script`, exactly as the built-in `yarn lint` does.
 */
const NODE_PM_GATE_DEFAULTS: Record<'npm' | 'pnpm', RepoGateCommands> = {
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
};

/** The stack a stored detection puts at the repository's root, or null. Assumes no shape. */
export function detectedRootStack(detected: unknown): Stack | null {
  if (!detected || typeof detected !== 'object') {
    return null;
  }
  const d = detected as Partial<DetectedStack>;
  const root = Array.isArray(d.components)
    ? d.components.find((c) => c?.path === '')?.stacks?.[0]
    : d.primary;
  return root === 'node' || root === 'python' || root === 'jvm' || root === 'go' ? root : null;
}

/**
 * Stack-derived fallback commands for a repository's stored detection, or null
 * when the built-in `yarn` gates apply: no detection, a root with no stack, or a
 * Node root on Yarn (or with no recorded manager). A non-null result may be sparse —
 * a gate it lacks has no unambiguous command for the stack, and the caller must
 * not substitute another ecosystem's.
 *
 * Only the root counts: a detection with `components` is read from the root
 * component (a polyglot root resolves by the fixed precedence, so node wins),
 * and one from before `components` existed carried a root-only `primary`.
 * The input is a JSON column, so nothing about its shape is assumed.
 */
export function detectedGateDefaults(detected: unknown): RepoGateCommands | null {
  const root = detectedRootStack(detected);
  if (root === null) {
    return null;
  }
  const d = detected as Partial<DetectedStack>;
  if (root === 'node') {
    const pm = d.packageManager;
    return pm === 'npm' || pm === 'pnpm' ? { ...NODE_PM_GATE_DEFAULTS[pm] } : null;
  }
  const evidence = Array.isArray(d.evidence) ? d.evidence : [];
  const rootFiles = new Set(evidence.filter((f) => typeof f === 'string' && !f.includes('/')));
  return stackGateDefaults(root, rootFiles);
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
  opts?: { packageJsonScripts?: string[]; treeTruncated?: boolean }
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
  const components = dirs
    .slice(0, MAX_COMPONENTS)
    .map((dir) => ({
      path: dir,
      stacks: PRECEDENCE.filter((stack) => SIGNALS[stack].some((f) => byDir.get(dir)?.has(f))),
    }))
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
      ? nodeGateCommands(present, new Set(opts?.packageJsonScripts))
      : { ...stackGateDefaults(rootStack, present) };
  // Python's lint is a suggestion only: `ruff` is not in the curated image, so it
  // is not a run-time default (a missing binary would fail the gate with 127).
  if (rootStack === 'python' && present.has('pyproject.toml')) {
    suggestedGateCommands.runLint = 'ruff check';
  }

  // Recorded only when exactly one root lockfile exists: two (a stale one beside the
  // live one) leave the manager unknown, and an unknown manager keeps the built-in
  // gates instead of guessing one that could differ from what the repo runs.
  const rootLockfiles = NODE_LOCKFILES.filter((l) => present.has(l.file));
  const packageManager =
    rootStack === 'node' && rootLockfiles.length === 1 ? rootLockfiles[0]?.pm : undefined;

  return {
    ...(components.length > 0 ? { components } : {}),
    ...(componentsTruncated ? { componentsTruncated } : {}),
    evidence,
    ...(packageManager ? { packageManager } : {}),
    primary,
    stacks,
    suggestedDockerfile: primary,
    suggestedGateCommands,
    ...(opts?.treeTruncated ? { treeTruncated: true } : {}),
  };
}
