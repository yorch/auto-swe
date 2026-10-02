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
    });
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
    });
  });

  it('writes NULL attribution when the activity was not dispatched for a node', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'e' });
    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');
    expect(createManyMock).toHaveBeenCalledWith({
      data: [expect.objectContaining({ recordingId: null, specNodeId: null, stepAttempt: null })],
    });
  });

  it('attaches the run when one exists', async () => {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'e' });

    await tracer.persist({ runId: 'run-1', workflowId: 'wf-1' }, 'n', 'a');

    expect(createManyMock).toHaveBeenCalledWith({
      data: [expect.objectContaining({ runId: 'run-1', workflowId: 'wf-1' })],
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

    await expect(
      tracer.persist({ runId: undefined, workflowId: 'wf-1' }, 'n', 'a')
    ).resolves.toBeUndefined();
  });

  it('reports whether a span context was attached', () => {
    const tracer = new AgentTracer();
    expect(tracer.hasSpanContext()).toBe(false);
    tracer.setSpanContext('t', 's');
    expect(tracer.hasSpanContext()).toBe(true);
  });
});
