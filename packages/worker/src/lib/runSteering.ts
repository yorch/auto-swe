import { prisma } from '@auto-swe/shared/db';
import type { MessageList } from '@mastra/core/agent';
import { logWarn } from './activityLog.js';
import type { AgentTracer } from './agentTracer.js';

/**
 * Steering for a running agent (spec §5). A person (or the orchestrator) writes a
 * `RunSteeringMessage`; the Mastra loop drains the undelivered ones at each STEP BOUNDARY through
 * the loop's `prepareStep` hook, appends them to the message history as a labelled block, marks
 * them delivered and records an `agent.steered` event on the trace.
 *
 * Only runs that carry an orchestration pass a run id here, so every other run pays nothing. The
 * cost for one that does is one indexed read per step (`run_steering_messages(run_id, created_at)`).
 * Harness loops (Claude Code, Pi) are a single turn and are never steered: their messages stay
 * undelivered and the launcher sees them as such.
 */

/** Most messages taken in one step, so a flood cannot swamp the context. */
const MAX_PER_STEP = 20;
const MAX_BODY_CHARS = 4000;

export const STEERING_HEADING = '[Steering update from the launcher — incorporate this]:';

export interface DrainedSteering {
  ids: string[];
  /** The labelled block to append to the history. */
  block: string;
}

/** Take the run's undelivered messages, oldest first, and mark them delivered. Null when none. */
export async function drainRunSteering(runId: string): Promise<DrainedSteering | null> {
  const rows = await prisma.runSteeringMessage.findMany({
    orderBy: { createdAt: 'asc' },
    select: { body: true, id: true },
    take: MAX_PER_STEP,
    where: { deliveredAt: null, runId },
  });
  if (rows.length === 0) {
    return null;
  }
  const ids = rows.map((r) => r.id);
  await prisma.runSteeringMessage.updateMany({
    data: { deliveredAt: new Date() },
    where: { deliveredAt: null, id: { in: ids } },
  });
  const lines = rows.map((r) => `- ${r.body.slice(0, MAX_BODY_CHARS)}`);
  return { block: `${STEERING_HEADING}\n${lines.join('\n')}`, ids };
}

/** The slice of Mastra's `prepareStep` argument this uses. */
interface PrepareStepArgs {
  messageList?: MessageList;
}

/**
 * A `prepareStep` hook for the Mastra loop that injects steering at each step boundary. It never
 * throws: a failed read is logged and the step proceeds unsteered, and the messages stay
 * undelivered for the next boundary.
 */
export function createSteeringPrepareStep(runId: string, tracer: AgentTracer) {
  return async (args: PrepareStepArgs) => {
    let drained: DrainedSteering | null;
    try {
      drained = await drainRunSteering(runId);
    } catch (err) {
      logWarn('steering read failed; continuing without it', {
        error: err instanceof Error ? err.message : String(err),
        runId,
      });
      return undefined;
    }
    if (!drained || !args.messageList) {
      return undefined;
    }
    args.messageList.add({ content: drained.block, role: 'user' }, 'input');
    tracer.addActivityEvent({
      name: 'agent.steered',
      outputJson: { count: drained.ids.length, messageIds: drained.ids },
    });
    return { messageList: args.messageList };
  };
}
