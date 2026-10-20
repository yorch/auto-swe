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
export function detectStack(
  presentFiles: string[],
  opts?: { packageJsonScripts?: string[] }
): DetectedStack {
  const present = new Set(presentFiles);
  const stacks = PRECEDENCE.filter((stack) => SIGNALS[stack].some((f) => present.has(f)));
  const primary = stacks[0] ?? null;

  const evidence = stacks.flatMap((stack) => SIGNALS[stack].filter((f) => present.has(f)));
  for (const { file } of NODE_LOCKFILES) {
    if (present.has(file)) {
      evidence.push(file);
    }
  }

  const suggestedGateCommands: RepoGateCommands = {};
  switch (primary) {
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
    evidence,
    primary,
    stacks,
    suggestedDockerfile: primary === 'go' || primary === null ? null : primary,
    suggestedGateCommands,
  };
}
