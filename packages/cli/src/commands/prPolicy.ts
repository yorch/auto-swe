import { type Dirent, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_POLICY_FILE_BYTES, validatePrPolicy } from '@auto-swe/sdk';
import { apiRequest, GatewayError, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { missingValue, parseFlags } from '../lib/flags.js';

/**
 * `auto-swe pr-policy` — a repository's `.auto-swe/pr-policy.yml`, and its pull request
 * evaluation settings.
 *
 * `init` and `validate` are token-free and offline (dispatched before credentials are
 * loaded). `status` and `mode` call the gateway with `AUTO_SWE_TOKEN`.
 */

const POLICY_PATH = path.join('.auto-swe', 'pr-policy.yml');

/** Directory names that mark a repository as having sensitive, locally detectable areas. */
const DETECT_NAMES: readonly string[] = [
  'migrations',
  'migration',
  'auth',
  'authz',
  'payments',
  'billing',
  'infra',
  'terraform',
  'charts',
  'helm',
  'k8s',
  'deploy',
];
const DETECT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'vendor']);
const DETECT_DEPTH = 3;

const MODE_CHOICES = ['off', 'advisory', 'auto', 'inherit'] as const;

const SUB_HELP = `auto-swe pr-policy — a repository's PR policy file and evaluation settings

  pr-policy init [--dir <path>] [--force]
                                   Write <path>/.auto-swe/pr-policy.yml (default: the current
                                   directory). Pre-fills sensitivePaths from the sensitive
                                   directories that exist locally. Refuses to overwrite an
                                   existing file unless --force is given. Token-free.
  pr-policy validate [file]        Check a policy file (default .auto-swe/pr-policy.yml) offline.
                                   Errors exit 1; warnings print and exit 0. Token-free.
  pr-policy status <repoId>        Show a repository's evaluation mode, enablement, last
                                   evaluation and auto-merge evidence (gateway, needs a token).
  pr-policy mode <repoId> <off|advisory|auto|inherit>
                                   Set a repository's evaluation mode; "inherit" restores the
                                   deployment default. auto is refused with the reasons it is not
                                   ready (exit 1). Needs a team lead or platform admin.
`;

const POLICY_TEMPLATE_HEADER = `# auto-swe pull request policy (.auto-swe/pr-policy.yml)
#
# The platform's defaults apply in full. This file can only make pull request evaluation
# STRICTER: add sensitive or high-risk paths, lower the LOW-class limits, lower highLines,
# raise approver counts, or name required reviewers. It cannot lower an approver count,
# raise a threshold, disable a default exclusion, or set the evaluation mode. Any such key
# is ignored, and \`auto-swe pr-policy validate\` reports it.
#
# The platform reads this file from the base branch.
version: 1
`;

const POLICY_TEMPLATE_FOOTER = `
# Paths whose changes make the whole pull request HIGH risk.
# highRiskPaths:
#   - 'deploy/production/**'

# LOW-class limits. Lower values are stricter.
# maxLowLines: 200
# maxLowFiles: 8
# maxLowDirs: 3

# Changed lines above which a pull request is HIGH risk. Lower is stricter.
# highLines: 600

# Approvals required per risk class. Each must be at least the platform's count.
# lowApprovers: 1
# standardApprovers: 1
# highApprovers: 2
`;

interface LastEvaluation {
  createdAt: string;
  prNumber: number;
  riskClass: string;
  requiredApprovers: number;
  statusState: string | null;
}

interface PrEvaluationStatus {
  enabled: boolean;
  mode: 'off' | 'advisory' | 'auto';
  modeSource: 'repository' | 'default';
  autoMergeAllowed: boolean;
  lastEvaluation: LastEvaluation | null;
  evidence: {
    lowMerged: number;
    badMerges: number;
    windowDays: number;
    minEvidence: number;
    satisfied: boolean;
  };
}

interface ModeResult {
  mode: string | null;
  modeSource: 'repository' | 'default';
}

