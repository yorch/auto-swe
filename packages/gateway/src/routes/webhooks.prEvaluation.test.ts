import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'hook-secret';

const settingsState = vi.hoisted(() => ({
  defaultMode: 'advisory' as string,
  enabled: true,
  failWith: null as Error | null,
  lastCtx: null as unknown,
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@auto-swe/shared/config', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: vi.fn(async () => false),
  resolveSettings: vi.fn(async (_keys: string[], ctx: unknown) => {
    settingsState.lastCtx = ctx;
    if (settingsState.failWith) {
      throw settingsState.failWith;
    }
    return {
      'prEvaluation.defaultMode': settingsState.defaultMode,
      'prEvaluation.enabled': settingsState.enabled,
    };
  }),
}));
vi.mock('../lib/githubWebhookSecret.js', () => ({
  resolveWebhookSecret: vi.fn(async () => ({ host: null, secret: SECRET, status: 'ok' })),
}));
vi.mock('../lib/repositoryHost.js', async (orig) => ({
  ...(await orig<typeof import('../lib/repositoryHost.js')>()),
  claimsHostWithOwnSecret: vi.fn(async () => false),
  webhookRepositoryWhere: vi.fn(async () => ({})),
}));

import { webhookRoutes } from './webhooks.js';

type Connection = {
  id: string;
  isActive: boolean;
  organizationName: string;
  prEvaluationMode: string | null;
  repoName: string;
  team: { orgId: string | null } | null;
  teamId: string;
};

const CONN: Connection = {
  id: 'c0ffee00-1111-4111-8111-111111111111',
  isActive: true,
  organizationName: 'acme',
  prEvaluationMode: null,
  repoName: 'api',
  team: { orgId: 'org-1' },
  teamId: 'team-1',
};

function sign(payload: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
}

