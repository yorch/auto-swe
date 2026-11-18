import { randomUUID } from 'node:crypto';
import { AGENT_RUN_DELIVERIES } from '@auto-swe/shared/lib/agentRun';
import {
  ORCHESTRATION_BUDGET_TIERS,
  ORCHESTRATION_STATUSES,
} from '@auto-swe/shared/lib/orchestration';
import type {
  OrchestrationApprovalDto,
  OrchestrationDetailDto,
  OrchestrationLaunchResponse,
  OrchestrationMessageDto,
  OrchestrationMessagesPage,
  OrchestrationSummaryDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import { apiRequest, apiRequestFull, GatewayError, runWithExitCodes } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { consumeEventStream } from '../lib/eventStream.js';
import { missingValue, parseFlags } from '../lib/flags.js';
import { clean, pad } from '../lib/format.js';
import { sleep } from '../lib/time.js';
import { resolveRepoId } from './agent.js';
import { resolveTeamIdBySlug } from './workflows.js';

/**
 * `auto-swe orchestrate` — a conversation with an orchestrator that starts, steers and collects
 * library agent runs. Every subcommand is a thin call over `/api/v1/orchestrations`; the gateway
 * decides what is allowed and this file only shapes the request and renders the answer.
 */

const SUB_HELP = `auto-swe orchestrate — a conversation that starts, steers and collects agent runs

  orchestrate start "<task>" [--agent=<key> ...] [--repo=<org/name> | --team=<slug>]
            [--connection=<id> ...] [--budget-tier=STANDARD|LARGE|EPIC]
            [--deliver=none|branch|draft_pr] [--idempotency-key=KEY] [--wait] [--json]
  orchestrate list [--team=<slug>] [--status=S] [--json]
  orchestrate show <id> [--json]
  orchestrate messages <id> [--follow] [--json]
  orchestrate say <id> "<message>"
  orchestrate steer <id> <childId> "<message>"
  orchestrate cancel-agent <id> <childId>
  orchestrate cancel <id>
  orchestrate end <id>

  HUMAN ACTS. These four are decisions only the person who launched the orchestration can make.
  They are recorded under your account. The in-app assistant cannot make them, and a service
  principal cannot either; the gateway enforces both.
  orchestrate attach <id> --repo=<org/name>      Attach the repository the orchestrator asked for
  orchestrate decline <id>                       Decline that request; the orchestration stays repo-less
  orchestrate approve <id> <approvalId>          Let one held MCP write run
  orchestrate deny <id> <approvalId>             Refuse one held MCP write

  FLAGS
    --agent=KEY           An agent on the allowlist. Repeatable; KEY may pin a version (key@3). Omit it
                          to use the platform's default agents; the output names the ones applied.
    --repo=<org/name>     Start on this repository. Writers and delivery need one.
    --team=<slug>         The team that owns the orchestration. Required without --repo; a repo-less
                          orchestration is read-only (no workspace, no delivery).
    --connection=<id>     An MCP connection (UUID) that children may use. Repeatable. Omit for none.
    --budget-tier=TIER    STANDARD (default), LARGE or EPIC.
    --deliver=MODE        Default delivery for writers once a repository is attached: none (default),
                          branch or draft_pr.
    --idempotency-key=K   A retried launch with the same key returns the orchestration it made.
                          Without it, each call sends a new key.
    --wait                Follow the transcript until the orchestration waits, completes, is cancelled
                          or fails. Exit 2 if it was cancelled or failed.
    --follow              (messages) Keep polling every 3 seconds until the orchestration finishes.
    --json                Print the API's data as JSON. messages prints one JSON object per line.

  ENVIRONMENT
    AUTO_SWE_WEB_URL      Dashboard base URL for the links this prints (default: http://localhost:3000)

  Pending requests from the orchestrator are printed with the exact command to answer them.
`;

const POLL_SECONDS = 3;
/** About five hours of polling: longer than an orchestration's four-hour lifetime. */
const MAX_POLLS = 6000;
const BASE = '/api/v1/orchestrations';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(@\d+)?$/;
const BUDGETS: readonly string[] = ORCHESTRATION_BUDGET_TIERS;
const DELIVERIES: readonly string[] = AGENT_RUN_DELIVERIES;
const STATUSES: readonly string[] = ORCHESTRATION_STATUSES;
const TERMINAL: readonly string[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

/**
 * Plain sentences for the refusal codes a person can act on. Every code in
 * ORCHESTRATION_REFUSAL_CODES is here (a test enforces it); the rest are common gateway refusals.
 */
const REFUSAL_SENTENCES = new Map<string, string>([
  [
    'ALLOWLIST_REQUIRED',
    'No default agents are available to this team; pass at least one --agent=<key>.',
  ],
  [
    'AGENT_RUN_CONCURRENCY_EXCEEDED',
    'Too many agent runs are already running for this team or repository; try again when one finishes.',
  ],
  [
    'CHILD_LIMIT',
    'This orchestration has reached its limit on children; see the platform settings.',
  ],
  [
    'CHILD_NOT_ALLOWED',
    'That agent is not on this orchestration allowlist, or it is no longer launchable.',
  ],
  [
    'CONNECTION_NOT_IN_SET',
    'That agent needs an MCP connection that was not given to this orchestration with --connection.',
  ],
  [
    'PUSH_PERMISSION_REQUIRED',
    'A writer needs you to hold GitHub push permission on the repository.',
  ],
  ['REPO_REQUIRED', 'This step needs a repository, and this orchestration has none attached.'],
  [
    'ROLE_RULE_VIOLATED',
    'That child does not fit its role: a reader delivers nothing and has no path scopes; a writer needs a repository, a delivery mode and path scopes.',
  ],
  [
    'SCOPE_OVERLAP',
    'Those path scopes overlap a running writer; narrow them or wait for that writer to finish.',
  ],
  ['ORCHESTRATION_NOT_ACTIVE', 'This orchestration has ended.'],
  ['REPO_ALREADY_ATTACHED', 'A repository is already attached to this orchestration.'],
  ['ORCHESTRATION_DISABLED', 'Orchestrated runs are turned off on this platform.'],
  ['TEAM_REPO_MISMATCH', 'That repository is not owned by the team you named.'],
  ['NOT_LAUNCHER', 'Only the person who launched this orchestration can do that.'],
  [
    'NO_PENDING_ATTACH',
    'The orchestrator has not asked for a repository, so there is nothing to answer.',
  ],
  ['APPROVAL_NOT_PENDING', 'That approval is no longer pending: it was decided or it expired.'],
]);

/** Replace a known refusal's text with its plain sentence; any other error passes through. */
function plainRefusal(err: unknown): unknown {
  if (!(err instanceof GatewayError)) {
    return err;
  }
  const sentence = REFUSAL_SENTENCES.get(err.code);
  return sentence === undefined
    ? err
    : new GatewayError(err.statusCode, err.code, sentence, err.details);
}

function gw<T>(
  env: CliEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> {
  return apiRequest<T>(env, method, path, body, headers).catch((err: unknown) => {
    throw plainRefusal(err);
  });
}

function gwFull<T>(env: CliEnv, path: string): Promise<T> {
  return apiRequestFull<T>(env, 'GET', path).catch((err: unknown) => {
    throw plainRefusal(err);
  });
}

export async function runOrchestrateCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handler = COMMANDS.get(sub);
  if (!handler) {
    process.stderr.write(`Unknown subcommand: orchestrate ${sub}\n${SUB_HELP}`);
    return 1;
  }
  return runWithExitCodes(() => handler(rest, env));
}

type Handler = (args: string[], env: CliEnv) => Promise<number>;

const COMMANDS = new Map<string, Handler>([
  ['start', cmdStart],
  ['list', cmdList],
  ['show', cmdShow],
  ['messages', cmdMessages],
  ['say', cmdSay],
  ['steer', cmdSteer],
  ['cancel-agent', cmdCancelAgent],
  ['cancel', cmdCancel],
  ['end', cmdEnd],
  ['attach', cmdAttach],
  ['decline', cmdDecline],
  ['approve', (a, e) => cmdDecide(a, e, 'APPROVE')],
  ['deny', (a, e) => cmdDecide(a, e, 'DENY')],
]);

// ── Argument helpers ─────────────────────────────────────────────────────────

function usage(message: string): number {
  process.stderr.write(`${message}\nRun \`auto-swe orchestrate help\` for usage.\n`);
  return 1;
}

/** Lift boolean switches out first: `parseFlags` would take the next bare word as their value. */
function takeSwitches(
  args: string[],
  names: readonly string[]
): { args: string[]; on: Record<string, boolean> } {
  const on: Record<string, boolean> = {};
  const rest: string[] = [];
  for (const a of args) {
    const name = names.find((n) => a === `--${n}`);
    if (name === undefined) {
      rest.push(a);
    } else {
      on[name] = true;
    }
  }
  return { args: rest, on };
}

/** Collect every `--name=value` / `--name value` occurrence; `parseFlags` keeps only the last. */
function takeRepeated(
  args: string[],
  name: string
): { values: string[]; rest: string[]; error?: string } {
  const flag = `--${name}`;
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) {
      continue;
    }
    if (a === flag) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { error: `${flag} requires a value`, rest, values };
      }
      values.push(next);
      i++;
    } else if (a.startsWith(`${flag}=`)) {
      values.push(a.slice(flag.length + 1));
    } else {
      rest.push(a);
    }
  }
  return { rest, values };
}

