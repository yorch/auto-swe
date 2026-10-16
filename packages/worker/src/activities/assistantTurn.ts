import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  ASSISTANT_TURN_LOST_DETAIL,
  type AssistantPageContext,
  type AssistantToolStep,
  assistantErrorDetail,
  assistantPageContextSchema,
} from '@auto-swe/shared/lib/assistantConversation';
import { createAssistantTools, summarizeToolResult } from '../agents/assistantTools.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { logError } from '../lib/activityLog.js';
import { AgentTracer, redactString } from '../lib/agentTracer.js';
import { createAssistantGateway } from '../lib/assistantGateway.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { redactToken } from '../lib/redactToken.js';
import { ownerOfUser, withSpendOwner } from '../lib/spendOwner.js';
import { nameAssistantConversation } from './assistantTitle.js';
import { runAgent } from './runAgent.js';

/**
 * One turn of an in-app assistant conversation: answer the user's latest message as the
 * `appAssistant` agent, writing the reply into its row as it is produced so the gateway can stream
 * it to the panel (`docs/adr/in-app-assistant.md` D6).
 *
 * The tools call the gateway with the turn's assistant token and never read the database. This
 * activity does — the conversation it was handed, and nothing else — because it is the platform
 * running the conversation, not the model.
 */

export interface AssistantTurnInput {
  conversationId: string;
  userId: string;
  /** The ASSISTANT row the gateway created PENDING for this turn. */
  replyId: string;
  /** The turn's assistant token. Never logged, never stored. */
  token: string;
}

export interface AssistantTurnResult {
  status: 'COMPLETE' | 'FAILED' | 'SKIPPED';
}

/** Earlier messages sent with a turn; older ones drop off. */
const HISTORY_MESSAGES = 20;
/** Longest earlier message sent with a turn. */
const HISTORY_MESSAGE_CHARS = 4000;
/** How often the growing reply is written back while the model streams. */
const FLUSH_INTERVAL_MS = 250;
/**
 * How long a finished reply waits for the conversation's title before it is marked COMPLETE. The
 * panel re-reads the title when the reply completes, so waiting a little shows it at once; a title
 * that takes longer still lands, and shows on the panel's next read.
 */
const TITLE_WAIT_MS = 10_000;

const AGENT_KEY = 'appAssistant';

const FAILED_TEXT = 'I hit an error answering that. Please try again.';
const BUDGET_TEXT = 'The assistant has reached its spending limit, so it cannot answer right now.';
const MAX_STEPS_NOTE =
  "\n\n_I reached this reply's step limit before finishing. Ask me to continue, or narrow the question._";

/**
 * Accumulates the reply as chunks arrive and writes it back at most every
 * {@link FLUSH_INTERVAL_MS}. Writes are chained, so they land in order and the last one wins.
 */
export class ReplyWriter {
  private text = '';
  private readonly steps: AssistantToolStep[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly write: (content: string, steps: AssistantToolStep[]) => Promise<void>
  ) {}

  get content(): string {
    return this.text;
  }

  get toolSteps(): AssistantToolStep[] {
    return this.steps;
  }

  onChunk(chunk: { type: string; payload?: unknown }): void {
    const p = (chunk.payload ?? {}) as Record<string, unknown>;
    switch (chunk.type) {
      case 'text-delta':
        if (typeof p.text === 'string') {
          this.text += p.text;
        }
        break;
      case 'tool-call':
        if (typeof p.toolCallId === 'string' && typeof p.toolName === 'string') {
          this.steps.push({
            id: p.toolCallId,
            input: p.args ?? {},
            status: 'running',
            tool: p.toolName,
          });
        }
        break;
      case 'tool-result': {
        const step = this.steps.find((s) => s.id === p.toolCallId);
        if (step) {
          step.status = p.isError ? 'error' : 'done';
          step.summary = p.isError ? 'failed' : summarizeToolResult(step.tool, p.result);
        }
        break;
      }
      case 'tool-error': {
        const step = this.steps.find((s) => s.id === p.toolCallId);
        if (step) {
          step.status = 'error';
          step.summary = 'failed';
        }
        break;
      }
      default:
        return;
    }
    this.schedule();
  }

