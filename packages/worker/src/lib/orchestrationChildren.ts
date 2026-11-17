import { prisma } from '@auto-swe/shared/db';
import { getArtifactStream } from '@auto-swe/shared/lib/artifactStore';
import {
  CHILD_RESULT_MAX_CHARS,
  type ChildResult,
  ChildResultSchema,
  orchestrationWorkflowId,
} from '@auto-swe/shared/lib/orchestration';
import { CONTEXT_OVERFLOW_KIND } from '../activities/contextOverflow.js';
import { logWarn } from './activityLog.js';
import { redactString } from './agentTracer.js';
import { writeNotice } from './orchestrationState.js';
import { getTemporalClient } from './temporalClient.js';

/**
 * A child agent run reaching a terminal state: build its one structured `ChildResult` from the
 * run, store it on the `OrchestrationChild`, leave a `CHILD_RESULT` message for the page, and tell
 * the orchestrator workflow with a `childFinished` signal.
 *
 * The signal is best-effort — a failure must never fail the run — and the workflow's polling
 * backstop (`refreshOrchestrationChildren`) reports any finished child whose result no turn has
 * read yet, so a lost signal strands nothing.
 */

const MAX_FILES = 500;

type RunStatus = 'SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED' | 'CANCELLED' | string;

function childStatus(status: RunStatus): ChildResult['status'] {
  if (status === 'SUCCESS' || status === 'SKIPPED') {
    return 'COMPLETED';
  }
  return status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}

