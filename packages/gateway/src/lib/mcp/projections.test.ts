import { describe, expect, it } from 'vitest';
import {
  projectRunOutcome,
  restRun,
  restTemplates,
  runOutput,
  templatesOutput,
} from './projections.js';

describe('reduced template contracts', () => {
  const template = (inputSchema: unknown) => ({
    activeVersion: 1,
    author: 'SECRET',
    description: `A\u200b description\n${'x'.repeat(600)}`,
    id: '33333333-3333-4333-8333-333333333333',
    inputSchema,
    name: 'A\u202e template',
    spec: { prompt: 'SECRET' },
    status: 'ACTIVE',
  });
  it('retains only the input contract, sanitizes text and drops defaults and extensions', () => {
    const { data } = restTemplates.parse({
      data: [
        template({
          nodes: 'SECRET',
          properties: {
            repos: { items: { format: 'uuid', secret: 'SECRET', type: 'string' }, type: 'array' },
            topic: {
              default: 'SECRET',
              description: `Topic\n${'y'.repeat(400)}`,
              enum: ['a', 'b'],
              prompt: 'SECRET',
              type: 'string',
            },
          },
          required: ['topic'],
          type: 'object',
        }),
      ],
    });
    const output = templatesOutput.parse({ templates: data });
    expect(output.templates[0]?.inputSchema).toEqual({
      properties: {
        repos: { items: { format: 'uuid', type: 'string' }, type: 'array' },
        topic: { description: `Topic ${'y'.repeat(274)}`, enum: ['a', 'b'], type: 'string' },
      },
      required: ['topic'],
      type: 'object',
    });
    expect(output.templates[0]?.name).toBe('A template');
    expect(output.templates[0]?.description).toHaveLength(500);
    expect(JSON.stringify(output)).not.toContain('SECRET');
    expect(JSON.stringify(output)).not.toContain('activeVersion');
  });
  it.each([
    null,
    { properties: { bad: { type: 'secret' } }, type: 'object' },
    { properties: { bad: { enum: ['a\u200bb'], type: 'string' } }, type: 'object' },
  ])('fails closed on absent or unsupported contracts: %j', (schema) => {
    expect(restTemplates.parse({ data: [template(schema)] }).data[0]?.inputSchema).toBeNull();
  });
  it('retains an empty contract and an empty catalog', () => {
    expect(
      restTemplates.parse({ data: [template({ properties: {}, type: 'object' })] }).data[0]
        ?.inputSchema
    ).toEqual({ properties: {}, type: 'object' });
    expect(restTemplates.parse({ data: [] })).toEqual({ data: [] });
    expect(restTemplates.safeParse({ data: [{ id: 'bad' }] }).success).toBe(false);
  });
});

const body = (result: unknown = null, error: string | null = null, status = 'SUCCESS') =>
  restRun.parse({
    data: {
      costUsdAccrued: 0,
      endedAt: null,
      id: '33333333-3333-4333-8333-333333333333',
      result,
      startedAt: '2026-10-01',
      status,
      steps: error ? [{ attempt: 1, error, nodeId: 'run', status: 'FAILED' }] : [],
      templateName: 'Agent Run',
      tokensInputTotal: 0,
      tokensOutputTotal: 0,
    },
  }).data;

