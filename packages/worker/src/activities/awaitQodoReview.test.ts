import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QodoFinding, QodoPrReviewState } from '../lib/qodo/client.js';

const m = vi.hoisted(() => ({
  calls: [] as string[],
  createClient: vi.fn((_deps: unknown) => ({}) as unknown),
  events: [] as { name: string; outputJson?: unknown }[],
  findRepo: vi.fn(async (_a: unknown) => null as unknown),
  persist: vi.fn(async (_tracer: unknown, _key: string) => true),
  script: [] as unknown[],
  settings: {} as Record<string, unknown>,
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: m.findRepo } },
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => m.settings[key]),
}));
vi.mock('../lib/agentTracer.js', () => ({
  AgentTracer: class {
    addActivityEvent(event: { name: string; outputJson?: unknown }) {
      m.events.push(event);
    }
  },
}));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: (tracer: unknown, key: string) => m.persist(tracer, key),
}));
vi.mock('../lib/execUtils.js', () => ({
  withHeartbeat: (_l: string, p: Promise<unknown>) => p,
}));
vi.mock('../lib/qodo/client.js', async (orig) => ({
  ...(await orig<typeof import('../lib/qodo/client.js')>()),
  createQodoFindingsClient: (deps: unknown) => {
    m.createClient(deps);
    return {
      async getPrReviewState(prUrl: string) {
        m.calls.push(prUrl);
        return m.script[Math.min(m.calls.length - 1, m.script.length - 1)];
      },
    };
  },
}));

import { createFakeQodoFindingsClient } from '../lib/qodo/client.js';
import {
  awaitQodoReview,
  clampWaitSeconds,
  QODO_REVIEW_MAX_FINDINGS,
  QODO_REVIEW_MAX_WAIT_SECONDS,
  readQodoReview,
} from './awaitQodoReview.js';

const PR = 'https://ghe.example.test/acme/widgets/pull/12';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function finding(over: Partial<QodoFinding> = {}): QodoFinding {
  return {
    actionLevel: 'action_required',
    attributionStatus: 'pending',
    category: 'Quality',
    description: 'Synthetic description.',
    id: 'f-1',
    source: 'IssueFinding',
    title: 'Synthetic title',
    ...over,
  };
}

function ok(
  over: {
    commitSha?: string;
    status?: 'completed' | 'failed' | 'other';
    findings?: QodoFinding[];
    truncated?: boolean;
    withheldFields?: number;
  } = {}
): QodoPrReviewState {
  const findings = over.findings ?? [];
  return {
    findingCount: findings.length,
    findings,
    kind: 'ok',
    session: {
      commitSha: over.commitSha ?? HEAD,
      runId: 1,
      startedAt: '2026-01-01T00:00:00Z',
      status: over.status ?? 'completed',
    },
    truncated: over.truncated ?? false,
    unrecognisedStatuses: 0,
    withheldFields: over.withheldFields ?? 0,
  };
}