export async function runPrPolicyCommand(
  args: string[],
  loadEnv: () => Promise<CliEnv>
): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'init') {
      return await cmdInit(rest);
    }
    if (sub === 'validate') {
      return await cmdValidate(rest);
    }
    if (sub === 'status') {
      return await cmdStatus(rest, await loadEnv());
    }
    if (sub === 'mode') {
      return await cmdMode(rest, await loadEnv());
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: pr-policy ${sub}\n${SUB_HELP}`);
  return 1;
}

/** True when a flag the subcommand does not declare was passed; names it on stderr. */
function rejectUnknownFlags(flags: Record<string, string>, known: readonly string[]): boolean {
  const unknown = Object.keys(flags).find((f) => !known.includes(f));
  if (unknown) {
    process.stderr.write(`Unknown flag: --${unknown}\n${SUB_HELP}`);
    return true;
  }
  return false;
}

async function cmdInit(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  if (positional.length > 0) {
    process.stderr.write(`Usage: pr-policy init [--dir <path>] [--force]\n${SUB_HELP}`);
    return 1;
  }
  if (rejectUnknownFlags(flags, ['dir', 'force'])) {
    return 1;
  }
  const valueless = missingValue(flags, 'dir');
  if (valueless) {
    process.stderr.write(`--${valueless} needs a path\n`);
    return 1;
  }
  const root = path.resolve(flags.dir ?? '.');
  const target = path.join(root, POLICY_PATH);
  const force = 'force' in flags;
  if (!force && existsSync(target)) {
    process.stderr.write(`${target} already exists; pass --force to overwrite it\n`);
    return 1;
  }

  const sensitive = await detectSensitiveDirs(root);
  const contents = policyTemplate(sensitive);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, contents, { flag: force ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stderr.write(`${target} already exists; pass --force to overwrite it\n`);
      return 1;
    }
    throw err;
  }
  const detected =
    sensitive.length > 0
      ? `sensitivePaths pre-filled for: ${sensitive.join(', ')}`
      : 'no sensitive directories detected; sensitivePaths is empty';
  process.stdout.write(`Wrote ${target}\n  ${detected}\n`);
  return 0;
}

/**
 * The `**\/<name>/**` glob for each sensitive directory name found under `root`, down to
 * {@link DETECT_DEPTH} levels, skipping dependency and build trees. Sorted and de-duplicated.
 */
export async function detectSensitiveDirs(root: string): Promise<string[]> {
  const found = new Set<string>();
  const names = new Set(DETECT_NAMES);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > DETECT_DEPTH) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || DETECT_SKIP.has(entry.name)) {
        continue;
      }
      if (names.has(entry.name)) {
        found.add(entry.name);
      }
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }
  await walk(root, 1);
  return [...found].sort().map((name) => `**/${name}/**`);
}

/** The commented template, with `sensitivePaths` filled in from the detected directories. */
export function policyTemplate(sensitivePaths: readonly string[]): string {
  const list =
    sensitivePaths.length === 0
      ? '\n# Paths whose changes are never LOW risk. Empty: no sensitive directories were found.\nsensitivePaths: []\n'
      : `\n# Paths whose changes are never LOW risk. Pre-filled from the directories that exist here\n# (up to three levels deep); each glob matches at any depth.\nsensitivePaths:\n${sensitivePaths.map((g) => `  - '${g}'`).join('\n')}\n`;
  return `${POLICY_TEMPLATE_HEADER}${list}${POLICY_TEMPLATE_FOOTER}`;
}

