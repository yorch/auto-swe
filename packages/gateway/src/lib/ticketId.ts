import { z } from 'zod';

/**
 * External ticket ids become Temporal workflow ids (`eng-<org>-<repo>-<id>`),
 * git branch names (`auto/<id>`) and dashboard/Slack text verbatim. Bound them
 * to a length Temporal accepts and to characters git refs accept, so a bad id
 * fails validation up front instead of after the ledger rows are written.
 */
export const MAX_TICKET_ID_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 20_000;

const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._#/-]*$/;

export const ExternalTicketIdSchema = z
  .string()
  .min(1)
  .max(MAX_TICKET_ID_LENGTH)
  .regex(TICKET_ID_RE, 'ticket id may only contain letters, digits, ".", "_", "#", "/" and "-"')
  .refine((id) => !id.includes('..') && !id.endsWith('/') && !id.endsWith('.'), {
    message: 'ticket id is not a valid git ref component',
  });
