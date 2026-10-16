import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  assistantConversation: { findFirst: vi.fn(), updateMany: vi.fn() },
  assistantMessage: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
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
vi.mock('../lib/spendOwner.js', () => ({
  ownerOfUser: vi.fn().mockResolvedValue({ orgId: 'org-1' }),
  withSpendOwner: vi.fn((_owner: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { persistActivityTrace } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { ownerOfUser, withSpendOwner } from '../lib/spendOwner.js';
import {
  AssistantTitleSchema,
  isTitleAttempt,
  nameAssistantConversation,
  nameAssistantConversationNow,
} from './assistantTitle.js';
import { runAgent } from './runAgent.js';

const mockedRunAgent = vi.mocked(runAgent);
const INPUT = { conversationId: 'conv-1', replyId: 'reply-1', userId: 'user-1' };

/** The person's messages, oldest first, as the three queries see them. */
function userMessages(contents: string[]) {
  const rows = contents.map((content, i) => ({ content, id: `m${i + 1}` }));
  db.assistantMessage.count.mockResolvedValue(rows.length);
  db.assistantMessage.findFirst.mockResolvedValue(rows[0] ?? null);
  db.assistantMessage.findMany.mockImplementation(async ({ take }: { take: number }) =>
    rows.slice(-take).reverse()
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.resolveSetting.mockResolvedValue(true);
  db.assistantConversation.findFirst.mockResolvedValue({ id: 'conv-1' });
  db.assistantConversation.updateMany.mockResolvedValue({ count: 1 });
  userMessages(['How do I set up the GitHub App?']);
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
    expect(db.assistantMessage.count.mock.calls[0]?.[0].where).toEqual({
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

  it('tries each of the first three messages, then at 5, 10, 20 and on doubling', () => {
    const attempts = Array.from({ length: 100 }, (_, i) => i + 1).filter(isTitleAttempt);
    expect(attempts).toEqual([1, 2, 3, 5, 10, 20, 40, 80]);
    expect(isTitleAttempt(0)).toBe(false);
    expect(isTitleAttempt(160)).toBe(true);
  });

  it('skips a turn that is not an attempt', async () => {
    userMessages(['hi', 'hello?', 'anyone', 'ok']);
    expect(await nameAssistantConversation(INPUT)).toBe('skipped');
    expect(mockedRunAgent).not.toHaveBeenCalled();
  });

  it('shows the model the first message and the latest three, oldest first', async () => {
    userMessages(['hi', 'two', 'three', 'four', 'Why did run 42 fail?']);
    await nameAssistantConversation(INPUT);
    const prompt = mockedRunAgent.mock.calls[0]?.[1] as string;
    const shown = [...prompt.matchAll(/<message>\n([^\n]*)\n<\/message>/g)].map((m) => m[1]);
    expect(shown).toEqual(['hi', 'three', 'four', 'Why did run 42 fail?']);
  });

  it('does not show the first message twice in a short conversation', async () => {
    userMessages(['hi', 'Slack cooldowns']);
    await nameAssistantConversation(INPUT);
    const prompt = mockedRunAgent.mock.calls[0]?.[1] as string;
    expect(prompt.match(/<message>/g)).toHaveLength(2);
  });

  it('names at once when forced, whatever the count, and never tags a reply it was not given', async () => {
    userMessages(['hi', 'two', 'three', 'Connecting the GitHub App']);
    expect(
      await nameAssistantConversation({ conversationId: 'conv-1', force: true, userId: 'user-1' })
    ).toBe('named');
    expect(vi.mocked(persistActivityTrace).mock.calls[0]?.[2]).toEqual({});
  });

  it('never throws: a failed model call is logged, the trace kept, and the title left', async () => {
    mockedRunAgent.mockRejectedValue(new Error('provider down'));
    expect(await nameAssistantConversation(INPUT)).toBe('failed');
    expect(db.assistantConversation.updateMany).not.toHaveBeenCalled();
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarn)).toHaveBeenCalledTimes(1);
  });
});

describe('nameAssistantConversationNow', () => {
  it("forces a naming, priced to the conversation's user", async () => {
    userMessages(['hi', 'two', 'three', 'four']);
    expect(await nameAssistantConversationNow({ conversationId: 'conv-1', userId: 'user-1' })).toBe(
      'named'
    );
    expect(ownerOfUser).toHaveBeenCalledWith('user-1');
    expect(withSpendOwner).toHaveBeenCalledTimes(1);
  });
});
