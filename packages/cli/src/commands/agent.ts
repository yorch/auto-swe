import { readFile } from 'node:fs/promises';
import {
  isTerminalWorkflowRunStatus,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from '@auto-swe/shared/types/api';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { missingValue, parseFlags } from '../lib/flags.js';
import { parsePositiveInt } from '../lib/format.js';
import { sleep } from '../lib/time.js';
import { findRepoByName } from './workRequests.js';

const SUB_HELP = `auto-swe agent — run a library agent on a repository

  agent run <key[@version]> "<prompt>" --repo=<org/name>|--repo-id=<uuid>
            [--deliver=none|branch|draft_pr] [--base=<branch>] [--max-steps=N]
            [--timeout=SECONDS] [--budget=STANDARD|LARGE|EPIC] [--idempotency-key=KEY] [--wait]
  agent rerun <workRequestId> [--idempotency-key=KEY] [--wait]

  The agent works in a throwaway checkout of the repository. By default nothing leaves
  that sandbox and you get the agent's text and its diff back. --deliver=branch pushes
  the result to a new branch and --deliver=draft_pr also opens a DRAFT pull request;
  either one only after the platform's checks pass. Nothing is ever merged.

  FLAGS
    <key[@version]>        A library agent (\`key\` floats; \`key@3\` pins the global version)
    --prompt=@<file>|-     Read the prompt from a file or stdin instead of the argument
                           (use it for a long prompt or one that begins with "-")
    --base=<branch>        Cut the checkout from this branch and open a draft PR into it
                           (default: the repository's default branch)
    --max-steps=N          Cap model steps (can only lower the platform ceiling)
    --timeout=SECONDS      Cap wall-clock time (can only lower the platform ceiling)
    --wait                 Poll until the run finishes; exit 2 if it did not succeed
    --idempotency-key=K    Make a retried launch return a conflict instead of a second run
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERIES = ['none', 'branch', 'draft_pr'];
const BUDGETS = ['STANDARD', 'LARGE', 'EPIC'];

interface LaunchResponse {
  workRequestId: string;
  workflowId: string | null;
  temporalWorkflowId: string;
  effective: { deliver: string; maxSteps: number; maxWallClockSeconds: number };
}

interface AgentRunResult {
  text?: string;
  branch?: string;
  headSha?: string;
  prUrl?: string;
  prNumber?: number;
  gate?: string;
  deliver?: string;
  diffVerified?: boolean;
  diffTruncated?: boolean;
  stoppedReason?: string;
  filesChanged?: Array<{
    path: string;
    operation: string;
    linesAdded: number;
    linesRemoved: number;
  }>;
  diff?: string;
}

export async function runAgentCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'run') {
      return await cmdRun(rest, env);
    }
    if (sub === 'rerun') {
      return await cmdRerun(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: agent ${sub}\n${SUB_HELP}`);
  return 1;
}

/**
 * `--wait` is a boolean, but `parseFlags` would give it the next bare word as a
 * value (`--wait <key>` would swallow the agent key), so it is lifted out first.
 */
function takeWait(args: string[]): { args: string[]; wait: boolean } {
  const wait = args.includes('--wait');
  return { args: args.filter((a) => a !== '--wait'), wait };
}

async function readPrompt(flagValue: string | undefined, positional: string | undefined) {
  if (flagValue !== undefined) {
    if (flagValue === '-') {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) {
        chunks.push(Buffer.from(c));
      }
      return Buffer.concat(chunks).toString('utf8').trim();
    }
    if (flagValue.startsWith('@')) {
      return (await readFile(flagValue.slice(1), 'utf8')).trim();
    }
    return flagValue;
  }
  return positional;
}

