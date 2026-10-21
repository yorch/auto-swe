import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createManyMock } = vi.hoisted(() => ({ createManyMock: vi.fn() }));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { agentTrace: { createMany: createManyMock } },
}));

import { AgentTracer } from './agentTracer.js';

beforeEach(() => {
  createManyMock.mockReset().mockResolvedValue({ count: 1 });
});

describe('AgentTracer.persist', () => {
  it('writes runless traces keyed by workflowId instead of dropping them', async () => {
    const tracer = new AgentTracer();
    tracer.addLlmResponse({ costUsd: 0.01, durationMs: 5, model: 'anthropic/x', role: 'r' });

    await tracer.persist({ runId: undefined, workflowId: 'wf-author-1' }, 'generateSpec', 'r', 1);

    expect(createManyMock).toHaveBeenCalledWith({
      data: [expect.objectContaining({ costUsd: 0.01, runId: null, workflowId: 'wf-author-1' })],
      skipDuplicates: true,
    });
  });

  it('writes the spend owner it is given, and NULL when it is given none', async () => {
    const tracer = new AgentTracer();
    tracer.addLlmResponse({ costUsd: 0.01, durationMs: 5, role: 'r' });
    await tracer.persist(
      { orgId: 'o1', runId: 'run-1', teamId: 't1', workflowId: 'wf-1' },
      'n',
      'r'
    );
    tracer.addLlmResponse({ costUsd: 0.01, durationMs: 5, role: 'r' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'r');
    expect(createManyMock.mock.calls[0]?.[0].data[0]).toMatchObject({ orgId: 'o1', teamId: 't1' });
    expect(createManyMock.mock.calls[1]?.[0].data[0]).toMatchObject({ orgId: null, teamId: null });
  });

  it('stamps the assistant reply it is given, and NULL when it is given none', async () => {
    const tracer = new AgentTracer();
    tracer.addLlmResponse({ durationMs: 5, role: 'r' });
    await tracer.persist(
      { assistantMessageId: 'reply-1', runId: undefined, workflowId: 'w' },
      'n',
      'r'
    );
    tracer.addLlmResponse({ durationMs: 5, role: 'r' });
    await tracer.persist({ runId: undefined, workflowId: 'w' }, 'n', 'r');
    expect(createManyMock.mock.calls[0]?.[0].data[0]).toMatchObject({
      assistantMessageId: 'reply-1',
    });
    expect(createManyMock.mock.calls[1]?.[0].data[0]).toMatchObject({ assistantMessageId: null });
  });

  it('records the spec node, recording id and step attempt it was given', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'e' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'runLint', 'a', 2, {
      recordingId: 'fan[1]/lint',
      specNodeId: 'lint',
      stepAttempt: 3,
    });
    expect(createManyMock).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          attempt: 2,
          nodeId: 'runLint',
          recordingId: 'fan[1]/lint',
          specNodeId: 'lint',
          stepAttempt: 3,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('writes NULL attribution when the activity was not dispatched for a node', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'e' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    expect(createManyMock).toHaveBeenCalledWith({
      data: [expect.objectContaining({ recordingId: null, specNodeId: null, stepAttempt: null })],
      skipDuplicates: true,
    });
  });

  it('attaches the run when one exists', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'e' });

    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');

    expect(createManyMock).toHaveBeenCalledWith({
      data: [expect.objectContaining({ runId: 'run-1', workflowId: 'wf-1' })],
      skipDuplicates: true,
    });
  });

  it('writes nothing for an empty batch', async () => {
    await new AgentTracer().persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('swallows DB errors', async () => {
    createManyMock.mockRejectedValue(new Error('db down'));
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'e' });

    await expect(tracer.persist({ runId: undefined, workflowId: 'wf-1' }, 'n', 'a')).resolves.toBe(
      false
    );
  });

  it('drops only what it wrote, so a second persist writes nothing twice', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'a' });
    tracer.addActivityEvent({ name: 'b' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    expect(tracer.size).toBe(0);

    tracer.addActivityEvent({ name: 'c' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');

    const names = createManyMock.mock.calls.flatMap(([arg]) =>
      (arg.data as { toolName: string }[]).map((r) => r.toolName)
    );
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('keeps the records buffered when the write fails, and writes them next time', async () => {
    createManyMock.mockRejectedValueOnce(new Error('db down'));
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'a' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    expect(tracer.size).toBe(1);

    tracer.addActivityEvent({ name: 'b' });
    await expect(tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a')).resolves.toBe(
      true
    );
    expect(
      createManyMock.mock.calls[1]?.[0].data.map((r: { toolName: string }) => r.toolName)
    ).toEqual(['a', 'b']);
    expect(tracer.size).toBe(0);
  });

  it('keeps a record added while a write is in flight', async () => {
    let release: () => void = () => {};
    createManyMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ count: 1 })))
    );
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'a' });
    const pending = tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    tracer.addActivityEvent({ name: 'b' });
    release();
    await pending;

    expect(tracer.size).toBe(1);
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    expect(createManyMock.mock.calls[1]?.[0].data[0].toolName).toBe('b');
  });

  it('numbers each batch from its seqOffset, whatever was flushed before', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'a' });
    tracer.addActivityEvent({ name: 'b' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a', 1, undefined, 0);
    tracer.addActivityEvent({ name: 'c' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a', 1, undefined, 2);

    const seqs = createManyMock.mock.calls.flatMap(([arg]) =>
      (arg.data as { seq: number }[]).map((r) => r.seq)
    );
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('re-sends the same ids with skipDuplicates after an ambiguous failure', async () => {
    // The first write may have committed although the client saw an error.
    createManyMock.mockRejectedValueOnce(new Error('connection reset'));
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'a' });
    tracer.addActivityEvent({ name: 'b' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');

    const [first, second] = createManyMock.mock.calls.map(([arg]) => arg);
    const ids = (arg: { data: { id: string }[] }) => arg.data.map((r) => r.id);
    expect(first.skipDuplicates).toBe(true);
    expect(second.skipDuplicates).toBe(true);
    expect(ids(first)).toHaveLength(2);
    expect(new Set(ids(first)).size).toBe(2);
    expect(ids(second)).toEqual(ids(first));
  });

  it('notifies a listener for every record added', () => {
    const tracer = new AgentTracer();
    const listener = vi.fn();
    tracer.onRecord(listener);
    tracer.addToolCall({ durationMs: 1, inputJson: {}, toolName: 't' });
    tracer.addLlmResponse({ durationMs: 1 });
    tracer.addActivityEvent({ name: 'e' });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('a throwing listener never breaks recording', () => {
    const tracer = new AgentTracer();
    tracer.onRecord(() => {
      throw new Error('boom');
    });
    expect(() => tracer.addActivityEvent({ name: 'e' })).not.toThrow();
    expect(tracer.size).toBe(1);
  });

  it('reports whether a span context was attached', () => {
    const tracer = new AgentTracer();
    expect(tracer.hasSpanContext()).toBe(false);
    tracer.setSpanContext('t', 's');
    expect(tracer.hasSpanContext()).toBe(true);
  });
});

describe('redactString / redactJsonValues', () => {
  it('redacts credential-shaped values wherever they appear', async () => {
    const { redactString } = await import('./agentTracer.js');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----';
    expect(redactString(pem)).toBe('***');
    expect(redactString(`key is sk-ant-${'a'.repeat(30)}`)).toBe('key is ***');
    expect(redactString(`sk-proj-${'b'.repeat(40)}`)).toBe('***');
    expect(redactString(`sk-${'c'.repeat(40)}`)).toBe('***');
    expect(redactString(`ghp_${'d'.repeat(40)}`)).toBe('***');
    expect(redactString(`github_pat_${'e'.repeat(30)}`)).toBe('***');
    expect(redactString(`xoxb-${'f'.repeat(12)}-more`)).toBe('***');
    expect(redactString(`AKIA${'G'.repeat(16)}`)).toBe('***');
    expect(redactString(`AIza${'h'.repeat(35)}`)).toBe('***');
    expect(redactString(`eyJ${'i'.repeat(12)}.eyJ${'j'.repeat(12)}.${'k'.repeat(12)}`)).toBe('***');
    // Left boundary: a secret prefix inside a longer identifier is not a secret.
    expect(redactString('task-1f2e3d4c-5b6a-7980-1234-567890abcdef')).toBe(
      'task-1f2e3d4c-5b6a-7980-1234-567890abcdef'
    );
    expect(redactString('risk-assessment-sk-abcdefgh0123456789abcdefgh01')).toBe(
      'risk-assessment-sk-abcdefgh0123456789abcdefgh01'
    );
    expect(redactString(`key=sk-proj-${'b'.repeat(40)}`)).toBe('key=***');
    expect(redactString('secret_access_key=abc123')).toBe('secret_access_key=***');
    expect(redactString('private_key: xyz')).toBe('private_key: ***');
    expect(redactString('password=hunter2')).toBe('password=***');
  });

  it('redacts sensitive keys by suffix and leaves usage counters alone', async () => {
    const { redactJsonValues } = await import('./agentTracer.js');
    const out = redactJsonValues({
      AWS_SECRET_ACCESS_KEY: 'x',
      anthropic_api_key: 'x',
      budget_tokens: 5,
      cache_creation_input_tokens: 5,
      GITHUB_APP_PRIVATE_KEY: 'x',
      input_tokens: 5,
      keys: ['a'],
      max_tokens: 5,
      next_page_token: 'x',
      output_tokens: 5,
      tool_key: 'keep',
      total_tokens: 5,
    }) as Record<string, unknown>;
    expect(out.AWS_SECRET_ACCESS_KEY).toBe('***');
    expect(out.anthropic_api_key).toBe('***');
    expect(out.GITHUB_APP_PRIVATE_KEY).toBe('***');
    expect(out.next_page_token).toBe('***');
    expect(out.max_tokens).toBe(5);
    expect(out.input_tokens).toBe(5);
    expect(out.output_tokens).toBe(5);
    expect(out.cache_creation_input_tokens).toBe(5);
    expect(out.total_tokens).toBe(5);
    expect(out.budget_tokens).toBe(5);
    expect(out.tool_key).toBe('keep');
    expect(out.keys).toEqual(['a']);
  });

  it('keeps object shape under a sensitive key while redacting nested secrets', async () => {
    const { redactJsonValues } = await import('./agentTracer.js');
    const out = redactJsonValues({
      properties: { token: { type: 'string' } },
      tools: [{ parameters: { api_key: 'secret-val', name: 'x' } }],
    }) as { properties: unknown; tools: { parameters: Record<string, unknown> }[] };
    expect(out.properties).toEqual({ token: { type: 'string' } });
    expect(out.tools[0]?.parameters.api_key).toBe('***');
    expect(out.tools[0]?.parameters.name).toBe('x');
  });

  it('scrubs a 5 MB string in well under a second', async () => {
    const { redactString } = await import('./agentTracer.js');
    const big = `${'x'.repeat(5 * 1024 * 1024)} sk-ant-${'a'.repeat(30)}`;
    const start = performance.now();
    expect(redactString(big)).toContain('***');
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
