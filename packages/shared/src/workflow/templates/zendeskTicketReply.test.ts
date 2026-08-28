import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
import { ZENDESK_TICKET_REPLY_SPEC } from './zendeskTicketReply.js';

describe('ZENDESK_TICKET_REPLY_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    const result = WorkflowSpecSchema.safeParse(ZENDESK_TICKET_REPLY_SPEC);
    expect(result.success).toBe(true);
  });
});
