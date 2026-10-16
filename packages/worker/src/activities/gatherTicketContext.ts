import type { ModelBackedAgentKey } from '@auto-swe/shared/agentKeys';
import type { RunRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { getErrorMessage } from '../lib/errors.js';
import { withHeartbeat } from '../lib/execUtils.js';
import {
  formatTicketContext,
  formatTicketDigest,
  loadTicket,
  type TicketDigest,
  TicketDigestSchema,
} from '../lib/ticketContext.js';
import { runAgent } from './runAgent.js';

export interface TicketContextResult {
  /** A tracker ticket was found for the run. */
  available: boolean;
  /** The gatherer produced a digest; false means `text` is the plain ticket. */
  digested: boolean;
  /** The ticket as a prompt block, for the steps that take it as an input; '' when unavailable. */
  text: string;
}

const NO_TICKET: TicketContextResult = { available: false, digested: false, text: '' };

/**
 * The context-gatherer step: the tracker ticket behind a run (with its newest comments and its
 * parent issue), digested by the `ticketContextGatherer` agent into one typed result.
 *
 * The fetch is deterministic and bounded; the agent has no tools, so it reads only the text it is
 * given and cannot be steered into acting on a tracker with the platform's token. It returns one
 * structured digest, which is rendered in front of the original description. When the agent fails
 * the run continues with the plain ticket, and the trace says so. A run with no ticket (none
 * named, a platform-generated id, no tracker configured, not found) returns `available: false`
 * without a model call. Only a cancellation stops the activity.
 */
export async function gatherTicketContext(
  workRequest: RunRequest,
  systemPromptOverride?: string
): Promise<TicketContextResult> {
  return withHeartbeat('gatherTicketContext', gatherImpl(workRequest, systemPromptOverride));
}

async function gatherImpl(
  workRequest: RunRequest,
  systemPromptOverride?: string
): Promise<TicketContextResult> {
  heartbeat('reading the tracker ticket');
  const tracer = new AgentTracer();
  try {
    const loaded = await loadTicket({
      rich: true,
      tracer,
      workRequestId: workRequest.workRequestId,
    });
    if (!loaded) {
      return NO_TICKET;
    }

    heartbeat('digesting the ticket');
    let digest: TicketDigest | null = null;
    try {
      const spec = await resolveAgentSpec(
        {
          agentKey: 'ticketContextGatherer' as ModelBackedAgentKey,
          outputSchema: TicketDigestSchema,
          promptOverride: systemPromptOverride,
        },
        await currentRequestContext()
      );
      const result = await runAgent<TicketDigest>(spec, formatTicketContext(loaded.issue), {
        spanName: 'llm.ticket_context',
      });
      const parsed = TicketDigestSchema.safeParse(result.object);
      if (!parsed.success) {
        throw new Error('the digest did not match its schema');
      }
      digest = parsed.data;
    } catch (err) {
      // A cancelled activity must stop, not return a result for a run already abandoned.
      throwIfActivityCancelled();
      tracer.addActivityEvent({
        error: getErrorMessage(err),
        name: 'ticket.digest_degraded',
        outputJson: { ticketId: loaded.ticketId },
      });
    }

    const text = formatTicketDigest(loaded.issue, digest);
    return { available: text !== '', digested: digest !== null, text };
  } finally {
    // Best-effort: a trace write must not fail a run.
    if (tracer.size > 0) {
      await persistActivityTrace(tracer, 'gatherTicketContext').catch(() => undefined);
    }
  }
}
