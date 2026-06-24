import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';

/**
 * Name of the GLOBAL workflow template that backs channel-run observability.
 * MUST match `CHANNEL_ASSISTANT_TEMPLATE_NAME` in
 * `packages/shared/src/lib/syncBuiltins.ts` (where the template + its v1 spec are
 * seeded). It's redeclared here rather than imported because the shared
 * `./lib/syncBuiltins` subpath isn't aliased for vitest; the name is the stable
 * lookup key (`findFirst({ name, teamId: null })`).
 */
const CHANNEL_ASSISTANT_TEMPLATE_NAME = 'Channel Assistant';

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
  kind: 'mention' | 'ambient';
  /** Short human label for the run (e.g. the Slack channel id or a thread ref). */
  label: string;
}

export interface FinalizeChannelRunInput {
  workflowId: string;
  status: 'SUCCESS' | 'FAILED';
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
      tokensInputTotal: totals._sum.inputTokens ?? 0,
      tokensOutputTotal: totals._sum.outputTokens ?? 0,
    },
    where: { id: run.id },
  });
}
