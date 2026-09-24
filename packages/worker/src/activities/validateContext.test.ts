import { beforeEach, describe, expect, it, vi } from 'vitest';

const { persistMock, runAgentMock, upsertMock } = vi.hoisted(() => ({
  persistMock: vi.fn(async (..._args: unknown[]) => {}),
  runAgentMock: vi.fn(),
  upsertMock: vi.fn(async () => ({ id: 'snap-1' })),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { contextSnapshot: { upsert: upsertMock } },
}));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: () => {},
}));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: (...args: unknown[]) => persistMock(...args),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async () => ({ agentKey: 'validateContext' })),
}));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({})),
}));
vi.mock('./runAgent.js', () => ({ runAgent: runAgentMock }));

import { buildValidationUserMessage, validateContext } from './validateContext.js';

describe('buildValidationUserMessage', () => {
  it('uses the structured payload for generic requests', () => {
    const request = {
      connectionId: 'conn-1',
      payload: { title: 'Draft Q3 roadmap', urgency: 'high' },
      workRequestId: 'wr-1',
    };

    const message = buildValidationUserMessage(request);
    const parsed = JSON.parse(message);

    expect(parsed).toEqual({
      payload: { title: 'Draft Q3 roadmap', urgency: 'high' },
    });
  });

  it('falls back to legacy SWE fields when no payload is present', () => {
    const request = {
      description: 'Add a health endpoint',
      externalTicketId: 'JIRA-42',
      repoId: 'repo-1',
      requestPayload: '{ "foo": "bar" }',
      workRequestId: 'wr-2',
    };

    const message = buildValidationUserMessage(request);
    const parsed = JSON.parse(message);

    expect(parsed).toEqual({
      description: 'Add a health endpoint',
      requestPayload: '{ "foo": "bar" }',
      title: 'JIRA-42',
    });
  });
});

describe('validateContext degradation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('continues with empty criteria, and records why, when the LLM call fails', async () => {
    runAgentMock.mockRejectedValue(new Error('provider 529'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);

    expect(out).toEqual({ contextSnapshotId: 'snap-1', successCriteria: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider 529'));
    const [tracer, key] = persistMock.mock.calls[0] as [
      { records: Array<{ type: string; toolName?: string | null; error?: string | null }> },
      string,
    ];
    expect(key).toBe('validateContext');
    expect(tracer.records).toContainEqual(
      expect.objectContaining({
        error: 'provider 529',
        toolName: 'context_validation.degraded',
        type: 'activity_event',
      })
    );
    warn.mockRestore();
  });

  it('records no degradation event on success', async () => {
    runAgentMock.mockResolvedValue({ object: { successCriteria: ['a'] } });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.successCriteria).toEqual(['a']);
    expect(persistMock).not.toHaveBeenCalled();
  });
});
