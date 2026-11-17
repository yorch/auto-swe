import { prisma } from '@auto-swe/shared/db';
import { createOrchestratorTools, IntentCollector } from '../agents/orchestratorTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { logError } from '../lib/activityLog.js';
import { AgentTracer, redactString } from '../lib/agentTracer.js';
import type { AgentTools } from '../lib/config/agentSpec.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey, ResolveCtx } from '../lib/config/types.js';
import { markChildResultsSeen, unreadChildIds } from '../lib/orchestrationChildren.js';
import {
  type FinishedChildInput,
  renderChildResults,
  renderEvents,
  renderStateBlock,
  renderTranscript,
  type TranscriptRow,
  TURN_INSTRUCTIONS,
} from '../lib/orchestrationContext.js';
import { countOrchestrationLoad, hasPendingAttach } from '../lib/orchestrationState.js';
import type {
  RunOrchestratorTurnInput,
  RunOrchestratorTurnResult,
} from '../lib/orchestrationTypes.js';
import { ownerOfTeam, withSpendOwner } from '../lib/spendOwner.js';
import { runAgent } from './runAgent.js';

/**
 * One orchestrator turn: read the batch of events, let the `orchestrator` agent answer, and hand
 * back the intents its tools recorded. The activity never applies an intent — it returns them, and
 * the workflow runs `applyOrchestrationIntents` — so nothing the model asked for happens as a side
 * effect of the turn. Not retried (the workflow proxy is single-attempt): a second attempt would
 * answer the same events twice.
 */

const AGENT_KEY = 'orchestrator';
/** Tool steps one turn may take. The tools only record, so a turn is a few steps. */
const MAX_STEPS = 12;
/**
 * Messages read for a turn's transcript window; older ones drop off (the first task is kept). The
 * rendered window is further bounded by `TRANSCRIPT_MAX_CHARS` in `orchestrationContext.ts`, so the
 * whole prompt is bounded (see the prompt budget there).
 */
const TRANSCRIPT_MESSAGES = 60;
const BUDGET_TEXT = 'The orchestrator has reached its spending limit and cannot take another turn.';
const FAILED_TEXT = 'The orchestrator hit an error on this turn. Send a message to try again.';
const UNPRICED_TEXT =
  "The orchestrator's model has no price in the model catalog while a USD budget cap is set, so it cannot take a turn. An admin must add the model to the model catalog or bind a priced model.";
const PRICE_UNAVAILABLE_TEXT =
  "The model catalog could not be read, so the orchestrator's model cannot be priced right now. Try again shortly.";

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);

/** The failure types in `err` and its cause chain. */
function failureTypes(err: unknown): Set<string> {
  const types = new Set<string>();
  let cur: unknown = err;
  for (let i = 0; i < 16 && cur instanceof Error; i++) {
    const type = (cur as { type?: unknown }).type;
    if (typeof type === 'string') {
      types.add(type);
    }
    types.add(cur.message.slice(0, 40));
    cur = (cur as { cause?: unknown }).cause;
  }
  return types;
}

// The `ApplicationFailure` types `usdCapGuard.ts` throws, spelled here so this module does not
// import the spend guard's dependency tree; `orchestrationTurn.test.ts` pins both.
function failureText(err: unknown): { code: string; text: string } {
  const types = failureTypes(err);
  const has = (code: string) => [...types].some((t) => t === code || t.startsWith(`${code}:`));
  if (has('BUDGET_EXCEEDED') || (err instanceof Error && err.message.includes('BUDGET_EXCEEDED'))) {
    return { code: 'BUDGET_EXCEEDED', text: BUDGET_TEXT };
  }
  if (has('MODEL_UNPRICED')) {
    return { code: 'MODEL_UNPRICED', text: UNPRICED_TEXT };
  }
  if (has('MODEL_PRICE_UNAVAILABLE')) {
    return { code: 'MODEL_PRICE_UNAVAILABLE', text: PRICE_UNAVAILABLE_TEXT };
  }
  return { code: 'TURN_FAILED', text: FAILED_TEXT };
}

