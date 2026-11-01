import type { PrismaClient } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = {
  approver: vi.fn(),
  figma: vi.fn(),
  github: vi.fn(),
  issueTracker: vi.fn(),
  knowledgeBase: vi.fn(),
  slack: vi.fn(),
};
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveFigmaConfig: () => cfg.figma(),
  resolveGitHubApproverAppConfig: () => cfg.approver(),
  resolveGitHubConfig: () => cfg.github(),
  resolveIssueTrackerConfig: () => cfg.issueTracker(),
  resolveKnowledgeBaseConfig: () => cfg.knowledgeBase(),
  resolveSlackConfig: () => cfg.slack(),
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_why: string, _models: string[], fn: () => unknown) => fn(),
}));

const test = {
  figma: vi.fn(),
  github: vi.fn(),
  issueTracker: vi.fn(),
  knowledgeBase: vi.fn(),
  slack: vi.fn(),
};
vi.mock('./systemConfigService.js', () => ({
  testFigmaConnection: () => test.figma(),
  testGitHubConnection: () => test.github(),
  testIssueTrackerConnection: (ticket: string) => test.issueTracker(ticket),
  testKnowledgeBaseConnection: () => test.knowledgeBase(),
  testSlackConnection: () => test.slack(),
}));

const probeApproverApp = vi.fn();
const probeHostCredential = vi.fn();
const probeRegistryRow = vi.fn();
vi.mock('./connectionProbes.js', () => ({
  probeApproverApp: () => probeApproverApp(),
  probeHostCredential: (host: string) => probeHostCredential(host),
  probeRegistryRow: (row: unknown) => probeRegistryRow(row),
}));

const testStoredCredential = vi.fn();
vi.mock('./credentialService.js', () => ({
  testStoredCredential: (row: unknown) => testStoredCredential(row),
}));

const { checkAllConnections } = await import('./connectionHealth.js');

const ok = (detail = 'fine') => ({ checks: [], detail, durationMs: 1, ok: true });

function prismaWith(rows: {
  approver?: { appId: string | null } | null;
  hosts?: Array<{ id: string; host: string }>;
  registries?: Array<{ id: string; name: string; ecosystem: string }>;
  credentials?: Array<{ id: string; provider: string; scope: string; lastFour: string }>;
}) {
  return {
    gitHubApproverApp: { findUnique: vi.fn().mockResolvedValue(rows.approver ?? null) },
    gitHubHostCredential: { findMany: vi.fn().mockResolvedValue(rows.hosts ?? []) },
    packageRegistry: { findMany: vi.fn().mockResolvedValue(rows.registries ?? []) },
    providerCredential: { findMany: vi.fn().mockResolvedValue(rows.credentials ?? []) },
  } as unknown as PrismaClient;
}

const byId = (entries: Awaited<ReturnType<typeof checkAllConnections>>) =>
  Object.fromEntries(entries.map((e) => [e.id, e]));

beforeEach(() => {
  vi.resetAllMocks();
  cfg.github.mockResolvedValue({ appId: null, appPrivateKey: null, token: null });
  cfg.slack.mockResolvedValue({ botToken: null });
  cfg.issueTracker.mockResolvedValue({ provider: null });
  cfg.knowledgeBase.mockResolvedValue({ enabled: false, provider: null });
  cfg.figma.mockResolvedValue({ enabled: false });
});

