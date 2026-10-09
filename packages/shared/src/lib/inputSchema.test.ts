import { describe, expect, it } from 'vitest';
import {
  type InputSchema,
  inputSchemaProblems,
  isInputSchema,
  validateInputPayload,
} from './inputSchema.js';

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

  it('enforces number bounds, inclusively', () => {
    const schema: InputSchema = {
      properties: { n: { maximum: 5, minimum: 1, type: 'number' } },
      type: 'object',
    };
    expect(validateInputPayload(schema, { n: 1 })).toEqual({ ok: true });
    expect(validateInputPayload(schema, { n: 5 })).toEqual({ ok: true });
    expect(validateInputPayload(schema, { n: 0 })).toEqual({
      errors: ["'n' must be at least 1"],
      ok: false,
    });
    expect(validateInputPayload(schema, { n: 6 })).toEqual({
      errors: ["'n' must be at most 5"],
      ok: false,
    });
    expect(validateInputPayload(schema, { n: Number.NaN }).ok).toBe(false);
  });

  it('enforces enum membership of array elements', () => {
    const schema: InputSchema = {
      properties: { tags: { items: { enum: ['a', 'b'], type: 'string' }, type: 'array' } },
      type: 'object',
    };
    expect(validateInputPayload(schema, { tags: ['a', 'b'] })).toEqual({ ok: true });
    expect(validateInputPayload(schema, { tags: ['a', 'c'] })).toEqual({
      errors: ["'tags[1]' must be one of: a, b"],
      ok: false,
    });
  });

  it('enforces minItems on a present array', () => {
    const schema: InputSchema = {
      properties: { tags: { items: { type: 'string' }, minItems: 1, type: 'array' } },
      type: 'object',
    };
    expect(validateInputPayload(schema, {})).toEqual({ ok: true });
    expect(validateInputPayload(schema, { tags: [] })).toEqual({
      errors: ["'tags' must have at least 1 item(s)"],
      ok: false,
    });
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

describe('integer and maxItems', () => {
  const schema: InputSchema = {
    properties: {
      n: { integer: true, type: 'number' },
      tags: { items: { type: 'string' }, maxItems: 2, type: 'array' },
    },
    type: 'object',
  };

  it('refuses a fraction for an integer and too many items', () => {
    expect(validateInputPayload(schema, { n: 2, tags: ['a', 'b'] })).toEqual({ ok: true });
    expect(validateInputPayload(schema, { n: 1.5, tags: ['a', 'b', 'c'] })).toEqual({
      errors: ["'n' must be a whole number", "'tags' must have at most 2 item(s)"],
      ok: false,
    });
  });

  it('never matches a string enum by substring', () => {
    const odd = {
      properties: { mode: { enum: 'triage fix', type: 'string' } },
      type: 'object',
    } as unknown as InputSchema;
    expect(validateInputPayload(odd, { mode: 'fix' })).toEqual({ ok: true });
  });
});

describe('inputSchemaProblems', () => {
  it('passes a sound schema', () => {
    expect(inputSchemaProblems(SWE_SCHEMA)).toEqual([]);
  });

  it.each([
    ['an object title', { title: { a: 1 }, type: 'string' }, /title must be a string/],
    [
      'a string items.enum',
      { items: { enum: 'a,b', type: 'string' }, type: 'array' },
      /items.enum/,
    ],
    ['a string enum', { enum: 'a', type: 'string' }, /enum must be a list/],
    ['an unknown type', { type: 'object' }, /type must be one of/],
    ['a text minimum', { minimum: '1', type: 'number' }, /minimum must be a number/],
    ['a fractional minItems', { minItems: 0.5, type: 'array' }, /minItems/],
    ['a default of the wrong type', { default: 'x', type: 'number' }, /default must be a number/],
  ])('reports %s', (_label, prop, re) => {
    const problems = inputSchemaProblems({ properties: { f: prop }, type: 'object' });
    expect(problems.join('\n')).toMatch(re);
  });

  it('reports a schema without the outline', () => {
    expect(inputSchemaProblems({ properties: [] })).toHaveLength(1);
  });
});