describe('pull request evaluation webhook handling', () => {
  const app = Fastify();
  let connections: Connection[] = [];
  let rows: Array<{ id: string; headSha: string; createdAt: Date }> = [];
  const findFirstCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }> = [];
  const updateManyCalls: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }> =
    [];
  const starts: Array<{ id: string; input: unknown }> = [];
  let startFailure: Error | null = null;
  let platformPr: { workflow: { temporalWorkflowId: string } } | null = null;
  let armedRow: { id: string } | null = null;
  const armedLookups: Array<Record<string, unknown>> = [];
  let botRow: { id: string } | null = null;
  const botLookups: Array<Record<string, unknown>> = [];
  const connectionWheres: Array<Record<string, unknown>> = [];
  const platformLookups: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });
    app.decorate('prisma', {
      connection: {
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          connectionWheres.push(args.where);
          return connections;
        }),
      },
      prEvaluation: {
        findFirst: vi.fn(
          async (args: {
            where: { autoMergeEnabled?: boolean; botApproved?: boolean; headSha: string };
          }) => {
            if (args.where.autoMergeEnabled) {
              armedLookups.push(args.where);
              return armedRow;
            }
            if (args.where.botApproved) {
              botLookups.push(args.where);
              return botRow;
            }
            findFirstCalls.push(args as never);
            const match = rows
              .filter((r) => r.headSha === args.where.headSha)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
            return match ? { id: match.id } : null;
          }
        ),
        update: vi.fn(async (args: never) => {
          updateCalls.push(args);
          return {};
        }),
        updateMany: vi.fn(async (args: never) => {
          updateManyCalls.push(args);
          return { count: 1 };
        }),
      },
      pullRequest: {
        findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
          // Only the evaluation pre-filter's own lookup; the other handlers' reads find nothing.
          if (!('workflowId' in args.where)) {
            return null;
          }
          platformLookups.push(args.where);
          return platformPr;
        }),
      },
    } as unknown as never);
    app.decorate('temporal', {
      startPrEvaluationWorkflow: vi.fn(async (id: string, input: unknown) => {
        if (startFailure) {
          throw startFailure;
        }
        starts.push({ id, input });
      }),
    } as unknown as never);
    await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
    await app.ready();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    connections = [{ ...CONN }];
    rows = [];
    findFirstCalls.length = 0;
    updateCalls.length = 0;
    updateManyCalls.length = 0;
    starts.length = 0;
    startFailure = null;
    platformPr = { workflow: { temporalWorkflowId: 'wf-1' } };
    armedRow = null;
    botRow = null;
    botLookups.length = 0;
    armedLookups.length = 0;
    connectionWheres.length = 0;
    platformLookups.length = 0;
    settingsState.defaultMode = 'advisory';
    settingsState.enabled = true;
    settingsState.failWith = null;
    settingsState.lastCtx = null;
  });

  function deliver(
    event: 'pull_request' | 'pull_request_review',
    body: Record<string, unknown>,
    delivery = 'D3adBeef-0001'
  ) {
    const payload = JSON.stringify({ repository: { full_name: 'acme/api' }, ...body });
    return app.inject({
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': delivery,
        'x-github-event': event,
        'x-hub-signature-256': sign(payload),
      },
      method: 'POST',
      payload,
      url: '/api/v1/webhooks/git',
    });
  }

  const pr = (extra: Record<string, unknown> = {}) => ({
    head: { sha: 'sha-1' },
    merged: false,
    number: 7,
    title: 'Add thing',
    ...extra,
  });

  describe('starting an evaluation', () => {
    it.each([
      ['pull_request', 'opened'],
      ['pull_request', 'reopened'],
      ['pull_request', 'synchronize'],
      ['pull_request', 'ready_for_review'],
      ['pull_request', 'converted_to_draft'],
      ['pull_request_review', 'submitted'],
      ['pull_request_review', 'dismissed'],
      ['pull_request_review', 'edited'],
    ] as const)('starts one for %s.%s', async (event, action) => {
      const res = await deliver(event, { action, pull_request: pr() });
      expect(res.statusCode).toBe(200);
      expect(starts).toEqual([
        {
          id: 'preval-c0ffee00-7-d3adbeef',
          input: { connectionId: CONN.id, prNumber: 7, trigger: `${event}.${action}` },
        },
      ]);
    });

    it('resolves settings with the repository team and organization', async () => {
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(settingsState.lastCtx).toEqual({ orgId: 'org-1', teamId: 'team-1' });
    });

    it('starts on an edit only when the base changed', async () => {
      await deliver('pull_request', { action: 'edited', pull_request: pr() });
      expect(starts).toHaveLength(0);
      await deliver('pull_request', {
        action: 'edited',
        changes: { base: { ref: { from: 'old' } } },
        pull_request: pr(),
      });
      expect(starts).toHaveLength(1);
    });

    it.each([
      ['labeled', 'pull_request'],
      ['assigned', 'pull_request'],
    ] as const)('ignores %s', async (action, event) => {
      await deliver(event, { action, pull_request: pr() });
      expect(starts).toHaveLength(0);
    });

    it('does nothing when the repository is unknown', async () => {
      connections = [];
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(starts).toHaveLength(0);
    });

    it('does nothing when the feature is disabled', async () => {
      settingsState.enabled = false;
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(starts).toHaveLength(0);
    });

    it('does nothing when the default mode is off', async () => {
      settingsState.defaultMode = 'off';
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(starts).toHaveLength(0);
    });

    it('lets a repository choice override the default in either direction', async () => {
      settingsState.defaultMode = 'off';
      connections = [{ ...CONN, prEvaluationMode: 'advisory' }];
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(starts).toHaveLength(1);
      starts.length = 0;
      settingsState.defaultMode = 'advisory';
      connections = [{ ...CONN, prEvaluationMode: 'off' }];
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(starts).toHaveLength(0);
    });

    it('evaluates a repository in enforce mode, chosen or inherited, without needing an armed row', async () => {
      connections = [{ ...CONN, prEvaluationMode: 'enforce' }];
      await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(starts).toHaveLength(1);
      starts.length = 0;
      connections = [{ ...CONN, prEvaluationMode: null }];
      settingsState.defaultMode = 'enforce';
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(starts).toHaveLength(1);
      expect(armedLookups).toEqual([]);
    });

    it('starts nothing for a pull request the platform did not open', async () => {
      platformPr = null;
      const res = await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(res.statusCode).toBe(200);
      expect(starts).toHaveLength(0);
      expect(platformLookups).toEqual([
        { prNumber: 7, repoId: CONN.id, workflowId: { not: null } },
      ]);
    });

    it('still starts one when the feature is off but an earlier evaluation armed the pull request', async () => {
      settingsState.enabled = false;
      armedRow = { id: 'row-1' };
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(starts).toHaveLength(1);
      expect(armedLookups).toEqual([
        {
          autoMergeEnabled: true,
          closedAt: null,
          connectionId: CONN.id,
          mergedAt: null,
          prNumber: 7,
        },
      ]);
    });

    it('still starts one when the effective mode is off but an earlier evaluation armed it', async () => {
      connections = [{ ...CONN, prEvaluationMode: 'off' }];
      armedRow = { id: 'row-1' };
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(starts).toHaveLength(1);
    });

    it('does not filter out a deactivated repository when looking up connections', async () => {
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(connectionWheres[0]).not.toHaveProperty('isActive');
    });

    it('starts one for a deactivated repository only when an earlier evaluation armed the pull request', async () => {
      connections = [{ ...CONN, isActive: false }];
      armedRow = null;
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(starts).toHaveLength(0);
      armedRow = { id: 'row-1' };
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() }, 'D3adBeef-0002');
      expect(starts).toHaveLength(1);
    });

    it('still starts one when the feature is off but a bot approval of an open pull request stands', async () => {
      settingsState.enabled = false;
      armedRow = null;
      botRow = { id: 'row-bot' };
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(starts).toHaveLength(1);
      expect(botLookups).toEqual([
        {
          botApproved: true,
          closedAt: null,
          connectionId: CONN.id,
          mergedAt: null,
          prNumber: 7,
        },
      ]);
      botRow = null;
    });

    it('starts one for an off-mode or deactivated repository with a standing bot approval only', async () => {
      armedRow = null;
      for (const patch of [{ prEvaluationMode: 'off' }, { isActive: false }]) {
        connections = [{ ...CONN, ...patch }];
        botRow = null;
        const before = starts.length;
        await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
        expect(starts).toHaveLength(before);
        botRow = { id: 'row-bot' };
        await deliver(
          'pull_request',
          { action: 'synchronize', pull_request: pr() },
          'D3adBeef-0003'
        );
        expect(starts).toHaveLength(before + 1);
      }
      botRow = null;
    });

    it('does not look for a bot approval when an armed row already starts the evaluation', async () => {
      settingsState.enabled = false;
      armedRow = { id: 'row-1' };
      const lookups = botLookups.length;
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(botLookups).toHaveLength(lookups);
    });

    it('starts nothing when switched off and nothing was armed', async () => {
      settingsState.enabled = false;
      armedRow = null;
      await deliver('pull_request', { action: 'synchronize', pull_request: pr() });
      expect(starts).toHaveLength(0);
    });

    it('answers 200 and carries on when the start fails', async () => {
      startFailure = new Error('temporal unreachable');
      const res = await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(res.statusCode).toBe(200);
    });

    it('answers 200 when the settings cannot be read', async () => {
      settingsState.failWith = new Error('db down');
      const res = await deliver('pull_request', { action: 'opened', pull_request: pr() });
      expect(res.statusCode).toBe(200);
      expect(starts).toHaveLength(0);
    });
  });

  describe('recording how a pull request ended', () => {
    const merged = (extra: Record<string, unknown> = {}) => ({
      action: 'closed',
      pull_request: pr({
        closed_at: '2026-10-01T10:00:00Z',
        merged: true,
        merged_at: '2026-10-01T10:00:00Z',
        ...extra,
      }),
    });

    it('marks exactly one row, the newest evaluation of the merged head', async () => {
      rows = [
        { createdAt: new Date('2026-09-30T10:00:00Z'), headSha: 'sha-1', id: 'old' },
        { createdAt: new Date('2026-09-30T12:00:00Z'), headSha: 'sha-1', id: 'newest' },
        { createdAt: new Date('2026-09-30T13:00:00Z'), headSha: 'sha-other', id: 'other-head' },
      ];
      await deliver('pull_request', merged());
      expect(updateCalls).toEqual([
        {
          data: {
            closedAt: new Date('2026-10-01T10:00:00Z'),
            mergedAt: new Date('2026-10-01T10:00:00Z'),
          },
          where: { id: 'newest' },
        },
      ]);
      expect(updateManyCalls).toHaveLength(0);
      expect(findFirstCalls[0]).toMatchObject({
        orderBy: { createdAt: 'desc' },
        where: { connectionId: CONN.id, headSha: 'sha-1', prNumber: 7 },
      });
    });

    it('marks nothing when no evaluation matches the merged head', async () => {
      rows = [{ createdAt: new Date(), headSha: 'sha-other', id: 'x' }];
      await deliver('pull_request', merged());
      expect(updateCalls).toHaveLength(0);
      expect(updateManyCalls).toHaveLength(0);
    });

    it('sets closedAt only for a close without a merge', async () => {
      rows = [{ createdAt: new Date(), headSha: 'sha-1', id: 'r1' }];
      await deliver('pull_request', {
        action: 'closed',
        pull_request: pr({ closed_at: '2026-10-02T00:00:00Z', merged: false }),
      });
      expect(updateCalls).toEqual([
        { data: { closedAt: new Date('2026-10-02T00:00:00Z') }, where: { id: 'r1' } },
      ]);
    });

    it('records a merge even when the feature is off', async () => {
      settingsState.enabled = false;
      rows = [{ createdAt: new Date(), headSha: 'sha-1', id: 'r1' }];
      await deliver('pull_request', merged());
      expect(updateCalls).toHaveLength(1);
    });

    it('starts a merged recount for the pull request once the merged row is stamped', async () => {
      rows = [{ createdAt: new Date(), headSha: 'sha-1', id: 'r1' }];
      await deliver('pull_request', merged());
      expect(starts).toHaveLength(1);
      expect(starts[0]?.input).toEqual({ connectionId: CONN.id, prNumber: 7, trigger: 'merged' });
      expect(starts[0]?.id).toBe('preval-c0ffee00-7-d3adbeef');
    });

    it('starts the recount even when the feature is off', async () => {
      settingsState.enabled = false;
      rows = [{ createdAt: new Date(), headSha: 'sha-1', id: 'r1' }];
      await deliver('pull_request', merged());
      expect(starts).toHaveLength(1);
    });

    it('starts no recount when no row matched the merged head, or the close was no merge', async () => {
      rows = [{ createdAt: new Date(), headSha: 'sha-other', id: 'x' }];
      await deliver('pull_request', merged());
      rows = [{ createdAt: new Date(), headSha: 'sha-1', id: 'r1' }];
      await deliver('pull_request', {
        action: 'closed',
        pull_request: pr({ closed_at: '2026-10-02T00:00:00Z', merged: false }),
      });
      expect(starts).toHaveLength(0);
    });

    it('still answers 200 when the recount cannot be started', async () => {
      rows = [{ createdAt: new Date(), headSha: 'sha-1', id: 'r1' }];
      startFailure = new Error('temporal down');
      expect((await deliver('pull_request', merged())).statusCode).toBe(200);
      expect(updateCalls).toHaveLength(1);
    });
  });

  describe('revert detection', () => {
    const revert = (title: string, body: string | null) => ({
      action: 'closed',
      pull_request: pr({
        body,
        merged: true,
        merged_at: '2026-10-01T10:00:00Z',
        number: 15,
        title,
      }),
    });

    it('marks the merged evaluations of the reverted PR from the default body', async () => {
      await deliver('pull_request', revert('Revert "Add thing"', 'Reverts acme/api#12\n\nwhy'));
      expect(updateManyCalls).toHaveLength(1);
      const call = updateManyCalls[0];
      expect(call.data).toEqual({ badMerge: true, badMergeReason: 'revert PR #15 merged' });
      expect(call.where).toMatchObject({ connectionId: CONN.id, prNumber: 12 });
      const since = (call.where.mergedAt as { gte: Date }).gte.getTime();
      const days = (Date.now() - since) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('takes the first reference in a squash-merged revert title', async () => {
      await deliver('pull_request', revert('Revert "Fix x (#12)" (#15)', null));
      expect(updateManyCalls[0]?.where).toMatchObject({ prNumber: 12 });
    });

    it('ignores a revert of another repository', async () => {
      await deliver('pull_request', revert('Revert "x"', 'Reverts other/repo#12'));
      expect(updateManyCalls).toHaveLength(0);
    });

    it('ignores a title that is not a revert and a body that is malformed', async () => {
      await deliver('pull_request', revert('Add thing (#12)', 'Reverts nothing'));
      expect(updateManyCalls).toHaveLength(0);
    });

    it('does not mark anything for a PR closed without a merge', async () => {
      await deliver('pull_request', {
        action: 'closed',
        pull_request: pr({ body: 'Reverts acme/api#12', merged: false, number: 15 }),
      });
      expect(updateManyCalls).toHaveLength(0);
    });
  });
});
