import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { normalizeAssistantTitle } from '@auto-swe/shared/lib/assistantConversation';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { runAgent } from './runAgent.js';

/**
 * Name an in-app assistant conversation with the `assistantTitler` agent, from the messages the
 * person has sent so far. The turn activity runs it alongside the reply, so the title is usually
 * written before the reply finishes.
 *
 * Only a conversation still titled by its first message is named, and the write re-checks that, so
 * a rename the person makes while the model works wins. The agent may decline ("hi" says nothing
 * yet); the next turn tries again, up to {@link MAX_TITLE_MESSAGES} messages in. Best-effort: it
 * never throws, and a failure leaves the first-message title in place.
 */

const AGENT_KEY = 'assistantTitler';

/** The person's messages the agent is shown; past this many, the conversation keeps its title. */
export const MAX_TITLE_MESSAGES = 3;
/** Longest message the agent is shown. */
const TITLE_MESSAGE_CHARS = 1000;

export const AssistantTitleSchema = z.object({
  /** Empty when the messages do not yet say what the conversation is about. */
  title: z.string(),
});

export interface NameConversationInput {
  conversationId: string;
  userId: string;
  /** The turn's reply, which the trace rows are tagged with. */
  replyId: string;
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
    const messages = await prisma.assistantMessage.findMany({
      orderBy: { createdAt: 'asc' },
      select: { content: true },
      take: MAX_TITLE_MESSAGES + 1,
      where: { conversationId: conversation.id, role: 'USER' },
    });
    if (messages.length === 0 || messages.length > MAX_TITLE_MESSAGES) {
      return 'skipped';
    }

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
      await persistActivityTrace(tracer, AGENT_KEY, { assistantMessageId: input.replyId });
    }
    if (title === '') {
      return 'declined';
    }
    const { count } = await prisma.assistantConversation.updateMany({
      data: { title, titleSource: 'MODEL' },
      where: { closedAt: null, id: conversation.id, titleSource: 'FIRST_MESSAGE' },
    });
    return count > 0 ? 'named' : 'skipped';
  } catch (err) {
    logWarn('[assistantTitle] could not name the conversation', {
      conversationId: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