function unknownFlag(flags: Record<string, string>, allowed: readonly string[]): string | null {
  const bad = Object.keys(flags).find((f) => !allowed.includes(f));
  return bad === undefined ? null : `Unknown flag: --${bad}`;
}

/** Positional ids are UUIDs; check them here so a typo fails before a round trip. */
function requireUuid(value: string | undefined, what: string): string | number {
  if (value === undefined || !UUID_RE.test(value)) {
    return usage(`${what} must be a UUID`);
  }
  return value;
}

function humanAct(): void {
  process.stderr.write('This is a human decision, recorded under your account.\n');
}

function dashboardUrl(id: string): string {
  const base = (process.env.AUTO_SWE_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/orchestrations/${id}`;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ── start ────────────────────────────────────────────────────────────────────

const START_FLAGS = ['repo', 'team', 'budget-tier', 'deliver', 'idempotency-key'];

async function cmdStart(rawArgs: string[], env: CliEnv): Promise<number> {
  const switches = takeSwitches(rawArgs, ['wait', 'json']);
  const agents = takeRepeated(switches.args, 'agent');
  const connections = takeRepeated(agents.rest, 'connection');
  const repeatError = agents.error ?? connections.error;
  if (repeatError !== undefined) {
    return usage(repeatError);
  }
  const { flags, positional } = parseFlags(connections.rest);
  const bare = missingValue(flags, ...START_FLAGS);
  if (bare) {
    return usage(`--${bare} requires a value`);
  }
  const unknown = unknownFlag(flags, START_FLAGS);
  if (unknown) {
    return usage(unknown);
  }
  if (positional.length !== 1) {
    return usage(
      positional.length === 0
        ? 'Missing task: pass it as one quoted argument'
        : 'Pass the task as one quoted argument'
    );
  }
  const task = (positional[0] ?? '').trim();
  if (!task) {
    return usage('The task is empty');
  }

  // No --agent: the gateway applies the platform's default allowlist.
  const allowlist = [...new Set(agents.values.map((a) => a.trim()))];
  const badAgent = allowlist.find((a) => !AGENT_KEY_RE.test(a));
  if (badAgent !== undefined) {
    return usage(`--agent "${badAgent}" is not an agent key (for example contentWriter or key@3)`);
  }
  const connectionIds = [...new Set(connections.values.map((c) => c.toLowerCase()))];
  const badConnection = connectionIds.find((c) => !UUID_RE.test(c));
  if (badConnection !== undefined) {
    return usage('--connection must be a connection UUID');
  }

  const budget = (flags['budget-tier'] ?? 'STANDARD').toUpperCase();
  if (!BUDGETS.includes(budget)) {
    return usage(`--budget-tier must be one of: ${BUDGETS.join(', ')}`);
  }
  const deliver = flags.deliver ?? 'none';
  if (!DELIVERIES.includes(deliver)) {
    return usage(`--deliver must be one of: ${DELIVERIES.join(', ')}`);
  }
  if (flags.repo === undefined && flags.team === undefined) {
    return usage(
      'Missing --team=<slug>: a repo-less orchestration needs the team that owns it (or pass --repo=<org/name>)'
    );
  }

  let repoId: string | undefined;
  if (flags.repo !== undefined) {
    const resolved = await resolveRepoId({ repo: flags.repo }, env);
    if (typeof resolved !== 'string') {
      return usage(resolved.error);
    }
    repoId = resolved;
  }
  let teamId: string | undefined;
  if (flags.team !== undefined) {
    const resolved = await resolveTeamIdBySlug(env, flags.team);
    if (!resolved) {
      return usage(`No team with slug "${flags.team}"`);
    }
    teamId = resolved;
  }
  if (switches.on.json && switches.on.wait) {
    return usage('--json and --wait cannot be combined');
  }

  const launched = await gw<OrchestrationLaunchResponse>(
    env,
    'POST',
    BASE,
    {
      ...(allowlist.length > 0 ? { allowlist } : {}),
      budgetTier: budget,
      ...(connectionIds.length > 0 ? { connectionIds } : {}),
      deliveryDefault: deliver,
      ...(repoId !== undefined ? { repoId } : {}),
      task,
      ...(teamId !== undefined ? { teamId } : {}),
    },
    { 'Idempotency-Key': flags['idempotency-key'] ?? randomUUID() }
  );

  if (switches.on.json) {
    process.stdout.write(`${JSON.stringify(launched)}\n`);
    return 0;
  }
  process.stdout.write(
    `Orchestration started.\n` +
      `  Orchestration: ${launched.orchestrationId}\n` +
      `  Status:        ${launched.status}\n` +
      (launched.allowlist
        ? `  Agents:        ${launched.allowlist.map((a) => agentLabel(a, launched.writeCapable)).join(', ') || '-'}${allowlist.length === 0 ? ' (platform default)' : ''}\n`
        : '') +
      `  Dashboard:     ${dashboardUrl(launched.orchestrationId)}\n`
  );
  if (!switches.on.wait) {
    process.stdout.write(
      `\nFollow the transcript with: auto-swe orchestrate messages ${launched.orchestrationId} --follow\n`
    );
    return 0;
  }
  process.stdout.write('\n');
  return follow(env, launched.orchestrationId, 'wait', false);
}

// ── Following a transcript ───────────────────────────────────────────────────

/** What one follow carries from the stream to the polling loop, so a fallback loses nothing. */
interface FollowState {
  announced: Set<string>;
  /** The transcript cursor: the last stream event id, which is the `next` the REST route returns. */
  cursor: string | undefined;
  lastStatus: string;
  /** Ids of messages already written, so a stream and a poll never print one twice. */
  printed: Set<string>;
}

/** Consecutive stream failures (after it had been established) before polling takes over. */
const STREAM_MAX_FAILURES = 5;
/** A bound on reconnects (the gateway ends a stream every 16 minutes): beyond an orchestration's life. */
const STREAM_MAX_CONNECTIONS = 1000;
const STREAM_BACKOFF_BASE_MS = 1000;
const STREAM_BACKOFF_MAX_MS = 30_000;
/** The exit code of a Ctrl-C while following: 128 + SIGINT. */
const EXIT_SIGINT = 130;

/**
 * Follow the orchestration and its transcript until it is finished. `wait` stops as soon as the
 * orchestration waits for a person (WAITING) and exits 2 when it was cancelled or failed; `follow`
 * stops only when it finishes. The server-sent event stream is used when the gateway offers it
 * and resumes from the last event id after a drop; when it is unavailable (a 429, a proxy that
 * does not stream, repeated failures) the same output comes from polling every few seconds.
 */
async function follow(
  env: CliEnv,
  id: string,
  mode: 'wait' | 'follow',
  json: boolean
): Promise<number> {
  const stop = mode === 'wait' ? [...TERMINAL, 'WAITING'] : TERMINAL;
  const state: FollowState = {
    announced: new Set(),
    cursor: undefined,
    lastStatus: '',
    printed: new Set(),
  };
  const streamed = await followStream(env, id, mode, json, stop, state);
  if (streamed !== null) {
    return streamed;
  }
  return followPoll(env, id, mode, json, stop, state);
}

/** Returns the exit code, or null when the stream is not usable and polling should take over. */
async function followStream(
  env: CliEnv,
  id: string,
  mode: 'wait' | 'follow',
  json: boolean,
  stop: readonly string[],
  state: FollowState
): Promise<number | null> {
  const ctl = new AbortController();
  let interrupted = false;
  // Ctrl-C closes the stream (freeing the gateway's per-user stream slot at once) and ends the
  // follow wherever it is waiting: the stream, a REST read in a batch, or the reconnect backoff.
  // The listener is persistent, so the FIRST Ctrl-C is the one that counts, and it is removed
  // in `finally`.
  let signalInterrupt: () => void = () => undefined;
  const interruptP = new Promise<'interrupted'>((resolve) => {
    signalInterrupt = () => resolve('interrupted');
  });
  const onSigint = () => {
    interrupted = true;
    ctl.abort();
    signalInterrupt();
  };
  process.on('SIGINT', onSigint);
  let failures = 0;
  try {
    for (let connection = 0; connection < STREAM_MAX_CONNECTIONS; connection++) {
      let exit: number | undefined;
      const cursorBefore = state.cursor;
      const consuming = consumeEventStream(env, `${BASE}/${id}/events`, {
        lastEventId: state.cursor,
        onBatch: async (events) => {
          let changed = false;
          for (const ev of events) {
            if (ev.id) {
              state.cursor = ev.id;
            }
            if (ev.event === 'message') {
              const message = parseJson<OrchestrationMessageDto>(ev.data);
              if (message && !state.printed.has(message.id)) {
                state.printed.add(message.id);
                writeMessage(message, json);
              }
            }
            changed = changed || ['message', 'child', 'status'].includes(ev.event);
          }
          if (!changed) {
            return false;
          }
          const detail = await gw<OrchestrationDetailDto>(env, 'GET', `${BASE}/${id}`);
          if (detail.status !== state.lastStatus) {
            state.lastStatus = detail.status;
            process.stderr.write(`[${detail.status}]\n`);
          }
          if (!json) {
            printPending(id, detail, state.announced);
          }
          if (stop.includes(detail.status)) {
            // Anything written before the status turned is read from the REST route once more.
            state.cursor = await printMessages(env, id, state.cursor, json, state.printed);
            exit = exitFor(mode, detail.status, id);
            return true;
          }
          return false;
        },
        signal: ctl.signal,
      });
      // An abandoned read (the user left while it was in flight) must not surface later.
      consuming.catch(() => undefined);
      const result = await Promise.race([consuming, interruptP]);
      if (exit !== undefined) {
        return exit;
      }
      if (result === 'interrupted') {
        return EXIT_SIGINT;
      }
      if (interrupted) {
        return EXIT_SIGINT;
      }
      if (result.kind === 'unavailable') {
        return null;
      }
      if (result.kind === 'done') {
        failures = 0;
        continue;
      }
      // A connection that moved the cursor made progress; one that only replayed did not.
      failures = state.cursor !== cursorBefore ? 1 : failures + 1;
      if (failures > STREAM_MAX_FAILURES) {
        return null;
      }
      const delay = Math.min(STREAM_BACKOFF_MAX_MS, STREAM_BACKOFF_BASE_MS * 2 ** (failures - 1));
      await Promise.race([
        sleep(Math.round(delay * (0.5 + Math.random() * 0.5)), ctl.signal),
        interruptP,
      ]);
      if (interrupted) {
        return EXIT_SIGINT;
      }
    }
    return null;
  } finally {
    process.off('SIGINT', onSigint);
    ctl.abort();
    signalInterrupt();
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Poll the orchestration and its transcript until it is finished. The detail is read before the
 * messages, so a status that turns terminal is never reported before the messages written before it.
 */
async function followPoll(
  env: CliEnv,
  id: string,
  mode: 'wait' | 'follow',
  json: boolean,
  stop: readonly string[],
  state: FollowState
): Promise<number> {
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const detail = await gw<OrchestrationDetailDto>(env, 'GET', `${BASE}/${id}`);
    if (detail.status !== state.lastStatus) {
      state.lastStatus = detail.status;
      process.stderr.write(`[${detail.status}]\n`);
    }
    state.cursor = await printMessages(env, id, state.cursor, json, state.printed);
    if (!json) {
      printPending(id, detail, state.announced);
    }
    if (stop.includes(detail.status)) {
      return exitFor(mode, detail.status, id);
    }
    await sleep(POLL_SECONDS * 1000);
  }
  process.stderr.write(
    `orchestrate: gave up following after several hours; check \`auto-swe orchestrate show ${id}\`\n`
  );
  return 1;
}

