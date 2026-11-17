import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  connectionFindFirst: vi.fn(),
  latestPayload: {} as Record<string, unknown>,
  messages: [] as Array<Record<string, unknown>>,
  orch: { launchedById: 'user-1', repoId: null as string | null },
  pending: false,
  running: 0,
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findFirst: db.connectionFindFirst },
    orchestration: { findUnique: vi.fn(async () => db.orch) },
    orchestrationApproval: { count: vi.fn(async () => 0) },
    orchestrationChild: { count: vi.fn(async () => db.running) },
    orchestrationMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.messages.push(data);
        return data;
      }),
      // The latest ATTACH_REQUEST: one an earlier test left pending, else the last one written.
      findFirst: vi.fn(async () => {
        const written = [...db.messages].reverse().find((x) => x.kind === 'ATTACH_REQUEST');
        if (written) {
          return { id: 'written', payload: written.payload };
        }
        return db.pending ? { id: 'pending', payload: db.latestPayload } : null;
      }),
    },
  },
}));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));

import type { OrchestrationGateway } from '../lib/orchestrationGateway.js';
import type { OrchestratorIntent } from '../lib/orchestrationTypes.js';
import { applyIntents } from './orchestrationApply.js';

const ORCH = '0b1c2d3e-0000-4000-8000-000000000001';
const CHILD = '0b1c2d3e-0000-4000-8000-0000000000c1';
const spawn: OrchestratorIntent = {
  intent: { agent: 'docsMaintainer', label: 'read docs', role: 'reader', task: 'read' },
  kind: 'spawn',
};

function gateway(
  handler: (path: string, body: unknown) => { status: number; body?: unknown } | Error
) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const gw: OrchestrationGateway = {
    post: async (path, body) => {
      calls.push({ body, path });
      const r = handler(path, body);
      if (r instanceof Error) {
        throw r;
      }
      return { body: r.body, status: r.status };
    },
  };
  return { calls, gw };
}
const input = (intents: OrchestratorIntent[]) => ({
  intents,
  orchestrationId: ORCH,
  token: 'orch_secret_token',
  turnKey: 'turn-1',
});

beforeEach(() => {
  db.messages = [];
  db.orch = { launchedById: 'user-1', repoId: null };
  db.pending = false;
  db.latestPayload = {};
  db.running = 0;
  db.connectionFindFirst.mockReset();
});

