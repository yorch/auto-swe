import { beforeEach, describe, expect, it, vi } from 'vitest';

const { persistMock, runAgentMock, ticketMock, upsertMock } = vi.hoisted(() => ({
  persistMock: vi.fn(async (..._args: unknown[]) => {}),
  runAgentMock: vi.fn(),
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

describe('validateContext ticket context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ticketMock.mockResolvedValue('');
    runAgentMock.mockResolvedValue({ object: { successCriteria: ['a'] } });
  });

  it('gives the model the tracker ticket of this run', async () => {
    ticketMock.mockResolvedValue('<ticket>Title: Health endpoint</ticket>');
    await validateContext({ description: 'Some work', workRequestId: 'wr-9' } as never);
    expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ workRequestId: 'wr-9' }));
    const message = JSON.parse(runAgentMock.mock.calls[0]?.[1] as string);
    expect(message.ticket).toContain('Health endpoint');
    expect(message.description).toBe('Some work');
  });

  it('adds nothing when the run has no ticket', async () => {
    await validateContext({ description: 'Some work', workRequestId: 'wr-9' } as never);
    expect(JSON.parse(runAgentMock.mock.calls[0]?.[1] as string)).not.toHaveProperty('ticket');
  });

  it('persists the ticket events it recorded, once, together with any degradation', async () => {
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

  it('still validates when the ticket lookup itself fails', async () => {
    ticketMock.mockRejectedValue(new Error('boom'));
    const out = await validateContext({ description: 'x', workRequestId: 'wr-9' } as never);
    expect(out.successCriteria).toEqual(['a']);
  });
});
