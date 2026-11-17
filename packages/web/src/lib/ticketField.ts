import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { isValidTicketId } from '@auto-swe/shared/lib/ticketId';

export const TICKET_ID_ERROR =
  'Enter a valid ticket ID (letters, digits, ".", "_", "#", "/" and "-")';
export const TICKET_HINT_PRESENT =
  'Names the branch and, when an issue tracker is configured, supplies the ticket as context.';
export const TICKET_WARNING_EMPTY =
  'Without a Ticket ID the run gets no tracker context and posts no ticket comments.';
export const DESCRIPTION_HINT_WITH_TICKET =
  'Optional when a Ticket ID is given — the ticket becomes the brief. Anything you type here takes precedence over the ticket.';
export const TASK_NAME_HINT =
  'Optional. A short name to find this request later; defaults to the first line of the description, or the ticket.';
export const TRACKER_UNREACHABLE = "Couldn't reach the issue tracker. Try again.";

export interface TicketFieldState {
  /** The schema declares a string `ticketId`. */
  hasTicket: boolean;
  /** The schema declares both a string `ticketId` and a string `description`. */
  hasTicketAndDescription: boolean;
  ticketRequired: boolean;
  /** Something has been typed in the ticket id field. */
  ticketFilled: boolean;
  /** The id as typed (the launch sends it untrimmed) passes the shared ticket-id check. */
  ticketValid: boolean;
  /** The ticket stands in for the description: both fields exist and a valid id is filled. */
  descriptionOptional: boolean;
  /** Helper text for the Ticket ID field when it is optional. */
  ticketHint?: { text: string; tone?: 'warning' };
}

function isStringProp(schema: InputSchema | null, key: string) {
  return schema?.properties[key]?.type === 'string';
}

/**
 * `trackerConfigured` is what a preview of the current ticket and repository reported: `false`
 * means no issue tracker is set up, so the ticket cannot become the brief; `null` is not known.
 */
export function ticketFieldState(
  schema: InputSchema | null,
  payload: Record<string, unknown>,
  trackerConfigured: boolean | null = null
): TicketFieldState {
  const hasTicket = isStringProp(schema, 'ticketId');
  const hasTicketAndDescription = hasTicket && isStringProp(schema, 'description');
  const ticketRequired = hasTicket && (schema?.required ?? []).includes('ticketId');
  const raw = typeof payload.ticketId === 'string' ? payload.ticketId : '';
  const ticketFilled = hasTicket && raw !== '';
  const ticketValid = ticketFilled && isValidTicketId(raw);
  let ticketHint: TicketFieldState['ticketHint'];
  if (hasTicket && !ticketRequired) {
    ticketHint = ticketFilled
      ? { text: TICKET_HINT_PRESENT }
      : { text: TICKET_WARNING_EMPTY, tone: 'warning' };
  }
  return {
    descriptionOptional: hasTicketAndDescription && ticketValid && trackerConfigured !== false,
    hasTicket,
    hasTicketAndDescription,
    ticketFilled,
    ticketHint,
    ticketRequired,
    ticketValid,
  };
}

/** Adjusts the generic schema errors for the ticket rules: ticket-id format, description optional. */
export function applyTicketErrors(
  schema: InputSchema | null,
  payload: Record<string, unknown>,
  errors: Record<string, string>,
  trackerConfigured: boolean | null = null
): Record<string, string> {
  const state = ticketFieldState(schema, payload, trackerConfigured);
  const next = { ...errors };
  // Only the "required" error goes: a length or pattern error on typed text stays.
  if (state.descriptionOptional && next.description && /required/i.test(next.description)) {
    delete next.description;
  }
  if (state.ticketFilled && !state.ticketValid) {
    next.ticketId = TICKET_ID_ERROR;
  }
  return next;
}

/** The payload to submit: an empty `ticketId` is dropped unless the schema requires it. */
export function submitPayload(
  schema: InputSchema | null,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const state = ticketFieldState(schema, payload);
  if (state.hasTicket && !state.ticketRequired && payload.ticketId === '') {
    return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'ticketId'));
  }
  return payload;
}
