/**
 * Launcher approval for the MCP tool calls an orchestration's agents make (spec section 7).
 *
 * One guard, bound to a run's connection target, is consulted by all three MCP binding points (the
 * Mastra wrapper in `agents/mcpTools.ts`, the harness relay in `agents/harness/mcpRelay.ts`, which
 * Claude Code and Pi both call through). A tool that does not declare `readOnlyHint: true` is a
 * write: it does not run until the launcher approves the one call, and a denial, a timeout or any
 * failure to find out is a refusal. A run that belongs to no orchestration gets no guard at all, so
 * its calls are untouched.
 *
 * Nothing here stores or logs an argument value: the approval row carries a digest of names, types
 * and sizes only.
 */
import { createHash } from 'node:crypto';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { isReadOnlyMcpTool } from '@auto-swe/shared/lib/orchestration';
import { heartbeat } from '@temporalio/activity';
import type { McpTracer } from '../agents/mcpTools.js';
import { logWarn } from './activityLog.js';
import { redactString } from './agentTracer.js';
import type { McpConnectionTarget } from './config/mcpConnection.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Largest result kept with an approval so a retried activity can return it. */
const MAX_OUTCOME_CHARS = 200_000;
const DIGEST_MAX_CHARS = 500;
const DIGEST_MAX_ARGS = 20;
const DIGEST_NAME_MAX_CHARS = 40;

export interface McpGuardCall {
  toolName: string;
  /** The model's arguments. Only their shape is ever stored. */
  args: unknown;
  /** The tool's MCP annotations as listed by the server; `undefined` when not visible. */
  annotations: unknown;
  signal?: AbortSignal;
}

export type McpGuardOutcome<T> =
  | { ran: true; value: T; replayed?: boolean }
  | { ran: false; message: string };

export interface McpApprovalGuard {
  /**
   * Runs `exec` when the call may run: at once for a read-only tool, after the launcher approves
   * for anything else. When it may not, `exec` is never called and `message` is the tool error for
   * the agent. A throw from `exec` propagates.
   */
  run<T>(call: McpGuardCall, exec: () => Promise<T>): Promise<McpGuardOutcome<T>>;
}

export interface McpApprovalOptions {
  /** The run (WorkflowRun id) the calls belong to. */
  runId: string;
  /** The connection the target was resolved from. */
  connectionId: string | undefined;
  tracer?: McpTracer;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Injectable for tests; resolves early (never rejects) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** JSON with object keys sorted, so equal arguments always serialise equally. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') {
      return `${v}n`;
    }
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
      return null;
    }
    if (typeof v !== 'object' || v === null) {
      return v;
    }
    if (seen.has(v)) {
      return '[circular]';
    }
    seen.add(v);
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return `string(${value.length})`;
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === 'object') {
    return `object(${Object.keys(value).length} keys)`;
  }
  return typeof value;
}

/**
 * The argument names with the type and size of each value, truncated. Never a value: the digest is
 * stored on the approval row and shown to the launcher, and an argument is where a credential or a
 * private record would be.
 */
export function redactedArgumentsDigest(args: unknown): string {
  let digest: string;
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    const keys = Object.keys(args);
    const parts = keys.slice(0, DIGEST_MAX_ARGS).map((key) => {
      const name = key.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, DIGEST_NAME_MAX_CHARS);
      let described: string;
      try {
        described = describeValue((args as Record<string, unknown>)[key]);
      } catch {
        described = 'unreadable';
      }
      return `${name}: ${described}`;
    });
    if (keys.length > DIGEST_MAX_ARGS) {
      parts.push(`+${keys.length - DIGEST_MAX_ARGS} more`);
    }
    digest = parts.length > 0 ? parts.join(', ') : '(no arguments)';
  } else {
    digest = args === undefined ? '(no arguments)' : describeValue(args);
  }
  const redacted = redactString(digest);
  return redacted.length > DIGEST_MAX_CHARS ? `${redacted.slice(0, DIGEST_MAX_CHARS)}…` : redacted;
}

