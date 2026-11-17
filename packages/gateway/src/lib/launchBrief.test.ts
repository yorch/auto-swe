import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupTrackerTicket = vi.hoisted(() => vi.fn());
vi.mock('./ticketLookup.js', () => ({ lookupTrackerTicket }));

import { resolveLaunchBrief } from './launchBrief.js';

const log = { warn: vi.fn() };
const connection = {
  githubApiUrl: null,
  githubUrl: null,
  organizationName: 'acme',
  repoName: 'api',
  team: { orgId: null },
  teamId: 't1',
};

describe('resolveLaunchBrief', () => {
  beforeEach(() => {
    lookupTrackerTicket.mockReset();
    log.warn.mockReset();
  });

  it('builds the fenced brief from the ticket', async () => {
    lookupTrackerTicket.mockResolvedValue({
      state: 'found',
      ticket: { description: 'Add a probe', title: 'Health check' },
    });
    const result = await resolveLaunchBrief({ connection, log, ticketId: 'PAY-12' });
    expect(result.ok).toBe(true);
    const description = result.ok ? result.description : '';
    expect(description.split('\n')[0]).toBe('Ticket PAY-12');
    expect(description).toContain('Health check');
    expect(description).toContain('<ticket>');
    expect(lookupTrackerTicket).toHaveBeenCalledWith('PAY-12', connection, log);
  });

  it('looks the ticket up without a repository when there is no connection', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'found', ticket: { title: 'T' } });
    await resolveLaunchBrief({ ticketId: 'PAY-12' });
    expect(lookupTrackerTicket).toHaveBeenCalledWith('PAY-12', null, undefined);
  });

  it('treats a connection without a repository name as none', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'found', ticket: { title: 'T' } });
    await resolveLaunchBrief({ connection: { ...connection, repoName: null }, ticketId: 'PAY-1' });
    expect(lookupTrackerTicket).toHaveBeenCalledWith('PAY-1', null, undefined);
  });

  it('passes the launch team and the read budget to the lookup', async () => {
    lookupTrackerTicket.mockResolvedValue({ state: 'found', ticket: { title: 'T' } });
    const launchTeam = { orgId: 'o1', teamId: 'tpl-team' };
    await resolveLaunchBrief({
      launchTeam,
      log,
      maxRetries: 0,
      ticketId: 'PAY-1',
      timeoutMs: 2000,
    });
    expect(lookupTrackerTicket).toHaveBeenCalledWith('PAY-1', null, log, {
      launchTeam,
      maxRetries: 0,
      timeoutMs: 2000,
    });
  });

  it.each([
    ['unconfigured', { state: 'unconfigured' }],
    ['not_found', { state: 'not_found' }],
    ['error', { state: 'error' }],
  ])('is not ok when the lookup says %s', async (_name, lookup) => {
    lookupTrackerTicket.mockResolvedValue(lookup);
    expect(await resolveLaunchBrief({ ticketId: 'PAY-12' })).toEqual({ ok: false });
  });

  it('never throws and carries no provider text', async () => {
    lookupTrackerTicket.mockRejectedValue(new Error('Jira said: secret detail'));
    const result = await resolveLaunchBrief({ log, ticketId: 'PAY-12' });
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});