function exitFor(mode: 'wait' | 'follow', status: string, id: string): number {
  if (mode === 'follow') {
    return 0;
  }
  if (status === 'WAITING') {
    process.stdout.write(
      `\nThe orchestration is waiting for a person. Show it with: auto-swe orchestrate show ${id}\n`
    );
    return 0;
  }
  return status === 'COMPLETED' ? 0 : 2;
}

/** Print every message after `after`; returns the cursor to resume from. */
async function printMessages(
  env: CliEnv,
  id: string,
  after: string | undefined,
  json: boolean,
  printed?: Set<string>
): Promise<string | undefined> {
  let cursor = after;
  for (;;) {
    const query = cursor === undefined ? '' : `?after=${encodeURIComponent(cursor)}`;
    const page = await gwFull<OrchestrationMessagesPage>(env, `${BASE}/${id}/messages${query}`);
    for (const message of page.data) {
      if (printed?.has(message.id)) {
        continue;
      }
      printed?.add(message.id);
      writeMessage(message, json);
    }
    if (page.data.length === 0 || !page.next) {
      return cursor;
    }
    cursor = page.next;
  }
}

function writeMessage(message: OrchestrationMessageDto, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  const target = message.childId ? ` (child ${message.childId})` : '';
  process.stdout.write(`${message.role.toLowerCase()}${target}: ${clean(message.body)}\n`);
}

