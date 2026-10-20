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

const NODE_LOCKFILES: Array<{ file: string; pm: 'npm' | 'yarn' | 'pnpm' }> = [
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
 * Detect a repository's stack(s) from the root files that are present —
 * `presentFiles` is a list of repo-root filenames (existence only; contents
 * are not needed). Returns every detected stack, the primary one by the fixed
 * precedence above, conservative suggested gate commands (keyed on
 * `Connection.gateCommands` / `REPO_GATE_COMMAND_KEYS`), the curated
 * `defaults/Dockerfile.<stack>` to build (null for go, which has none), and
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

  const suggestedGateCommands: RepoGateCommands = {};
  // Suggestions stay root-only: a repo with no root stack gets none.
  switch (rootStacks[0] ?? null) {
    case 'node':
      Object.assign(
        suggestedGateCommands,
        nodeGateCommands(present, new Set(opts?.packageJsonScripts))
      );
      break;
    case 'python':
      suggestedGateCommands.runTests = 'python -m pytest';
      if (present.has('pyproject.toml')) {
        suggestedGateCommands.runLint = 'ruff check';
      }
      break;
    case 'jvm':
      suggestedGateCommands.runTests = present.has('pom.xml')
        ? 'mvn -B -q test'
        : './gradlew test --no-daemon';
      break;
    case 'go':
      suggestedGateCommands.runTests = 'go test ./...';
      break;
    case null:
      break;
  }

  return {
    ...(components.length > 0 ? { components } : {}),
    ...(componentsTruncated ? { componentsTruncated } : {}),
    evidence,
    primary,
    stacks,
    suggestedDockerfile: primary === 'go' || primary === null ? null : primary,
    suggestedGateCommands,
    ...(opts?.treeTruncated ? { treeTruncated: true } : {}),
  };
}
