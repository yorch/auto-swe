import { prisma } from '@auto-swe/shared/db';
import type { TicketFailureClass } from '@auto-swe/shared/lib/integrations/ticketFailure';
import type { RepoWorkRequest, RunRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assessSuccessCriteria, NO_CRITERIA_REASON } from '../lib/contextAmbiguity.js';
import { getErrorMessage } from '../lib/errors.js';
import { withHeartbeat } from '../lib/execUtils.js';
import { formatTicketContext, readTicket } from '../lib/ticketContext.js';
import { resolveTicketContext } from '../lib/ticketFallback.js';
import { runAgent } from './runAgent.js';

// ── Zod schema for structured output ──

const ContextValidationSchema = z.object({
  successCriteria: z.array(z.string()),
});

export interface ValidateContextResult {
  contextSnapshotId: string;
  successCriteria: string[];
  /** False when validation found nothing to verify but ambiguities, or nothing at all. A template can stop on it. */
  actionable: boolean;
  /** The ambiguity reasons, `AMBIGUOUS:` marker removed. */
  ambiguities: string[];
}

// ── Thin requests and refused tracker credentials ──

/**
 * A request is "thin" only when, once the ticket key and the punctuation and whitespace around what
 * is left are removed, BOTH hold: it has fewer than {@link THIN_REQUEST_MAX_TOKENS}
 * whitespace-separated tokens AND fewer than {@link THIN_REQUEST_MAX_CHARS} characters (Unicode
 * code points), and it has no acceptance-criteria-like structure (see {@link isThinRequest}).
 * Deliberately narrow: the cost of a false "thin" is stopping a run that could have proceeded, so
 * a substantive request must still reach the model. "Vuln UIP-15211" (1 token) is thin; a
 * three-word request ("Add dark mode", "Enable CSP headers"), a single long token such as a URL,
 * and a CJK sentence (no spaces, but 16+ characters) are not.
 */
export const THIN_REQUEST_MAX_TOKENS = 3;
export const THIN_REQUEST_MAX_CHARS = 16;

/** A line that starts a list item or a checkbox, or opens with "acceptance" or "criteria". */
const STRUCTURED_LINE = /^\s*(?:[-*+•]\s|\d+[.)]\s|\[[ xX]?\]|acceptance|criteria)/im;

/** The tracker classes that mean its credentials are refused: the only ones that can skip the validator. */
const AUTH_REFUSED_CLASSES: readonly TicketFailureClass[] = ['unauthorized', 'forbidden'];

/**
 * True when the request text says too little to validate on its own: after removing the ticket key
 * (every occurrence, any case) and the punctuation, symbols and whitespace at both ends, it has
 * fewer than {@link THIN_REQUEST_MAX_TOKENS} whitespace-separated tokens and fewer than
 * {@link THIN_REQUEST_MAX_CHARS} characters, and no line starts a list item or says "acceptance" or
 * "criteria". Both limits must hold: 3 tokens, or 16 characters, is not thin. Empty and
 * whitespace-only text is thin.
 */