/** One notice per pending request, printed once. Commands are shown to the launcher only. */
function printPending(id: string, detail: OrchestrationDetailDto, announced: Set<string>): void {
  const attach = detail.pendingAttach;
  if (attach && !announced.has(`attach:${attach.messageId}`)) {
    announced.add(`attach:${attach.messageId}`);
    const name = attach.candidateRepoName ? clean(attach.candidateRepoName) : null;
    const lines = [
      `\nNeeds a person: the orchestrator asks to attach a repository${name ? `: ${name}` : ''}.`,
      `  Reason: ${clean(attach.reason)}`,
    ];
    lines.push(
      detail.canControl
        ? `  Attach:  auto-swe orchestrate attach ${id} --repo=${name ?? '<org/name>'}\n  Decline: auto-swe orchestrate decline ${id}`
        : '  Waiting for the launcher to attach or decline it.'
    );
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  for (const approval of detail.pendingApprovals) {
    if (announced.has(`approval:${approval.id}`)) {
      continue;
    }
    announced.add(`approval:${approval.id}`);
    process.stdout.write(`${approvalNotice(id, approval, detail.canControl)}\n`);
  }
}

function approvalNotice(id: string, a: OrchestrationApprovalDto, canControl: boolean): string {
  const connection = a.connectionName ? ` on ${clean(a.connectionName)}` : '';
  const head = `\nNeeds a person: an agent wants to run ${clean(a.toolName)}${connection}.\n  Arguments: ${clean(a.argumentsDigest)}\n  Expires:   ${a.expiresAt}`;
  return canControl
    ? `${head}\n  Approve: auto-swe orchestrate approve ${id} ${a.id}\n  Deny:    auto-swe orchestrate deny ${id} ${a.id}`
    : `${head}\n  Waiting for the launcher to decide.`;
}

// ── list / show / messages ───────────────────────────────────────────────────

async function cmdList(rawArgs: string[], env: CliEnv): Promise<number> {
  const switches = takeSwitches(rawArgs, ['json']);
  const { flags, positional } = parseFlags(switches.args);
  const bare = missingValue(flags, 'team', 'status');
  if (bare) {
    return usage(`--${bare} requires a value`);
  }
  const unknown = unknownFlag(flags, ['team', 'status']);
  if (unknown) {
    return usage(unknown);
  }
  if (positional.length > 0) {
    return usage(`Unexpected argument: ${positional[0] ?? ''}`);
  }
  const query = new URLSearchParams();
  if (flags.status !== undefined) {
    const status = flags.status.toUpperCase();
    if (!STATUSES.includes(status)) {
      return usage(`--status must be one of: ${STATUSES.join(', ')}`);
    }
    query.set('status', status);
  }
  if (flags.team !== undefined) {
    const teamId = await resolveTeamIdBySlug(env, flags.team);
    if (!teamId) {
      return usage(`No team with slug "${flags.team}"`);
    }
    query.set('teamId', teamId);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const page = await gwFull<{ data: OrchestrationSummaryDto[] }>(env, `${BASE}${suffix}`);
  if (switches.on.json) {
    process.stdout.write(`${JSON.stringify(page.data)}\n`);
    return 0;
  }
  if (page.data.length === 0) {
    process.stdout.write('No orchestrations.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('ID', 37)}${pad('STATUS', 11)}${pad('AGENTS', 9)}${pad('SPEND', 10)}${pad('REPOSITORY', 30)}TITLE\n`
  );
  for (const o of page.data) {
    process.stdout.write(
      `${pad(o.id, 37)}${pad(o.status, 11)}${pad(`${o.runningChildCount}/${o.childCount}`, 9)}${pad(money(o.costUsd), 10)}${pad(clean(o.repoName ?? '-'), 30)}${clean(o.title)}\n`
    );
  }
  return 0;
}

async function cmdShow(rawArgs: string[], env: CliEnv): Promise<number> {
  const switches = takeSwitches(rawArgs, ['json']);
  const { flags, positional } = parseFlags(switches.args);
  const unknown = unknownFlag(flags, []);
  if (unknown) {
    return usage(unknown);
  }
  if (positional.length !== 1) {
    return usage('Usage: orchestrate show <id> [--json]');
  }
  const id = requireUuid(positional[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  const detail = await gw<OrchestrationDetailDto>(env, 'GET', `${BASE}/${id}`);
  if (switches.on.json) {
    process.stdout.write(`${JSON.stringify(detail)}\n`);
    return 0;
  }
  process.stdout.write(renderDetail(detail));
  return 0;
}

/** An agent reference, marked when its effective agent can change files. */
function agentLabel(ref: string, writeCapable: readonly string[] | undefined): string {
  return writeCapable?.includes(ref) ? `${clean(ref)} (can change files)` : clean(ref);
}

function renderDetail(d: OrchestrationDetailDto): string {
  const lines: string[] = [];
  lines.push(clean(d.title));
  lines.push(`  Orchestration: ${d.id}`);
  lines.push(`  Status:        ${d.status}`);
  lines.push(`  Repository:    ${repositoryLine(d)}`);
  lines.push(`  Team:          ${d.teamName ? clean(d.teamName) : '-'}`);
  if (d.billing) {
    lines.push(
      `  Billing:       orchestrator turns to ${clean(d.billing.orchestratorTeamName ?? '-')}; children to ${clean(d.billing.childrenTeamName ?? '-')}`
    );
  }
  lines.push(`  Launched by:   ${d.launchedByName ? clean(d.launchedByName) : '-'}`);
  const b = d.budget;
  const used =
    b?.percentUsed != null && b.tokens
      ? `, ${b.percentUsed}% used (${b.tokens.used.toLocaleString('en-US')} of ${b.tokens.cap.toLocaleString('en-US')} ${b.tokens.kind} tokens)`
      : '';
  const remaining =
    b?.monthlyRemainingUsd != null ? `, ${money(b.monthlyRemainingUsd)} remaining this month` : '';
  lines.push(`  Budget:        ${d.budgetTier}${used}${remaining}`);
  lines.push(
    `  Spend:         ${money(d.cost.totalUsd)} (orchestrator ${money(d.cost.orchestratorUsd)}, children ${money(d.cost.childrenUsd)})`
  );
  lines.push(`  Allowlist:     ${d.allowlist.map(clean).join(', ') || '-'}`);
  lines.push(
    `  Connections:   ${d.connections.map((c) => clean(c.name ?? c.id)).join(', ') || '-'}`
  );
  lines.push('');

  if (d.children.length === 0) {
    lines.push('Agents: none yet.');
  } else {
    const running = d.children.filter((c) => c.status === 'RUNNING' || c.status === 'STARTING');
    lines.push(`Agents (${running.length} running of ${d.children.length}):`);
    lines.push(
      `${pad('CHILD ID', 37)}${pad('AGENT', 20)}${pad('ROLE', 26)}${pad('STATUS', 11)}${pad('SPEND', 10)}BRANCH / PR`
    );
    for (const c of d.children) {
      const role =
        c.role === 'WRITER'
          ? `writer${c.pathScopes.length > 0 ? ` ${c.pathScopes.map(clean).join(',')}` : ''}`
          : 'reader';
      lines.push(
        `${pad(c.id, 37)}${pad(clean(c.agentKey), 20)}${pad(role, 26)}${pad(c.status, 11)}${pad(money(c.costUsd), 10)}${clean(c.prUrl ?? c.branch ?? '-')}`
      );
    }
  }

  if (d.pendingAttach) {
    lines.push('');
    const name = d.pendingAttach.candidateRepoName ?? '<org/name>';
    lines.push(`Pending repository request: ${clean(name)}`);
    lines.push(`  Reason: ${clean(d.pendingAttach.reason)}`);
    lines.push(
      d.canControl
        ? `  Attach:  auto-swe orchestrate attach ${d.id} --repo=${clean(name)}\n  Decline: auto-swe orchestrate decline ${d.id}`
        : '  Waiting for the launcher to attach or decline it.'
    );
  }
  if (d.pendingApprovals.length > 0) {
    lines.push('');
    lines.push('Pending approvals:');
    for (const a of d.pendingApprovals) {
      lines.push(
        `  ${a.id}  ${clean(a.toolName)}${a.connectionName ? ` on ${clean(a.connectionName)}` : ''}  (expires ${a.expiresAt})`
      );
      if (d.canControl) {
        lines.push(
          `    approve: auto-swe orchestrate approve ${d.id} ${a.id}   deny: auto-swe orchestrate deny ${d.id} ${a.id}`
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function repositoryLine(d: OrchestrationDetailDto): string {
  if (d.repoId) {
    return `${clean(d.repoName ?? d.repoId)} (attached)`;
  }
  if (d.pendingAttach) {
    return `none; requested ${clean(d.pendingAttach.candidateRepoName ?? 'a repository')}`;
  }
  return 'none (read-only)';
}

async function cmdMessages(rawArgs: string[], env: CliEnv): Promise<number> {
  const switches = takeSwitches(rawArgs, ['follow', 'json']);
  const { flags, positional } = parseFlags(switches.args);
  const unknown = unknownFlag(flags, []);
  if (unknown) {
    return usage(unknown);
  }
  if (positional.length !== 1) {
    return usage('Usage: orchestrate messages <id> [--follow] [--json]');
  }
  const id = requireUuid(positional[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  if (switches.on.follow) {
    return follow(env, id, 'follow', switches.on.json === true);
  }
  await printMessages(env, id, undefined, switches.on.json === true);
  return 0;
}

// ── Talking to the orchestrator and its agents ───────────────────────────────

/** Parse `<id> ... "<text>"`: the ids before the text, and the text as one argument. */
function parseSend(
  args: string[],
  idCount: number,
  usageLine: string
): { ids: string[]; text: string } | string {
  const { flags, positional } = parseFlags(args);
  const unknown = unknownFlag(flags, []);
  if (unknown) {
    return unknown;
  }
  if (positional.length !== idCount + 1) {
    return usageLine;
  }
  const text = (positional[idCount] ?? '').trim();
  if (text.length === 0 || text.length > 4000) {
    return 'The message must be between 1 and 4000 characters';
  }
  return { ids: positional.slice(0, idCount), text };
}

async function cmdSay(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseSend(args, 1, 'Usage: orchestrate say <id> "<message>"');
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  await gw(env, 'POST', `${BASE}/${id}/messages`, { body: parsed.text });
  process.stdout.write('Message sent to the orchestrator.\n');
  return 0;
}

async function cmdSteer(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseSend(args, 2, 'Usage: orchestrate steer <id> <childId> "<message>"');
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  const childId = requireUuid(parsed.ids[1], 'Child id');
  if (typeof childId !== 'string') {
    return childId;
  }
  await gw(env, 'POST', `${BASE}/${id}/children/${childId}/messages`, { body: parsed.text });
  process.stdout.write(
    `Steering message queued for child ${childId}. It is delivered at the agent's next step.\n`
  );
  return 0;
}

/** Parse `<id> [<childId>]` with no text, for the one-id and two-id commands. */
function parseIds(args: string[], count: number, usageLine: string): { ids: string[] } | string {
  const { flags, positional } = parseFlags(args);
  const unknown = unknownFlag(flags, []);
  if (unknown) {
    return unknown;
  }
  if (positional.length !== count) {
    return usageLine;
  }
  return { ids: positional };
}

async function cmdCancelAgent(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseIds(args, 2, 'Usage: orchestrate cancel-agent <id> <childId>');
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  const childId = requireUuid(parsed.ids[1], 'Child id');
  if (typeof childId !== 'string') {
    return childId;
  }
  await gw(env, 'POST', `${BASE}/${id}/children/${childId}/cancel`);
  process.stdout.write(`Cancel requested for child ${childId}.\n`);
  return 0;
}

async function cmdCancel(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseIds(args, 1, 'Usage: orchestrate cancel <id>');
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  await gw(env, 'POST', `${BASE}/${id}/cancel`);
  process.stdout.write('Cancel requested. Running agents are cancelled; pushed branches stay.\n');
  return 0;
}

async function cmdEnd(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseIds(args, 1, 'Usage: orchestrate end <id>');
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  await gw(env, 'POST', `${BASE}/${id}/end`);
  process.stdout.write('Orchestration ended.\n');
  return 0;
}

// ── Human acts ───────────────────────────────────────────────────────────────

async function cmdAttach(args: string[], env: CliEnv): Promise<number> {
  const { flags, positional } = parseFlags(args);
  const bare = missingValue(flags, 'repo', 'repo-id');
  if (bare) {
    return usage(`--${bare} requires a value`);
  }
  const unknown = unknownFlag(flags, ['repo', 'repo-id']);
  if (unknown) {
    return usage(unknown);
  }
  if (positional.length !== 1) {
    return usage('Usage: orchestrate attach <id> --repo=<org/name>');
  }
  const id = requireUuid(positional[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  if (flags.repo === undefined && flags['repo-id'] === undefined) {
    return usage('Missing required flag: --repo=<org/name>');
  }
  const repoId = await resolveRepoId(flags, env);
  if (typeof repoId !== 'string') {
    return usage(repoId.error);
  }
  humanAct();
  await gw(env, 'POST', `${BASE}/${id}/attach`, { repoId });
  process.stdout.write(
    'Repository attached. Writers and delivery are available now; children started from here bill its owning team.\n'
  );
  return 0;
}

async function cmdDecline(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseIds(args, 1, 'Usage: orchestrate decline <id>');
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  humanAct();
  await gw(env, 'POST', `${BASE}/${id}/attach/decline`);
  process.stdout.write('Repository request declined. The orchestration stays repo-less.\n');
  return 0;
}

async function cmdDecide(
  args: string[],
  env: CliEnv,
  decision: 'APPROVE' | 'DENY'
): Promise<number> {
  const verb = decision === 'APPROVE' ? 'approve' : 'deny';
  const parsed = parseIds(args, 2, `Usage: orchestrate ${verb} <id> <approvalId>`);
  if (typeof parsed === 'string') {
    return usage(parsed);
  }
  const id = requireUuid(parsed.ids[0], 'Orchestration id');
  if (typeof id !== 'string') {
    return id;
  }
  const approvalId = requireUuid(parsed.ids[1], 'Approval id');
  if (typeof approvalId !== 'string') {
    return approvalId;
  }
  humanAct();
  await gw(env, 'POST', `${BASE}/${id}/approvals/${approvalId}`, { decision });
  process.stdout.write(
    decision === 'APPROVE'
      ? `Approved. The held call (${approvalId}) runs once.\n`
      : `Denied. The agent gets an error for that call and it does not run.\n`
  );
  return 0;
}