/** Only an https URL is stored: the page links it and the orchestrator reads it. */
function httpsUrl(value: unknown): string | undefined {
  const raw = str(value, 1000);
  if (!raw) {
    return undefined;
  }
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const GATE_FAILURE_RE = /gate|PATH_OUT_OF_SCOPE|security/i;

/**
 * The text of a run's result, when the run's context snapshot replaced it with an artifact
 * placeholder (a string over the snapshot's inline limit is stored as an artifact): the text read
 * back, or the placeholder with the fact that it could not be read.
 */
export type ResolvedResultText = { text: string } | { unreadable: string };

export interface BuiltChildResult {
  result: ChildResult;
  /** Field paths of the run output that did not match the result contract; empty when it did. */
  issues: string[];
}

/**
 * The result of a finished agent run. `snapshot` is the run's context snapshot (its `result` is
 * the terminate node's output); `failure` is the error of its failed step. Redacted and truncated.
 * Never throws: output that does not match the contract becomes a FAILED result that says so.
 */
export function buildChildResultWithIssues(input: {
  status: RunStatus;
  snapshot: unknown;
  costUsd: number;
  failure?: string | null;
  resolvedText?: ResolvedResultText;
}): BuiltChildResult {
  const status = childStatus(input.status);
  const result = asRecord(asRecord(input.snapshot)?.result) ?? {};
  const snapshotError = str(asRecord(input.snapshot)?.error, 2000);
  const failure = input.failure ?? snapshotError;
  const costUsd = Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0;

  const placeholder = str(result.text, CHILD_RESULT_MAX_CHARS);
  const resolved = input.resolvedText;
  const text =
    resolved && 'text' in resolved
      ? str(resolved.text, CHILD_RESULT_MAX_CHARS)
      : resolved
        ? `${resolved.unreadable} (the full text is stored as an artifact on the run but could not be read here)`
        : placeholder;
  const summarySource =
    text ??
    (status === 'COMPLETED'
      ? ''
      : status === 'CANCELLED'
        ? 'The run was cancelled.'
        : `The run failed${failure ? `: ${failure}` : '.'}`);

  const files = Array.isArray(result.filesChanged) ? result.filesChanged.slice(0, MAX_FILES) : [];
  const filesChanged = files.flatMap((f) => {
    const rec = asRecord(f);
    const path = str(rec?.path, 1000);
    return path
      ? [{ added: nonNegInt(rec?.linesAdded), path, removed: nonNegInt(rec?.linesRemoved) }]
      : [];
  });

  const gateValue = result.gate;
  const gate =
    gateValue === 'passed' || gateValue === 'no_changes' || gateValue === 'not_applicable'
      ? gateValue
      : status === 'FAILED' && failure && GATE_FAILURE_RE.test(failure)
        ? ('failed' as const)
        : undefined;

  const stopped = result.stoppedReason;
  const parsed = ChildResultSchema.safeParse({
    branch: str(result.branch, 300),
    costUsd,
    filesChanged,
    gate,
    prUrl: httpsUrl(result.prUrl),
    status,
    stoppedReason: stopped === 'max_steps' || stopped === 'wall_clock' ? stopped : undefined,
    summary: redactString(summarySource).slice(0, CHILD_RESULT_MAX_CHARS),
  });
  if (parsed.success) {
    return { issues: [], result: parsed.data };
  }
  // The run's output broke the contract (a branch name the schema refuses, say). The child still
  // finishes: a FAILED result that names the fields, never the values.
  const issues = [
    ...new Set(
      parsed.error.issues.map(
        (i) =>
          i.path
            .map(String)
            .join('.')
            .replace(/[^\w.]/g, '?') || '(root)'
      )
    ),
  ].slice(0, 10);
  return {
    issues,
    result: {
      costUsd,
      filesChanged: [],
      status: 'FAILED',
      summary: `The run finished, but its result did not match the result contract and was dropped (fields: ${issues.join(', ')}).`,
    },
  };
}

export function buildChildResult(
  input: Parameters<typeof buildChildResultWithIssues>[0]
): ChildResult {
  return buildChildResultWithIssues(input).result;
}

const SPILL_MARKER_RE =
  /^\[stored as artifact ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \u2014 (\d+) bytes\]$/i;
/** Bytes read back from a spilled result; enough for {@link CHILD_RESULT_MAX_CHARS} of any script. */
const SPILL_READ_MAX_BYTES = CHILD_RESULT_MAX_CHARS * 4;

/**
 * When the run's `result.text` is the placeholder of a value its context snapshot spilled to an
 * artifact, the text read back from the artifact store (bounded), else a note that it could not be
 * read. Undefined when the text is not a placeholder. Only an artifact of THIS run, of the spill
 * kind and ready, is ever read — the check the gateway's "View full text" route makes — and a read
 * failure never fails the child.
 */
export async function resolveSpilledResultText(
  runId: string,
  snapshot: unknown
): Promise<ResolvedResultText | undefined> {
  const text = asRecord(asRecord(snapshot)?.result)?.text;
  if (typeof text !== 'string') {
    return undefined;
  }
  const marker = SPILL_MARKER_RE.exec(text.trim());
  if (!marker) {
    return undefined;
  }
  const placeholder = text.trim().slice(0, 200);
  try {
    const artifact = await prisma.workflowArtifact.findFirst({
      select: { id: true },
      where: { id: marker[1], kind: CONTEXT_OVERFLOW_KIND, runId, status: 'ready' },
    });
    if (!artifact) {
      return { unreadable: placeholder };
    }
    const { stream } = await getArtifactStream(artifact.id);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      bytes += buf.byteLength;
      if (bytes >= SPILL_READ_MAX_BYTES) {
        break;
      }
    }
    stream.destroy();
    return {
      text: Buffer.concat(chunks).subarray(0, SPILL_READ_MAX_BYTES).toString('utf8'),
    };
  } catch (err) {
    logWarn('orchestration child result artifact could not be read', {
      error: err instanceof Error ? err.message : String(err),
      runId,
    });
    return { unreadable: placeholder };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The orchestration a run belongs to as a child, read from the launch payload and CONFIRMED
 * against the `OrchestrationChild` row the gateway wrote in the launch transaction. The payload
 * alone is never trusted: the Agent Run template is reachable from other launch paths, and a
 * forged `orchestrationId` must not tie a run (and its finalization signal) to someone else's
 * orchestration. Null when the run is not a child.
 */
export async function childOrchestrationIdOf(
  payload: unknown,
  workRequestId: string | null | undefined
): Promise<string | null> {
  const claimed = asRecord(payload)?.orchestrationId;
  if (typeof claimed !== 'string' || !UUID_RE.test(claimed) || !workRequestId) {
    return null;
  }
  const child = await prisma.orchestrationChild.findFirst({
    select: { id: true },
    where: { orchestrationId: claimed, workRequestId },
  });
  return child ? claimed : null;
}

/**
 * The single writer of a child's STARTING to RUNNING move and of its `runId`. Called as soon as the
 * run row exists (`createWorkflowRun`) and by the polling backstop for a child that missed it.
 * Idempotent, and never touches a child that already ended.
 */
export async function markChildRunStarted(input: {
  orchestrationId: string;
  workRequestId: string;
  runId: string;
}): Promise<boolean> {
  const moved = await prisma.orchestrationChild.updateMany({
    data: { runId: input.runId, status: 'RUNNING' },
    where: {
      orchestrationId: input.orchestrationId,
      status: { in: ['STARTING', 'RUNNING'] },
      workRequestId: input.workRequestId,
    },
  });
  return moved.count > 0;
}

export interface CompletedChild {
  orchestrationId: string;
  childId: string;
}

/**
 * Record the result of the finished run `runId` on its orchestration child. Returns the child when
 * THIS call moved it to a terminal state, null when the run is not an orchestration child, is not
 * finished, or an earlier call already recorded it.
 */
export async function completeOrchestrationChild(runId: string): Promise<CompletedChild | null> {
  const run = await prisma.workflowRun.findUnique({
    select: {
      contextSnapshot: true,
      costUsdAccrued: true,
      endedAt: true,
      id: true,
      orchestrationId: true,
      status: true,
      steps: {
        orderBy: { endedAt: 'desc' },
        select: { error: true },
        take: 1,
        where: { error: { not: null } },
      },
      workRequestId: true,
    },
    where: { id: runId },
  });
  if (!run?.orchestrationId || !run.workRequestId || !run.endedAt) {
    return null;
  }
  const child = await prisma.orchestrationChild.findFirst({
    select: { id: true, status: true },
    where: { orchestrationId: run.orchestrationId, workRequestId: run.workRequestId },
  });
  if (!child || !['STARTING', 'RUNNING'].includes(child.status)) {
    return null;
  }
  const built = buildChildResultWithIssues({
    costUsd: run.costUsdAccrued,
    failure: run.steps[0]?.error ? redactString(run.steps[0].error) : null,
    resolvedText: await resolveSpilledResultText(run.id, run.contextSnapshot),
    snapshot: run.contextSnapshot,
    status: run.status,
  });
  const done = await recordChildResult({
    childId: child.id,
    orchestrationId: run.orchestrationId,
    result: built.result,
    runId: run.id,
  });
  if (done && built.issues.length > 0) {
    await writeNotice(
      run.orchestrationId,
      'CHILD_RESULT_INVALID',
      `The result of child ${child.id} did not match the result contract (fields: ${built.issues.join(', ')}) and was replaced by a failure.`
    ).catch(() => undefined);
  }
  return done;
}

/** Store `result` on the child and leave its `CHILD_RESULT` message, once. */
export async function recordChildResult(input: {
  childId: string;
  orchestrationId: string;
  result: ChildResult;
  runId?: string;
}): Promise<CompletedChild | null> {
  const moved = await prisma.orchestrationChild.updateMany({
    data: {
      costUsd: input.result.costUsd,
      endedAt: new Date(),
      resultJson: input.result as object,
      status: input.result.status,
      ...(input.runId ? { runId: input.runId } : {}),
    },
    where: { id: input.childId, status: { in: ['STARTING', 'RUNNING'] } },
  });
  if (moved.count === 0) {
    return null;
  }
  await prisma.orchestrationMessage
    .create({
      data: {
        body: `A child finished (${input.result.status.toLowerCase()}).`,
        childId: input.childId,
        kind: 'CHILD_RESULT',
        orchestrationId: input.orchestrationId,
        // `seen` flips once an orchestrator turn has read the result; the backstop reports the rest.
        payload: { childId: input.childId, seen: false, status: input.result.status },
        role: 'SYSTEM',
      },
    })
    .catch((err) => {
      logWarn('orchestration child result message not written', {
        childId: input.childId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return { childId: input.childId, orchestrationId: input.orchestrationId };
}

/** Signal the orchestrator that a child finished. Never throws. */
export async function signalChildFinished(done: CompletedChild): Promise<boolean> {
  try {
    const handle = getTemporalClient().workflow.getHandle(
      orchestrationWorkflowId(done.orchestrationId)
    );
    await handle.signal('childFinished', { childId: done.childId });
    return true;
  } catch (err) {
    logWarn('orchestration childFinished signal failed; the backstop will report it', {
      childId: done.childId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Called when a run has just been finalized. A no-op for a run that is not an orchestration child.
 * Never throws: the run is already over, and nothing here may fail it.
 */
export async function onOrchestrationRunFinalized(runId: string): Promise<void> {
  try {
    const done = await completeOrchestrationChild(runId);
    if (done) {
      await signalChildFinished(done);
    }
  } catch (err) {
    logWarn('orchestration child completion failed; the backstop will reconcile it', {
      error: err instanceof Error ? err.message : String(err),
      runId,
    });
  }
}

/** The CHILD_RESULT message of each of `childIds`, newest first per child. */
async function resultMessages(
  orchestrationId: string,
  childIds: readonly string[]
): Promise<Map<string, { id: string; payload: Record<string, unknown>; seen: boolean }>> {
  const rows = await prisma.orchestrationMessage.findMany({
    orderBy: { createdAt: 'desc' },
    select: { childId: true, id: true, payload: true },
    where: { childId: { in: [...childIds] }, kind: 'CHILD_RESULT', orchestrationId },
  });
  const out = new Map<string, { id: string; payload: Record<string, unknown>; seen: boolean }>();
  for (const row of rows) {
    if (!row.childId || out.has(row.childId)) {
      continue;
    }
    const payload = asRecord(row.payload) ?? {};
    out.set(row.childId, { id: row.id, payload, seen: payload.seen === true });
  }
  return out;
}

/**
 * Which of `childIds` still have a result no orchestrator turn has read. A child with no
 * `CHILD_RESULT` message at all (the write failed) is unread: the stored result, not the message
 * row, is what exists.
 */
export async function unreadChildIds(
  orchestrationId: string,
  childIds: readonly string[]
): Promise<Set<string>> {
  if (childIds.length === 0) {
    return new Set();
  }
  const messages = await resultMessages(orchestrationId, childIds);
  return new Set(childIds.filter((id) => messages.get(id)?.seen !== true));
}

/**
 * Mark the children's results read, once a turn that carried them has completed. A child whose
 * message was never written gets one (already seen), so the page and the backstop agree.
 */
export async function markChildResultsSeen(
  orchestrationId: string,
  childIds: readonly string[]
): Promise<void> {
  if (childIds.length === 0) {
    return;
  }
  const messages = await resultMessages(orchestrationId, childIds);
  for (const childId of new Set(childIds)) {
    const existing = messages.get(childId);
    if (existing?.seen) {
      continue;
    }
    if (existing) {
      await prisma.orchestrationMessage.update({
        data: { payload: { ...existing.payload, seen: true } },
        where: { id: existing.id },
      });
      continue;
    }
    await createResultMessage(orchestrationId, childId, null, true);
  }
}

/** Write a child's `CHILD_RESULT` message. The status comes from the stored result when given. */
async function createResultMessage(
  orchestrationId: string,
  childId: string,
  status: string | null,
  seen: boolean
): Promise<void> {
  const stored =
    status ??
    (
      await prisma.orchestrationChild.findFirst({
        select: { status: true },
        where: { id: childId, orchestrationId },
      })
    )?.status ??
    'FAILED';
  await prisma.orchestrationMessage.create({
    data: {
      body: `A child finished (${stored.toLowerCase()}).`,
      childId,
      kind: 'CHILD_RESULT',
      orchestrationId,
      payload: { childId, seen, status: stored },
      role: 'SYSTEM',
    },
  });
}

/**
 * Finished children (a terminal status is written together with `resultJson`) whose result no
 * orchestrator turn has read, older than `graceMs`. Keyed on the child, not on the message row: a child whose
 * `CHILD_RESULT` message was never written is found here and its message is re-created from the
 * stored result, so the page and the next turn see it.
 */
export async function findUnseenChildResults(
  orchestrationId: string,
  graceMs: number
): Promise<string[]> {
  const finished = await prisma.orchestrationChild.findMany({
    select: { endedAt: true, id: true, status: true },
    where: {
      endedAt: { lt: new Date(Date.now() - graceMs) },
      orchestrationId,
      status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
    },
  });
  if (finished.length === 0) {
    return [];
  }
  const messages = await resultMessages(
    orchestrationId,
    finished.map((c) => c.id)
  );
  const unseen: string[] = [];
  for (const child of finished) {
    const message = messages.get(child.id);
    if (message?.seen) {
      continue;
    }
    if (!message) {
      try {
        await createResultMessage(orchestrationId, child.id, child.status, false);
      } catch (err) {
        logWarn('orchestration child result message not re-created', {
          childId: child.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    unseen.push(child.id);
  }
  return unseen;
}
