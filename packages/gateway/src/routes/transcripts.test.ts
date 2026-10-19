import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transcriptRoutes } from './transcripts.js';

const h = vi.hoisted(() => ({
  artifacts: new Map<string, Buffer>(),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  getArtifact: vi.fn(async (id: string) => {
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

beforeEach(() => {
  h.artifacts.clear();
  vi.clearAllMocks();
});

describe('transcriptRoutes', () => {
  it('refuses service principals on every route', async () => {
    const { app, prisma } = await buildApp({ service: true });
    prisma.agentTranscript.findUnique.mockResolvedValue(transcriptRow({ id: SP_TX }));
    for (const [method, url] of [
      ['GET', `/api/v1/workflow-runs/${RUN_ID}/transcripts`],
      ['GET', `/api/v1/transcripts/${SP_TX}`],
      ['GET', `/api/v1/transcripts/${SP_TX}/content`],
      ['POST', `/api/v1/transcripts/${SP_TX}/verify`],
      [
        'GET',
        '/api/v1/platform/transcripts/export?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      ],
    ] as const) {
      const res = await app.inject({ headers: SP_AUTH, method, url });
      expect(res.statusCode).toBe(403);
      // ENGINEER-role routes reach the handler's refusal; ADMIN routes are
      // refused at the auth layer (a principal holds no role).
      expect(['TRANSCRIPTS_NOT_AVAILABLE', 'FORBIDDEN']).toContain(res.json().error.code);
    }
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
});
