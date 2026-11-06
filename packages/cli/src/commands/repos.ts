import { readFile } from 'node:fs/promises';
import { parseRepoSetupYaml } from '@auto-swe/shared/lib/repoSetup';
import {
  REPO_GATE_COMMAND_KEYS,
  type RepoGateCommandKey,
  type RepoGateCommands,
  type RepositorySummary,
} from '@auto-swe/shared/types/api';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { FLAG_PRESENT, parseFlags } from '../lib/flags.js';
import { pad } from '../lib/format.js';
import { findRepoByName } from './workRequests.js';

/**
 * `auto-swe repos` — repository settings a CLI user needs without the dashboard.
 *
 * `gate-commands` shows or changes the commands a gate step with no command of its own runs on
 * the repository. A change is sent as the full set, like the connection form sends it; the
 * gateway refuses it (exit 2) unless the caller is a platform admin or an admin of the
 * repository's team.
 *
 * `setup` shows or replaces the repository's workspace setup, the definition that otherwise
 * comes from its `.auto-swe/setup.yml`, under the same role.
 */

/** The flag for each gate, in the order `REPO_GATE_COMMAND_KEYS` lists them. */
const GATE_FLAGS: Record<RepoGateCommandKey, string> = {
  runBuild: 'build',
  runLint: 'lint',
  runPerfBench: 'perf-bench',
  runTests: 'tests',
  runTypecheck: 'typecheck',
  runVulnScan: 'vuln-scan',
};

const SUB_HELP = `auto-swe repos — repository settings

  repos gate-commands <org/name>      Print the repository's gate commands
  repos gate-commands <org/name> [--lint=CMD] [--typecheck=CMD] [--tests=CMD] [--build=CMD]
        [--vuln-scan=CMD] [--perf-bench=CMD] [--clear]
                                      Set the named gates; an empty value (--lint=) removes that
                                      gate's command, --clear removes every one first. A gate with
                                      no command runs the built-in default. Changing them needs a
                                      platform admin or an admin of the repository's team.
  repos setup <org/name>              Print the repository's workspace setup
  repos setup <org/name> --file=PATH  Set it from a YAML or JSON file (the .auto-swe/setup.yml
                                      schema); it then replaces the repository's own file
  repos setup <org/name> --clear      Remove it, so workspaces read .auto-swe/setup.yml again.
                                      Changing it needs a platform admin or an admin of the
                                      repository's team.
  repos test-access <org/name> [--json]
                                      Check what a run on the repository could do: the platform
                                      credential for its host mints a token, sees the repository
                                      and may push, the default branch exists; and the same for
                                      your own saved token, if you have one. Exits 1 when a step
                                      fails. Needs a platform admin or a lead of the repository's
                                      team.
`;

