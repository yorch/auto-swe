import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepRecord,
} from '@auto-swe/shared/types/api';
import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { pad, parsePositiveInt } from '../lib/format.js';
import { parseFlags } from './workflows.js';

/**
 * `auto-swe runs` — list and inspect workflow runs from the terminal.
 *
 * The list endpoint accepts `?status`, `?templateId`, `?workRequestId` —
 * we surface the common ones as flags. Tail polls the run detail endpoint
 * until the run reaches a terminal status (max polls capped so a stuck run
 * doesn't keep the CLI alive forever).
 */

const SUB_HELP = `auto-swe runs — inspect workflow runs

  runs list [--status=STATUS] [--template-id=ID] [--limit=N]
                                        Recent runs (default limit 20)
  runs show <runId>                     Print one run + its steps as JSON
  runs tail <runId> [--interval=SEC] [--max=N]
                                        Poll until the run reaches a terminal
                                        status; prints one summary line per change
`;

export async function runRunsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  try {
    if (sub === 'list') return await cmdList(rest, env);
    if (sub === 'show') return await cmdShow(rest, env);
    if (sub === 'tail') return await cmdTail(rest, env);
  } catch (err) {
    if (err instanceof GatewayError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write(`Unknown subcommand: runs ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdList(args: string[], env: CliEnv): Promise<number> {
  const { flags } = parseFlags(args);
  const limit = parsePositiveInt(flags.limit, 20);
  if (limit === 'invalid') {
    process.stderr.write('--limit must be a positive integer\n');
    return 1;
  }
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (flags.status) params.set('status', flags.status);
  if (flags['template-id']) params.set('templateId', flags['template-id']);
  if (flags['work-request-id']) params.set('workRequestId', flags['work-request-id']);
  const url = `/api/v1/workflow-runs?${params.toString()}`;

  const rows = await apiRequest<WorkflowRunSummary[]>(env, 'GET', url);
  if (rows.length === 0) {
    process.stdout.write('No runs visible.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('ID', 38) + pad('TICKET', 18) + pad('STATUS', 12) + pad('TPLv', 6)}STARTED\n`
  );
  for (const r of rows) {
    process.stdout.write(
      pad(r.id, 38) +
        pad(r.workRequest?.externalTicketId ?? '-', 18) +
        pad(r.status, 12) +
        pad(`v${r.templateVersion}`, 6) +
        `${r.startedAt}\n`
    );
  }
  return 0;
}

async function cmdShow(args: string[], env: CliEnv): Promise<number> {
  const { positional } = parseFlags(args);
  const id = positional[0];
  if (!id) {
    process.stderr.write('Usage: runs show <runId>\n');
    return 1;
  }
  const detail = await apiRequest<WorkflowRunDetail>(env, 'GET', `/api/v1/workflow-runs/${id}`);
  process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
  return 0;
}

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'SKIPPED']);

async function cmdTail(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const id = positional[0];
  if (!id) {
    process.stderr.write('Usage: runs tail <runId> [--interval=SEC] [--max=N]\n');
    return 1;
  }
  const intervalSec = parsePositiveInt(flags.interval, 5);
  if (intervalSec === 'invalid') {
    process.stderr.write('--interval must be a positive integer (seconds)\n');
    return 1;
  }
  const maxPolls = parsePositiveInt(flags.max, 180);
  if (maxPolls === 'invalid') {
    process.stderr.write('--max must be a positive integer\n');
    return 1;
  }

  let lastSignature = '';
  for (let i = 0; i < maxPolls; i++) {
    const detail = await apiRequest<WorkflowRunDetail>(env, 'GET', `/api/v1/workflow-runs/${id}`);
    const signature = stepSignature(detail);
    if (signature !== lastSignature) {
      lastSignature = signature;
      const last = detail.steps.at(-1);
      const lastLine = last ? ` last: ${last.nodeId} (${last.status})` : '';
      process.stdout.write(
        `[${detail.status}] ${detail.steps.length} steps recorded.${lastLine}\n`
      );
    }
    if (TERMINAL_STATUSES.has(detail.status)) return detail.status === 'SUCCESS' ? 0 : 2;
    await sleep(intervalSec * 1000);
  }
  process.stderr.write(`runs tail: gave up after ${maxPolls} polls\n`);
  return 1;
}

function stepSignature(d: WorkflowRunDetail): string {
  // A new line is printed whenever (a) the run status flips, OR (b) a new
  // step row lands, OR (c) the most recent step's status changes.
  const last = d.steps.at(-1);
  return `${d.status}|${d.steps.length}|${last?.nodeId ?? ''}|${last?.status ?? ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export for type discovery in callers (unused at runtime).
export type { WorkflowStepRecord };
