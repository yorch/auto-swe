import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { normalizeAssistantTitle } from '@auto-swe/shared/lib/assistantConversation';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { ownerOfUser, withSpendOwner } from '../lib/spendOwner.js';
import { runAgent } from './runAgent.js';

/**
 * Name an in-app assistant conversation with the `assistantTitler` agent, from the person's
 * messages: the first, and the latest few. The turn activity runs it alongside the reply, so the
 * title is usually written before the reply finishes; resetting a title to automatic runs it at
 * once, through `AssistantTitleWorkflow`.
 *
 * Only a conversation still titled by its first message is named, and the write re-checks that, so
 * a rename the person makes while the model works wins, and a title the model already wrote is
 * never replaced under the person. The agent may decline ("hi" says nothing yet); a turn tries
 * again on the schedule {@link isTitleAttempt} sets. Best-effort: it never throws, and a failure
 * leaves the first-message title in place.
 */

const AGENT_KEY = 'assistantTitler';

/** The person's latest messages the agent is shown, besides their first. */
const RECENT_TITLE_MESSAGES = 3;
/** Longest message the agent is shown. */
const TITLE_MESSAGE_CHARS = 1000;

/**
 * Whether a turn whose user message is the `count`-th tries to name a still-untitled conversation:
 * each of the first three, then the 5th, 10th, 20th and so on, so a conversation that finds its
 * topic late is still named while one that never does costs a call per doubling.
 */
export function isTitleAttempt(count: number): boolean {
  if (count >= 1 && count <= 3) {
    return true;
  }
  if (count < 5 || count % 5 !== 0) {
    return false;
  }
  const doublings = count / 5;
  return (doublings & (doublings - 1)) === 0;
}

export const AssistantTitleSchema = z.object({
  /** Empty when the messages do not yet say what the conversation is about. */
  title: z.string(),
});

export interface NameConversationInput {
  conversationId: string;
  userId: string;
  /** The turn's reply, which the trace rows are tagged with. None when not run by a turn. */
  replyId?: string;
  /** Name it whatever the message count: the person asked for an automatic title. */
  force?: boolean;
}

export type NameConversationResult = 'named' | 'declined' | 'skipped' | 'failed';

function clip(text: string): string {
  return text.length <= TITLE_MESSAGE_CHARS ? text : `${text.slice(0, TITLE_MESSAGE_CHARS)}…`;
}

export async function nameAssistantConversation(
  input: NameConversationInput
): Promise<NameConversationResult> {
  try {
    const conversation = await prisma.assistantConversation.findFirst({
      select: { id: true },
      where: {
        closedAt: null,
        id: input.conversationId,
        titleSource: 'FIRST_MESSAGE',
        userId: input.userId,
      },
    });
    if (!conversation || !(await resolveSetting('assistant.generateTitles'))) {
      return 'skipped';
    }
    const userMessages = { conversationId: conversation.id, role: 'USER' as const };
    const count = await prisma.assistantMessage.count({ where: userMessages });
    if (count === 0 || !(input.force || isTitleAttempt(count))) {
      return 'skipped';
    }
    // The first message, which usually names the topic, then the latest ones, oldest first.
    const [first, recent] = await Promise.all([
      prisma.assistantMessage.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { content: true, id: true },
        where: userMessages,
      }),
      prisma.assistantMessage.findMany({
        orderBy: { createdAt: 'desc' },
        select: { content: true, id: true },
        take: RECENT_TITLE_MESSAGES,
        where: userMessages,
      }),
    ]);
    const latest = recent.reverse().filter((m) => m.id !== first?.id);
    const messages = first ? [first, ...latest] : latest;

    const tracer = new AgentTracer();
    let title: string;
    try {
      const spec = await resolveAgentSpec({
        agentKey: AGENT_KEY as ModelBackedAgentKey,
        outputSchema: AssistantTitleSchema,
      });
      const body = messages.map((m) => `<message>\n${clip(m.content)}\n</message>`).join('\n');
      const result = await runAgent<z.infer<typeof AssistantTitleSchema>>(
        spec,
        `<messages>\n${body}\n</messages>`,
        { maxSteps: 1, spanName: 'llm.assistant_title', tracer }
      );
      const parsed = AssistantTitleSchema.safeParse(result.object);
      if (!parsed.success) {
        throw new Error('the title did not match its schema');
      }
      // Models like to wrap a title in quotes or end it with a full stop; neither belongs in one.
      title = normalizeAssistantTitle(
        parsed.data.title
          .trim()
          .replace(/^["'“‘`]+|["'”’`]+$/g, '')
          .replace(/[.。]+$/, '')
      );
    } finally {
      await persistActivityTrace(
        tracer,
        AGENT_KEY,
        input.replyId ? { assistantMessageId: input.replyId } : {}
      );
    }
    if (title === '') {
      return 'declined';
    }
    const written = await prisma.assistantConversation.updateMany({
      data: { title, titleSource: 'MODEL' },
      where: { closedAt: null, id: conversation.id, titleSource: 'FIRST_MESSAGE' },
    });
    return written.count > 0 ? 'named' : 'skipped';
  } catch (err) {
    logWarn('[assistantTitle] could not name the conversation', {
      conversationId: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

/**
 * The activity `AssistantTitleWorkflow` runs when the person resets a title to automatic: name the
 * conversation now, priced to that person like their turns.
 */
export async function nameAssistantConversationNow(input: {
  conversationId: string;
  userId: string;
}): Promise<NameConversationResult> {
  return withSpendOwner(ownerOfUser(input.userId), () =>
    nameAssistantConversation({ ...input, force: true })
  );
}
