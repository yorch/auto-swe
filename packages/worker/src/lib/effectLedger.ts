import { createHash } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { TicketFailureClass } from '@auto-swe/shared/lib/integrations/ticketFailure';
import {
  RUN_EFFECT_DETAIL_MAX_CHARS,
  RUN_EFFECT_ERROR_MAX_CHARS,
  type RunEffectKind,
  type RunEffectStatus,
  type RunEffectVia,
} from '@auto-swe/shared/lib/runEffects';
import { activityInfo } from '@temporalio/activity';
import { currentWorkflowRunId } from './activityContext.js';
import { logWarn } from './activityLog.js';
import { currentNodeTag } from './activityNodeTag.js';
import { redactJsonValues, redactString } from './agentTracer.js';
import { getErrorMessage } from './errors.js';
import { currentSpendOwner } from './spendOwner.js';

/** A write must not hold up the tool call or step that it records. */
const WRITE_TIMEOUT_MS = 5_000;
const TARGET_MAX_CHARS = 500;
const ACTION_MAX_CHARS = 200;

export interface EffectInput {
  kind: RunEffectKind;
  /** What was done: an MCP tool name, `create`, `update`, `push`, `transition`. */
  action: string;
  /** External id, URL, branch or tool name. */
  target?: string | null;
  status: RunEffectStatus;
  via: RunEffectVia;
  /** The call's raw input. Only a digest of its redacted form is stored. */
  input?: unknown;
  /** A small summary (PR number, branch, head sha); redacted and capped. */
  detail?: Record<string, unknown>;
  /** A failure; its message is redacted and capped. */
  error?: unknown;
  agentKey?: string | null;
}

/**
 * Whether the remote server declared the MCP tool read-only (`readOnlyHint`). Takes a Mastra tool
 * (annotations under `mcp`) or an MCP SDK `Tool` (annotations on the tool). Absent means unknown,
 * and unknown is treated as a mutation.
 */
export function mcpToolIsReadOnly(tool: unknown): boolean {
  const t = tool as
    | {
        annotations?: { readOnlyHint?: boolean };
        mcp?: { annotations?: { readOnlyHint?: boolean } };
      }
    | undefined;
  return (t?.mcp?.annotations ?? t?.annotations)?.readOnlyHint === true;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/** Sorted-key JSON, so the same input always digests the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** SHA-256 of the canonical, redacted input; null when there is none or it cannot be serialized. */
function digestOf(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  try {
    return createHash('sha256')
      .update(canonical(redactJsonValues(input)))
      .digest('hex');
  } catch {
    return null;
  }
}

function summaryOf(detail: Record<string, unknown> | undefined): object | null {
  if (!detail) {
    return null;
  }
  try {
    const redacted = redactJsonValues(detail) as object;
    const text = JSON.stringify(redacted);
    return text.length <= RUN_EFFECT_DETAIL_MAX_CHARS
      ? redacted
      : { preview: text.slice(0, RUN_EFFECT_DETAIL_MAX_CHARS), truncated: true };
  } catch {
    return null;
  }
}

function currentWorkflowIdOrUndefined(): string | undefined {
  try {
    return activityInfo().workflowExecution?.workflowId;
  } catch {
    return undefined;
  }
}

async function write(effect: EffectInput): Promise<void> {
  const workflowId = currentWorkflowIdOrUndefined();
  if (!workflowId) {
    logWarn('run effect not recorded: no workflow context', {
      action: effect.action,
      kind: effect.kind,
    });
    return;
  }
  const [runId, owner] = await Promise.all([currentWorkflowRunId(), currentSpendOwner()]);
  await prisma.runEffect.create({
    data: {
      action: cap(redactString(effect.action), ACTION_MAX_CHARS),
      agentKey: effect.agentKey ?? null,
      detail: (summaryOf(effect.detail) ?? undefined) as never,
      error:
        effect.error === undefined
          ? null
          : cap(redactString(getErrorMessage(effect.error)), RUN_EFFECT_ERROR_MAX_CHARS),
      inputDigest: digestOf(effect.input),
      kind: effect.kind,
      orgId: owner.orgId ?? null,
      runId: runId ?? null,
      specNodeId: currentNodeTag()?.specNodeId ?? null,
      status: effect.status,
      target: effect.target ? cap(redactString(effect.target), TARGET_MAX_CHARS) : null,
      teamId: owner.teamId ?? null,
      via: effect.via,
      workflowId,
    },
  });
}

/**
 * Records one change a run made outside the sandbox. Best effort, like trace persistence: it never
 * throws and never fails or meaningfully delays its caller, so a lost write costs a row, not the
 * step. Input is stored as a digest only; detail and error are redacted and capped. Outside an
 * activity there is no workflow to attach to, so nothing is written.
 */
export async function recordEffect(effect: EffectInput): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      write(effect),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), WRITE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch (err) {
    try {
      logWarn('run effect could not be recorded', {
        action: effect.action,
        error: getErrorMessage(err),
        kind: effect.kind,
      });
    } catch {
      // Even a failing logger must not fail the caller.
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records the outcome of a best-effort tracker sync. `failure` is what `syncTrackerOnEvent`
 * resolves: the class of the first write the tracker refused, or null when it refused none.
 * `wrote` is whether anything reached the ticket (`SyncTrackerOptions.onOutcome`). A failure
 * records `FAILED`; no failure and a write records `DONE`; no failure and no write (a GitHub
 * `workflow_started`, a Jira or Linear issue already in the target status) records `SKIPPED`. A caller that could not learn `wrote` (undefined) is taken to
 * have written. A result a caller did not get (a mocked or absent one, `undefined`) records
 * nothing.
 */
export function recordTrackerSync(
  event: { issueId: string; type: string },
  failure: TicketFailureClass | null | undefined,
  wrote?: boolean
): Promise<void> {
  if (failure === undefined) {
    return Promise.resolve();
  }
  return recordEffect({
    action: `sync:${event.type}`,
    error: failure ?? undefined,
    input: event,
    kind: 'TRACKER',
    status: failure ? 'FAILED' : wrote === false ? 'SKIPPED' : 'DONE',
    target: event.issueId,
    via: 'activity',
  });
}

/**
 * Runs a `git push` and records it, failure included, then returns or rethrows exactly what the
 * push did. `headSha` is the commit pushed when the caller knows it.
 */
export async function recordGitPush<T>(
  branch: string,
  headSha: string | null | undefined,
  push: () => Promise<T>
): Promise<T> {
  const effect = {
    action: 'push',
    detail: headSha ? { headSha } : undefined,
    kind: 'GIT_PUSH',
    target: branch,
    via: 'activity',
  } as const;
  try {
    const result = await push();
    await recordEffect({ ...effect, status: 'DONE' });
    return result;
  } catch (err) {
    await recordEffect({ ...effect, error: err, status: 'FAILED' });
    throw err;
  }
}
