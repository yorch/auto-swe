import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from '../lib/runVisibility.js';
import { signDownloadLink } from '../lib/transcriptDownloadLink.js';
import { _resetAuthCachesForTests, assertServiceScopesAdmissible } from '../plugins/auth.js';
import { contentAuthHook, transcriptRoutes } from './transcripts.js';

const h = vi.hoisted(() => ({
  artifacts: new Map<string, Buffer>(),
  /** Artifact reads that wait for the test to release them. */
  gates: new Map<string, Promise<void>>(),
  log: { info: vi.fn(), warn: vi.fn() },
  metricFailures: [] as string[],
}));

vi.mock('../lib/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/metrics.js')>()),
  recordTranscriptAccessLogFailure: (action: string) => h.metricFailures.push(action),
}));

vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  getArtifact: vi.fn(async (id: string) => {
    await h.gates.get(id);
    const body = h.artifacts.get(id);
    if (!body) {
      throw new Error('artifact not found');
    }
    return { body, contentType: 'application/x-ndjson+gzip' };
  }),
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@auto-swe/shared/lib/tenantGuard')>();
  return { ...orig, runUnscoped: (_r: string, _m: readonly string[], fn: () => unknown) => fn() };
});

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const TX_ID = '22222222-2222-4222-8222-222222222222';
const SP_TX = '33333333-3333-4333-8333-333333333333';

function newMockPrisma() {
  return {
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    agentTranscript: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentTranscriptPart: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    apiToken: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    transcriptAccessLog: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: 'log-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'ENGINEER', slackId: null }),
    },
    workflowRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function putPart(lines: unknown[]): { artifactId: string; seq: number; sha256: string } {
  const artifactId = `art-${h.artifacts.size}`;
  const body = gzipSync(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  h.artifacts.set(artifactId, body);
  return {
    artifactId,
    seq: h.artifacts.size - 1,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

function transcriptRow(overrides: Record<string, unknown> = {}) {
  return {
    activityOutcome: 'succeeded',
    activityType: 'executeImplementation',
    agentKeys: ['implementer'],
    attempt: 1,
    closedAt: new Date('2026-01-01T01:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    id: TX_ID,
    legalHold: false,
    modelCallCount: 1,
    runId: RUN_ID,
    runLegalHold: false,
    runtime: 'ai-sdk',
    sha256: null,
    sizeBytes: 10,
    specNodeId: null,
    status: 'complete',
    workflowId: 'wf-1',
    ...overrides,
  };
}

async function buildApp(opts: { role?: string; service?: boolean } = {}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    hashToken: (t: string) => `hash:${t}`,
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: opts.role ?? 'ADMIN',
      sub: 'u-1',
    }),
  } as unknown as never);
  if (opts.service) {
    prisma.apiToken.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 86_400_000),
      id: 'tok-1',
      revokedAt: null,
      scopes: ['runs:read'],
      servicePrincipal: {
        connectionIds: [],
        disabledAt: null,
        id: 'sp-1',
        name: 'deployer',
        team: { isActive: true, organization: { isActive: true } },
        teamId: 'team-1',
        templateIds: [],
      },
      servicePrincipalId: 'sp-1',
      user: null,
      userId: null,
    });
  }
  // Swap in the spyable logger before routes freeze the instance.
  app.addHook('onRequest', async (request) => {
    request.log = h.log as never;
  });
  // The auth plugin's boot-time check: a route may only declare serviceScopes behind a role a
  // service principal can hold.
  app.addHook('onRoute', assertServiceScopesAdmissible);
  await app.register(transcriptRoutes);
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };
const SP_AUTH = { authorization: 'Bearer ats_service' };

function ndjson(res: { payload: string }) {
  return res.payload
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

const previousKey = process.env.CONFIG_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});
afterAll(() => {
  if (previousKey === undefined) {
    delete process.env.CONFIG_ENCRYPTION_KEY;
  } else {
    process.env.CONFIG_ENCRYPTION_KEY = previousKey;
  }
  _resetKeyCacheForTests();
});

beforeEach(() => {
  h.artifacts.clear();
  h.gates.clear();
  h.metricFailures.length = 0;
  vi.clearAllMocks();
  _resetAuthCachesForTests();
});