describe('checkAllConnections', () => {
  it('skips what is not configured instead of calling it a failure', async () => {
    const entries = byId(await checkAllConnections(prismaWith({})));
    for (const id of ['github', 'slack', 'issue-tracker', 'knowledge-base', 'figma']) {
      expect(entries[id]).toMatchObject({ detail: 'Not configured.', status: 'skipped' });
    }
    expect(test.github).not.toHaveBeenCalled();
    expect(test.slack).not.toHaveBeenCalled();
  });

  it('runs the same check the integration button runs, and reports its answer', async () => {
    cfg.github.mockResolvedValue({ appId: null, appPrivateKey: null, token: 'ghp_x' });
    cfg.slack.mockResolvedValue({ botToken: 'xoxb-x' });
    test.github.mockResolvedValue({ detail: 'Authenticated as octocat', ok: true });
    test.slack.mockResolvedValue({ detail: 'Slack API error: invalid_auth', ok: false });
    const entries = byId(await checkAllConnections(prismaWith({})));
    expect(entries.github).toMatchObject({ detail: 'Authenticated as octocat', status: 'ok' });
    expect(entries.slack).toMatchObject({ status: 'failed' });
    expect(entries.github?.href).toBe('/admin/integrations');
  });

  it('treats an App with no token as configured', async () => {
    cfg.github.mockResolvedValue({ appId: '42', appPrivateKey: 'pem', token: null });
    test.github.mockResolvedValue({ detail: 'ok', ok: true });
    const entries = byId(await checkAllConnections(prismaWith({})));
    expect(entries.github?.status).toBe('ok');
  });

  it('skips the tracker unless it is given a ticket to fetch', async () => {
    cfg.issueTracker.mockResolvedValue({ provider: 'jira' });
    const without = byId(await checkAllConnections(prismaWith({})));
    expect(without['issue-tracker']?.status).toBe('skipped');
    expect(without['issue-tracker']?.detail).toContain('ticket id');
    expect(test.issueTracker).not.toHaveBeenCalled();

    test.issueTracker.mockResolvedValue({ detail: 'Fetched "x"', ok: true });
    const withTicket = byId(
      await checkAllConnections(prismaWith({}), { trackerTicketId: 'PAY-1' })
    );
    expect(withTicket['issue-tracker']?.status).toBe('ok');
    expect(test.issueTracker).toHaveBeenCalledWith('PAY-1');
  });

  it('skips a knowledge base that is configured but disabled', async () => {
    cfg.knowledgeBase.mockResolvedValue({ enabled: false, provider: 'confluence' });
    const entries = byId(await checkAllConnections(prismaWith({})));
    expect(entries['knowledge-base']?.status).toBe('skipped');
  });

  it('a check that throws is a failed entry and does not hide the others', async () => {
    cfg.github.mockResolvedValue({ appId: null, appPrivateKey: null, token: 'ghp_x' });
    cfg.slack.mockResolvedValue({ botToken: 'xoxb-x' });
    test.github.mockRejectedValue(new Error('boom: ghp_x leaked in a message'));
    test.slack.mockResolvedValue({ detail: 'fine', ok: true });
    const entries = byId(await checkAllConnections(prismaWith({})));
    expect(entries.github).toMatchObject({ detail: 'The check could not run.', status: 'failed' });
    expect(JSON.stringify(entries.github)).not.toContain('ghp_x');
    expect(entries.slack?.status).toBe('ok');
  });

  it('checks each host credential, active registry and model key', async () => {
    probeHostCredential.mockResolvedValue(ok('host fine'));
    probeRegistryRow.mockResolvedValue({
      ...ok(),
      detail: 'The registry returned 401.',
      ok: false,
    });
    testStoredCredential.mockResolvedValue({ ok: true, status: 200 });
    const prisma = prismaWith({
      credentials: [{ id: 'c1', lastFour: 'abcd', provider: 'anthropic', scope: 'GLOBAL' }],
      hosts: [{ host: 'ghe.corp', id: 'h1' }],
      registries: [{ ecosystem: 'npm', id: 'r1', name: 'internal' }],
    });
    const entries = byId(await checkAllConnections(prisma));
    expect(entries['github-host:h1']).toMatchObject({
      group: 'github-host',
      label: 'GitHub host ghe.corp',
      status: 'ok',
    });
    expect(probeHostCredential).toHaveBeenCalledWith('ghe.corp');
    expect(entries['registry:r1']).toMatchObject({
      group: 'registry',
      label: 'npm registry internal',
      status: 'failed',
    });
    expect(entries['model-provider:c1']).toMatchObject({
      label: 'anthropic key ····abcd (global)',
      status: 'ok',
    });
  });

  it('only lists registries that are active', async () => {
    const prisma = prismaWith({});
    await checkAllConnections(prisma);
    expect(prisma.packageRegistry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } })
    );
  });

  it('words a refused model key by status and a dead one by its fixed error', async () => {
    testStoredCredential
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ error: 'request failed (TypeError)', ok: false });
    const prisma = prismaWith({
      credentials: [
        { id: 'c1', lastFour: 'aaaa', provider: 'openai', scope: 'GLOBAL' },
        { id: 'c2', lastFour: 'bbbb', provider: 'google', scope: 'TEAM' },
      ],
    });
    const entries = byId(await checkAllConnections(prisma));
    expect(entries['model-provider:c1']?.detail).toBe('The provider returned 401.');
    expect(entries['model-provider:c2']?.detail).toBe(
      'The provider could not be reached (request failed (TypeError)).'
    );
  });

  it('includes the approver App only when one is set up, and fails a half-configured one', async () => {
    const none = byId(await checkAllConnections(prismaWith({ approver: null })));
    expect(none['github-approver-app']).toBeUndefined();

    cfg.approver.mockResolvedValue(null);
    const half = byId(await checkAllConnections(prismaWith({ approver: { appId: '42' } })));
    expect(half['github-approver-app']).toMatchObject({ status: 'failed' });
    expect(probeApproverApp).not.toHaveBeenCalled();

    cfg.approver.mockResolvedValue({ appId: '42' });
    probeApproverApp.mockResolvedValue(ok('Approver App x is valid.'));
    const full = byId(await checkAllConnections(prismaWith({ approver: { appId: '42' } })));
    expect(full['github-approver-app']).toMatchObject({ status: 'ok' });
  });
});
