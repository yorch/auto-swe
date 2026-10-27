import { beforeEach, describe, expect, it, vi } from 'vitest';

const { persistMock, runAgentMock, settingMock, ticketMock, upsertMock } = vi.hoisted(() => ({
  persistMock: vi.fn(async (..._args: unknown[]) => {}),
  runAgentMock: vi.fn(),
  settingMock: vi.fn(async (..._args: unknown[]) => false),
  ticketMock: vi.fn(async (..._args: unknown[]) => ''),
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
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: (...args: unknown[]) => settingMock(...args),
}));
vi.mock('../lib/ticketContext.js', () => ({ loadTicketContext: ticketMock }));
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

describe('buildValidationUserMessage with a tracker ticket', () => {
  const ticket = '\n\n## Issue tracker ticket\n<ticket>\nTitle: Health endpoint\n</ticket>';

  it('adds the ticket beside the structured payload', () => {
    const parsed = JSON.parse(
      buildValidationUserMessage(
        { payload: { title: 'T' }, workRequestId: 'wr-1' } as never,
        ticket
      )
    );
    expect(parsed).toEqual({ payload: { title: 'T' }, ticket });
  });

  it('adds the ticket to the legacy fields, and leaves them alone without one', () => {
    const request = {
      description: 'D',
      externalTicketId: 'JIRA-1',
      workRequestId: 'wr-1',
    } as never;
    expect(JSON.parse(buildValidationUserMessage(request, ticket))).toEqual({
      description: 'D',
      ticket,
      title: 'JIRA-1',
    });
    expect(JSON.parse(buildValidationUserMessage(request, ''))).not.toHaveProperty('ticket');
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

    expect(out).toEqual({
      actionable: true,
      ambiguities: [],
      contextSnapshotId: 'snap-1',
      successCriteria: [],
    });
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

describe('validateContext verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a request whose every criterion is an ambiguity as not actionable', async () => {
    runAgentMock.mockResolvedValue({
      object: { successCriteria: ['AMBIGUOUS: only a Jira URL, no description'] },
    });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out).toEqual({
      actionable: false,
      ambiguities: ['only a Jira URL, no description'],
      contextSnapshotId: 'snap-1',
      successCriteria: ['AMBIGUOUS: only a Jira URL, no description'],
    });
    // The snapshot keeps the criteria exactly as the agent wrote them.
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          successCriteria: ['AMBIGUOUS: only a Jira URL, no description'],
        }),
      })
    );
  });

  it('reports a successful extraction that found nothing as not actionable', async () => {
    runAgentMock.mockResolvedValue({ object: { successCriteria: [] } });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.actionable).toBe(false);
    expect(out.ambiguities).toEqual(['validation could not extract any verifiable criteria']);
    expect(out.successCriteria).toEqual([]);
  });

  it('does not stop a request when the extraction itself failed', async () => {
    runAgentMock.mockRejectedValue(new Error('provider 529'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.actionable).toBe(true);
    warn.mockRestore();
  });

  it('reports a request with a verifiable criterion as actionable', async () => {
    runAgentMock.mockResolvedValue({
      object: { successCriteria: ['GET /health returns 200', 'AMBIGUOUS: no auth stated'] },
    });
    const out = await validateContext({ description: 'x', workRequestId: 'wr-1' } as never);
    expect(out.actionable).toBe(true);
    expect(out.ambiguities).toEqual(['no auth stated']);
  });
});

describe('validateContext ticket context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingMock.mockResolvedValue(false);
    ticketMock.mockResolvedValue('');
    runAgentMock.mockResolvedValue({ object: { successCriteria: ['a'] } });
  });

  const sentMessage = () => JSON.parse(runAgentMock.mock.calls[0]?.[1] as string);

  describe('from an earlier step', () => {
    it('gives the model the ticket the gatherer step produced, and fetches nothing itself', async () => {
      settingMock.mockResolvedValue(true);
      await validateContext(
        { description: 'Some work', workRequestId: 'wr-9' } as never,
        undefined,
        '<ticket>Title: Health endpoint</ticket>'
      );
      expect(sentMessage().ticket).toContain('Health endpoint');
      expect(ticketMock).not.toHaveBeenCalled();
    });

    it('takes an empty ticket from the step as "none", even with the fallback on', async () => {
      settingMock.mockResolvedValue(true);
      await validateContext({ description: 'x', workRequestId: 'wr-9' } as never, undefined, '');
      expect(sentMessage()).not.toHaveProperty('ticket');
      expect(ticketMock).not.toHaveBeenCalled();
    });
  });

  describe('when no step provided one', () => {
    it('does not fetch on its own while the fallback setting is off', async () => {
      await validateContext({ description: 'Some work', workRequestId: 'wr-9' } as never);
      expect(settingMock).toHaveBeenCalledWith('workflow.ticketContextFallback', expect.anything());
      expect(ticketMock).not.toHaveBeenCalled();
      expect(sentMessage()).not.toHaveProperty('ticket');
    });

    it("fetches the run's ticket when the fallback is on", async () => {
      settingMock.mockResolvedValue(true);
      ticketMock.mockResolvedValue('<ticket>Title: Health endpoint</ticket>');
      await validateContext({ description: 'Some work', workRequestId: 'wr-9' } as never);
      expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ workRequestId: 'wr-9' }));
      expect(sentMessage().ticket).toContain('Health endpoint');
    });

    it('reads a failing setting as off, and still validates when the lookup itself fails', async () => {
      settingMock.mockRejectedValue(new Error('db down'));
      const off = await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
      expect(off.successCriteria).toEqual(['a']);
      expect(ticketMock).not.toHaveBeenCalled();

      settingMock.mockResolvedValue(true);
      ticketMock.mockRejectedValue(new Error('boom'));
      const on = await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
      expect(on.successCriteria).toEqual(['a']);
    });

    it('persists the ticket events it recorded, once, together with any degradation', async () => {
      settingMock.mockResolvedValue(true);
      ticketMock.mockImplementation(async (args: unknown) => {
        (
          args as { tracer: { addActivityEvent: (e: { name: string }) => void } }
        ).tracer.addActivityEvent({
          name: 'ticket.context_loaded',
        });
        return '<ticket>x</ticket>';
      });
      runAgentMock.mockRejectedValue(new Error('provider 529'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
      expect(persistMock).toHaveBeenCalledTimes(1);
      const [tracer] = persistMock.mock.calls[0] as [
        { records: Array<{ toolName?: string | null }> },
      ];
      expect(tracer.records.map((r) => r.toolName)).toEqual([
        'ticket.context_loaded',
        'context_validation.degraded',
      ]);
      warn.mockRestore();
    });
  });
});