export async function runReposCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'gate-commands') {
      return await cmdGateCommands(rest, env);
    }
    if (sub === 'setup') {
      return await cmdSetup(rest, env);
    }
    if (sub === 'test-access') {
      return await cmdTestAccess(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: repos ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdGateCommands(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const ref = positional[0];
  const [org, name, extra] = ref?.split('/') ?? [];
  if (!org || !name || extra !== undefined) {
    process.stderr.write(`Usage: repos gate-commands <org/name> [flags]\n${SUB_HELP}`);
    return 1;
  }
  const known = new Set([...Object.values(GATE_FLAGS), 'clear']);
  const unknown = Object.keys(flags).find((f) => !known.has(f));
  if (unknown) {
    process.stderr.write(`Unknown flag: --${unknown}\n${SUB_HELP}`);
    return 1;
  }
  const valueless = REPO_GATE_COMMAND_KEYS.find((key) => flags[GATE_FLAGS[key]] === FLAG_PRESENT);
  if (valueless) {
    process.stderr.write(
      `--${GATE_FLAGS[valueless]} needs a command; pass --${GATE_FLAGS[valueless]}= to remove it\n`
    );
    return 1;
  }

  const repo = await findRepoByName(env, org, name);
  if (!repo) {
    process.stderr.write(`Repository "${ref}" not found.\n`);
    return 1;
  }
  const changes = REPO_GATE_COMMAND_KEYS.filter((key) => GATE_FLAGS[key] in flags);
  if (changes.length === 0 && !('clear' in flags)) {
    printGateCommands(repo.gateCommands ?? null);
    return 0;
  }

  const next: Record<string, string> = 'clear' in flags ? {} : { ...(repo.gateCommands ?? {}) };
  for (const key of changes) {
    const command = flags[GATE_FLAGS[key]] ?? '';
    if (command.trim() === '') {
      delete next[key];
    } else {
      next[key] = command;
    }
  }
  const updated = await apiRequest<RepositorySummary>(
    env,
    'PATCH',
    `/api/v1/repositories/${repo.id}`,
    {
      gateCommands: Object.keys(next).length > 0 ? next : null,
    }
  );
  printGateCommands(updated.gateCommands ?? null);
  return 0;
}

async function cmdSetup(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const ref = positional[0];
  const [org, name, extra] = ref?.split('/') ?? [];
  const unknown = Object.keys(flags).find((f) => f !== 'file' && f !== 'clear');
  if (!org || !name || extra !== undefined || positional.length > 1 || unknown) {
    process.stderr.write(
      `${unknown ? `Unknown flag: --${unknown}\n` : ''}Usage: repos setup <org/name> [--file=PATH | --clear]\n${SUB_HELP}`
    );
    return 1;
  }
  if ('file' in flags && 'clear' in flags) {
    process.stderr.write('--file and --clear cannot be combined\n');
    return 1;
  }
  const file = flags.file;
  if (file === FLAG_PRESENT || file === '') {
    process.stderr.write('--file needs a path\n');
    return 1;
  }
  let next: unknown;
  if (file !== undefined) {
    const parsed = parseRepoSetupYaml(await readFile(file, 'utf8'));
    if (!parsed.ok) {
      process.stderr.write(`${file}: ${parsed.error}\n`);
      return 1;
    }
    next = parsed.setup;
  }
  const repo = await findRepoByName(env, org, name);
  if (!repo) {
    process.stderr.write(`Repository "${ref}" not found.\n`);
    return 1;
  }
  if (file === undefined && !('clear' in flags)) {
    printSetup(repo.setup ?? null);
    return 0;
  }
  const updated = await apiRequest<RepositorySummary>(
    env,
    'PATCH',
    `/api/v1/repositories/${repo.id}`,
    { setup: next ?? null }
  );
  printSetup(updated.setup ?? null);
  return 0;
}

function printSetup(setup: unknown): void {
  process.stdout.write(
    setup == null
      ? "(none: workspaces read the repository's .auto-swe/setup.yml)\n"
      : `${JSON.stringify(setup, null, 2)}\n`
  );
}

interface AccessResult {
  ok: boolean;
  detail: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

async function cmdTestAccess(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const ref = positional[0];
  const [org, name, extra] = ref?.split('/') ?? [];
  const unknown = Object.keys(flags).find((f) => f !== 'json');
  if (!org || !name || extra !== undefined || positional.length > 1 || unknown) {
    process.stderr.write(
      `${unknown ? `Unknown flag: --${unknown}\n` : ''}Usage: repos test-access <org/name> [--json]\n${SUB_HELP}`
    );
    return 1;
  }
  const repo = await findRepoByName(env, org, name);
  if (!repo) {
    process.stderr.write(`Repository "${ref}" not found.\n`);
    return 1;
  }
  const result = await apiRequest<AccessResult>(
    env,
    'POST',
    `/api/v1/repositories/${repo.id}/test-access`,
    {}
  );
  if (flags.json === FLAG_PRESENT) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  for (const check of result.checks) {
    process.stdout.write(`${pad(check.ok ? 'ok' : 'failed', 9)}${check.detail}\n`);
  }
  process.stdout.write(result.ok ? `\n${ref} is reachable.\n` : `\n${ref} has a failing step.\n`);
  return result.ok ? 0 : 1;
}

function printGateCommands(commands: RepoGateCommands | null): void {
  for (const key of REPO_GATE_COMMAND_KEYS) {
    process.stdout.write(`${pad(GATE_FLAGS[key], 14)}${commands?.[key] ?? '(built-in default)'}\n`);
  }
}