export async function runOrchestratorTurn(
  input: RunOrchestratorTurnInput
): Promise<RunOrchestratorTurnResult> {
  const orch = await prisma.orchestration.findUnique({
    select: {
      allowlist: true,
      id: true,
      orgId: true,
      repo: { select: { organizationName: true, repoName: true } },
      repoId: true,
      status: true,
      teamId: true,
      title: true,
    },
    where: { id: input.orchestrationId },
  });
  if (!orch || TERMINAL.has(orch.status)) {
    return { intents: [], pendingApprovals: 0, runningChildren: 0, status: 'SKIPPED' };
  }

  const ctx: ResolveCtx = { orgId: orch.orgId ?? undefined, teamId: orch.teamId };
  const collector = new IntentCollector();
  const tracer = new AgentTracer();

  // The durable count of turns: one hidden marker per turn, written BEFORE the model runs, so a
  // tool-only turn, a failed one and one whose worker died all count toward `maxTurns` after a
  // restart. The dashboard and the transcript hide it (`hidden`).
  await writeTurnMarker(orch.id, input).catch((err) => {
    logError('[orchestratorTurn] turn marker not written', {
      err: err instanceof Error ? err.message : String(err),
      orchestrationId: orch.id,
    });
  });

  try {
    return await withSpendOwner(ownerOfTeam(orch.teamId), async () => {
      try {
        const { deferredIds, message, shownIds } = await buildTurnMessage(input, orch);
        const spec = await resolveAgentSpec(
          { agentKey: AGENT_KEY as ModelBackedAgentKey, availableTools: {} as AgentTools },
          ctx
        );
        // The Agent row grants no tools (`toolKeys: []`); the four intent-recording tools are
        // bound here, in code, as the channel assistant binds `delegateTask`.
        spec.tools = createOrchestratorTools(collector) as unknown as AgentTools;
        const result = await runAgent(spec, message, {
          ctx,
          maxSteps: MAX_STEPS,
          perStepAccounting: true,
          spanName: 'llm.orchestrator',
          tracer,
        });
        const text = redactString(result.text ?? '').trim();
        if (text) {
          await prisma.orchestrationMessage.create({
            data: {
              body: text,
              kind: 'TEXT',
              orchestrationId: orch.id,
              // `turn` is what the turn count is recovered from; a gateway-written message to a child
              // is also ORCHESTRATOR text but carries no `turn`, so it never counts as one.
              payload: { turn: input.turn, turnKey: input.turnKey },
              role: 'ORCHESTRATOR',
            },
          });
        }
        await markChildResultsSeen(orch.id, shownIds);
        await touch(orch.id);
        const load = await countOrchestrationLoad(orch.id);
        return {
          ...(deferredIds.length > 0 ? { deferredChildIds: deferredIds } : {}),
          intents: collector.intents,
          pendingApprovals: load.pendingApprovals,
          runningChildren: load.runningChildren,
          status: 'COMPLETE' as const,
        };
      } finally {
        await persistActivityTrace(tracer, AGENT_KEY);
      }
    });
  } catch (err) {
    logError('[orchestratorTurn] turn failed', {
      err: err instanceof Error ? err.message : String(err),
      orchestrationId: orch.id,
    });
    const failure = failureText(err);
    await prisma.orchestrationMessage
      .create({
        data: {
          body: failure.text,
          kind: 'NOTICE',
          orchestrationId: orch.id,
          payload: { code: failure.code, turnKey: input.turnKey },
          role: 'SYSTEM',
        },
      })
      .catch(() => undefined);
    const load = await countOrchestrationLoad(orch.id).catch(() => ({
      pendingApprovals: 0,
      runningChildren: 0,
    }));
    return {
      intents: [],
      pendingApprovals: load.pendingApprovals,
      runningChildren: load.runningChildren,
      status: 'FAILED',
    };
  }
}

/**
 * The turn's durable marker: a SYSTEM NOTICE with no body and `payload.marker`/`payload.hidden`,
 * which {@link beginOrchestrationRun} counts. Hidden from the transcript the model reads; the
 * dashboard filters rows whose payload says `hidden`.
 */
async function writeTurnMarker(
  orchestrationId: string,
  input: RunOrchestratorTurnInput
): Promise<void> {
  await prisma.orchestrationMessage.create({
    data: {
      body: '',
      kind: 'NOTICE',
      orchestrationId,
      payload: { hidden: true, marker: true, turn: input.turn, turnKey: input.turnKey },
      role: 'SYSTEM',
    },
  });
}

function isHiddenRow(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as { hidden?: unknown }).hidden === true
  );
}

async function touch(orchestrationId: string): Promise<void> {
  await prisma.orchestration
    .update({ data: { updatedAt: new Date() }, where: { id: orchestrationId } })
    .catch(() => undefined);
}

