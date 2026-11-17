import { describe, expect, it } from 'vitest';
import {
  declaredConnectionInputs,
  INPUT_PATTERN_MAX_FIELDS,
  type InputSchema,
  inputPatternProblem,
  inputSchemaProblems,
  isInputSchema,
  runAuthorizedConnectionIds,
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

  it('refuses the keys the platform fills from text, as connections', () => {
    // `ticketId` arrives as an external ticket id and `description` as prose — the modal, this
    // API and the automations engine all fill them from text. A schema typing either as a
    // `connection` would make that text the connection the run uses, and the run's authorized set
    // is derived from the payload, so no launch path would notice.
    for (const key of ['ticketId', 'description']) {
      expect(
        inputSchemaProblems({
          properties: { [key]: { type: 'connection' } },
          type: 'object',
        }).join('\n')
      ).toMatch(new RegExp(`${key}.*may not be a connection`));
    }
  });

  it.each(['http_api', 'hubspot'])('allows a connection input typed %s', (connectionType) => {
    expect(
      inputSchemaProblems({
        properties: { target: { connectionType, type: 'connection' } },
        type: 'object',
      })
    ).toEqual([]);
  });

  it('still allows connectionId as a connection, which is the run’s own', () => {
    expect(
      inputSchemaProblems({
        properties: { connectionId: { connectionType: 'git_repo', type: 'connection' } },
        type: 'object',
      })
    ).toEqual([]);
  });
});

describe('declaredConnectionInputs', () => {
  const schema: InputSchema = {
    properties: {
      connectionId: { connectionType: 'issue_tracker', type: 'connection' },
      docConnectionId: { connectionType: 'confluence', type: 'connection' },
      issueId: { type: 'string' },
    },
    required: ['connectionId'],
    type: 'object',
  };

  it('reports every connection-typed field the payload fills', () => {
    expect(
      declaredConnectionInputs(schema, {
        connectionId: 'jira-1',
        docConnectionId: 'wiki-1',
        issueId: 'P-1',
      })
    ).toEqual([
      { connectionId: 'jira-1', expectedType: 'issue_tracker', field: 'connectionId' },
      { connectionId: 'wiki-1', expectedType: 'confluence', field: 'docConnectionId' },
    ]);
  });

  it('reports nothing for a field the payload omits or leaves empty', () => {
    expect(declaredConnectionInputs(schema, { issueId: 'P-1' })).toEqual([]);
    expect(declaredConnectionInputs(schema, { docConnectionId: '' })).toEqual([]);
    expect(declaredConnectionInputs(schema, { docConnectionId: 42 })).toEqual([]);
  });

  it('reports nothing without a schema or a payload object', () => {
    expect(declaredConnectionInputs(null, { docConnectionId: 'wiki-1' })).toEqual([]);
    expect(declaredConnectionInputs(schema, null)).toEqual([]);
    expect(declaredConnectionInputs(schema, ['wiki-1'])).toEqual([]);
  });

  it('leaves the expected type off a field that names none', () => {
    const open: InputSchema = {
      properties: { any: { type: 'connection' } },
      type: 'object',
    };
    expect(declaredConnectionInputs(open, { any: 'conn-1' })).toEqual([
      { connectionId: 'conn-1', field: 'any' },
    ]);
  });
});

describe('runAuthorizedConnectionIds', () => {
  const schema: InputSchema = {
    properties: {
      connectionId: { connectionType: 'issue_tracker', type: 'connection' },
      docConnectionId: { connectionType: 'confluence', type: 'connection' },
    },
    type: 'object',
  };

  it('is the run’s own connection plus every declared field the payload fills', () => {
    expect(
      runAuthorizedConnectionIds({
        inputSchema: schema,
        payload: { connectionId: 'jira-1', docConnectionId: 'wiki-1' },
        workspaceConnectionId: 'jira-1',
      })
    ).toEqual(['jira-1', 'wiki-1']);
  });

  it('does not repeat the workspace connection', () => {
    expect(
      runAuthorizedConnectionIds({
        inputSchema: schema,
        payload: { connectionId: 'jira-1' },
        workspaceConnectionId: 'jira-1',
      })
    ).toEqual(['jira-1']);
  });

  it('authorizes only the workspace connection when the payload names none', () => {
    expect(
      runAuthorizedConnectionIds({
        inputSchema: schema,
        payload: {},
        workspaceConnectionId: 'jira-1',
      })
    ).toEqual(['jira-1']);
  });

  it('is empty for a run with no connection and no declared field', () => {
    // Distinct from "no pin": the run was resolved, and it may use nothing.
    expect(
      runAuthorizedConnectionIds({ inputSchema: schema, payload: {}, workspaceConnectionId: null })
    ).toEqual([]);
    expect(
      runAuthorizedConnectionIds({ inputSchema: null, payload: null, workspaceConnectionId: null })
    ).toEqual([]);
  });
});