  /** Write now, after any write already queued. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const content = this.text;
    const steps = this.steps.map((s) => ({ ...s }));
    this.chain = this.chain.then(() => this.write(content, steps)).catch(() => undefined);
    return this.chain;
  }

  /** Stop any pending write without making it. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Wait for `promise`, but no longer than `ms`. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

function failureText(err: unknown): string {
  const type = (err as { type?: string } | null)?.type;
  const message = err instanceof Error ? err.message : '';
  if (type === 'BUDGET_EXCEEDED' || message.includes('BUDGET_EXCEEDED')) {
    return BUDGET_TEXT;
  }
  return FAILED_TEXT;
}

export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const reply = await prisma.assistantMessage.findFirst({
    select: { createdAt: true, id: true, status: true },
    where: {
      conversation: { closedAt: null, id: input.conversationId, userId: input.userId },
      id: input.replyId,
      role: 'ASSISTANT',
    },
  });
  // Already answered (a retried activity), or not this conversation's: nothing to do.
  if (!reply || (reply.status !== 'PENDING' && reply.status !== 'STREAMING')) {
    return { status: 'SKIPPED' };
  }

  const earlier = await prisma.assistantMessage.findMany({
    orderBy: { createdAt: 'desc' },
    select: { content: true, pageContext: true, role: true, status: true },
    take: HISTORY_MESSAGES + 1,
    where: { conversationId: input.conversationId, createdAt: { lt: reply.createdAt } },
  });
  const [latest, ...before] = earlier;
  if (latest?.role !== 'USER') {
    await prisma.assistantMessage.update({
      data: { error: FAILED_TEXT, status: 'FAILED' },
      where: { id: reply.id },
    });
    return { status: 'FAILED' };
  }
  const history = before
    .reverse()
    .filter((m) => m.status === 'COMPLETE' && m.content.trim() !== '')
    .map((m) => ({
      content: clip(m.content, HISTORY_MESSAGE_CHARS),
      role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
    }));
  const parsedPage = assistantPageContextSchema.safeParse(latest.pageContext);
  const pageContext: AssistantPageContext | null = parsedPage.success ? parsedPage.data : null;

  await prisma.assistantMessage.update({
    data: { content: '', error: null, status: 'STREAMING', steps: [] },
    where: { id: reply.id },
  });
  // Named alongside the reply, from the person's messages alone, so the title is usually written
  // before the reply finishes. Never throws.
  const titling = withSpendOwner(ownerOfUser(input.userId), () =>
    nameAssistantConversation({
      conversationId: input.conversationId,
      replyId: reply.id,
      userId: input.userId,
    })
  ).catch(() => undefined);
  const writer = new ReplyWriter(async (content, steps) => {
    await prisma.assistantMessage.updateMany({
      data: { content, steps: steps as object[] },
      where: { id: reply.id, status: 'STREAMING' },
    });
  });

  try {
    const result = await withSpendOwner(ownerOfUser(input.userId), async () => {
      const tools = createAssistantTools({
        gateway: createAssistantGateway(input.token),
        pageContext,
      });
      const spec = await resolveAgentSpec({
        agentKey: AGENT_KEY as ModelBackedAgentKey,
        availableTools: tools,
      });
      const maxSteps = await resolveSetting('assistant.maxStepsPerTurn');
      // The turn owns its tracer so its rows carry the reply they were written for: the admin
      // failure view reads them by that, not by a time window. Persisted inside the spend owner's
      // scope, which stamps the rows' owner.
      const tracer = new AgentTracer();
      try {
        return await runAgent(spec, latest.content, {
          history,
          maxSteps,
          onChunk: (chunk) => writer.onChunk(chunk),
          spanName: 'llm.app_assistant',
          tracer,
        });
      } finally {
        await persistActivityTrace(tracer, AGENT_KEY, { assistantMessageId: reply.id });
      }
    });
    await writer.flush();
    let content = result.text ?? writer.content;
    if (result.stoppedReason === 'max_steps') {
      content += MAX_STEPS_NOTE;
    }
    await settleWithin(titling, TITLE_WAIT_MS);
    await prisma.assistantMessage.update({
      data: { content, status: 'COMPLETE', steps: writer.toolSteps as object[] },
      where: { id: reply.id },
    });
    return { status: 'COMPLETE' };
  } catch (err) {
    writer.cancel();
    logError('[assistantTurn] turn failed', {
      conversationId: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
      replyId: reply.id,
    });
    await prisma.assistantMessage.update({
      data: {
        error: failureText(err),
        // Stored for admins, so scrubbed of credential-shaped text and of the turn's own token.
        errorDetail: redactToken(redactString(assistantErrorDetail(err)), input.token),
        status: 'FAILED',
        steps: writer.toolSteps as object[],
      },
      where: { id: reply.id },
    });
    return { status: 'FAILED' };
  } finally {
    await titling;
    await prisma.assistantConversation
      .update({ data: { updatedAt: new Date() }, where: { id: input.conversationId } })
      .catch(() => undefined);
  }
}

/**
 * Mark a reply FAILED when its turn could not run at all (the activity timed out or the worker
 * died), so the panel stops waiting for it. A reply that already finished is left alone.
 */
export async function failAssistantReply(input: { replyId: string }): Promise<void> {
  await prisma.assistantMessage.updateMany({
    data: { error: FAILED_TEXT, errorDetail: ASSISTANT_TURN_LOST_DETAIL, status: 'FAILED' },
    where: { id: input.replyId, status: { in: ['PENDING', 'STREAMING'] } },
  });
}