/** The data of every access-log row the route wrote, in order. */
function accessRows(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.transcriptAccessLog.create.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data
  );
}

/** The outcome each access-log update recorded, in order. */
function outcomes(prisma: ReturnType<typeof newMockPrisma>) {
  return prisma.transcriptAccessLog.update.mock.calls.map(
    (c) => (c[0] as { data: { outcome: string } }).data.outcome
  );
}

describe('transcriptRoutes', () => {
  it('refuses service principals on every route', async () => {
    const { app, prisma } = await buildApp({ service: true });
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow({ id: SP_TX }));
    // ENGINEER-role routes opt in to service tokens and refuse them in the handler.
    for (const [method, url] of [
      ['GET', `/api/v1/workflow-runs/${RUN_ID}/transcripts`],
      ['GET', `/api/v1/transcripts/${SP_TX}`],
      ['GET', `/api/v1/transcripts/${SP_TX}/content`],
      ['POST', `/api/v1/transcripts/${SP_TX}/download-link`],
    ] as const) {
      const res = await app.inject({
        headers: SP_AUTH,
        method,
        url,
        ...(method === 'POST' ? { payload: { format: 'raw', scrubPii: false } } : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('TRANSCRIPTS_NOT_AVAILABLE');
    }
    // ADMIN routes never admit a service token at all (a principal holds no role).
    for (const [method, url] of [
      ['POST', `/api/v1/transcripts/${SP_TX}/verify`],
      [
        'GET',
        '/api/v1/platform/transcripts/export?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      ],
      ['GET', '/api/v1/platform/transcripts/access-log'],
    ] as const) {
      const res = await app.inject({ headers: SP_AUTH, method, url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    }
    expect(prisma.transcriptAccessLog.create).not.toHaveBeenCalled();
  });

  it('lets a non-admin list transcripts for a visible run, 404 when invisible', async () => {
    const { app, prisma } = await buildApp({ role: 'ENGINEER' });
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    prisma.agentTranscript.findMany.mockResolvedValue([transcriptRow()]);
    const ok = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toHaveLength(1);
    expect(ok.json().data[0].id).toBe(TX_ID);

    prisma.workflowRun.findFirst.mockResolvedValue(null);
    const missing = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('requires run control for content: visible-but-not-controlled → 404', async () => {
    const { app, prisma } = await buildApp({ role: 'ENGINEER' });
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue(null); // control filter finds nothing
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('makes a runless transcript ADMIN-only', async () => {
    const { app, prisma } = await buildApp({ role: 'ENGINEER' });
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow({ runId: null }));
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('streams every record across multiple parts, then the eof sentinel', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    const p0 = putPart([
      { kind: 'http_call', path: '/v1/messages', seq: 0 },
      { kind: 'http_call', path: '/v1/messages', seq: 1 },
    ]);
    const p1 = putPart([{ event: 'truncated', kind: 'marker', seq: 2 }]);
    p1.seq = 1;
    prisma.agentTranscriptPart.findMany.mockResolvedValue([p0, p1]);

    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('transcript-');
    const lines = ndjson(res);
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toEqual({ complete: true, kind: 'eof' });
    expect(lines[0]).toMatchObject({ kind: 'http_call', seq: 0 });
    // The audit line records the read.
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transcript_content_read', transcriptId: TX_ID }),
      expect.any(String)
    );
  });

  it('emits integrity_error and no eof when a part hash mismatches', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    const part = putPart([{ kind: 'http_call', seq: 0 }]);
    part.sha256 = '0'.repeat(64);
    prisma.agentTranscriptPart.findMany.mockResolvedValue([part]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content`,
    });
    const lines = ndjson(res);
    expect(lines.at(-1)).toMatchObject({ kind: 'integrity_error', reason: 'sha_mismatch' });
    expect(lines.some((l) => l.kind === 'eof')).toBe(false);
  });

  it('emits integrity_error too_large when a part decompresses past the bound', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    const huge = gzipSync('x'.repeat(65 * 1024 * 1024));
    const artifactId = 'art-huge';
    h.artifacts.set(artifactId, huge);
    prisma.agentTranscriptPart.findMany.mockResolvedValue([
      { artifactId, seq: 0, sha256: createHash('sha256').update(huge).digest('hex') },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content`,
    });
    const lines = ndjson(res);
    expect(lines.at(-1)).toMatchObject({ kind: 'integrity_error', reason: 'too_large' });
  });

  it('scrubs both record and normalized when scrubPii=true', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    prisma.agentTranscriptPart.findMany.mockResolvedValue([
      putPart([
        {
          kind: 'http_call',
          path: '/v1/messages',
          request: { messages: [{ content: 'mail jane@example.com', role: 'user' }], model: 'm' },
          response: { body: { content: [{ text: 'ok', type: 'text' }], type: 'message' } },
          seq: 0,
        },
      ]),
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content?format=normalized&scrubPii=true`,
    });
    const line = ndjson(res)[0] as {
      normalized: { messages: { content: { text: string }[] }[] };
      record: { request: { messages: { content: string }[] } };
    };
    expect(JSON.stringify(line.record)).not.toContain('jane@example.com');
    expect(JSON.stringify(line.normalized)).not.toContain('jane@example.com');
    expect(JSON.stringify(line)).toContain('[EMAIL]');
  });

  it('rejects an export range over 31 days or with to <= from', async () => {
    const { app } = await buildApp();
    for (const [from, to] of [
      ['2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'],
      ['2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'],
    ]) {
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/platform/transcripts/export?from=${from}&to=${to}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_RANGE');
    }
  });

  it('paginates export by cursor across more than a batch of transcripts', async () => {
    const { app, prisma } = await buildApp();
    const total = 55;
    const all = Array.from({ length: total }, (_, i) =>
      transcriptRow({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), id: `tx-${i}` })
    );
    prisma.agentTranscript.findMany.mockImplementation(
      async ({ take, where }: { take: number; where: Record<string, unknown> }) => {
        let rows = all;
        const or = where.OR as
          | { createdAt: { gt: Date } | Date; id?: { gt: string } }[]
          | undefined;
        if (or) {
          const [a, b] = or as [
            { createdAt: { gt: Date } },
            { createdAt: Date; id: { gt: string } },
          ];
          rows = all.filter(
            (t) =>
              t.createdAt > a.createdAt.gt ||
              (t.createdAt.getTime() === b.createdAt.getTime() && t.id > (b.id?.gt ?? ''))
          );
        }
        return rows.slice(0, take);
      }
    );
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/transcripts/export?from=2025-12-31T00:00:00Z&to=2026-01-31T00:00:00Z',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('transcripts-export-');
    const lines = ndjson(res);
    expect(lines.at(-1)).toEqual({ complete: true, kind: 'eof' });
    // One eof + one line per transcript (no parts → none).
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transcript_export' }),
      expect.any(String)
    );
  });

  it('sets a run-level legal hold in one transaction and audits it', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findUnique.mockResolvedValue({ id: RUN_ID });
    const res = await app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { reason: 'litigation hold' },
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts/legal-hold`,
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.agentTranscript.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: RUN_ID } })
    );
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'transcript_legal_hold_set',
        actorId: 'u-1',
        reason: 'litigation hold',
        runId: RUN_ID,
      }),
      expect.any(String)
    );
  });

  it('sets and clears a per-transcript legal hold', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    const set = await app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { reason: 'hold this one' },
      url: `/api/v1/transcripts/${TX_ID}/legal-hold`,
    });
    expect(set.statusCode).toBe(200);
    expect(prisma.agentTranscript.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ legalHold: true, legalHoldReason: 'hold this one' }),
        where: { id: TX_ID },
      })
    );
    const clear = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/transcripts/${TX_ID}/legal-hold`,
    });
    expect(clear.statusCode).toBe(200);
    expect(prisma.agentTranscript.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ legalHold: false }) })
    );
  });

  it('releases a run hold without touching per-transcript holds', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findUnique.mockResolvedValue({ id: RUN_ID });
    await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts/legal-hold`,
    });
    const data = prisma.agentTranscript.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.runLegalHold).toBe(false);
    expect(data.legalHold).toBeUndefined();
  });

  it('writes only runLegalHold* when a run-level hold is set', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findUnique.mockResolvedValue({ id: RUN_ID });
    await app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { reason: 'r' },
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts/legal-hold`,
    });
    const data = prisma.agentTranscript.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.runLegalHold).toBe(true);
    expect(data.legalHold).toBeUndefined();
  });

  it('logs a content read before streaming and records ok once the stream ends', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    prisma.agentTranscriptPart.findMany.mockResolvedValue([putPart([{ kind: 'marker' }])]);
    const res = await app.inject({
      headers: { ...AUTH, 'user-agent': 'test-agent' },
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content?format=normalized&scrubPii=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(accessRows(prisma)).toEqual([
      expect.objectContaining({
        action: 'content_read',
        actorId: 'u-1',
        actorRole: 'ADMIN',
        outcome: 'started',
        params: { format: 'normalized', scrubPii: true, via: 'api' },
        runId: RUN_ID,
        scope: 'transcript',
        transcriptId: TX_ID,
        userAgent: 'test-agent',
      }),
    ]);
    // The row exists before any part is read.
    expect(prisma.transcriptAccessLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.agentTranscriptPart.findMany.mock.invocationCallOrder[0] as number
    );
    await vi.waitFor(() => expect(outcomes(prisma)).toEqual(['ok']));
    expect(prisma.transcriptAccessLog.update.mock.calls[0]?.[0]).toMatchObject({
      data: { completedAt: expect.any(Date) },
      where: { id: 'log-1' },
    });
  });

  it('records integrity_error when a part fails verification', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    const part = putPart([{ kind: 'http_call' }]);
    part.sha256 = '0'.repeat(64);
    prisma.agentTranscriptPart.findMany.mockResolvedValue([part]);
    await app.inject({ headers: AUTH, method: 'GET', url: `/api/v1/transcripts/${TX_ID}/content` });
    await vi.waitFor(() => expect(outcomes(prisma)).toEqual(['integrity_error']));
  });

  it('records aborted when the client disconnects mid-stream', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    const p0 = putPart([{ kind: 'http_call', seq: 0 }]);
    const p1 = putPart([{ kind: 'http_call', seq: 1 }]);
    let release = () => {};
    // The second part's read waits until the client is gone.
    h.gates.set(
      p1.artifactId,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    prisma.agentTranscriptPart.findMany.mockResolvedValue([p0, p1]);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(`${address}/api/v1/transcripts/${TX_ID}/content`, {
          headers: AUTH,
        });
        req.on('response', (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            reject(err);
          }
        });
        req.end();
      });
      await vi.waitFor(() => expect(outcomes(prisma)).toEqual(['aborted']));
    } finally {
      release();
      await app.close();
    }
    // The generator's own completion does not overwrite the recorded outcome.
    expect(prisma.transcriptAccessLog.update).toHaveBeenCalledTimes(1);
  });

  it('records aborted when the client disconnects while the access row is being written', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    prisma.agentTranscriptPart.findMany.mockResolvedValue([putPart([{ kind: 'marker' }])]);
    let insertStarted = () => {};
    const started = new Promise<void>((resolve) => {
      insertStarted = resolve;
    });
    let releaseInsert = () => {};
    prisma.transcriptAccessLog.create.mockImplementation(async () => {
      insertStarted();
      await new Promise<void>((resolve) => {
        releaseInsert = resolve;
      });
      return { id: 'log-1' };
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const req = httpRequest(`${address}/api/v1/transcripts/${TX_ID}/content`, {
        headers: AUTH,
      });
      req.on('error', () => {});
      req.end();
      await started;
      req.destroy();
      // Let the server see the disconnect before the insert returns.
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseInsert();
      await vi.waitFor(() => expect(outcomes(prisma)).toEqual(['aborted']));
    } finally {
      releaseInsert();
      await app.close();
    }
    expect(prisma.transcriptAccessLog.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'log-1' },
    });
  });

  it('refuses at registration a download-link hook behind a role a service principal cannot hold', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRoute', assertServiceScopesAdmissible);
    expect(() =>
      app.get(
        '/x/:id',
        {
          config: { serviceScopes: ['runs:read'] },
          onRequest: contentAuthHook({ requiredRole: 'ADMIN' }),
        },
        async () => ({})
      )
    ).toThrow(/serviceScopes behind a role/);
    // The ENGINEER fallback the content route uses is admissible.
    expect(() =>
      app.get(
        '/y/:id',
        {
          config: { serviceScopes: ['runs:read'] },
          onRequest: contentAuthHook({ requiredRole: 'ENGINEER' }),
        },
        async () => ({})
      )
    ).not.toThrow();
  });

  it('still serves the read when the access-log insert fails, and counts the failure', async () => {
    const { app, prisma } = await buildApp();
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
    prisma.agentTranscriptPart.findMany.mockResolvedValue([putPart([{ kind: 'marker' }])]);
    prisma.transcriptAccessLog.create.mockRejectedValue(new Error('db down'));
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/transcripts/${TX_ID}/content`,
    });
    expect(res.statusCode).toBe(200);
    expect(ndjson(res).at(-1)).toEqual({ complete: true, kind: 'eof' });
    expect(h.metricFailures).toEqual(['content_read']);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'content_read' }),
      expect.stringContaining('access log write failed')
    );
    // No row, so nothing to complete.
    expect(prisma.transcriptAccessLog.update).not.toHaveBeenCalled();
  });

  it('logs an export with its filters, and integrity_error when a transcript is corrupt', async () => {
    const { app, prisma } = await buildApp();
    const bad = putPart([{ kind: 'http_call' }]);
    bad.sha256 = '0'.repeat(64);
    prisma.agentTranscript.findMany.mockResolvedValueOnce([transcriptRow()]);
    prisma.agentTranscriptPart.findMany.mockResolvedValue([bad]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/transcripts/export?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&agentKey=implementer',
    });
    // Export carries on past the corrupt transcript and still ends with eof.
    expect(ndjson(res).at(-1)).toEqual({ complete: true, kind: 'eof' });
    expect(accessRows(prisma)).toEqual([
      expect.objectContaining({
        action: 'export',
        params: expect.objectContaining({
          agentKey: 'implementer',
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-02T00:00:00Z',
          via: 'api',
        }),
        scope: 'export',
        transcriptId: null,
      }),
    ]);
    await vi.waitFor(() => expect(outcomes(prisma)).toEqual(['integrity_error']));
  });

  it('logs a clean export as ok', async () => {
    const { app, prisma } = await buildApp();
    await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/transcripts/export?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
    });
    await vi.waitFor(() => expect(outcomes(prisma)).toEqual(['ok']));
  });

  it('logs a verification and its result', async () => {
    const { app, prisma } = await buildApp();
    const part = putPart([{ kind: 'marker' }]);
    prisma.agentTranscript.findUnique.mockResolvedValue(
      transcriptRow({ sha256: createHash('sha256').update(part.sha256).digest('hex') })
    );
    prisma.agentTranscriptPart.findMany.mockResolvedValue([part]);
    const ok = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/transcripts/${TX_ID}/verify`,
    });
    expect(ok.json().ok).toBe(true);

    part.sha256 = '0'.repeat(64);
    const bad = await app.inject({
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/transcripts/${TX_ID}/verify`,
    });
    expect(bad.json().ok).toBe(false);
    expect(accessRows(prisma).map((r) => [r.action, r.scope, r.transcriptId])).toEqual([
      ['verify', 'transcript', TX_ID],
      ['verify', 'transcript', TX_ID],
    ]);
    expect(outcomes(prisma)).toEqual(['ok', 'integrity_error']);
  });

  it('logs every legal-hold change, run and per-transcript', async () => {
    const { app, prisma } = await buildApp();
    prisma.workflowRun.findUnique.mockResolvedValue({ id: RUN_ID });
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
    await app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { reason: 'litigation' },
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts/legal-hold`,
    });
    await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/workflow-runs/${RUN_ID}/transcripts/legal-hold`,
    });
    await app.inject({
      headers: AUTH,
      method: 'PUT',
      payload: { reason: 'keep' },
      url: `/api/v1/transcripts/${TX_ID}/legal-hold`,
    });
    await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/transcripts/${TX_ID}/legal-hold`,
    });
    expect(
      accessRows(prisma).map((r) => [r.action, r.scope, r.runId, r.transcriptId, r.outcome])
    ).toEqual([
      ['legal_hold_set', 'run', RUN_ID, null, 'ok'],
      ['legal_hold_cleared', 'run', RUN_ID, null, 'ok'],
      ['legal_hold_set', 'transcript', RUN_ID, TX_ID, 'ok'],
      ['legal_hold_cleared', 'transcript', RUN_ID, TX_ID, 'ok'],
    ]);
    expect(accessRows(prisma)[0]?.params).toEqual({ reason: 'litigation' });
    expect(accessRows(prisma)[0]?.completedAt).toBeInstanceOf(Date);
  });

  describe('access-log API', () => {
    it('filters, pages newest first, and names the actor', async () => {
      const { app, prisma } = await buildApp();
      prisma.transcriptAccessLog.findMany.mockResolvedValue([
        {
          action: 'content_read',
          actorId: 'u-1',
          actorRole: 'ADMIN',
          completedAt: new Date('2026-01-01T00:00:01Z'),
          createdAt: new Date('2026-01-01T00:00:00Z'),
          id: 'log-1',
          ip: '127.0.0.1',
          outcome: 'ok',
          params: { format: 'raw', scrubPii: false, via: 'api' },
          runId: RUN_ID,
          scope: 'transcript',
          transcriptId: TX_ID,
          userAgent: null,
        },
      ]);
      prisma.transcriptAccessLog.count.mockResolvedValue(51);
      prisma.user.findMany.mockResolvedValue([{ email: 'a@example.com', id: 'u-1', name: 'A' }]);
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/platform/transcripts/access-log?action=content_read&actorId=u-1&transcriptId=${TX_ID}&runId=${RUN_ID}&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=10&offset=20`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [
          expect.objectContaining({
            actor: { email: 'a@example.com', name: 'A' },
            createdAt: '2026-01-01T00:00:00.000Z',
            id: 'log-1',
            outcome: 'ok',
          }),
        ],
        total: 51,
      });
      expect(prisma.transcriptAccessLog.findMany).toHaveBeenCalledWith({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 10,
        where: {
          action: 'content_read',
          actorId: 'u-1',
          createdAt: {
            gte: new Date('2026-01-01T00:00:00Z'),
            lt: new Date('2026-01-02T00:00:00Z'),
          },
          runId: RUN_ID,
          transcriptId: TX_ID,
        },
      });
    });

    it('defaults to 50 rows and refuses a limit over 200', async () => {
      const { app, prisma } = await buildApp();
      await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/transcripts/access-log',
      });
      expect(prisma.transcriptAccessLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 50, where: {} })
      );
      const tooMany = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/transcripts/access-log?limit=201',
      });
      expect(tooMany.statusCode).toBe(400);
    });

    it('is ADMIN-only', async () => {
      const { app, prisma } = await buildApp({ role: 'LEAD' });
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/platform/transcripts/access-log',
      });
      expect(res.statusCode).toBe(403);
      expect(prisma.transcriptAccessLog.findMany).not.toHaveBeenCalled();
    });
  });

  describe('download links', () => {
    async function issue(app: Awaited<ReturnType<typeof buildApp>>['app'], body: object) {
      return app.inject({
        headers: AUTH,
        method: 'POST',
        payload: body,
        url: `/api/v1/transcripts/${TX_ID}/download-link`,
      });
    }

    it('issues a relative, 60-second link to a caller who controls the run', async () => {
      const { app, prisma } = await buildApp({ role: 'ENGINEER' });
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
      const before = Date.now();
      const res = await issue(app, { format: 'normalized', scrubPii: true });
      expect(res.statusCode).toBe(200);
      const { expiresAt, url } = res.json() as { expiresAt: string; url: string };
      expect(url).toMatch(
        new RegExp(
          `^/api/v1/transcripts/${TX_ID}/content\\?format=normalized&scrubPii=true&dl=[\\w.-]+$`
        )
      );
      const ttl = new Date(expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(55_000);
      expect(ttl).toBeLessThanOrEqual(61_000);
      // The control filter, not the visibility filter, decided.
      const [{ where }] = prisma.workflowRun.findFirst.mock.calls[0] as unknown as [
        { where: object },
      ];
      const actor = { role: 'ENGINEER', sub: 'u-1' } as never;
      const gate = { mode: 'off', staleAfterHours: 0 } as never;
      expect(where).toEqual({ id: RUN_ID, ...buildWorkflowRunControlFilter(actor, gate) });
      expect(where).not.toEqual({ id: RUN_ID, ...buildWorkflowRunVisibilityFilter(actor, gate) });
    });

    it('refuses a caller who can see but not control the run (404)', async () => {
      const { app, prisma } = await buildApp({ role: 'ENGINEER' });
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      prisma.workflowRun.findFirst.mockResolvedValue(null);
      const res = await issue(app, { format: 'raw', scrubPii: false });
      expect(res.statusCode).toBe(404);
    });

    it('issues links for a runless transcript to ADMIN only', async () => {
      const engineer = await buildApp({ role: 'ENGINEER' });
      engineer.prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow({ runId: null }));
      expect((await issue(engineer.app, { format: 'raw', scrubPii: false })).statusCode).toBe(404);

      const admin = await buildApp({ role: 'ADMIN' });
      admin.prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow({ runId: null }));
      expect((await issue(admin.app, { format: 'raw', scrubPii: false })).statusCode).toBe(200);
    });

    it('streams with a valid link and no other credential, logged as via download_link', async () => {
      const { app, prisma } = await buildApp({ role: 'ENGINEER' });
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
      prisma.agentTranscriptPart.findMany.mockResolvedValue([putPart([{ kind: 'marker' }])]);
      const { url } = (await issue(app, { format: 'raw', scrubPii: false })).json() as {
        url: string;
      };
      const token = new URL(url, 'http://x').searchParams.get('dl') as string;

      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain(`transcript-${TX_ID}-raw.ndjson`);
      expect(ndjson(res).at(-1)).toEqual({ complete: true, kind: 'eof' });
      expect(accessRows(prisma)).toEqual([
        expect.objectContaining({
          action: 'download_link',
          actorId: 'u-1',
          outcome: 'ok',
          params: { format: 'raw', scrubPii: false, via: 'api' },
          transcriptId: TX_ID,
        }),
        expect.objectContaining({
          action: 'content_read',
          actorId: 'u-1',
          params: { format: 'raw', scrubPii: false, via: 'download_link' },
        }),
      ]);
      // The user was re-read and the run authorization re-run at use time.
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u-1' } })
      );
      expect(prisma.workflowRun.findFirst).toHaveBeenCalledTimes(2);
      // The token itself never reaches a log line.
      expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls])).not.toContain(token);
    });

    it('refuses an expired, tampered or mismatched link with 401', async () => {
      const { app, prisma } = await buildApp();
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      prisma.workflowRun.findFirst.mockResolvedValue({ id: RUN_ID });
      const base = `/api/v1/transcripts/${TX_ID}/content`;
      const link = (claims: Partial<Parameters<typeof signDownloadLink>[0]>, now?: number) =>
        signDownloadLink({ fmt: 'raw', pii: false, sub: 'u-1', tid: TX_ID, ...claims }, now).token;
      const good = link({});
      const [payload, sig] = good.split('.') as [string, string];
      const forgedPayload = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
          pii: true,
        })
      ).toString('base64url');
      const cases: [string, string][] = [
        [
          `${base}?format=raw&scrubPii=false&dl=${link({}, Date.now() - 120_000)}`,
          'DOWNLOAD_LINK_EXPIRED',
        ],
        [`${base}?format=raw&scrubPii=true&dl=${forgedPayload}.${sig}`, 'DOWNLOAD_LINK_INVALID'],
        [
          `${base}?format=raw&scrubPii=false&dl=${payload}.${'A'.repeat(43)}`,
          'DOWNLOAD_LINK_INVALID',
        ],
        [
          `/api/v1/transcripts/${SP_TX}/content?format=raw&scrubPii=false&dl=${good}`,
          'DOWNLOAD_LINK_INVALID',
        ],
        [`${base}?format=normalized&scrubPii=false&dl=${good}`, 'DOWNLOAD_LINK_INVALID'],
        [`${base}?format=raw&scrubPii=true&dl=${good}`, 'DOWNLOAD_LINK_INVALID'],
        [`${base}?format=raw&scrubPii=false&dl=`, 'DOWNLOAD_LINK_INVALID'],
      ];
      for (const [url, code] of cases) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
        expect(res.json().error.code, url).toBe(code);
      }
      // A refusal is logged only when the link's signature verified, so its
      // subject is known: expired, wrong transcript, wrong format, wrong PII.
      // A forged, unsigned or empty link writes nothing.
      await vi.waitFor(() => expect(accessRows(prisma)).toHaveLength(4));
      for (const row of accessRows(prisma)) {
        expect(row).toMatchObject({
          action: 'content_read',
          actorId: 'u-1',
          outcome: 'denied',
          params: { status: 401, via: 'download_link' },
          runId: null,
        });
      }
      expect(accessRows(prisma).map((r) => r.transcriptId)).toEqual([TX_ID, SP_TX, TX_ID, TX_ID]);
    });

    it('refuses a link whose user was deactivated or lost access since it was issued', async () => {
      const { app, prisma } = await buildApp();
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      const token = signDownloadLink({ fmt: 'raw', pii: false, sub: 'u-gone', tid: TX_ID }).token;
      const url = `/api/v1/transcripts/${TX_ID}/content?format=raw&scrubPii=false&dl=${token}`;

      prisma.user.findUnique.mockResolvedValueOnce({
        isActive: false,
        role: 'ENGINEER',
        slackId: null,
      });
      const disabled = await app.inject({ method: 'GET', url });
      expect(disabled.statusCode).toBe(401);
      expect(disabled.json().error.code).toBe('DOWNLOAD_LINK_INVALID');

      _resetAuthCachesForTests();
      prisma.workflowRun.findFirst.mockResolvedValue(null); // no longer controls the run
      const noAccess = await app.inject({ method: 'GET', url });
      expect(noAccess.statusCode).toBe(404);
      await vi.waitFor(() => expect(accessRows(prisma)).toHaveLength(2));
      expect(accessRows(prisma).map((r) => [r.outcome, r.actorId, r.actorRole])).toEqual([
        ['denied', 'u-gone', null],
        ['denied', 'u-gone', 'ENGINEER'],
      ]);
      expect(prisma.transcriptAccessLog.update).not.toHaveBeenCalled();
    });

    it('logs a refused link request as denied', async () => {
      const { app, prisma } = await buildApp({ role: 'ENGINEER' });
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      prisma.workflowRun.findFirst.mockResolvedValue(null);
      const res = await issue(app, { format: 'raw', scrubPii: false });
      expect(res.statusCode).toBe(404);
      await vi.waitFor(() =>
        expect(accessRows(prisma)).toEqual([
          expect.objectContaining({
            action: 'download_link',
            actorId: 'u-1',
            outcome: 'denied',
            params: { status: 404, via: 'api' },
            transcriptId: TX_ID,
          }),
        ])
      );
    });
  });

  describe('denied content reads', () => {
    it('logs a 404 the same way whether or not the transcript exists', async () => {
      const { app, prisma } = await buildApp({ role: 'ENGINEER' });
      // Missing transcript.
      const missing = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/transcripts/${TX_ID}/content`,
      });
      // Existing transcript the caller does not control.
      prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow());
      const hidden = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/transcripts/${TX_ID}/content`,
      });
      expect(missing.statusCode).toBe(404);
      expect(hidden.json()).toEqual(missing.json());
      await vi.waitFor(() => expect(accessRows(prisma)).toHaveLength(2));
      for (const row of accessRows(prisma)) {
        expect(row).toMatchObject({
          action: 'content_read',
          actorId: 'u-1',
          outcome: 'denied',
          params: { status: 404, via: 'api' },
          runId: null,
          transcriptId: TX_ID,
        });
      }
    });

    it('writes no row for an unidentified caller or a malformed id', async () => {
      const { app, prisma } = await buildApp();
      const res = await app.inject({ method: 'GET', url: `/api/v1/transcripts/${TX_ID}/content` });
      expect(res.statusCode).toBe(401);
      const forged = await app.inject({
        method: 'GET',
        url: `/api/v1/transcripts/${TX_ID}/content?format=raw&scrubPii=false&dl=e30.${'A'.repeat(43)}`,
      });
      expect(forged.statusCode).toBe(401);
      await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/transcripts/not-a-uuid/content',
      });
      // A signed-in denial afterwards is recorded, so the hooks above had run.
      await app.inject({
        headers: AUTH,
        method: 'GET',
        url: `/api/v1/transcripts/${TX_ID}/content`,
      });
      await vi.waitFor(() => expect(accessRows(prisma)).toHaveLength(1));
      expect(accessRows(prisma)[0]).toMatchObject({ actorId: 'u-1', outcome: 'denied' });
    });
  });
});
