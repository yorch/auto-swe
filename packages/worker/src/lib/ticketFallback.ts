import { resolveSetting } from '@auto-swe/shared/config';
import type { AgentTracer } from './agentTracer.js';
import type { ResolveCtx } from './config/types.js';
import { loadTicketContext } from './ticketContext.js';

/**
 * The tracker ticket for a step's prompt, from one of two places.
 *
 * A ticket handed in by an earlier step (the context gatherer's `text`) is used as it is, and an
 * empty string means the run has none: neither fetches again. Only when no step provided one, and
 * `workflow.ticketContextFallback` is on, is the ticket fetched here, so templates that predate
 * the gatherer step can still get it. Best-effort throughout: a failing setting read means off, and
 * a failing lookup means no ticket, because neither may fail a step that has its own description.
 */
export async function resolveTicketContext(
  fromStep: string | undefined,
  args: {
    ctx: ResolveCtx;
    tracer?: Pick<AgentTracer, 'addActivityEvent'>;
    workRequestId: string;
  }
): Promise<string> {
  if (fromStep !== undefined) {
    return fromStep;
  }
  const fallback = await resolveSetting('workflow.ticketContextFallback', args.ctx).catch(
    () => false
  );
  if (!fallback) {
    return '';
  }
  return loadTicketContext({ tracer: args.tracer, workRequestId: args.workRequestId }).catch(
    () => ''
  );
}