/** The one user message of the turn: transcript, state, results, new events, instructions. */
async function buildTurnMessage(
  input: RunOrchestratorTurnInput,
  orch: {
    allowlist: string[];
    id: string;
    repo: { organizationName: string | null; repoName: string | null } | null;
    repoId: string | null;
    title: string;
  }
): Promise<{ deferredIds: string[]; message: string; shownIds: string[] }> {
  const [recent, first, children, pendingAttach] = await Promise.all([
    prisma.orchestrationMessage.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        body: true,
        childId: true,
        createdAt: true,
        id: true,
        kind: true,
        payload: true,
        role: true,
      },
      // Turn markers (hidden) are one per turn: read a wider window, filter them out below.
      take: TRANSCRIPT_MESSAGES * 2,
      where: { kind: { not: 'CHILD_RESULT' }, orchestrationId: orch.id },
    }),
    prisma.orchestrationMessage.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { body: true, childId: true, id: true, kind: true, payload: true, role: true },
      where: { orchestrationId: orch.id, role: 'USER' },
    }),
    prisma.orchestrationChild.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        agentKey: true,
        endedAt: true,
        id: true,
        label: true,
        pathScopes: true,
        resultJson: true,
        role: true,
        status: true,
      },
      where: { orchestrationId: orch.id },
    }),
    hasPendingAttach(orch.id),
  ]);

  const visible = recent.filter((r) => !isHiddenRow(r.payload)).slice(0, TRANSCRIPT_MESSAGES);
  const rows: TranscriptRow[] = [...visible].reverse();
  // The launcher's task is always shown, even when a long conversation pushed it out of the window.
  if (first && !visible.some((r) => r.id === first.id)) {
    rows.unshift(first);
  }

  // EVERY finished child's result goes in on every turn: the orchestrator is a fresh single message
  // each turn, so a result it read once would be gone by the next. `unread` only labels the ones
  // that are new and decides whose screening notices are written.
  const finished: FinishedChildInput[] = children
    .filter((c) => TERMINAL.has(c.status) && c.resultJson !== null)
    .sort((a, b) => (a.endedAt?.getTime() ?? 0) - (b.endedAt?.getTime() ?? 0))
    .map((c) => ({
      agentKey: c.agentKey,
      id: c.id,
      label: c.label,
      resultJson: c.resultJson,
      status: c.status,
    }));
  const unread = await unreadChildIds(
    orch.id,
    finished.map((c) => c.id)
  );
  const section = await renderChildResults(finished, { unreadIds: unread });
  for (const { body, childId } of section.notices) {
    // Once per child: a retried turn (the result is still unread) must not repeat the notice. One
    // that already exists is in the transcript read above.
    const exists = await prisma.orchestrationMessage.findFirst({
      select: { id: true },
      where: {
        AND: [
          { payload: { equals: 'RESULT_SCREENED', path: ['code'] } },
          { payload: { equals: childId, path: ['childId'] } },
        ],
        kind: 'NOTICE',
        orchestrationId: orch.id,
      },
    });
    if (exists) {
      continue;
    }
    await prisma.orchestrationMessage.create({
      data: {
        body,
        kind: 'NOTICE',
        orchestrationId: orch.id,
        payload: { childId, code: 'RESULT_SCREENED', turnKey: input.turnKey },
        role: 'SYSTEM',
      },
    });
    rows.push({ body, kind: 'NOTICE', payload: { code: 'RESULT_SCREENED' }, role: 'SYSTEM' });
  }

  const repoName = orch.repo
    ? `${orch.repo.organizationName ?? ''}/${orch.repo.repoName ?? ''}`.replace(/^\//, '')
    : undefined;
  const message = [
    renderTranscript(rows, { childLabels: new Map(children.map((c) => [c.id, c.label])) }),
    renderStateBlock({
      allowlist: orch.allowlist,
      children: children.map((c) => ({
        agentKey: c.agentKey,
        id: c.id,
        label: c.label,
        pathScopes: c.pathScopes,
        role: c.role,
        status: c.status,
      })),
      repo: orch.repoId
        ? { name: repoName, state: 'attached' }
        : { state: pendingAttach ? 'requested' : 'none' },
      title: orch.title,
    }),
    ...(section.text ? [section.text] : []),
    renderEvents({ attachedRepoName: repoName, events: input.events }),
    TURN_INSTRUCTIONS,
  ].join('\n\n');
  return { deferredIds: section.deferredIds, message, shownIds: section.shownIds };
}