export function isThinRequest(text: string, ticketKey?: string): boolean {
  if (STRUCTURED_LINE.test(text)) {
    return false;
  }
  const withoutKey = ticketKey
    ? text.replace(new RegExp(ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
    : text;
  const core = withoutKey.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
  const tokens = core === '' ? 0 : core.split(/\s+/).length;
  return tokens < THIN_REQUEST_MAX_TOKENS && [...core].length < THIN_REQUEST_MAX_CHARS;
}

/**
 * The text the submitter typed, or null for a structured-payload request, which is never thin.
 * Only `description` counts: on every real launch (API, Slack modal, schedules, automations,
 * webhooks) `requestPayload` is a JSON envelope of the whole request, so joining it in would make
 * every request one long token and never thin. It is used only when there is no description, and
 * then it is JSON, so not thin, and the model sees it.
 */
function requestText(request: RunRequest): string | null {
  if (request.payload != null) {
    return null;
  }
  const legacy = request as RepoWorkRequest;
  return legacy.description?.trim() ? legacy.description : (legacy.requestPayload ?? '');
}

type ThinRequestOutcome =
  | { kind: 'refused'; reason: TicketFailureClass }
  | { kind: 'found'; ticketText: string }
  | { kind: 'proceed' };

/**
 * For a request that is thin and has no ticket from the gatherer step, reads the ticket again (the
 * gatherer's reason is not an input of this step), and only in that narrow case. A ticket found
 * now (the gatherer failed transiently) wins and is returned as plain prompt text; otherwise the
 * class the tracker refused the run's credentials with (`unauthorized` or `forbidden`) means the
 * validator is pointless: it would judge a bare key. Best-effort: anything unclear is `proceed`.
 *
 * The re-read intentionally ignores `workflow.ticketContextFallback`: that setting gates only the
 * fallback read when no gatherer step supplied a ticket.
 *
 * When the re-read finds the ticket and the model still returns not actionable, the stop result
 * carries the gatherer's original `unavailableReason`, so the card may still say the ticket could
 * not be read although validation did read it. Known and left as is.
 */
async function rereadForThinRequest(
  request: RunRequest,
  ticketContext: string | undefined,
  tracer: AgentTracer
): Promise<ThinRequestOutcome> {
  const text = requestText(request);
  if (ticketContext !== '' || text === null) {
    return { kind: 'proceed' };
  }
  if (!isThinRequest(text, (request as RepoWorkRequest).externalTicketId)) {
    return { kind: 'proceed' };
  }
  try {
    const { reason, ticket } = await readTicket({ tracer, workRequestId: request.workRequestId });
    if (ticket) {
      return { kind: 'found', ticketText: formatTicketContext(ticket.issue) };
    }
    return reason && AUTH_REFUSED_CLASSES.includes(reason)
      ? { kind: 'refused', reason }
      : { kind: 'proceed' };
  } catch {
    return { kind: 'proceed' };
  }
}

// ── Context Validator Activity ──

/**
 * Proof-migration for the WS3 `AgentSpec`/`runAgent` foundation: this activity
 * is the first caller of the normalized resolution + generic agent loop. It
 * resolves a tool-free spec for the `validateContext` role and delegates the
 * model call (tracing + cost) to `runAgent`, keeping only the snapshot upsert
 * and the graceful-degradation behavior (an LLM failure yields empty criteria
 * so the workflow can still proceed).
 */
export function buildValidationUserMessage(request: RunRequest, ticketText = ''): string {
  // The tracker ticket rides beside the request, so the criteria reflect what the ticket asks for
  // and not only what the submitter typed.
  const ticket = ticketText ? { ticket: ticketText } : {};
  // Generic workflows supply a structured payload; SWE workflows keep the
  // legacy scalar fields. Prefer the payload when present.
  if (request.payload != null) {
    return JSON.stringify({ payload: request.payload, ...ticket });
  }
  const legacy = request as RepoWorkRequest;
  return JSON.stringify({
    description: legacy.description,
    requestPayload: legacy.requestPayload,
    title: legacy.externalTicketId,
    ...ticket,
  });
}

export async function validateContext(
  workRequest: RunRequest,
  systemPromptOverride?: string,
  ticketContext?: string
): Promise<ValidateContextResult> {
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat(
    'validateContext',
    validateContextImpl(workRequest, systemPromptOverride, ticketContext)
  );
}

async function validateContextImpl(
  workRequest: RunRequest,
  systemPromptOverride?: string,
  ticketContext?: string
): Promise<ValidateContextResult> {
  heartbeat('extracting success criteria');

  const tracer = new AgentTracer();
  const reread = await rereadForThinRequest(workRequest, ticketContext, tracer);
  if (reread.kind === 'refused') {
    // Nothing to validate: the tracker refused its credentials and the request is a bare key. Skip
    // the model call; the stop node already reports the tracker failure from the gatherer's output.
    tracer.addActivityEvent({
      name: 'context_validation.skipped',
      outputJson: { reason: 'ticket_auth_refused', ticketUnavailableReason: reread.reason },
    });
    await persistActivityTrace(tracer, 'validateContext').catch(() => undefined);
    const snapshot = await prisma.contextSnapshot.upsert({
      create: { successCriteria: [], workRequestId: workRequest.workRequestId },
      update: { successCriteria: [] },
      where: { workRequestId: workRequest.workRequestId },
    });
    return {
      actionable: false,
      // Same as `assessSuccessCriteria` for an unactionable result: the stop message lists these.
      ambiguities: [NO_CRITERIA_REASON],
      contextSnapshotId: snapshot.id,
      successCriteria: [],
    };
  }

  const ctx = await currentRequestContext();
  const spec = await resolveAgentSpec(
    {
      agentKey: 'validateContext',
      outputSchema: ContextValidationSchema,
      promptOverride: systemPromptOverride,
    },
    ctx
  );

  const ticketText =
    reread.kind === 'found'
      ? reread.ticketText
      : await resolveTicketContext(ticketContext, {
          ctx,
          tracer,
          workRequestId: workRequest.workRequestId,
        });
  const userMessage = buildValidationUserMessage(workRequest, ticketText);

  let successCriteria: string[] = [];
  let degraded = false;
  try {
    const result = await runAgent<z.infer<typeof ContextValidationSchema>>(spec, userMessage, {
      spanName: 'llm.context_validation',
    });
    successCriteria = result.object?.successCriteria ?? [];
  } catch (err) {
    // A cancelled activity must stop, not persist a snapshot for a run the
    // workflow has already abandoned.
    throwIfActivityCancelled();
    degraded = true;
    // Graceful degradation: empty criteria still allows the workflow to
    // proceed — but say so. Downstream, the domain-logic reviewer checks the
    // diff against these criteria, and an empty list silently turns that check
    // off; an operator reading the run must be able to see why.
    const error = getErrorMessage(err);
    console.warn(
      `[validateContext] success-criteria extraction failed; continuing with none: ${error}`
    );
    tracer.addActivityEvent({
      error,
      name: 'context_validation.degraded',
      outputJson: { successCriteria: 0 },
    });
  }

  // Best-effort: the trace write must not turn a degraded run into a failed one.
  if (tracer.size > 0) {
    await persistActivityTrace(tracer, 'validateContext').catch(() => undefined);
  }

  heartbeat('persisting context snapshot');

  // Upsert to handle Temporal retries idempotently
  const snapshot = await prisma.contextSnapshot.upsert({
    create: {
      successCriteria,
      workRequestId: workRequest.workRequestId,
    },
    update: {
      successCriteria,
    },
    where: { workRequestId: workRequest.workRequestId },
  });

  return {
    contextSnapshotId: snapshot.id,
    successCriteria,
    ...assessSuccessCriteria(successCriteria, { degraded }),
  };
}
