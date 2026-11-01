import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  automationFindMany: vi.fn(async () => [] as unknown[]),
  connectionFindMany: vi.fn(async () => [] as unknown[]),
  fetch: vi.fn(),
  platformCredential: vi.fn(async () => ({ config: {}, scope: 'instance' })),
  pullRequestFindFirst: vi.fn(async () => null as unknown),
  runFindFirst: vi.fn(async () => null as unknown),
  settings: { 'github.prFeedbackAutomationsEnabled': true } as Record<string, unknown>,
  token: vi.fn(async () => 'tok'),
  webhookSecretFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => m.settings[key] ?? false),
}));
vi.mock('@auto-swe/shared/lib/githubHostCredential', () => ({
  resolvePlatformCredential: m.platformCredential,
}));
vi.mock('@auto-swe/shared/lib/githubHostScope', () => ({
  installationTargetFor: vi.fn(() => ({ apiUrl: 'https://api.github.com' })),
}));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({
  resolveGitHubToken: m.token,
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: vi.fn(() => ({ ok: true, url: 'https://github.com/acme/api' })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({})),
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: async (_r: string, _m: string[], fn: () => unknown) => fn(),
}));

const prisma = {
  automation: { findMany: m.automationFindMany },
  connection: { findMany: m.connectionFindMany },
  gitHubHostWebhookSecret: { findMany: m.webhookSecretFindMany },
  pullRequest: { findFirst: m.pullRequestFindFirst },
  workflowRun: { findFirst: m.runFindFirst },
} as never;

vi.stubGlobal('fetch', m.fetch);

import { installationTargetFor } from '@auto-swe/shared/lib/githubHostScope';
import { enrichPrFeedbackFacts } from './prFeedback.js';

const CONN = {
  githubApiUrl: null,
  githubUrl: null,
  id: 'conn-1',
  installation: { host: null, installationId: 'i1' },
  organizationName: 'acme',
  repoName: 'api',
  team: { orgId: 'org-1' },
  teamId: 'team-1',
};

const event = () => ({
  facts: {
    eventId: '700',
    eventKind: 'issue_comment' as const,
    htmlUrl: 'https://github.com/acme/api/pull/9#issuecomment-700',
    notes: 'fix it',
    origin: 'other' as const,
    prNumber: 9,
    senderId: '42',
    senderLogin: 'reviewer',
    submittedAt: '2026-10-20T00:00:00Z',
    trigger: 'command' as const,
  },
  org: 'acme',
  repoFullName: 'acme/api',
  repoHtmlUrl: 'https://github.com/acme/api',
  repoName: 'api',
  repositoryId: 500,
});

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.settings['github.prFeedbackAutomationsEnabled'] = true;
  m.connectionFindMany.mockResolvedValue([CONN]);
  m.automationFindMany.mockResolvedValue([]);
  m.pullRequestFindFirst.mockResolvedValue(null);
  m.token.mockResolvedValue('tok');
  m.platformCredential.mockResolvedValue({ config: {}, scope: 'instance' });
  m.webhookSecretFindMany.mockResolvedValue([]);
});

describe('enrichPrFeedbackFacts — the host read for `other` origins is gated', () => {
  it('does not read the host when no enabled automation allows others+command', async () => {
    const r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r).toMatchObject({ type: 'ok' });
    if (r.type === 'ok') {
      expect(r.facts.headRef).toBeUndefined();
      expect(r.facts.origin).toBe('other');
    }
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('does not read the host when the kill switch is off', async () => {
    m.settings['github.prFeedbackAutomationsEnabled'] = false;
    m.automationFindMany.mockResolvedValue([
      { filters: { pullRequests: ['others'], triggers: ['command'] } },
    ]);
    const r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r.type).toBe('ok');
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('reads the host when an eligible automation exists; 404 → ignored, 500 → failed', async () => {
    m.automationFindMany.mockResolvedValue([
      { filters: { pullRequests: ['others'], triggers: ['command'] } },
    ]);
    m.fetch.mockResolvedValue({ ok: false, status: 404 });
    let r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r.type).toBe('ignored');
    m.fetch.mockResolvedValue({ ok: false, status: 500 });
    r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r.type).toBe('failed');
    m.fetch.mockResolvedValue({
      json: async () => ({
        head: { ref: 'feature/x', repo: { id: 500 } },
        state: 'open',
      }),
      ok: true,
      status: 200,
    });
    r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r).toMatchObject({ facts: { headRef: 'feature/x' }, type: 'ok' });
  });
  it("reads the host with a token restricted to the connection's repository", async () => {
    m.automationFindMany.mockResolvedValue([
      { filters: { pullRequests: ['others'], triggers: ['command'] } },
    ]);
    m.fetch.mockResolvedValue({ ok: false, status: 404 });
    await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    // The target is built from the connection's own installation and name.
    expect(installationTargetFor).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'i1',
        organizationName: 'acme',
        repoName: 'api',
      }),
      expect.anything()
    );
  });
});

