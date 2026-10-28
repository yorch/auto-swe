import type {
  AssistantConversationInput,
  AssistantTurnRequest,
} from '@auto-swe/shared/lib/assistantConversation';
import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { RETRY_RUN_RECORD, RETRY_SINGLE_ATTEMPT, T_2M, T_15M, T_30S } from './proxyOptions.js';

/**
 * AssistantConversationWorkflow — one in-app assistant conversation
 * (`docs/history/in-app-assistant.md` D6).
 *
 * The gateway starts it with `signalWithStart` under the id `assistant-<conversationId>` and hands
 * it each turn as an `assistantTurn` signal: the reply row to fill and the assistant token the
 * turn's tools call the gateway with. Turns run one at a time, in the order they were sent. With
 * no turn for {@link IDLE_TIMEOUT} the workflow completes; the next message starts it again, so an
 * idle conversation holds no worker resources.
 *
 * A turn that cannot run at all (the activity timed out, or the worker died past its heartbeat)
 * marks its reply FAILED so the panel stops waiting. The turn activity is not retried: it streams
 * into the reply as it goes, and a second attempt would answer the same message twice.
 *
 * V8-isolate rule: only `import type` from external packages / `@auto-swe/shared`; runtime imports
 * come from `@temporalio/workflow` and the activity proxies below. The signal's name is therefore
 * written here and checked against `ASSISTANT_TURN_SIGNAL` by the workflow test.
 */

export const assistantTurnSignal = defineSignal<[AssistantTurnRequest]>('assistantTurn');

/** How long the workflow waits for another message before it completes. */
const IDLE_TIMEOUT = '30 minutes';

/** Turns per execution before continuing as new, so the history stays small. */
const MAX_TURNS_PER_RUN = 50;

const { runAssistantTurn } = proxyActivities<Pick<typeof activitiesType, 'runAssistantTurn'>>({
  // runAgent pumps heartbeats while the model works, so a dead worker is noticed in minutes.
  heartbeatTimeout: T_2M,
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: T_15M,
});

const { failAssistantReply } = proxyActivities<Pick<typeof activitiesType, 'failAssistantReply'>>({
  retry: RETRY_RUN_RECORD,
  startToCloseTimeout: T_30S,
});

export async function AssistantConversationWorkflow(
  input: AssistantConversationInput
): Promise<void> {
  const queue: AssistantTurnRequest[] = [...(input.pending ?? [])];
  setHandler(assistantTurnSignal, (turn) => {
    queue.push(turn);
  });

  let turns = 0;
  for (;;) {
    if (queue.length === 0 && !(await condition(() => queue.length > 0, IDLE_TIMEOUT))) {
      return;
    }
    const turn = queue.shift() as AssistantTurnRequest;
    try {
      await runAssistantTurn({
        conversationId: input.conversationId,
        replyId: turn.replyId,
        token: turn.token,
        userId: input.userId,
      });
    } catch (err) {
      log.warn('AssistantConversationWorkflow: turn did not complete', {
        conversationId: input.conversationId,
        err: err instanceof Error ? err.message : String(err),
        replyId: turn.replyId,
      });
      try {
        await failAssistantReply({ replyId: turn.replyId });
      } catch {
        // The reply stays open; the panel shows it as still working until it is reloaded.
      }
    }
    turns += 1;
    if (turns >= MAX_TURNS_PER_RUN || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof AssistantConversationWorkflow>({ ...input, pending: queue });
    }
  }
}
