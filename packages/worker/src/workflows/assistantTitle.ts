import type { AssistantTitleInput } from '@auto-swe/shared/lib/assistantConversation';
import { proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import { T_2M } from './proxyOptions.js';

/**
 * AssistantTitleWorkflow — name an in-app assistant conversation now, because its user reset the
 * title to automatic. The gateway starts it under `assistant-title-<conversationId>`; a reset while
 * one runs joins it. One activity, not retried: it never throws, and a title it could not write
 * stays the first message's until the user's next turn names it.
 *
 * V8-isolate rule: only `import type` from external packages / activities; runtime imports come
 * from `@temporalio/workflow` and the activity proxy.
 */
const { nameAssistantConversationNow } = proxyActivities<
  Pick<typeof activitiesType, 'nameAssistantConversationNow'>
>({
  retry: { maximumAttempts: 1 },
  startToCloseTimeout: T_2M,
});

export async function AssistantTitleWorkflow(input: AssistantTitleInput): Promise<void> {
  await nameAssistantConversationNow(input);
}