describe('enrichPrFeedbackFacts — a Qodo nudge', () => {
  const SHA = 'c'.repeat(40);
  const nudge = (over: Record<string, unknown> = {}) => {
    const e = event();
    return {
      ...e,
      facts: {
        ...e.facts,
        eventKind: 'review' as const,
        headRef: 'auto/prfb-9-1',
        headSha: SHA,
        notes: '',
        senderId: '424242',
        trigger: 'qodo_findings' as const,
        ...over,
      },
    };
  };
  const platformPr = {
    repoId: 'conn-1',
    workflow: { assignedBranch: 'auto/prfb-9-1', temporalWorkflowId: 'wf-1' },
  };

  beforeEach(() => {
    m.settings['qodo.prFeedbackBotAccountIds'] = [424242];
    m.settings['qodo.enabled'] = true;
    m.pullRequestFindFirst.mockResolvedValue(platformPr);
    m.runFindFirst.mockResolvedValue({ template: { origin: 'USER', teamId: 'team-1' } });
  });

  it('passes an allowlisted bot on a platform pull request through, origin set', async () => {
    const r = await enrichPrFeedbackFacts(prisma, nudge() as never, 'github.com');
    expect(r).toMatchObject({
      facts: { headSha: SHA, origin: 'workflow', trigger: 'qodo_findings' },
      type: 'ok',
    });
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it('answers a bot that is not on the allowlist as any bot has always been answered', async () => {
    const r = await enrichPrFeedbackFacts(prisma, nudge({ senderId: '1' }) as never, 'github.com');
    expect(r).toEqual({ reason: 'left by a Bot, not a person', type: 'ignored' });
    // Nothing was queried for it.
    expect(m.connectionFindMany).not.toHaveBeenCalled();
  });

  it('ignores every bot while the allowlist is empty', async () => {
    m.settings['qodo.prFeedbackBotAccountIds'] = [];
    const r = await enrichPrFeedbackFacts(prisma, nudge() as never, 'github.com');
    expect(r).toMatchObject({ type: 'ignored' });
  });

  it('matches the numeric id, not the login', async () => {
    const r = await enrichPrFeedbackFacts(
      prisma,
      nudge({ senderId: '424243', senderLogin: 'qodo-lookalike[bot]' }) as never,
      'github.com'
    );
    expect(r.type).toBe('ignored');
  });

  it('ignores a pull request the platform did not open', async () => {
    m.pullRequestFindFirst.mockResolvedValue(null);
    const r = await enrichPrFeedbackFacts(prisma, nudge() as never, 'github.com');
    expect(r).toMatchObject({
      reason: 'the pull request is not one the platform opened',
      type: 'ignored',
    });
  });

  it('ignores the nudge when Qodo reading is off for the repository’s team', async () => {
    m.settings['qodo.enabled'] = false;
    const r = await enrichPrFeedbackFacts(prisma, nudge() as never, 'github.com');
    expect(r.type).toBe('ignored');
  });

  it('reads the pull request once for the head a discussion comment does not carry', async () => {
    m.fetch.mockResolvedValue({
      json: async () => ({
        head: { ref: 'auto/prfb-9-1', repo: { id: 500 }, sha: SHA.toUpperCase() },
        state: 'open',
      }),
      ok: true,
      status: 200,
    });
    const r = await enrichPrFeedbackFacts(
      prisma,
      nudge({ eventKind: 'issue_comment', headRef: undefined, headSha: undefined }) as never,
      'github.com'
    );
    expect(r).toMatchObject({
      facts: { headRef: 'auto/prfb-9-1', headSha: SHA, origin: 'workflow' },
      type: 'ok',
    });
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a discussion comment on a closed or forked pull request, or one that cannot be read', async () => {
    const issueNudge = nudge({
      eventKind: 'issue_comment',
      headRef: undefined,
      headSha: undefined,
    });
    const answer = (head: Record<string, unknown>, state = 'open') =>
      m.fetch.mockResolvedValue({
        json: async () => ({ head, state }),
        ok: true,
        status: 200,
      });
    answer({ ref: 'x', repo: { id: 500 }, sha: SHA }, 'closed');
    expect(await enrichPrFeedbackFacts(prisma, issueNudge as never, 'github.com')).toMatchObject({
      type: 'ignored',
    });
    answer({ ref: 'x', repo: { id: 9 }, sha: SHA });
    expect(await enrichPrFeedbackFacts(prisma, issueNudge as never, 'github.com')).toMatchObject({
      reason: 'the pull request is from a fork',
      type: 'ignored',
    });
    answer({ ref: 'x', repo: { id: 500 } });
    expect(await enrichPrFeedbackFacts(prisma, issueNudge as never, 'github.com')).toMatchObject({
      reason: 'the pull request names no head commit',
      type: 'ignored',
    });
    m.fetch.mockResolvedValue({ ok: false, status: 500 });
    expect((await enrichPrFeedbackFacts(prisma, issueNudge as never, 'github.com')).type).toBe(
      'failed'
    );
  });
});
