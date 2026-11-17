import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';
import { describe, expect, it } from 'vitest';
import { applyTicketErrors, submitPayload, ticketFieldState } from './ticketField';

const schema: InputSchema = {
  properties: { description: { type: 'string' }, ticketId: { type: 'string' } },
  required: ['description'],
  type: 'object',
};

describe('ticketFieldState', () => {
  it('has no ticket rules without a string ticketId', () => {
    const state = ticketFieldState(
      { properties: { description: { type: 'string' } }, type: 'object' },
      {}
    );
    expect(state.hasTicket).toBe(false);
    expect(state.ticketHint).toBeUndefined();
  });
  it('warns when optional and empty, hints when filled', () => {
    expect(ticketFieldState(schema, { ticketId: '' }).ticketHint?.tone).toBe('warning');
    const filled = ticketFieldState(schema, { ticketId: 'A-1' });
    expect(filled.ticketHint?.tone).toBeUndefined();
    expect(filled.descriptionOptional).toBe(true);
  });
  it('keeps description required for an invalid id or a schema without description', () => {
    expect(ticketFieldState(schema, { ticketId: 'a..b' }).descriptionOptional).toBe(false);
    expect(
      ticketFieldState(
        { properties: { ticketId: { type: 'string' } }, type: 'object' },
        {
          ticketId: 'A-1',
        }
      ).descriptionOptional
    ).toBe(false);
  });
  it('gives a required ticket id no optional hint', () => {
    expect(
      ticketFieldState({ ...schema, required: ['ticketId'] }, { ticketId: '' }).ticketHint
    ).toBeUndefined();
  });
});

describe('a preview that found no tracker', () => {
  it('makes the description required again', () => {
    expect(ticketFieldState(schema, { ticketId: 'A-1' }, false).descriptionOptional).toBe(false);
    expect(ticketFieldState(schema, { ticketId: 'A-1' }, true).descriptionOptional).toBe(true);
    expect(
      applyTicketErrors(
        schema,
        { ticketId: 'A-1' },
        { description: 'This field is required' },
        false
      )
    ).toEqual({ description: 'This field is required' });
  });
});

describe('applyTicketErrors', () => {
  it('keeps a description error that is not "required"', () => {
    expect(
      applyTicketErrors(
        schema,
        { ticketId: 'A-1' },
        { description: 'Must be at most 5 characters' }
      )
    ).toEqual({ description: 'Must be at most 5 characters' });
  });

  it('drops the description error for a valid ticket and flags a bad id', () => {
    expect(
      applyTicketErrors(schema, { ticketId: 'A-1' }, { description: 'This field is required' })
    ).toEqual({});
    expect(applyTicketErrors(schema, { ticketId: 'a..b' }, {}).ticketId).toMatch(/valid ticket ID/);
    expect(applyTicketErrors(schema, { ticketId: '' }, { description: 'x' })).toEqual({
      description: 'x',
    });
  });
});

describe('submitPayload', () => {
  it('strips an empty optional ticketId only', () => {
    expect(submitPayload(schema, { description: 'd', ticketId: '' })).toEqual({ description: 'd' });
    expect(submitPayload(schema, { description: 'd', ticketId: 'A-1' })).toEqual({
      description: 'd',
      ticketId: 'A-1',
    });
    expect(submitPayload({ ...schema, required: ['ticketId'] }, { ticketId: '' })).toEqual({
      ticketId: '',
    });
  });
});