/** A clock the test advances only by sleeping, so a deadline is reached without waiting. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function read(script: QodoPrReviewState[], over: { waitSeconds?: number } = {}) {
  const client = createFakeQodoFindingsClient(script);
  return {
    client,
    result: readQodoReview({
      ...clock(),
      client,
      headSha: HEAD,
      prUrl: PR,
      waitSeconds: over.waitSeconds ?? 30,
    }),
  };
}

describe('readQodoReview', () => {
  it('reports a completed review of the head commit as reviewed', async () => {
    const { result } = read([ok({ findings: [finding()] })]);
    expect(await result).toMatchObject({
      blocking: true,
      headMatches: true,
      reviewedHeadSha: HEAD,
      status: 'reviewed',
    });
  });

  it('compares the commit case-insensitively', async () => {
    const client = createFakeQodoFindingsClient([ok({ commitSha: HEAD.toUpperCase() })]);
    const out = await readQodoReview({
      ...clock(),
      client,
      headSha: HEAD,
      prUrl: PR,
      waitSeconds: 0,
    });
    expect(out.status).toBe('reviewed');
  });

  it('reports a review of another commit as stale once the wait is over', async () => {
    const { client, result } = read([ok({ commitSha: OTHER, findings: [finding()] })]);
    const out = await result;
    expect(out).toMatchObject({
      blocking: false,
      headMatches: false,
      reviewedHeadSha: OTHER,
      status: 'stale',
    });
    expect(out.findings).toEqual([]);
    expect(client.calls.length).toBeGreaterThan(1);
  });

  it('picks up the review of the head commit when it lands during the wait', async () => {
    const { result } = read([ok({ commitSha: OTHER }), { kind: 'no_session' }, ok()]);
    expect((await result).status).toBe('reviewed');
  });

  it('is pending at the deadline when the session is not completed', async () => {
    const { result } = read([ok({ status: 'other' })]);
    expect(await result).toMatchObject({ headMatches: true, status: 'pending' });
  });

  it('is pending at the deadline when Qodo has no review at all', async () => {
    const { client, result } = read([{ kind: 'no_session' }]);
    expect(await result).toMatchObject({ reviewedHeadSha: null, status: 'pending' });
    expect(client.calls.length).toBeGreaterThan(1);
  });

  it('reads once and does not sleep when the wait is 0', async () => {
    const { client, result } = read([{ kind: 'no_session' }], { waitSeconds: 0 });
    expect((await result).status).toBe('pending');
    expect(client.calls).toHaveLength(1);
  });

  it('treats a failed session on the head commit as unavailable, without waiting', async () => {
    const { client, result } = read([ok({ status: 'failed' })]);
    expect((await result).status).toBe('unavailable');
    expect(client.calls).toHaveLength(1);
  });

  it('keeps waiting past a failed session of an older commit', async () => {
    const { result } = read([ok({ commitSha: OTHER, status: 'failed' }), ok()]);
    expect((await result).status).toBe('reviewed');
  });

  it('maps an unreadable Qodo to unavailable at once', async () => {
    const { client, result } = read([{ kind: 'unavailable', reason: 'call_failed' }]);
    expect((await result).status).toBe('unavailable');
    expect(client.calls).toHaveLength(1);
  });

  it('counts open findings by level, ranks them, and derives worst and blocking', async () => {
    const { result } = read([
      ok({
        findings: [
          finding({ actionLevel: 'informational', id: 'i' }),
          finding({ actionLevel: 'remediation_recommended', id: 'r' }),
          finding({ actionLevel: 'action_required', id: 'a' }),
          finding({ actionLevel: 'action_required', attributionStatus: 'implemented', id: 'x' }),
          finding({ actionLevel: 'action_required', attributionStatus: 'dismissed', id: 'y' }),
        ],
      }),
    ]);
    const out = await result;
    expect(out.counts).toEqual({
      actionRequired: 1,
      informational: 1,
      open: 3,
      remediationRecommended: 1,
    });
    expect(out.findings.map((f) => f.id)).toEqual(['a', 'r', 'i']);
    expect(out.worst).toBe('action_required');
    expect(out.blocking).toBe(true);
  });

  it('is not blocking when the worst open finding is below action_required', async () => {
    const { result } = read([
      ok({ findings: [finding({ actionLevel: 'remediation_recommended' })] }),
    ]);
    const out = await result;
    expect(out).toMatchObject({ blocking: false, worst: 'remediation_recommended' });
  });

  it('reports a clean review as reviewed with nothing open', async () => {
    const out = await read([ok()]).result;
    expect(out).toMatchObject({
      blocking: false,
      counts: { actionRequired: 0, informational: 0, open: 0, remediationRecommended: 0 },
      status: 'reviewed',
      worst: 'none',
    });
  });

  it('never counts an unknown attribution status or an unknown level as blocking', async () => {
    const out = await read([
      ok({
        findings: [
          finding({ attributionStatus: 'unknown', id: 'u' }),
          finding({ actionLevel: 'unknown', id: 'k' }),
        ],
      }),
    ]).result;
    expect(out.counts).toMatchObject({ actionRequired: 0, open: 1 });
    expect(out.blocking).toBe(false);
    expect(out.worst).toBe('none');
  });

  it('lists at most 25 findings and says it truncated', async () => {
    const many = Array.from({ length: 40 }, (_, i) => finding({ id: `f-${i}` }));
    const out = await read([ok({ findings: many })]).result;
    expect(out.findings).toHaveLength(QODO_REVIEW_MAX_FINDINGS);
    expect(out.counts.open).toBe(40);
    expect(out.truncated).toBe(true);
  });

  it('carries the client truncation flag through', async () => {
    const out = await read([ok({ findings: [finding()], truncated: true })]).result;
    expect(out.truncated).toBe(true);
  });

  it('ignores open findings below the lowest level asked for', async () => {
    const client = createFakeQodoFindingsClient([
      ok({
        findings: [
          finding({ actionLevel: 'informational', id: 'i' }),
          finding({ actionLevel: 'remediation_recommended', id: 'r' }),
        ],
      }),
    ]);
    const out = await readQodoReview({
      ...clock(),
      client,
      headSha: HEAD,
      minLevel: 'remediation_recommended',
      prUrl: PR,
      waitSeconds: 0,
    });
    expect(out.findings.map((f) => f.id)).toEqual(['r']);
    expect(out.counts.informational).toBe(0);
  });

  it('still counts and blocks on a finding whose text was withheld', async () => {
    const out = await read([
      ok({
        findings: [
          finding({
            description: '[withheld: failed the injection screen]',
            title: '[withheld: failed the injection screen]',
          }),
        ],
        withheldFields: 2,
      }),
    ]).result;
    expect(out).toMatchObject({
      blocking: true,
      counts: { actionRequired: 1, open: 1 },
      status: 'reviewed',
      withheldFields: 2,
    });
  });

  it('has no passed field, so the interpreter never reads it as a failed gate', async () => {
    const out = await read([ok({ findings: [finding()] })]).result;
    expect(out).not.toHaveProperty('passed');
  });
});

describe('clampWaitSeconds', () => {
  it('clamps to 0..600 and falls back for a non-number', () => {
    expect(clampWaitSeconds(99_999, 180)).toBe(QODO_REVIEW_MAX_WAIT_SECONDS);
    expect(clampWaitSeconds(-5, 180)).toBe(0);
    expect(clampWaitSeconds(12.9, 180)).toBe(12);
    expect(clampWaitSeconds('9', 180)).toBe(180);
    expect(clampWaitSeconds(undefined, 180)).toBe(180);
    expect(clampWaitSeconds(Number.NaN, 180)).toBe(180);
    expect(clampWaitSeconds(undefined, 5000)).toBe(QODO_REVIEW_MAX_WAIT_SECONDS);
  });
});

describe('awaitQodoReview', () => {
  beforeEach(() => {
    m.createClient.mockClear();
    m.findRepo.mockReset();
    m.calls.length = 0;
    m.events.length = 0;
    m.persist.mockClear();
    m.script = [ok()];
    m.settings = { 'qodo.enabled': true, 'qodo.reviewWaitSeconds': 0 };
    m.findRepo.mockResolvedValue({ team: { orgId: 'org-1' }, teamId: 'team-1' });
  });

  const input = { headSha: HEAD, prUrl: PR, repoId: 'repo-1' };

  it('returns disabled before it builds a client or reads from Qodo', async () => {
    m.settings = { 'qodo.enabled': false };
    const out = await awaitQodoReview(input);
    expect(out.status).toBe('disabled');
    expect(m.createClient).not.toHaveBeenCalled();
    expect(m.calls).toEqual([]);
  });

  it('derives the team from the run’s repository, never from the inputs', async () => {
    const out = await awaitQodoReview({
      ...input,
      connectionId: 'someone-elses',
      teamId: 'other-team',
    } as typeof input);
    expect(out.status).toBe('reviewed');
    expect(m.findRepo).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', type: 'git_repo' } })
    );
    expect(m.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' })
    );
  });

  it('is unavailable for a run with no repository or a repository with no team', async () => {
    expect((await awaitQodoReview({ ...input, repoId: null })).status).toBe('unavailable');
    m.findRepo.mockResolvedValue({ team: null, teamId: null });
    expect((await awaitQodoReview(input)).status).toBe('unavailable');
    expect(m.createClient).not.toHaveBeenCalled();
  });

  it('is unavailable for a connection id that is not a repository', async () => {
    // The lookup filters on the repository type, so another kind of connection is not found.
    m.findRepo.mockImplementation(async (a: unknown) =>
      (a as { where: { type?: string } }).where.type === 'git_repo' ? null : { teamId: 'team-1' }
    );
    expect((await awaitQodoReview({ ...input, repoId: 'an-mcp-connection' })).status).toBe(
      'unavailable'
    );
    expect(m.createClient).not.toHaveBeenCalled();
  });

  it('records the outcome and persists the trace, even when the read fails', async () => {
    m.script = [{ kind: 'unavailable', reason: 'call_failed' }];
    const out = await awaitQodoReview(input);
    expect(out.status).toBe('unavailable');
    expect(m.events.map((e) => e.name)).toEqual(['qodo.read_unavailable', 'qodo.review_outcome']);
    expect(m.events[0]?.outputJson).toEqual({ reason: 'call_failed' });
    expect(m.events[1]?.outputJson).toEqual({
      reason: 'read',
      status: 'unavailable',
      withheldFields: 0,
    });
    expect(m.persist).toHaveBeenCalledOnce();
  });

  it('records the outcome and persists when the database lookup throws', async () => {
    m.findRepo.mockRejectedValue(new Error('secret-db-detail'));
    await awaitQodoReview(input);
    expect(m.events).toEqual([
      {
        name: 'qodo.review_outcome',
        outputJson: { reason: 'error', status: 'unavailable', withheldFields: 0 },
      },
    ]);
    expect(m.persist).toHaveBeenCalledOnce();
  });

  it('hands the client the same tracer it persists', async () => {
    await awaitQodoReview(input);
    const deps = m.createClient.mock.calls[0]?.[0] as { tracer: unknown };
    expect(m.persist.mock.calls[0]?.[0]).toBe(deps.tracer);
  });

  it('is unavailable when the bound inputs are missing', async () => {
    expect((await awaitQodoReview({ ...input, headSha: undefined })).status).toBe('unavailable');
    expect((await awaitQodoReview({ ...input, prUrl: 42 })).status).toBe('unavailable');
  });

  it('never throws when the database or the client fails', async () => {
    m.findRepo.mockRejectedValue(new Error('secret-db-detail'));
    const out = await awaitQodoReview(input);
    expect(out.status).toBe('unavailable');
    expect(JSON.stringify(out)).not.toContain('secret-db-detail');
  });

  it('waits for the node’s own seconds, clamped, over the setting', async () => {
    m.settings = { 'qodo.enabled': true, 'qodo.reviewWaitSeconds': 600 };
    m.script = [{ kind: 'no_session' }];
    const out = await awaitQodoReview({ ...input, waitSeconds: 0 });
    expect(out.status).toBe('pending');
    expect(m.calls).toHaveLength(1);
  });
});