async function cmdValidate(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  if (positional.length > 1) {
    process.stderr.write(`Usage: pr-policy validate [file]\n${SUB_HELP}`);
    return 1;
  }
  if (rejectUnknownFlags(flags, [])) {
    return 1;
  }
  const file = path.resolve(positional[0] ?? POLICY_PATH);
  let size: number;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      process.stderr.write(`${file}: not a file\n`);
      return 1;
    }
    size = stat.size;
  } catch (err) {
    process.stderr.write(
      `${file}: cannot read — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
  if (size > MAX_POLICY_FILE_BYTES) {
    process.stderr.write(
      `${file}: ${size} bytes; a policy file may be at most ${MAX_POLICY_FILE_BYTES / 1024} KiB\n`
    );
    return 1;
  }
  const result = validatePrPolicy(await fs.readFile(file, 'utf8'));
  if (!result.ok) {
    process.stderr.write(`INVALID: ${file}\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  const count = result.warnings.length;
  process.stdout.write(
    `OK: ${file}${count > 0 ? ` (${count} warning${count === 1 ? '' : 's'})` : ''}\n`
  );
  return 0;
}

async function cmdStatus(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const repoId = positional[0];
  if (!repoId || positional.length > 1) {
    process.stderr.write(`Usage: pr-policy status <repoId>\n${SUB_HELP}`);
    return 1;
  }
  if (rejectUnknownFlags(flags, [])) {
    return 1;
  }
  const status = await apiRequest<PrEvaluationStatus>(
    env,
    'GET',
    `/api/v1/repositories/${encodeURIComponent(repoId)}/pr-evaluation`
  );
  const last = status.lastEvaluation;
  const ev = status.evidence;
  const lines = [
    `Repository:      ${repoId}`,
    `Enabled:         ${status.enabled ? 'yes' : 'no'}`,
    `Mode:            ${status.mode} (${status.modeSource === 'repository' ? 'set on this repository' : 'deployment default'})`,
    `Auto-merge:      ${status.autoMergeAllowed ? 'allowed by this deployment' : 'not allowed by this deployment'}`,
    last
      ? `Last evaluation:  PR #${last.prNumber} — class ${last.riskClass}, ${last.requiredApprovers} approver(s) required, status ${last.statusState ?? 'none'}, evaluated ${last.createdAt}`
      : 'Last evaluation:  none',
    `Evidence:        ${ev.lowMerged} low-risk merge(s) in ${ev.windowDays} days (minimum ${ev.minEvidence}), ${ev.badMerges} marked bad, auto ${ev.satisfied ? 'satisfied' : 'not satisfied'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function cmdMode(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const [repoId, choice, ...extra] = positional;
  if (!repoId || !choice || extra.length > 0) {
    process.stderr.write(`Usage: pr-policy mode <repoId> <off|advisory|auto|inherit>\n${SUB_HELP}`);
    return 1;
  }
  if (rejectUnknownFlags(flags, [])) {
    return 1;
  }
  if (!(MODE_CHOICES as readonly string[]).includes(choice)) {
    process.stderr.write(`mode must be one of: ${MODE_CHOICES.join(', ')} (got "${choice}")\n`);
    return 1;
  }
  const mode = choice === 'inherit' ? null : choice;
  try {
    const result = await apiRequest<ModeResult>(
      env,
      'PUT',
      `/api/v1/repositories/${encodeURIComponent(repoId)}/pr-evaluation`,
      { mode }
    );
    const shown = result.mode ?? 'inherit';
    const source =
      result.modeSource === 'repository' ? 'set on this repository' : 'deployment default';
    process.stdout.write(`Mode for ${repoId}: ${shown} (${source})\n`);
    return 0;
  } catch (err) {
    if (err instanceof GatewayError && err.statusCode === 400 && err.code === 'AUTO_NOT_READY') {
      const reasons = refusalReasons(err.details);
      if (reasons.length === 0) {
        process.stderr.write(`${err.message}\n`);
      } else {
        process.stderr.write(`${err.message}:\n${reasons.join('\n')}\n`);
      }
      return 1;
    }
    throw err;
  }
}

/** The `reasons` a 400 AUTO_NOT_READY carries under `error.details`, or none when absent. */
function refusalReasons(details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('reasons' in details)) {
    return [];
  }
  const reasons: unknown = details.reasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons.filter((r: unknown): r is string => typeof r === 'string');
}
