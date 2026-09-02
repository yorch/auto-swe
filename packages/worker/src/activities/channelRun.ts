import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { CHANNEL_ASSISTANT_TEMPLATE_NAME } from '@auto-swe/shared/lib/channelTask';
import { logError } from '../lib/activityLog.js';

/**
 * Name of the GLOBAL workflow template that backs channel-run observability —
 * the stable `findFirst({ name, teamId: null })` lookup key. Imported from the
 * shared, vitest-aliased `@auto-swe/shared/lib/channelTask` so it can't drift
 * from the seed in `syncBuiltins`.
 */

/**
 * The minimal spec we stamp onto each channel run's `specSnapshot` (the seeded
 * template version carries the canonical copy). A single terminal node — the run
 * is a trace container, not an interpreted graph; the `/runs` viewer renders the
 * AgentTrace event stream regardless of node mapping.
 */
const CHANNEL_ASSISTANT_SPEC = {
  description: 'Observability shell for channel-assistant turns and ambient digests.',
  entry: 'done',
  name: CHANNEL_ASSISTANT_TEMPLATE_NAME,
  nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
} as const;

/**
 * Channel-run lifecycle activities — give channel-assistant turns + ambient
 * digests lightweight `WorkflowRun` records so their agent traces are observable
 * in `/runs`.
 *
 * Why this exists: `ChannelAssistantWorkflow` / `ChannelAmbientWorkflow` call
 * `runAgent` → `persistActivityTrace`, which resolves the run via
 * `currentWorkflowRunId()` (a `WorkflowRun.findUnique({ where: { workflowId } })`
 * keyed on the Temporal workflowId). With no `WorkflowRun` row, that returns
 * `undefined` and `AgentTracer.persist` no-ops — so channel traces were silently
 * dropped. Creating a run row keyed to the SAME Temporal workflowId BEFORE the
 * turn runs makes that lookup resolve, and the traces persist under it.
 *
 * These run rows are deliberately minimal: they are trace containers, not
 * interpreted graphs. They do NOT route through `finalizeWorkflowRun` (which
 * increments `OrgMonthlyUsage` and reads `ActiveWorkflow` — neither of which a
 * channel has; channel cost is tracked separately in `ChannelMonthlyUsage` via
 * `accrueChannelUsage`). Finalize here is a minimal direct update.
 */

export interface StartChannelRunInput {
  /** The Temporal workflowId — MUST match the value `currentWorkflowRunId()` keys on. */
  workflowId: string;
  channelId: string;
  /** Owning team — optional; resolved from the channel row when omitted (ambient path). */
  teamId?: string;
  /** Owning org — optional; resolved from the channel row when omitted (ambient path). */
  orgId?: string;
  kind: 'mention' | 'ambient' | 'reactive';
  /** Short human label for the run (e.g. the Slack channel id or a thread ref). */
  label: string;
  /** Gap J (audit): Slack user (`U…`) who triggered the run — `mention` path only. */
  userSlackId?: string;
  /** Gap J (audit): the triggering message text (truncated) for "who asked what". */
  userText?: string;
}

/** Cap on the audit text snapshot stashed onto the run (defensive against a paste). */
const MAX_AUDIT_TEXT_CHARS = 280;

export interface FinalizeChannelRunInput {
  workflowId: string;
  status: 'SUCCESS' | 'FAILED';
}

export interface TouchChannelThreadSessionInput {
  channelId: string;
  threadTs: string;
}

/**
 * Retention for `ChannelThreadSession` rows. Sessions only matter while fresh (the
 * gateway's read window is far shorter), so rows older than this are dead and are
 * swept opportunistically on the next touch — keeping the table bounded per channel
 * without a separate scheduled job. Must comfortably exceed the gateway's
 * `SESSION_WINDOW_MS` (30 min) so a live session is never reaped.
 */
const THREAD_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Probability of running the stale-session sweep on any given touch. The sweep is
 * a bounding mechanism, not a correctness one (the gateway's read window already
 * ignores stale rows), so it doesn't need to run every turn — gating it keeps the
 * extra `deleteMany` off the per-turn hot path while still reaping a channel's dead
 * rows within a handful of turns. (An activity, not a workflow, so `Math.random`
 * is fine here — no determinism constraint.) Note: a channel that goes fully idle
 * stops touching and so stops sweeping; its (tiny) rows linger harmlessly until the
 * channel is next active or deleted — acceptable for a bounded-size convenience table.
 */
const THREAD_SESSION_SWEEP_PROBABILITY = 0.1;

/**
 * Persistent live session (Gap H): record that the assistant was just active in
 * this thread, so a plain follow-up reply (no re-@mention) can continue the
 * conversation while the session is fresh. Upserts `ChannelThreadSession` keyed on
 * `(channelId, threadTs)`, bumping `lastAssistantAt` to now, and (occasionally)
 * sweeps this channel's long-dead session rows so the table stays bounded (one
 * permanent row per thread otherwise).
 *
 * Always written (cheap) regardless of whether the channel has the follow-up
 * feature enabled — the gateway gates on `followupSessionEnabled` at read time, so
 * a stale row is harmless. Best-effort: a failure here must not break the turn.
 */