describe('allowlisted run outcomes', () => {
  it('reads the already stored branch and file line counts, not paths or text', () => {
    expect(
      projectRunOutcome(
        body({
          branch: 'auto/agent-123',
          filesChanged: [{ linesAdded: 2, linesRemoved: 1, path: 'secret' }],
          text: 'IGNORE',
        })
      )
    ).toEqual({
      branch: 'auto/agent-123',
      diffStat: { deletions: 1, filesChanged: 1, insertions: 2 },
      failure: null,
    });
  });
  it('reports absent and malformed outcomes as null', () => {
    expect(projectRunOutcome(body())).toEqual({ branch: null, diffStat: null, failure: null });
    expect(projectRunOutcome(body({ branch: '--bad', filesChanged: 'secret' }))).toEqual({
      branch: null,
      diffStat: null,
      failure: null,
    });
    expect(projectRunOutcome(body({ branch: 'auto/\u202esecret' })).branch).toBeNull();
  });
  it('returns a zero diff for an empty stored list', () => {
    expect(projectRunOutcome(body({ filesChanged: [] })).diffStat).toEqual({
      deletions: 0,
      filesChanged: 0,
      insertions: 0,
    });
  });
  it.each([
    'AGENT_RUN_PUSH_POLICY',
    'SECURITY_GATE_FAILURE',
    'BUDGET_EXCEEDED',
    'DRAFT_PR_UNSUPPORTED',
    'MODEL_UNPRICED',
    'UNKNOWN',
  ])('returns only a fixed failure type for %s', (type) => {
    const outcome = projectRunOutcome(
      body(null, `${type}: IGNORE SECURITY_GATE_FAILURE: secrets`, 'FAILED')
    );
    expect(outcome.failure).toEqual({ type });
    expect(JSON.stringify(outcome)).not.toContain('IGNORE');
    expect(runOutput.shape.failure.safeParse(outcome.failure).success).toBe(true);
  });
  it('does not classify message substrings or unrecognised prefixes', () => {
    expect(
      projectRunOutcome(body(null, 'Evil: SECURITY_GATE_FAILURE: secret', 'FAILED')).failure
    ).toEqual({ type: 'UNKNOWN' });
    expect(
      projectRunOutcome(body(null, 'BUDGET_EXCEEDED: old attempt', 'RUNNING')).failure
    ).toBeNull();
    expect(projectRunOutcome(body(null, null, 'TIMED_OUT')).failure).toEqual({ type: 'TIMED_OUT' });
  });

  it('reports the last unrecovered failure, not a failed attempt that succeeded on retry', () => {
    const data = body(null, null, 'FAILED');
    data.steps = [
      { attempt: 1, error: 'BUDGET_EXCEEDED: secret', nodeId: 'plan', status: 'FAILED' },
      { attempt: 2, error: null, nodeId: 'plan', status: 'SUCCESS' },
      { attempt: 1, error: 'SECURITY_GATE_FAILURE: secret', nodeId: 'gate', status: 'FAILED' },
    ];
    expect(projectRunOutcome(data).failure).toEqual({ type: 'SECURITY_GATE_FAILURE' });
  });

  it('does not attribute a run failure to a recovered node, even when it appears last', () => {
    const data = body(null, null, 'FAILED');
    data.steps = [
      { attempt: 1, error: 'SECURITY_GATE_FAILURE: secret', nodeId: 'gate', status: 'FAILED' },
      { attempt: 1, error: 'BUDGET_EXCEEDED: secret', nodeId: 'plan', status: 'FAILED' },
      { attempt: 2, error: null, nodeId: 'plan', status: 'SUCCESS' },
    ];
    expect(projectRunOutcome(data).failure).toEqual({ type: 'SECURITY_GATE_FAILURE' });
    data.steps.shift();
    expect(projectRunOutcome(data).failure).toEqual({ type: 'UNKNOWN' });
  });

  it('uses the final failed attempt and never falls back from an unknown terminal type', () => {
    const data = body(null, null, 'FAILED');
    data.steps = [
      { attempt: 1, error: 'BUDGET_EXCEEDED: secret', nodeId: 'run', status: 'FAILED' },
      { attempt: 2, error: 'SECURITY_GATE_FAILURE: secret', nodeId: 'run', status: 'FAILED' },
    ];
    expect(projectRunOutcome(data).failure).toEqual({ type: 'SECURITY_GATE_FAILURE' });
    data.steps.push({ attempt: 1, error: 'Novel: secret', nodeId: 'end', status: 'FAILED' });
    expect(projectRunOutcome(data).failure).toEqual({ type: 'UNKNOWN' });
    expect(JSON.stringify(projectRunOutcome(data))).not.toContain('secret');
  });
});