/** The identity of one call within a run; see {@link createMcpApprovalGuard}. */
export function mcpCallKey(
  runId: string,
  toolName: string,
  args: unknown,
  ordinal: number
): string {
  return `mcp-${sha256(canonicalJson([runId, toolName, canonicalJson(args), ordinal]))}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function pumpHeartbeat(): void {
  try {
    heartbeat('waiting for MCP write approval');
  } catch {
    // No activity context (unit tests, a call outside an activity): nothing to keep alive.
  }
}

// ── Messages for the agent ───────────────────────────────────────────────────

const refusal = (toolName: string, why: string): string =>
  `The MCP tool call '${toolName}' was not run: ${why} Do not retry the same call; continue without it or tell the user what you could not do.`;

const DENIED = (tool: string) => refusal(tool, 'the launcher denied it.');
const EXPIRED = (tool: string) => refusal(tool, 'the launcher did not answer in time.');
const NO_APPROVER = (tool: string) =>
  refusal(tool, 'this orchestration has no person who can approve a write.');
const UNCHECKED = (tool: string) =>
  refusal(tool, 'its approval could not be checked, and an unchecked write is never run.');
const NOT_ALLOWED = (tool: string) =>
  refusal(tool, "its connection is not in this orchestration's set.");
const STOPPED = (tool: string) => refusal(tool, 'the run stopped while it waited for approval.');
const ALREADY_STARTED = (tool: string) =>
  refusal(tool, 'an earlier attempt may already have run it, and a write is never run twice.');

// ── The guard ────────────────────────────────────────────────────────────────

interface OrchestrationFacts {
  teamId: string;
  launchedById: string | null;
  connectionIds: string[];
}

/** A write's result, or the error the tool itself threw (kept apart from a failed approval). */
type Settled<T> = McpGuardOutcome<T> | { threw: true; error: unknown };

type ApprovalRow = {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  expiresAt: Date;
  outcome?: unknown;
};

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

class DenyAllGuard implements McpApprovalGuard {
  constructor(private readonly tracer?: McpTracer) {}
  async run<T>(call: McpGuardCall): Promise<McpGuardOutcome<T>> {
    this.tracer?.addActivityEvent({
      name: 'mcp.write_denied',
      outputJson: { reason: 'unchecked', toolName: call.toolName },
    });
    return { message: UNCHECKED(call.toolName), ran: false };
  }
}

class OrchestrationGuard implements McpApprovalGuard {
  private readonly ordinals = new Map<string, number>();
  constructor(
    private readonly orchestrationId: string,
    private readonly facts: OrchestrationFacts,
    private readonly childId: string | null,
    private readonly connectionName: string,
    private readonly opts: McpApprovalOptions
  ) {}

  private event(name: string, outputJson: Record<string, unknown>): void {
    this.opts.tracer?.addActivityEvent({ name, outputJson });
  }

  private deny<T>(toolName: string, reason: string, message: string): McpGuardOutcome<T> {
    this.event('mcp.write_denied', { reason, toolName });
    return { message, ran: false };
  }

  async run<T>(call: McpGuardCall, exec: () => Promise<T>): Promise<McpGuardOutcome<T>> {
    const { toolName } = call;
    const connectionId = this.opts.connectionId;
    // Defence in depth behind the gateway's check at spawn: the connection must be in the set.
    if (!connectionId || !this.facts.connectionIds.includes(connectionId)) {
      return this.deny(toolName, 'connection_not_in_set', NOT_ALLOWED(toolName));
    }
    if (isReadOnlyMcpTool(call.annotations)) {
      return { ran: true, value: await exec() };
    }
    // The ordinal is taken before anything is awaited, so parallel identical calls are numbered in
    // the order they were issued, and a retried attempt that issues them again numbers them alike.
    const identity = sha256(canonicalJson([toolName, canonicalJson(call.args)]));
    const ordinal = this.ordinals.get(identity) ?? 0;
    this.ordinals.set(identity, ordinal + 1);

    if (this.facts.launchedById === null) {
      return this.deny(toolName, 'no_approver', NO_APPROVER(toolName));
    }
    let settled: Settled<T>;
    try {
      settled = await this.runWrite(call, ordinal, exec);
    } catch {
      logWarn('mcp write approval failed closed', { tool: toolName });
      return this.deny(toolName, 'unchecked', UNCHECKED(toolName));
    }
    if ('threw' in settled) {
      throw settled.error;
    }
    return settled;
  }

  private async runWrite<T>(
    call: McpGuardCall,
    ordinal: number,
    exec: () => Promise<T>
  ): Promise<Settled<T>> {
    const { toolName } = call;
    const callKey = mcpCallKey(this.opts.runId, toolName, call.args, ordinal);
    const now = this.opts.now ?? Date.now;
    const signal = call.signal ?? this.opts.signal;

    let row = (await prisma.orchestrationApproval.findUnique({
      where: { orchestrationId_callKey: { callKey, orchestrationId: this.orchestrationId } },
    })) as ApprovalRow | null;

    if (!row) {
      const seconds = await resolveSetting('orchestration.approvalTimeoutSeconds', {
        teamId: this.facts.teamId,
      });
      row = await this.open(call, callKey, new Date(now() + seconds * 1000));
    }

    if (row.status === 'PENDING') {
      row = await this.wait(row, toolName, signal);
      if (!row) {
        return this.deny(toolName, 'stopped', STOPPED(toolName));
      }
    }
    if (row.status === 'DENIED') {
      return this.deny(toolName, 'denied', DENIED(toolName));
    }
    if (row.status === 'EXPIRED') {
      return this.deny(toolName, 'expired', EXPIRED(toolName));
    }
    return this.execute(row, toolName, exec);
  }

  /** Creates the approval and its request message together, or reads the winner of a race. */
  private async open(call: McpGuardCall, callKey: string, expiresAt: Date): Promise<ApprovalRow> {
    const argumentsDigest = redactedArgumentsDigest(call.args);
    try {
      return (await prisma.$transaction(async (tx) => {
        const created = await tx.orchestrationApproval.create({
          data: {
            argumentsDigest,
            callKey,
            childId: this.childId,
            connectionId: this.opts.connectionId as string,
            expiresAt,
            orchestrationId: this.orchestrationId,
            runId: this.opts.runId,
            toolName: call.toolName,
          },
        });
        await tx.orchestrationMessage.create({
          data: {
            body: '',
            childId: this.childId,
            kind: 'APPROVAL_REQUEST',
            orchestrationId: this.orchestrationId,
            payload: {
              approvalId: created.id,
              argumentsDigest,
              connectionName: this.connectionName,
              expiresAt: expiresAt.toISOString(),
              toolName: call.toolName,
            },
            role: 'SYSTEM',
          },
        });
        return created;
      })) as ApprovalRow;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const existing = (await prisma.orchestrationApproval.findUnique({
        where: {
          orchestrationId_callKey: { callKey, orchestrationId: this.orchestrationId },
        },
      })) as ApprovalRow | null;
      if (!existing) {
        throw err;
      }
      return existing;
    }
  }

  /** Polls until the row leaves PENDING; null when the run stops first. */
  private async wait(
    first: ApprovalRow,
    toolName: string,
    signal: AbortSignal | undefined
  ): Promise<ApprovalRow | null> {
    const interval = this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = this.opts.sleep ?? defaultSleep;
    const now = this.opts.now ?? Date.now;
    let row = first;
    for (;;) {
      if (row.status !== 'PENDING') {
        return row;
      }
      if (now() >= new Date(row.expiresAt).getTime()) {
        // Compare-and-set: a decision that landed first stands.
        await prisma.orchestrationApproval.updateMany({
          data: { decidedAt: new Date(now()), status: 'EXPIRED' },
          where: { id: row.id, status: 'PENDING' },
        });
        const settled = (await prisma.orchestrationApproval.findUnique({
          where: { id: row.id },
        })) as ApprovalRow | null;
        if (!settled) {
          throw new Error(`approval for ${toolName} vanished`);
        }
        return settled.status === 'PENDING' ? { ...settled, status: 'EXPIRED' } : settled;
      }
      if (signal?.aborted) {
        return null;
      }
      pumpHeartbeat();
      await sleep(interval, signal);
      if (signal?.aborted) {
        return null;
      }
      const next = (await prisma.orchestrationApproval.findUnique({
        where: { id: row.id },
      })) as ApprovalRow | null;
      if (!next) {
        throw new Error(`approval for ${toolName} vanished`);
      }
      row = next;
    }
  }

  /** Runs an approved call once; a retried attempt finds what the first one did. */
  private async execute<T>(
    row: ApprovalRow,
    toolName: string,
    exec: () => Promise<T>
  ): Promise<Settled<T>> {
    const recorded = row.outcome as { state?: string; value?: unknown; message?: string } | null;
    if (recorded && typeof recorded === 'object' && recorded.state) {
      if (recorded.state === 'DONE' && 'value' in recorded) {
        return { ran: true, replayed: true, value: recorded.value as T };
      }
      if (recorded.state === 'DONE') {
        return {
          message: refusal(
            toolName,
            'it already ran on an earlier attempt and its result was not kept.'
          ),
          ran: false,
        };
      }
      // STARTED (an attempt died mid-call) or FAILED: never run a write a second time.
      return { message: ALREADY_STARTED(toolName), ran: false };
    }
    // The marker is written first, so a crash between here and the result is seen as STARTED.
    await prisma.orchestrationApproval.update({
      data: { outcome: { state: 'STARTED' } },
      where: { id: row.id },
    });
    this.event('mcp.write_approved', { approvalId: row.id, toolName });
    let value: T;
    try {
      value = await exec();
    } catch (err) {
      await this.record(row.id, { state: 'FAILED' });
      return { error: err, threw: true };
    }
    await this.record(row.id, this.outcomeOf(value));
    return { ran: true, value };
  }

  private outcomeOf(value: unknown): Record<string, unknown> {
    try {
      const text = JSON.stringify(value);
      if (text !== undefined && text.length <= MAX_OUTCOME_CHARS) {
        return { state: 'DONE', value: JSON.parse(text) };
      }
    } catch {
      // Not serialisable: fall through to a result-less record.
    }
    return { state: 'DONE' };
  }

  /** Best effort: the call has already run, so a failure to record it must not undo that. */
  private async record(id: string, outcome: Record<string, unknown>): Promise<void> {
    try {
      await prisma.orchestrationApproval.update({
        data: { outcome: outcome as never },
        where: { id },
      });
    } catch {
      logWarn('mcp write outcome could not be recorded', { approvalId: id });
    }
  }
}

/**
 * The guard for a run, or `null` when the run belongs to no orchestration (its calls are then
 * untouched). A lookup that fails, a missing orchestration or a run row that does not say what it
 * belongs to when the caller knows it must (`expectOrchestrated`) yields a guard that refuses
 * every call.
 *
 * A write's `callKey` is a hash of the run, the tool, the canonical arguments and the ordinal of
 * the call among identical ones, because neither the relay nor Pi sees the model's tool-call id and
 * a retried activity's model issues new ids anyway.
 */
export async function createMcpApprovalGuard(
  opts: McpApprovalOptions & { expectOrchestrated?: boolean }
): Promise<McpApprovalGuard | null> {
  try {
    const run = await prisma.workflowRun.findUnique({
      select: { orchestrationId: true },
      where: { id: opts.runId },
    });
    const orchestrationId = run?.orchestrationId ?? null;
    if (!orchestrationId) {
      return opts.expectOrchestrated ? new DenyAllGuard(opts.tracer) : null;
    }
    const orchestration = await prisma.orchestration.findUnique({
      select: { connectionIds: true, launchedById: true, teamId: true },
      where: { id: orchestrationId },
    });
    if (!orchestration) {
      return new DenyAllGuard(opts.tracer);
    }
    let childId: string | null = null;
    let connectionName = 'MCP connection';
    try {
      const child = await prisma.orchestrationChild.findFirst({
        select: { id: true },
        where: { orchestrationId, runId: opts.runId },
      });
      childId = child?.id ?? null;
      if (opts.connectionId) {
        const conn = await prisma.connection.findUnique({
          select: { name: true },
          where: { id: opts.connectionId },
        });
        connectionName = conn?.name || connectionName;
      }
    } catch {
      // Labels only: the approval still works without them.
    }
    return new OrchestrationGuard(orchestrationId, orchestration, childId, connectionName, opts);
  } catch {
    logWarn('mcp approval guard could not be built; MCP calls are refused', { runId: opts.runId });
    return new DenyAllGuard(opts.tracer);
  }
}

/**
 * Attaches the run's approval guard to its resolved MCP target, in place (the target's credential
 * properties are not enumerable, so a copy would drop them). A run that belongs to no orchestration
 * returns the target as it was. `run` is the WorkflowRun id; pass `expectOrchestrated` when the
 * caller already knows the run belongs to one.
 */
export async function withMcpApproval(
  target: McpConnectionTarget | null,
  opts: Omit<McpApprovalOptions, 'connectionId'> & { expectOrchestrated?: boolean }
): Promise<McpConnectionTarget | null> {
  if (!target) {
    return target;
  }
  const guard = await createMcpApprovalGuard({ ...opts, connectionId: target.connectionId });
  if (!guard) {
    return target;
  }
  return Object.assign(target, { approval: guard });
}