async function resolveRepoId(
  flags: Record<string, string>,
  env: CliEnv
): Promise<string | { error: string }> {
  if (!flags.repo && !flags['repo-id']) {
    return { error: 'Missing required flag: --repo=<org/name> or --repo-id=<uuid>' };
  }
  if (flags.repo && flags['repo-id']) {
    return { error: '--repo and --repo-id are mutually exclusive; provide only one.' };
  }
  if (flags['repo-id']) {
    return UUID_RE.test(flags['repo-id'])
      ? flags['repo-id']
      : { error: '--repo-id must be a valid UUID' };
  }
  // `--repo` also accepts a repository UUID, since that is what the API takes.
  const repo = flags.repo as string;
  if (UUID_RE.test(repo)) {
    return repo;
  }
  const [org, name] = repo.split('/');
  if (!org || !name) {
    return { error: '--repo must be in "org/name" format (e.g. acme/payments-api)' };
  }
  const found = await findRepoByName(env, org, name);
  return found ? found.id : { error: `Repository "${repo}" not found.` };
}

function idempotencyHeader(key: string | undefined): Record<string, string> | undefined {
  return key ? { 'Idempotency-Key': key } : undefined;
}

async function cmdRun(rawArgs: string[], env: CliEnv): Promise<number> {
  if (rawArgs.includes('-h') || rawArgs.includes('--help')) {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const { args, wait } = takeWait(rawArgs);
  const { flags, positional } = parseFlags(args);
  const bare = missingValue(
    flags,
    'repo',
    'repo-id',
    'deliver',
    'base',
    'max-steps',
    'timeout',
    'budget',
    'idempotency-key',
    'prompt'
  );
  if (bare) {
    process.stderr.write(`--${bare} requires a value\n`);
    return 1;
  }
  const agent = positional[0];
  if (!agent) {
    process.stderr.write('Usage: agent run <key[@version]> "<prompt>" --repo=<org/name>\n');
    return 1;
  }
  const prompt = await readPrompt(flags.prompt, positional[1]);
  if (!prompt) {
    process.stderr.write('Missing prompt: pass it as the second argument or with --prompt=@file\n');
    return 1;
  }

  const deliver = flags.deliver ?? 'none';
  if (!DELIVERIES.includes(deliver)) {
    process.stderr.write(`--deliver must be one of: ${DELIVERIES.join(', ')}\n`);
    return 1;
  }
  const budget = (flags.budget ?? 'STANDARD').toUpperCase();
  if (!BUDGETS.includes(budget)) {
    process.stderr.write(`--budget must be one of: ${BUDGETS.join(', ')}\n`);
    return 1;
  }
  const maxSteps = parsePositiveInt(flags['max-steps'], 0);
  if (maxSteps === 'invalid') {
    process.stderr.write('--max-steps must be a positive integer\n');
    return 1;
  }
  const timeout = parsePositiveInt(flags.timeout, 0);
  if (timeout === 'invalid') {
    process.stderr.write('--timeout must be a positive integer (seconds)\n');
    return 1;
  }

  const repoId = await resolveRepoId(flags, env);
  if (typeof repoId !== 'string') {
    process.stderr.write(`${repoId.error}\n`);
    return 1;
  }

  const launched = await apiRequest<LaunchResponse>(
    env,
    'POST',
    '/api/v1/agent-runs',
    {
      agent,
      ...(flags.base ? { baseBranch: flags.base } : {}),
      budgetTier: budget,
      deliver,
      ...(maxSteps > 0 ? { maxSteps } : {}),
      ...(timeout > 0 ? { maxWallClockSeconds: timeout } : {}),
      prompt,
      repoId,
    },
    idempotencyHeader(flags['idempotency-key'])
  );
  return afterLaunch(launched, wait, env);
}

async function cmdRerun(rawArgs: string[], env: CliEnv): Promise<number> {
  const { args, wait } = takeWait(rawArgs);
  const { flags, positional } = parseFlags(args);
  const id = positional[0];
  if (!id || !UUID_RE.test(id)) {
    process.stderr.write('Usage: agent rerun <workRequestId> [--wait]\n');
    return 1;
  }
  const launched = await apiRequest<LaunchResponse>(
    env,
    'POST',
    `/api/v1/agent-runs/${id}/rerun`,
    {},
    idempotencyHeader(flags['idempotency-key'])
  );
  return afterLaunch(launched, wait, env);
}

async function afterLaunch(launched: LaunchResponse, wait: boolean, env: CliEnv): Promise<number> {
  process.stdout.write('Agent run started.\n');
  process.stdout.write(`  Work request: ${launched.workRequestId}\n`);
  process.stdout.write(
    `  Limits:       ${launched.effective.maxSteps} steps, ${launched.effective.maxWallClockSeconds}s, deliver=${launched.effective.deliver}\n`
  );
  if (!wait) {
    process.stdout.write(
      `\nMonitor progress, the run appears once the worker starts it:\n` +
        `  auto-swe runs list --work-request-id=${launched.workRequestId}\n`
    );
    return 0;
  }
  return waitForRun(launched.workRequestId, env);
}

/** Wait for the run row, then poll it to a terminal status. Exit 0 only on SUCCESS. */
async function waitForRun(workRequestId: string, env: CliEnv, intervalSec = 3): Promise<number> {
  let runId: string | undefined;
  for (let i = 0; i < 100 && !runId; i++) {
    const rows = await apiRequest<WorkflowRunSummary[]>(
      env,
      'GET',
      `/api/v1/workflow-runs?limit=1&workRequestId=${workRequestId}`
    );
    runId = rows[0]?.id;
    if (!runId) {
      await sleep(intervalSec * 1000);
    }
  }
  if (!runId) {
    process.stderr.write('agent run: the run did not start in time; check `auto-swe runs list`\n');
    return 1;
  }
  let lastStatus = '';
  for (let i = 0; i < 2000; i++) {
    const detail = await apiRequest<WorkflowRunDetail>(
      env,
      'GET',
      `/api/v1/workflow-runs/${runId}`
    );
    if (detail.status !== lastStatus) {
      lastStatus = detail.status;
      process.stdout.write(`[${detail.status}]\n`);
    }
    if (isTerminalWorkflowRunStatus(detail.status)) {
      printOutcome(detail);
      return detail.status === 'SUCCESS' ? 0 : 2;
    }
    await sleep(intervalSec * 1000);
  }
  process.stderr.write('agent run: gave up waiting\n');
  return 1;
}

function printOutcome(detail: WorkflowRunDetail): void {
  if (detail.status !== 'SUCCESS') {
    const failed = [...detail.steps].reverse().find((s) => s.error);
    process.stderr.write(`Run ${detail.status}${failed?.error ? `:\n${failed.error}\n` : '\n'}`);
    return;
  }
  const r = (detail.result ?? {}) as AgentRunResult;
  if (r.stoppedReason) {
    process.stdout.write(
      `Stopped early (${r.stoppedReason === 'max_steps' ? 'step limit' : 'time limit'}); the work may be incomplete.\n`
    );
  }
  if (r.text) {
    process.stdout.write(`\n${r.text}\n`);
  }
  if (r.branch) {
    process.stdout.write(
      `\nBranch: ${r.branch}${r.headSha ? ` @ ${r.headSha.slice(0, 12)}` : ''}\n`
    );
  }
  if (r.prUrl) {
    process.stdout.write(`Draft PR: ${r.prUrl}\n`);
  }
  if (r.gate === 'no_changes') {
    process.stdout.write('The agent made no changes.\n');
  }
  if (r.filesChanged?.length) {
    process.stdout.write(`\nFiles changed (${r.filesChanged.length}):\n`);
    for (const f of r.filesChanged.slice(0, 50)) {
      process.stdout.write(
        `  ${f.operation.padEnd(7)} ${f.path} (+${f.linesAdded}/-${f.linesRemoved})\n`
      );
    }
  }
  if (r.diff && r.deliver === 'none') {
    process.stdout.write(
      `\n--- diff (the agent's own view, not verified${r.diffTruncated ? ', truncated' : ''}) ---\n${r.diff}\n`
    );
  }
}
