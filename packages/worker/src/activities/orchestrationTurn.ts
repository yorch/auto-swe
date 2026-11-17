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
  fenceFinishedChild,
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
/** Messages of the transcript sent with a turn; older ones drop off (the first task is kept). */
const TRANSCRIPT_MESSAGES = 60;
const BUDGET_TEXT = 'The orchestrator has reached its spending limit and cannot take another turn.';
const FAILED_TEXT = 'The orchestrator hit an error on this turn. Send a message to try again.';

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);

function failureText(err: unknown): { code: string; text: string } {
  const type = (err as { type?: string } | null)?.type;
  const message = err instanceof Error ? err.message : '';
  if (type === 'BUDGET_EXCEEDED' || message.includes('BUDGET_EXCEEDED')) {
    return { code: 'BUDGET_EXCEEDED', text: BUDGET_TEXT };
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

  try {
    return await withSpendOwner(ownerOfTeam(orch.teamId), async () => {
      try {
        const message = await buildTurnMessage(input, orch);
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
              payload: { turnKey: input.turnKey },
              role: 'ORCHESTRATOR',
            },
          });
        }
        await markChildResultsSeen(
          orch.id,
          input.events.flatMap((e) => (e.type === 'childFinished' ? [e.childId] : []))
        );
        await touch(orch.id);
        const load = await countOrchestrationLoad(orch.id);
        return {
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

async function touch(orchestrationId: string): Promise<void> {
  await prisma.orchestration
    .update({ data: { updatedAt: new Date() }, where: { id: orchestrationId } })
    .catch(() => undefined);
}

/** The one user message of the turn: transcript, state, new events, instructions. */
async function buildTurnMessage(
  input: RunOrchestratorTurnInput,
  orch: {
    allowlist: string[];
    id: string;
    repo: { organizationName: string | null; repoName: string | null } | null;
    repoId: string | null;
    title: string;
  }
): Promise<string> {
  const [recent, first, children, pendingAttach] = await Promise.all([
    prisma.orchestrationMessage.findMany({
      orderBy: { createdAt: 'desc' },
      select: { body: true, createdAt: true, id: true, kind: true, payload: true, role: true },
      take: TRANSCRIPT_MESSAGES,
      where: { kind: { not: 'CHILD_RESULT' }, orchestrationId: orch.id },
    }),
    prisma.orchestrationMessage.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { body: true, id: true, kind: true, payload: true, role: true },
      where: { orchestrationId: orch.id, role: 'USER' },
    }),
    prisma.orchestrationChild.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        agentKey: true,
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

  const rows: TranscriptRow[] = [...recent].reverse();
  // The launcher's task is always shown, even when a long conversation pushed it out of the window.
  if (first && !recent.some((r) => r.id === first.id)) {
    rows.unshift(first);
  }

  // Each finished child the events name goes in once, fenced and screened.
  const fencedByChild = new Map<string, string>();
  const notices: string[] = [];
  const finishedIds = input.events.flatMap((e) => (e.type === 'childFinished' ? [e.childId] : []));
  // A result a turn already read (the signal and the backstop can both report it) is not repeated.
  const unread = await unreadChildIds(orch.id, finishedIds);
  for (const e of input.events) {
    if (e.type !== 'childFinished' || fencedByChild.has(e.childId) || !unread.has(e.childId)) {
      continue;
    }
    const child = children.find((c) => c.id === e.childId);
    if (!child) {
      continue;
    }
    const fenced = await fenceFinishedChild(child);
    if (fenced) {
      fencedByChild.set(child.id, fenced.block);
      if (fenced.droppedLines > 0 || fenced.withheld) {
        notices.push(
          fenced.withheld
            ? `The result of child ${child.id} was withheld: it could not be screened for prompt injection.`
            : `${fenced.droppedLines} line(s) of the result of child ${child.id} were removed: they matched a prompt-injection pattern.`
        );
      }
    }
  }
  for (const body of notices) {
    await prisma.orchestrationMessage.create({
      data: {
        body,
        kind: 'NOTICE',
        orchestrationId: orch.id,
        payload: { code: 'RESULT_SCREENED', turnKey: input.turnKey },
        role: 'SYSTEM',
      },
    });
    rows.push({ body, kind: 'NOTICE', payload: { code: 'RESULT_SCREENED' }, role: 'SYSTEM' });
  }

  const repoName = orch.repo
    ? `${orch.repo.organizationName ?? ''}/${orch.repo.repoName ?? ''}`.replace(/^\//, '')
    : undefined;
  return [
    renderTranscript(rows),
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
    renderEvents({ attachedRepoName: repoName, events: input.events, fencedByChild }),
    TURN_INSTRUCTIONS,
  ].join('\n\n');
}