describe('applyOrchestrationIntents', () => {
  it('sends a spawn to the gateway with a per-intent idempotency key', async () => {
    db.running = 1;
    const { calls, gw } = gateway(() => ({
      body: { childId: 'c', workflowId: 'agent-x', workRequestId: 'w' },
      status: 201,
    }));
    const out = await applyIntents(input([spawn, spawn]), gw);
    expect(calls.map((c) => c.path)).toEqual([
      `/api/v1/orchestrations/${ORCH}/children`,
      `/api/v1/orchestrations/${ORCH}/children`,
    ]);
    expect(calls.map((c) => (c.body as { turnKey: string }).turnKey)).toEqual([
      'turn-1:0',
      'turn-1:1',
    ]);
    expect(out).toMatchObject({ refused: 0, runningChildren: 1, spawned: 2, wait: true });
    expect(db.messages).toEqual([]);
  });

  it('turns a refusal into a SYSTEM notice with its code and never retries', async () => {
    const { calls, gw } = gateway(() => ({
      body: { code: 'SCOPE_OVERLAP', message: 'overlaps writer w1' },
      status: 409,
    }));
    const out = await applyIntents(input([spawn]), gw);
    expect(calls).toHaveLength(1);
    expect(out.refused).toBe(1);
    expect(out.spawned).toBe(0);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      kind: 'NOTICE',
      payload: expect.objectContaining({ code: 'SCOPE_OVERLAP' }),
      role: 'SYSTEM',
    });
    expect(String(db.messages[0]?.body)).toContain('overlaps writer w1');
  });

  it('notes an unreachable or odd answer without leaking the token or the body', async () => {
    const down = await applyIntents(
      input([spawn]),
      gateway(() => new Error('connect orch_secret_token')).gw
    );
    expect(down.refused).toBe(1);
    expect(db.messages[0]?.payload).toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
    db.messages = [];
    const odd = await applyIntents(
      input([spawn]),
      gateway(() => ({ body: '<html>secret</html>', status: 502 })).gw
    );
    expect(odd.refused).toBe(1);
    expect(db.messages[0]?.payload).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(JSON.stringify(db.messages)).not.toContain('secret');
    // A well-formed refusal with a code this worker does not know is a generic notice, not a throw.
    db.messages = [];
    const unknown = await applyIntents(
      input([spawn]),
      gateway(() => ({ body: { code: 'SOMETHING_NEW', message: 'later' }, status: 409 })).gw
    );
    expect(unknown.refused).toBe(1);
    expect(db.messages[0]?.payload).toMatchObject({ code: 'GATEWAY_ERROR' });
    expect(db.messages[0]?.body).toContain('HTTP 409');
  });

  it('routes message and cancel to the child routes and refuses a junk child id locally', async () => {
    const { calls, gw } = gateway(() => ({ status: 200 }));
    await applyIntents(
      input([
        { intent: { childId: CHILD, message: 'hi' }, kind: 'message' },
        { intent: { childId: CHILD }, kind: 'cancel' },
        { intent: { childId: '../../x' }, kind: 'cancel' },
      ]),
      gw
    );
    expect(calls.map((c) => c.path)).toEqual([
      `/api/v1/orchestrations/${ORCH}/children/${CHILD}/messages`,
      `/api/v1/orchestrations/${ORCH}/children/${CHILD}/cancel`,
    ]);
    expect(calls[0]?.body).toEqual({ body: 'hi' });
    expect(db.messages[0]?.payload).toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('rejects a malformed spawn locally, without calling the gateway', async () => {
    const { calls, gw } = gateway(() => ({ status: 201 }));
    const bad = {
      intent: { ...spawn.intent, role: 'writer' },
      kind: 'spawn',
    } as OrchestratorIntent;
    const out = await applyIntents(input([bad]), gw);
    expect(calls).toHaveLength(0);
    expect(out.refused).toBe(1);
  });

  it('sends the same spawn key on a retried apply and a different one for each intent and turn', async () => {
    const { calls, gw } = gateway(() => ({ status: 200 }));
    await applyIntents(input([spawn, spawn]), gw);
    await applyIntents(input([spawn, spawn]), gw);
    await applyIntents({ ...input([spawn]), turnKey: 'turn-2' }, gw);
    const keys = calls.map((c) => (c.body as { turnKey: string }).turnKey);
    expect(keys).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:0', 'turn-1:1', 'turn-2:0']);
  });

  describe('requestRepo', () => {
    const req = (candidate?: string): OrchestratorIntent => ({
      intent: { candidate, reason: 'need the code' },
      kind: 'requestRepo',
    });
    const { gw } = gateway(() => ({ status: 200 }));

    it('writes a pending ATTACH_REQUEST for the launcher to confirm', async () => {
      const out = await applyIntents(input([req()]), gw);
      expect(db.messages).toHaveLength(1);
      expect(db.messages[0]).toMatchObject({
        kind: 'ATTACH_REQUEST',
        payload: { candidateRepoId: null, reason: 'need the code' },
        role: 'ORCHESTRATOR',
      });
      expect(db.messages[0]?.payload).not.toHaveProperty('status');
      expect(out.refused).toBe(0);
    });

    it('lets a new request through once the earlier one was attached or declined', async () => {
      for (const resolved of [
        { reason: 'x', resolution: 'DECLINED', resolvedAt: 'now' },
        { reason: 'x', repoId: 'r', resolution: 'ATTACHED', resolvedAt: 'now' },
        { reason: 'x', status: 'DECLINED' },
      ]) {
        db.messages = [];
        db.pending = true;
        db.latestPayload = resolved;
        const out = await applyIntents(input([req()]), gw);
        expect(out.refused).toBe(0);
        expect(db.messages.map((m) => m.kind)).toEqual(['ATTACH_REQUEST']);
        expect(out.pendingAttach).toBe(true);
      }
    });

    it('still reads a legacy payload with status PENDING as pending', async () => {
      db.pending = true;
      db.latestPayload = { reason: 'x', status: 'PENDING' };
      const out = await applyIntents(input([req()]), gw);
      expect(out.refused).toBe(1);
    });

    it('creates only one pending request for two requestRepo intents', async () => {
      const out = await applyIntents(input([req(), req()]), gw);
      expect(db.messages.filter((m) => m.kind === 'ATTACH_REQUEST')).toHaveLength(1);
      expect(db.messages.filter((m) => m.kind === 'NOTICE')).toHaveLength(1);
      expect(db.messages.find((m) => m.kind === 'NOTICE')?.payload).toMatchObject({
        code: 'ATTACH_ALREADY_PENDING',
      });
      expect(out.refused).toBe(1);
    });

    it('is refused when a request is already pending', async () => {
      db.pending = true;
      const out = await applyIntents(input([req()]), gw);
      expect(out.refused).toBe(1);
      expect(db.messages.map((m) => m.kind)).toEqual(['NOTICE']);
      expect(db.messages[0]?.payload).toMatchObject({ code: 'ATTACH_ALREADY_PENDING' });
      expect(out.pendingAttach).toBe(true);
    });

    it('is refused once a repository is attached', async () => {
      db.orch.repoId = 'repo-1';
      await applyIntents(input([req()]), gw);
      expect(db.messages[0]?.payload).toMatchObject({ code: 'REPO_ALREADY_ATTACHED' });
    });

    it('is refused for an orchestration with no person to confirm', async () => {
      (db.orch as { launchedById: string | null }).launchedById = null;
      await applyIntents(input([req()]), gw);
      expect(db.messages[0]?.payload).toMatchObject({ code: 'ATTACH_NOT_AVAILABLE' });
    });

    it('keeps a reachable candidate and silently drops an unreachable one', async () => {
      const id = '0b1c2d3e-0000-4000-8000-0000000000d1';
      db.connectionFindFirst.mockResolvedValueOnce({ id });
      await applyIntents(input([req(id)]), gw);
      expect(db.messages[0]?.payload).toMatchObject({ candidateRepoId: id });

      db.messages = [];
      db.connectionFindFirst.mockResolvedValueOnce(null);
      await applyIntents(input([req(id)]), gw);
      // Same outcome as a candidate that does not exist: a request with no candidate, no notice.
      expect(db.messages).toHaveLength(1);
      expect(db.messages[0]).toMatchObject({
        kind: 'ATTACH_REQUEST',
        payload: { candidateRepoId: null },
      });
      const where = db.connectionFindFirst.mock.calls[1]?.[0].where;
      expect(where).toMatchObject({ id, type: 'git_repo' });
      expect(JSON.stringify(where)).toContain('user-1');
    });
  });
});
