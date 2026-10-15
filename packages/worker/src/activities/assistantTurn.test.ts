import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  assistantConversation: { update: vi.fn() },
  assistantMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn().mockResolvedValue(7) }));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/activityLog.js', () => ({ logError: vi.fn() }));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async (input: { availableTools: unknown }) => ({
    agentKey: 'appAssistant',
    tools: input.availableTools,
  })),
}));
vi.mock('../lib/spendOwner.js', () => ({
  ownerOfUser: vi.fn().mockResolvedValue({ orgId: 'org-1' }),
  withSpendOwner: (_owner: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { persistActivityTrace } from '../lib/activityContext.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { failAssistantReply, ReplyWriter, runAssistantTurn } from './assistantTurn.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);
const INPUT = { conversationId: 'conv-1', replyId: 'reply-1', token: 'asst_t', userId: 'user-1' };
const AT = new Date('2026-10-14T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  db.assistantMessage.findFirst.mockResolvedValue({
    createdAt: AT,
    id: 'reply-1',
    status: 'PENDING',
  });
  db.assistantMessage.findMany.mockResolvedValue([
    {
      content: 'How do I set up GitHub?',
      pageContext: { route: '/studio/integrations' },
      role: 'USER',
      status: 'COMPLETE',
    },
    { content: 'Earlier answer', pageContext: null, role: 'ASSISTANT', status: 'COMPLETE' },
    { content: 'Earlier question', pageContext: null, role: 'USER', status: 'COMPLETE' },
    { content: '', pageContext: null, role: 'ASSISTANT', status: 'FAILED' },
  ]);
  db.assistantMessage.update.mockResolvedValue({});
  db.assistantMessage.updateMany.mockResolvedValue({ count: 1 });
  db.assistantConversation.update.mockResolvedValue({});
});

describe('runAssistantTurn', () => {
  it('answers the latest message with the earlier ones as history, and completes the reply', async () => {
    mockedRunAgent.mockImplementation(async (_spec, _message, options) => {
      await options?.onChunk?.({ payload: { text: 'See ' }, type: 'text-delta' });
      return { text: 'See [Integrations](/docs/configuration#integrations).' };
    });
    expect(await runAssistantTurn(INPUT)).toEqual({ status: 'COMPLETE' });

    const [spec, message, options] = mockedRunAgent.mock.calls[0] ?? [];
    expect(Object.keys((spec as { tools: object }).tools).sort()).toEqual([
      'callApi',
      'describeApi',
      'getPageContext',
      'searchDocs',
    ]);
    expect(message).toBe('How do I set up GitHub?');
    expect(options).toMatchObject({
      history: [
        { content: 'Earlier question', role: 'user' },
        { content: 'Earlier answer', role: 'assistant' },
      ],
      maxSteps: 7,
    });
    expect(vi.mocked(resolveAgentSpec).mock.calls[0]?.[0]).toMatchObject({
      agentKey: 'appAssistant',
    });
    expect(db.assistantMessage.update).toHaveBeenLastCalledWith({
      data: {
        content: 'See [Integrations](/docs/configuration#integrations).',
        status: 'COMPLETE',
        steps: [],
      },
      where: { id: 'reply-1' },
    });
  });

  it('says so when the reply ran out of steps', async () => {
    mockedRunAgent.mockResolvedValue({ stoppedReason: 'max_steps', text: 'Partial' });
    await runAssistantTurn(INPUT);
    const data = db.assistantMessage.update.mock.calls.at(-1)?.[0].data;
    expect(data.content).toMatch(/^Partial\n\n_I reached this reply's step limit/);
  });

  it('fails the reply in words fit for the user when the model call fails', async () => {
    mockedRunAgent.mockRejectedValue(new Error('provider exploded: key sk-123'));
    expect(await runAssistantTurn(INPUT)).toEqual({ status: 'FAILED' });
    const data = db.assistantMessage.update.mock.calls.at(-1)?.[0].data;
    expect(data.status).toBe('FAILED');
    expect(data.error).toBe('I hit an error answering that. Please try again.');
  });

  it('persists the trace once, tagged with the reply, whether the turn succeeds or fails', async () => {
    mockedRunAgent.mockResolvedValueOnce({ text: 'Done' });
    await runAssistantTurn(INPUT);
    mockedRunAgent.mockRejectedValueOnce(new Error('provider down'));
    await runAssistantTurn(INPUT);

    const persisted = vi.mocked(persistActivityTrace).mock.calls;
    expect(persisted).toHaveLength(2);
    for (const [i, call] of persisted.entries()) {
      // The tracer handed to runAgent is the one persisted, so runAgent leaves persisting to us.
      expect(call[0]).toBe(mockedRunAgent.mock.calls[i]?.[2]?.tracer);
      expect(call.slice(1)).toEqual(['appAssistant', { assistantMessageId: 'reply-1' }]);
    }
  });

  it('records the cause for admins, scrubbed of the turn token and credentials', async () => {
    mockedRunAgent.mockRejectedValue(
      new Error('gateway refused asst_t with Authorization: Bearer abc123', {
        cause: new Error('upstream 401'),
      })
    );
    await runAssistantTurn(INPUT);
    const detail = db.assistantMessage.update.mock.calls.at(-1)?.[0].data.errorDetail as string;
    expect(detail).toContain('Error: gateway refused');
    expect(detail).toContain('caused by Error: upstream 401');
    expect(detail).not.toContain('asst_t');
    expect(detail).not.toContain('abc123');
  });

  it('does nothing for a reply that is already answered or not this user’s', async () => {
    db.assistantMessage.findFirst.mockResolvedValue(null);
    expect(await runAssistantTurn(INPUT)).toEqual({ status: 'SKIPPED' });
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(db.assistantMessage.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      conversation: { closedAt: null, id: 'conv-1', userId: 'user-1' },
      id: 'reply-1',
    });
  });
});

describe('ReplyWriter', () => {
  it('collects text and tool steps and writes them in order', async () => {
    const writes: Array<{ content: string; steps: unknown[] }> = [];
    const writer = new ReplyWriter(async (content, steps) => {
      writes.push({ content, steps });
    });
    writer.onChunk({ payload: { text: 'Hello' }, type: 'text-delta' });
    writer.onChunk({
      payload: { args: { query: 'github' }, toolCallId: 'c1', toolName: 'searchDocs' },
      type: 'tool-call',
    });
    writer.onChunk({
      payload: { result: { results: [1] }, toolCallId: 'c1', toolName: 'searchDocs' },
      type: 'tool-result',
    });
    writer.onChunk({ payload: { toolCallId: 'c2', toolName: 'callApi' }, type: 'tool-call' });
    writer.onChunk({ payload: { error: 'x', toolCallId: 'c2' }, type: 'tool-error' });
    writer.onChunk({ payload: { text: ' world' }, type: 'text-delta' });
    await writer.flush();
    expect(writes.at(-1)).toEqual({
      content: 'Hello world',
      steps: [
        {
          id: 'c1',
          input: { query: 'github' },
          status: 'done',
          summary: '1 doc section',
          tool: 'searchDocs',
        },
        { id: 'c2', input: {}, status: 'error', summary: 'failed', tool: 'callApi' },
      ],
    });
  });
});

describe('failAssistantReply', () => {
  it('fails only a reply that is still open', async () => {
    await failAssistantReply({ replyId: 'reply-1' });
    expect(db.assistantMessage.updateMany).toHaveBeenCalledWith({
      data: { error: expect.any(String), errorDetail: expect.any(String), status: 'FAILED' },
      where: { id: 'reply-1', status: { in: ['PENDING', 'STREAMING'] } },
    });
  });
});
