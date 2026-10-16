import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  assistantConversation: { findFirst: vi.fn(), updateMany: vi.fn() },
  assistantMessage: { findMany: vi.fn() },
}));
const settings = vi.hoisted(() => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: settings.resolveSetting }));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn(async () => ({ agentKey: 'assistantTitler', tools: {} })),
}));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { persistActivityTrace } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { AssistantTitleSchema, nameAssistantConversation } from './assistantTitle.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);
const INPUT = { conversationId: 'conv-1', replyId: 'reply-1', userId: 'user-1' };

beforeEach(() => {
  vi.clearAllMocks();
  settings.resolveSetting.mockResolvedValue(true);
  db.assistantConversation.findFirst.mockResolvedValue({ id: 'conv-1' });
  db.assistantConversation.updateMany.mockResolvedValue({ count: 1 });
  db.assistantMessage.findMany.mockResolvedValue([{ content: 'How do I set up the GitHub App?' }]);
  mockedRunAgent.mockResolvedValue({ object: { title: 'Setting up the GitHub App' } });
});

describe('nameAssistantConversation', () => {
  it("names a conversation from the person's messages, unless it has been renamed meanwhile", async () => {
    expect(await nameAssistantConversation(INPUT)).toBe('named');

    expect(db.assistantConversation.findFirst.mock.calls[0]?.[0].where).toEqual({
      closedAt: null,
      id: 'conv-1',
      titleSource: 'FIRST_MESSAGE',
      userId: 'user-1',
    });
    expect(db.assistantMessage.findMany.mock.calls[0]?.[0].where).toEqual({
      conversationId: 'conv-1',
      role: 'USER',
    });
    expect(vi.mocked(resolveAgentSpec).mock.calls[0]?.[0]).toEqual({
      agentKey: 'assistantTitler',
      outputSchema: AssistantTitleSchema,
    });
    expect(mockedRunAgent.mock.calls[0]?.[1]).toBe(
      '<messages>\n<message>\nHow do I set up the GitHub App?\n</message>\n</messages>'
    );
    expect(db.assistantConversation.updateMany).toHaveBeenCalledWith({
      data: { title: 'Setting up the GitHub App', titleSource: 'MODEL' },
      where: { closedAt: null, id: 'conv-1', titleSource: 'FIRST_MESSAGE' },
    });
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledWith(
      mockedRunAgent.mock.calls[0]?.[2]?.tracer,
      'assistantTitler',
      { assistantMessageId: 'reply-1' }
    );
  });

  it('tidies what the model returns into one stored line', async () => {
    mockedRunAgent.mockResolvedValue({ object: { title: '  "Why run\n4f2a failed."  ' } });
    await nameAssistantConversation(INPUT);
    expect(db.assistantConversation.updateMany.mock.calls[0]?.[0].data.title).toBe(
      'Why run 4f2a failed'
    );
  });

  it('leaves the title alone when the model declines, so a later turn can try again', async () => {
    mockedRunAgent.mockResolvedValue({ object: { title: '' } });
    expect(await nameAssistantConversation(INPUT)).toBe('declined');
    expect(db.assistantConversation.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing for a conversation the person renamed, or one already named', async () => {
    db.assistantConversation.findFirst.mockResolvedValue(null);
    expect(await nameAssistantConversation(INPUT)).toBe('skipped');
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it('does nothing while the setting is off', async () => {
    settings.resolveSetting.mockResolvedValue(false);
    expect(await nameAssistantConversation(INPUT)).toBe('skipped');
    expect(settings.resolveSetting).toHaveBeenCalledWith('assistant.generateTitles');
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it('stops trying once the conversation is past its first few messages', async () => {
    db.assistantMessage.findMany.mockResolvedValue([
      { content: 'hi' },
      { content: 'hello?' },
      { content: 'anyone' },
      { content: 'ok' },
    ]);
    expect(await nameAssistantConversation(INPUT)).toBe('skipped');
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it('never throws: a failed model call is logged, the trace kept, and the title left', async () => {
    mockedRunAgent.mockRejectedValue(new Error('provider down'));
    expect(await nameAssistantConversation(INPUT)).toBe('failed');
    expect(db.assistantConversation.updateMany).not.toHaveBeenCalled();
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarn)).toHaveBeenCalledTimes(1);
  });
});
