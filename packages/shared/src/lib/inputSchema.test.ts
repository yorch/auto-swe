import { describe, expect, it } from 'vitest';
import { type InputSchema, isInputSchema, validateInputPayload } from './inputSchema.js';

const SWE_SCHEMA: InputSchema = {
  properties: {
    budget: { enum: ['STANDARD', 'LARGE', 'EPIC'], type: 'string' },
    connectionId: { format: 'uuid', type: 'string' },
    description: { type: 'string' },
    ticketId: { type: 'string' },
  },
  required: ['ticketId', 'connectionId', 'description'],
  type: 'object',
};

const VALID = {
  budget: 'STANDARD',
  connectionId: '2c2cfa23-f253-4c05-a21d-e16dda27b552',
  description: 'Add a health endpoint',
  ticketId: 'JIRA-1',
};

describe('validateInputPayload', () => {
  it('accepts a valid SWE payload', () => {
    expect(validateInputPayload(SWE_SCHEMA, VALID)).toEqual({ ok: true });
  });

  it('rejects a non-object payload', () => {
    expect(validateInputPayload(SWE_SCHEMA, 'nope')).toEqual({
      errors: ['payload must be an object'],
      ok: false,
    });
  });

  it('reports every missing required field at once', () => {
    const res = validateInputPayload(SWE_SCHEMA, { budget: 'STANDARD' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toEqual([
        "'ticketId' is required",
        "'connectionId' is required",
        "'description' is required",
      ]);
    }
  });

  it('rejects a wrong scalar type', () => {
    const res = validateInputPayload(SWE_SCHEMA, { ...VALID, ticketId: 42 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain("'ticketId' must be a string (got number)");
    }
  });

  it('enforces uuid format', () => {
    const res = validateInputPayload(SWE_SCHEMA, { ...VALID, connectionId: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain("'connectionId' must be a UUID");
    }
  });

  it('enforces enum membership', () => {
    const res = validateInputPayload(SWE_SCHEMA, { ...VALID, budget: 'HUGE' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain("'budget' must be one of: STANDARD, LARGE, EPIC");
    }
  });

  it('allows unknown extra keys (additive)', () => {
    expect(validateInputPayload(SWE_SCHEMA, { ...VALID, extra: 'fine' })).toEqual({ ok: true });
  });

  it('validates array element types and uuid format', () => {
    const schema: InputSchema = {
      properties: { ids: { items: { format: 'uuid', type: 'string' }, type: 'array' } },
      required: ['ids'],
      type: 'object',
    };
    expect(validateInputPayload(schema, { ids: [VALID.connectionId] })).toEqual({ ok: true });
    const bad = validateInputPayload(schema, { ids: ['x'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toContain("'ids[0]' must be a UUID");
    }
  });

  it('lets a non-SWE template declare its own contract', () => {
    const schema: InputSchema = {
      properties: { quantity: { type: 'number' }, sku: { type: 'string' } },
      required: ['sku'],
      type: 'object',
    };
    expect(validateInputPayload(schema, { quantity: 3, sku: 'ABC' })).toEqual({ ok: true });
    expect(validateInputPayload(schema, { quantity: 3 }).ok).toBe(false);
  });

  it('treats connection-typed fields as UUID strings', () => {
    const schema: InputSchema = {
      properties: {
        connectionId: { connectionType: 'notion', type: 'connection' },
      },
      required: ['connectionId'],
      type: 'object',
    };
    expect(validateInputPayload(schema, { connectionId: VALID.connectionId })).toEqual({
      ok: true,
    });
    const bad = validateInputPayload(schema, { connectionId: 'not-a-uuid' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toContain("'connectionId' must be a valid connection ID (UUID)");
    }
  });
});

describe('isInputSchema', () => {
  it('accepts a well-formed schema', () => {
    expect(isInputSchema(SWE_SCHEMA)).toBe(true);
  });
  it('rejects malformed values', () => {
    expect(isInputSchema(null)).toBe(false);
    expect(isInputSchema({ type: 'array' })).toBe(false);
    expect(isInputSchema({ properties: {}, type: 'object' })).toBe(true);
    expect(isInputSchema('x')).toBe(false);
  });
});