describe('string maxLength and pattern', () => {
  const schema = (prop: Record<string, unknown>) =>
    ({ properties: { v: { type: 'string', ...prop } }, type: 'object' }) as InputSchema;
  /** `pre`, then as many `unit`s as fit in the longest accepted source, then `post`. */
  const fill = (pre: string, unit: string, post: string) => {
    let s = pre;
    while ((s + unit + post).length <= 200) {
      s += unit;
    }
    return s + post;
  };

  it('accepts a conforming value and fully anchors the pattern', () => {
    const s = schema({ maxLength: 20, pattern: '[a-z]+-\\d{2}' });
    expect(validateInputPayload(s, { v: 'abc-12' })).toEqual({ ok: true });
    expect(validateInputPayload(s, { v: 'xabc-12!' }).ok).toBe(false);
  });

  it('rejects an over-long value without echoing it', () => {
    const r = validateInputPayload(schema({ maxLength: 5 }), { v: 'secretvalue' });
    expect(r).toEqual({ errors: ["'v' must be at most 5 characters"], ok: false });
  });

  it('applies maxLength, but not a pattern, to array items', () => {
    const s = {
      properties: { v: { items: { maxLength: 5, type: 'string' }, type: 'array' } },
      type: 'object',
    } as InputSchema;
    expect(inputSchemaProblems(s)).toEqual([]);
    expect(validateInputPayload(s, { v: ['abc'] })).toEqual({ ok: true });
    expect(validateInputPayload(s, { v: ['abcdef'] }).ok).toBe(false);

    const patterned = {
      properties: { v: { items: { pattern: 'CVE-\\d+', type: 'string' }, type: 'array' } },
      type: 'object',
    };
    expect(inputSchemaProblems(patterned)).toEqual([
      "'v': items.pattern is not supported (an array has no bound on its item count); constrain items with enum or maxLength",
    ]);
    // A stored one (saved before the check, or written around it) fails closed, once per field.
    const r = validateInputPayload(patterned as InputSchema, { v: ['CVE-1', 'CVE-2'] });
    expect(r).toEqual({
      errors: [
        "'v' cannot be checked: the template's input schema declares a pattern on array items, which is not supported; fix the schema",
      ],
      ok: false,
    });
  });

  it('does not run an adversarial pattern: (a+)+$ is refused at save', () => {
    expect(inputSchemaProblems(schema({ pattern: '(a+)+$' }))[0]).toMatch(/groups or alternation/);
  });

  it('refuses at save the exponential patterns that passed the old checker', () => {
    const attacks = [
      `${'\\w{0,10}'.repeat(8)}!`,
      `${'\\w{0,10}'.repeat(10)}!`,
      `${'\\w{0,5}'.repeat(14)}!`,
      `${'.{0,10}'.repeat(8)}!`,
      `${'a?'.repeat(60)}a{60}!`,
      'a+a+a+$',
      '\\w?\\w?\\w?',
      'a{1,2}b{1,2}c{1,2}',
      'a{2,}b*c+',
      // Two varying quantifiers and a run of exact blocks: cubic in the value's length.
      fill('a*a*', '[a]{6}', 'b'),
      fill('.*.*', '.{6}', 'b'),
      fill('a*a*', '\\w{4}', 'b'),
      fill('a*a*', 'a{9}', 'b'),
      '\\w*\\w*!',
      'a?a*!',
    ];
    for (const pattern of attacks) {
      expect(inputPatternProblem(pattern), pattern).toMatch(/quantifiers whose count varies/);
      expect(inputSchemaProblems(schema({ pattern })).length, pattern).toBeGreaterThan(0);
    }
    const items = {
      properties: { v: { items: { pattern: '\\w*\\w*\\w*!', type: 'string' }, type: 'array' } },
      type: 'object',
    };
    expect(inputSchemaProblems(items)[0]).toMatch(/items.pattern is not supported/);
  });

  it('counts a lazy quantifier once and an exact count not at all', () => {
    expect(inputPatternProblem('a*?')).toBeNull();
    expect(inputPatternProblem('\\d{4}-\\d{4}-\\d{2,4}x{3,3}')).toBeNull();
    expect(inputPatternProblem('a*?b+?')).toMatch(/has 2 quantifiers/);
    expect(inputPatternProblem('a*?b+?c??')).toMatch(/has 3 quantifiers/);
  });

  it('refuses a pattern the engine would not compile', () => {
    expect(inputPatternProblem('a{2,1}')).not.toBeNull();
    expect(inputPatternProblem('a{2}{3}')).not.toBeNull();
  });

  it('runs the worst accepted shapes over a 256-character adversarial value in well under 20 ms', () => {
    // One varying quantifier, then as many exact blocks as fit, then a character that never
    // matches: the engine tries every length of the quantifier, and each try reads the rest.
    const worst = [
      fill('[a-z]{0,256}', '.{4}', 'b'),
      fill('.{0,255}', '\\w{6}', 'b'),
      fill('a*', '[\\s\\S]{1000}', 'b'),
      fill('\\w*', '[a-zA-Z0-9._-]{2}', 'b'),
      fill('', 'a{6}', '.*b'),
      fill('a*?', '[^b]{9}', '$b'),
    ];
    for (const pattern of worst) {
      // A fresh copy, so the first call compiles the expression and runs it cold.
      const s = schema({ maxLength: 256, pattern });
      expect(inputSchemaProblems(s), pattern).toEqual([]);
      for (const value of ['a'.repeat(256), `${'ab'.repeat(127)}a!`]) {
        const t = performance.now();
        expect(validateInputPayload(s, { v: value })).toEqual({
          errors: ["'v' does not match the required pattern"],
          ok: false,
        });
        expect(performance.now() - t, pattern).toBeLessThan(20);
      }
    }
  });

  it(`refuses more than ${INPUT_PATTERN_MAX_FIELDS} patterned properties, and the most allowed check fast`, () => {
    const properties: Record<string, unknown> = {};
    const payload: Record<string, string> = {};
    for (let i = 0; i < INPUT_PATTERN_MAX_FIELDS; i++) {
      // A distinct source per field, so no field reuses another's compiled expression.
      properties[`f${i}`] = {
        maxLength: 256,
        pattern: fill(`[a-z]{0,${200 + i}}`, '.{4}', 'b'),
        type: 'string',
      };
      payload[`f${i}`] = 'a'.repeat(256);
    }
    const full = { properties, type: 'object' } as InputSchema;
    expect(inputSchemaProblems(full)).toEqual([]);
    const t = performance.now();
    const r = validateInputPayload(full, payload);
    expect(performance.now() - t).toBeLessThan(50);
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors).toHaveLength(INPUT_PATTERN_MAX_FIELDS);

    const over = {
      properties: { ...properties, extra: { pattern: 'x', type: 'string' } },
      type: 'object',
    };
    expect(inputSchemaProblems(over)).toEqual([
      `${INPUT_PATTERN_MAX_FIELDS + 1} properties declare a pattern; the maximum is ${INPUT_PATTERN_MAX_FIELDS} ('extra' over the limit)`,
    ]);
    // Stored anyway: the patterns past the cap are not run, and a value for one is refused.
    const stored = over as InputSchema;
    expect(validateInputPayload(stored, { extra: 'x' })).toEqual({
      errors: [
        `'extra' cannot be checked: the template's input schema declares a pattern on more than ${INPUT_PATTERN_MAX_FIELDS} properties; fix the schema`,
      ],
      ok: false,
    });
    expect(validateInputPayload(stored, { f0: 'a'.repeat(200) }).ok).toBe(false);
    expect(validateInputPayload(stored, {})).toEqual({ ok: true });
  });

  it('fails closed, rather than throwing, on a stored property that is null', () => {
    const stored = { properties: { v: null }, type: 'object' } as unknown as InputSchema;
    expect(inputSchemaProblems(stored)).toEqual(["'v': must be an object"]);
    expect(validateInputPayload(stored, { v: 'x' })).toEqual({
      errors: ["'v' cannot be checked: the template's input schema does not describe it"],
      ok: false,
    });
    expect(validateInputPayload(stored, {})).toEqual({ ok: true });
  });

  it('fails closed, naming the schema, on a stored pattern outside the subset', () => {
    // Saved before the subset was enforced: never compiled, never run, and every value refused.
    const stored = schema({ pattern: '^(CVE|GHSA)-\\d+$' });
    expect(inputSchemaProblems(stored).length).toBeGreaterThan(0);
    expect(validateInputPayload(stored, { v: 'CVE-1' })).toEqual({
      errors: [
        "'v' cannot be checked: the template's input schema declares a pattern this platform does not run; fix the schema",
      ],
      ok: false,
    });
  });

  it('refuses bad schemas at save', () => {
    for (const bad of [
      { pattern: '[' },
      { pattern: 'a'.repeat(201) },
      { pattern: '' },
      { pattern: '(a)\\1' },
      { pattern: 'a|b' },
      { pattern: 'a+b+c+d+' },
      { pattern: 'a+b+c+' },
      { pattern: 12 },
      { maxLength: 1.5 },
      { maxLength: 0 },
      { maxLength: 1001 },
      { maxLength: 300, pattern: 'a' },
    ]) {
      expect(inputSchemaProblems(schema(bad)).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
    expect(
      inputSchemaProblems({
        properties: { n: { maxLength: 3, type: 'number' } },
        type: 'object',
      })
    ).toEqual(["'n': maxLength applies only to a string"]);
  });

  it('leaves existing schemas unchanged', () => {
    expect(inputSchemaProblems(SWE_SCHEMA)).toEqual([]);
    expect(validateInputPayload(SWE_SCHEMA, VALID)).toEqual({ ok: true });
  });
});