export async function touchChannelThreadSession(
  input: TouchChannelThreadSessionInput
): Promise<void> {
  try {
    const now = new Date();
    await prisma.channelThreadSession.upsert({
      create: { channelId: input.channelId, lastAssistantAt: now, threadTs: input.threadTs },
      update: { lastAssistantAt: now },
      where: {
        channelId_threadTs: { channelId: input.channelId, threadTs: input.threadTs },
      },
    });
    // Sweep this channel's dead sessions occasionally (not every turn — see
    // THREAD_SESSION_SWEEP_PROBABILITY). Cheap + bounds growth; a failure here
    // must not affect the turn (own try/catch).
    if (Math.random() < THREAD_SESSION_SWEEP_PROBABILITY) {
      try {
        await prisma.channelThreadSession.deleteMany({
          where: {
            channelId: input.channelId,
            lastAssistantAt: { lt: new Date(now.getTime() - THREAD_SESSION_RETENTION_MS) },
          },
        });
      } catch (sweepErr) {
        logError(`[channelRun] thread-session sweep failed for ${input.channelId}:`, {
          channelId: input.channelId,
          err: sweepErr instanceof Error ? sweepErr.message : sweepErr,
        });
      }
    }
  } catch (err) {
    logError(
      `[channelRun] failed to touch thread session for ${input.channelId}/${input.threadTs}:`,
      {
        channelId: input.channelId,
        err: err instanceof Error ? err.message : err,
      }
    );
  }
}

/**
 * Resolve the GLOBAL "Channel Assistant" template's id + active version (seeded
 * by `syncBuiltins`). Throws if it's missing — that's a seed/bootstrap error the
 * caller should surface, not silently swallow.
 */
async function resolveChannelAssistantTemplate(): Promise<{
  templateId: string;
  templateVersion: number;
}> {
  const template = await prisma.workflowTemplate.findFirst({
    select: { activeVersion: true, id: true },
    where: { name: CHANNEL_ASSISTANT_TEMPLATE_NAME, teamId: null },
  });
  if (!template?.activeVersion) {
    throw new Error(
      `no active "${CHANNEL_ASSISTANT_TEMPLATE_NAME}" workflow template — run \`yarn db:seed\``
    );
  }
  return { templateId: template.id, templateVersion: template.activeVersion };
}

/**
 * Create a lightweight `WorkflowRun` row for a channel turn, keyed to the
 * Temporal workflowId so `currentWorkflowRunId()` (used inside `runAgent` →
 * `persistActivityTrace`) resolves it and the turn's agent traces persist.
 *
 * Idempotent: a re-delivered workflow with the same workflowId already has a row,
 * so the unique-constraint violation (P2002) on `workflowId` is caught and
 * treated as a no-op — a Temporal retry won't crash.
 *
 * The channel/kind/label metadata is stashed into `specSnapshot.channel` (a Json
 * column that already exists) so the run is queryable/identifiable without a
 * schema change.
 */
export async function startChannelRun(input: StartChannelRunInput): Promise<void> {
  const { templateId, templateVersion } = await resolveChannelAssistantTemplate();

  // The ambient path only knows the channelId, so backfill team/org from the
  // channel row when not supplied. Best-effort — the metadata is observability
  // only (it isn't load-bearing for trace resolution, which keys on workflowId).
  let { orgId, teamId } = input;
  if (!teamId || !orgId) {
    const channel = await prisma.slackChannel.findUnique({
      select: { orgId: true, teamId: true },
      where: { id: input.channelId },
    });
    teamId = teamId ?? channel?.teamId ?? undefined;
    orgId = orgId ?? channel?.orgId ?? undefined;
  }

  // Snapshot the minimal spec + the channel metadata. The metadata rides along
  // in the Json spec snapshot — no schema column added.
  const specSnapshot = {
    ...CHANNEL_ASSISTANT_SPEC,
    channel: {
      channelId: input.channelId,
      kind: input.kind,
      label: input.label,
      orgId: orgId ?? null,
      teamId: teamId ?? null,
      // Gap J (audit): who triggered the run + what they asked (mention path only).
      userSlackId: input.userSlackId ?? null,
      userText: input.userText ? input.userText.slice(0, MAX_AUDIT_TEXT_CHARS) : null,
    },
  };

  try {
    await prisma.workflowRun.create({
      data: {
        specSnapshot: specSnapshot as unknown as Prisma.InputJsonValue,
        status: 'RUNNING',
        templateId,
        templateVersion,
        workflowId: input.workflowId,
        workRequestId: null,
      },
    });
  } catch (err) {
    // Unique-constraint violation on workflowId → a prior attempt already created
    // the run row. Idempotent no-op; anything else is a real error.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
      throw err;
    }
  }
}

/**
 * Finalize a channel run: set its terminal `status` + `endedAt`, and denormalize
 * `costUsdAccrued` / token totals by summing the run's `AgentTrace` rows (which
 * now persist under this runId). Deliberately a minimal direct update — it does
 * NOT touch `OrgMonthlyUsage` (channel cost lives in `ChannelMonthlyUsage`) or
 * `ActiveWorkflow` (channels have none).
 *
 * Best-effort + idempotent: a missing run row (e.g. `startChannelRun` was never
 * reached) is a no-op; re-running just re-writes the same summed totals.
 */
export async function finalizeChannelRun(input: FinalizeChannelRunInput): Promise<void> {
  const run = await prisma.workflowRun.findUnique({
    select: { id: true },
    where: { workflowId: input.workflowId },
  });
  if (!run) {
    return;
  }

  const totals = await prisma.agentTrace.aggregate({
    _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    where: { runId: run.id },
  });

  await prisma.workflowRun.update({
    data: {
      costUsdAccrued: totals._sum.costUsd ?? 0,
      endedAt: new Date(),
      status: input.status,
      tokensInputTotal: BigInt(totals._sum.inputTokens ?? 0),
      tokensOutputTotal: BigInt(totals._sum.outputTokens ?? 0),
    },
    where: { id: run.id },
  });
}
