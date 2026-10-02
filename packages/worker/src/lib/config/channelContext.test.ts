import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { slackChannel: { findUnique } } }));

import { withChannelScope } from './channelContext.js';

beforeEach(() => findUnique.mockReset());

describe('withChannelScope', () => {
  it('returns the context untouched, with no lookup, when there is no channel', async () => {
    const base = { teamId: 't' };
    expect(await withChannelScope(base, undefined)).toBe(base);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("fills in the channel's team and org for a run with no ledger row", async () => {
    findUnique.mockResolvedValue({ orgId: 'org-1', teamId: 'team-1' });
    expect(await withChannelScope({ workflowTemplateId: 'tpl' }, 'chan-1')).toEqual({
      channelId: 'chan-1',
      orgId: 'org-1',
      teamId: 'team-1',
      workflowTemplateId: 'tpl',
    });
    expect(findUnique).toHaveBeenCalledWith({
      select: { orgId: true, teamId: true },
      where: { id: 'chan-1' },
    });
  });

  it('keeps the run own team and org when it has them, and does not look the channel up', async () => {
    const out = await withChannelScope({ orgId: 'org-run', teamId: 'team-run' }, 'chan-1');
    expect(out).toEqual({ channelId: 'chan-1', orgId: 'org-run', teamId: 'team-run' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('degrades to the channel id alone when the channel row is gone', async () => {
    findUnique.mockResolvedValue(null);
    expect(await withChannelScope({}, 'chan-1')).toEqual({ channelId: 'chan-1' });
  });
});
