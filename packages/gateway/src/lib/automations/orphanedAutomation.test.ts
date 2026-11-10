import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  slackToken: 'xoxb-token' as string | null,
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackBotTokenForSlackChannel: vi.fn(async () => m.slackToken),
}));
vi.mock('../slack.js', () => ({ postSlackMessage: vi.fn(async () => '1.0') }));
vi.mock('../auditLog.js', () => ({ writeAuditLog: vi.fn(async () => undefined) }));

import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';
import { writeAuditLog } from '../auditLog.js';
import { postSlackMessage } from '../slack.js';
import { disableOrphanedAutomation, orphanedAutomationNotice } from './orphanedAutomation.js';

const AUTOMATION = { id: 'auto-1', name: 'Nightly <!channel> & co', source: 'inbound.event' };
const REASON = 'the person who switched it on is no longer an active user';
const NOW = new Date('2026-11-10T12:00:00Z');

function harness(opts: { changed?: number; channel?: string | null } = {}) {
  const updateMany = vi.fn(async () => ({ count: opts.changed ?? 1 }));
  const teamFindUnique = vi.fn(async () => ({
    name: 'Payments',
    slackNotifyChannel: opts.channel === undefined ? 'C123' : opts.channel,
  }));
  const fastify = {
    log: { warn: vi.fn() },
    prisma: { automation: { updateMany }, team: { findUnique: teamFindUnique } },
  };
  return { fastify, teamFindUnique, updateMany };
}

const run = (h: ReturnType<typeof harness>) =>
  disableOrphanedAutomation(h.fastify as never, {
    automation: AUTOMATION,
    now: NOW,
    reason: REASON,
    teamId: 'team-1',
  });

beforeEach(() => {
  m.slackToken = 'xoxb-token';
  vi.clearAllMocks();
});

describe('disableOrphanedAutomation', () => {
  it('switches it off only while it is still on, and records why', async () => {
    const h = harness();
    await expect(run(h)).resolves.toBe(true);
    expect(h.updateMany).toHaveBeenCalledWith({
      data: { autoDisabledAt: NOW, autoDisabledReason: REASON, enabled: false },
      where: { enabled: true, id: 'auto-1' },
    });
  });

  it('audits the change as the system acting, not a person', async () => {
    await run(harness());
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'UPDATE',
        actor: null,
        after: { autoDisabledReason: REASON, enabled: false },
        before: { enabled: true },
        entityId: 'auto-1',
        entityType: 'Automation',
      })
    );
  });

  it('tells the team’s Slack channel, with outside text escaped', async () => {
    await run(harness());
    expect(resolveSlackBotTokenForSlackChannel).toHaveBeenCalledWith('C123');
    const [options, token] = vi.mocked(postSlackMessage).mock.calls[0] ?? [];
    expect(token).toBe('xoxb-token');
    expect(options?.channel).toBe('C123');
    expect(options?.text).not.toContain('<!channel>');
    expect(options?.text).toContain('Nightly &lt;!channel&gt; &amp; co');
    expect(options?.text).toContain(REASON);
  });

  it('does nothing more when another fire already switched it off', async () => {
    const h = harness({ changed: 0 });
    await expect(run(h)).resolves.toBe(false);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('posts nothing for a team with no Slack channel, and still audits', async () => {
    await run(harness({ channel: null }));
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it('survives a Slack failure: the automation is already off', async () => {
    vi.mocked(postSlackMessage).mockRejectedValueOnce(new Error('slack is down'));
    const h = harness();
    await expect(run(h)).resolves.toBe(true);
    expect(h.fastify.log.warn).toHaveBeenCalled();
  });

  it('survives having no Slack token', async () => {
    m.slackToken = null;
    await expect(run(harness())).resolves.toBe(true);
    expect(postSlackMessage).not.toHaveBeenCalled();
  });
});

describe('orphanedAutomationNotice', () => {
  it('names the automation, the reason and how to turn it back on', () => {
    const text = orphanedAutomationNotice('Nightly', 'inbound.event', REASON);
    expect(text).toContain('Nightly');
    expect(text).toContain(REASON);
    expect(text).toMatch(/lead/i);
  });
});
