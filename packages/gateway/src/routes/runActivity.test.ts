import Fastify, { type LightMyRequestResponse } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { activityAfter, runActivityRoutes } from './runActivity.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN = uuid(1);
const TS = new Date('2026-01-01T00:00:00.000Z');
const AUTH = { authorization: 'Bearer fake' };
type Row = Record<string, unknown>;
type Item = { id: string; kind: string; detail: { hasBodies: boolean } };
function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b));
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') {
      return (value as Row[]).every((condition) => matches(row, condition));
    }
    if (key === 'OR') {
      return (value as Row[]).some((condition) => matches(row, condition));
    }
    const actual = row[key] ?? null;
    if (value instanceof Date) {
      return actual instanceof Date && +actual === +value;
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).every(([op, expected]) => {
        if (op === 'in') {
          return Array.isArray(expected) && expected.includes(actual);
        }
        if (op === 'not') {
          return actual !== expected;
        }
        if (op === 'startsWith') {
          return (
            typeof actual === 'string' &&
            typeof expected === 'string' &&
            actual.startsWith(expected)
          );
        }
        if (actual === null) {
          return false;
        }
        return op === 'gt'
          ? compare(actual, expected) > 0
          : op === 'gte'
            ? compare(actual, expected) >= 0
            : op === 'lte'
              ? compare(actual, expected) <= 0
              : op === 'lt'
                ? compare(actual, expected) < 0
                : actual === expected;
      });
    }
    return actual === value;
  });
}
function model(rows: Row[]) {
  return {
    findFirst: vi.fn(async ({ where, omit }: { where: Row; omit?: Record<string, boolean> }) => {
      const row = rows.find((entry) => matches(entry, where));
      return row ? Object.fromEntries(Object.entries(row).filter(([key]) => !omit?.[key])) : null;
    }),
    findMany: vi.fn(
      async ({
        where,
        orderBy = [],
        take,
        select,
      }: {
        where?: Row;
        orderBy?: Record<string, 'asc'>[];
        take?: number;
        select?: Record<string, boolean>;
      }) => {
        const result = rows
          .filter((row) => matches(row, where))
          .sort((a, b) => {
            for (const ordering of orderBy) {
              const key = Object.keys(ordering)[0] ?? 'id';
              if (
                a[key] instanceof Date &&
                b[key] instanceof Date &&
                compare(a[key], b[key]) === 0 &&
                a.fraction !== b.fraction
              ) {
                return compare(a.fraction, b.fraction);
              }
              if (compare(a[key], b[key]) < 0) {
                return -1;
              }
              if (compare(a[key], b[key]) > 0) {
                return 1;
              }
            }
            return 0;
          })
          .slice(0, take);
        return result.map((row) =>
          select
            ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null]))
            : row
        );
      }
    ),
  };
}
async function setup() {
  const base = {
    attempt: 2,
    id: uuid(2),
    recordingId: 'fan[0]/node',
    runId: RUN,
    specNodeId: 'node',
    stepAttempt: 1,
  };
  const step = {
    ...base,
    endedAt: TS,
    error: null,
    nodeId: base.recordingId,
    nodeType: 'step',
    startedAt: TS,
    status: 'SUCCEEDED',
    stepName: 'test',
  };
  const trace = {
    ...base,
    agentKey: 'agent',
    createdAt: TS,
    durationMs: 10,
    id: uuid(3),
    inputJson: { secret: 'large-secret' },
    outputJson: {},
    toolName: 'read',
    type: 'tool_call',
  };
  const http = {
    ...base,
    activityType: null,
    blocked: false,
    blockReason: null,
    bodiesTruncated: false,
    createdAt: TS,
    durationMs: null,
    error: null,
    host: 'example.com',
    id: uuid(4),
    method: 'GET',
    orgId: null,
    otelSpanId: null,
    otelTraceId: null,
    path: '/path',
    port: null,
    purpose: 'other',
    requestBody: 'redacted request',
    requestBytes: null,
    responseBody: 'redacted response',
    responseBytes: null,
    scheme: 'https',
    source: 'worker',
    startedAt: TS,
    status: 200,
    teamId: null,
    temporalRunId: null,
    transcriptId: null,
    workflowId: 'wf',
  };
  const human = {
    ...base,
    id: uuid(5),
    kind: 'APPROVAL',
    nodeId: base.recordingId,
    requestedAt: TS,
    resolvedAt: TS,
    resolvedBy: uuid(6),
    resolvedVia: 'web',
    status: 'RESOLVED',
    title: 'Approve',
  };
  const traces: Row[] = [trace];
  const prisma = {
    agentTrace: model(traces),
    apiToken: {
      findUnique: vi.fn().mockResolvedValue({
        expiresAt: new Date(Date.now() + 86_400_000),
        id: 'token',
        revokedAt: null,
        scopes: ['runs:read'],
        servicePrincipal: {
          connectionIds: [],
          disabledAt: null,
          id: uuid(9),
          team: { isActive: true, organization: { isActive: true } },
          teamId: 'team',
          templateIds: [],
        },
        servicePrincipalId: uuid(9),
        user: null,
        userId: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    workflowHttpCall: model([http]),
    workflowHumanStep: model([human]),
    workflowRun: { findFirst: vi.fn(async () => ({ id: RUN })) },
    workflowStep: model([step]),
  };
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    hashToken: (value: string) => value,
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user' }),
  } as never);
  await app.register(runActivityRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.ready();
  return { app, http, human, prisma, step, traces };
}
const path = `/api/v1/workflow-runs/${RUN}/activity`;
describe('run activity', () => {
  it('merges phases and sources without loading or returning large payloads', async () => {
    const { app, prisma } = await setup();
    const response = await app.inject({ headers: AUTH, url: path });
    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data).toHaveLength(6);
    expect(data.map((item: Row) => item.id)).toEqual([...data.map((item: Row) => item.id)].sort());
    expect(response.body).not.toContain('large-secret');
    expect(response.body).not.toContain('redacted request');
    expect(data.find((item: Item) => item.kind === 'http_call').detail.hasBodies).toBe(true);
    expect(prisma.agentTrace.findMany.mock.calls[0]?.[0].select).not.toHaveProperty('inputJson');
    expect(prisma.workflowHttpCall.findMany.mock.calls[0]?.[0].select).not.toHaveProperty(
      'requestBody'
    );
    await app.close();
  });
  it('pages stably across equal timestamps, source prefixes, and two phases of one row', async () => {
    const { app, traces } = await setup();
    traces.push(
      { ...traces[0], fraction: 0.1, id: uuid(10) },
      { ...traces[0], fraction: 0.2, id: uuid(9) }
    );
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const response: LightMyRequestResponse = await app.inject({
        headers: AUTH,
        url: `${path}?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      });
      expect(response.statusCode).toBe(200);
      ids.push(...response.json().data.map((item: Row) => item.id));
      cursor = response.json().nextCursor;
    } while (cursor && ids.length < 10);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids).toEqual([...ids].sort());
    await app.close();
  });
  it('orders mixed timestamps and projects LLM and activity events compactly', async () => {
    const { app, traces, step, human, http } = await setup();
    step.startedAt = new Date(TS.getTime() - 2000);
    human.resolvedAt = new Date(TS.getTime() + 2000);
    http.startedAt = new Date(TS.getTime() + 1000);
    traces.push(
      {
        ...traces[0],
        costUsd: 0.2,
        id: uuid(11),
        inputTokens: 20,
        model: 'model',
        outputTokens: 10,
        type: 'llm_response',
      },
      {
        ...traces[0],
        error: 'failed',
        id: uuid(12),
        toolName: 'container.exec',
        type: 'activity_event',
      }
    );
    const response = await app.inject({ headers: AUTH, url: path });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data[0].detail.phase).toBe('started');
    expect(data.at(-1).detail.phase).toBe('resolved');
    expect(data.find((item: Item) => item.kind === 'llm_response').detail.inputTokens).toBe(20);
    expect(data.find((item: Item) => item.kind === 'activity_event').detail.error).toBe('failed');
    await app.close();
  });
  it('applies kinds, linkage and since filters and validates cursors', async () => {
    const { app } = await setup();
    const good = await app.inject({
      headers: AUTH,
      url: `${path}?kinds=http_call&recordingId=fan%5B0%5D%2Fnode&specNodeId=node&since=${TS.toISOString()}`,
    });
    expect(good.json().data).toHaveLength(1);
    for (const query of ['recordingId=other', 'specNodeId=other', 'since=2027-01-01T00:00:00Z']) {
      expect((await app.inject({ headers: AUTH, url: `${path}?${query}` })).json().data).toEqual(
        []
      );
    }
    for (const query of ['cursor=nope', 'kinds=secret', 'limit=501', 'since=yesterday']) {
      expect((await app.inject({ headers: AUTH, url: `${path}?${query}` })).statusCode).toBe(400);
    }
    await app.close();
  });
  it('uses timestamp ordering before ID ordering', () => {
    expect(
      activityAfter('startedAt', 'step:', ':1', { id: `step:${uuid(2)}:0`, ts: TS.toISOString() })
    ).toMatchObject({
      OR: [
        { startedAt: { gte: new Date(TS.getTime() + 1) } },
        { id: { gte: uuid(2) }, startedAt: { gte: TS, lt: new Date(TS.getTime() + 1) } },
      ],
    });
  });
  it('returns 404 before reading sources when a run is invisible', async () => {
    const { app, prisma } = await setup();
    prisma.workflowRun.findFirst.mockResolvedValueOnce(null as never);
    expect((await app.inject({ headers: AUTH, url: path })).statusCode).toBe(404);
    expect(prisma.agentTrace.findMany).not.toHaveBeenCalled();
    await app.close();
  });
  it('omits bodies for viewers, includes them for controllers, and scopes the call to the run', async () => {
    const { app, prisma, http } = await setup();
    const url = `/api/v1/workflow-runs/${RUN}/http-calls/${http.id}`;
    prisma.workflowRun.findFirst
      .mockResolvedValueOnce({ id: RUN })
      .mockResolvedValueOnce(null as never);
    const view = await app.inject({ headers: AUTH, url });
    expect(view.json().data).not.toHaveProperty('requestBody');
    const control = await app.inject({ headers: AUTH, url });
    expect(control.json().data.requestBody).toBe('redacted request');
    expect(
      (await app.inject({ headers: AUTH, url: url.replace(http.id, uuid(99)) })).statusCode
    ).toBe(404);
    await app.close();
  });
  it('exports all pages and a final eof sentinel under the same filters', async () => {
    const { app } = await setup();
    const response = await app.inject({ headers: AUTH, url: `${path}/export?limit=1&kinds=step` });
    expect(response.statusCode).toBe(200);
    const lines = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0].kind).toBe('step');
    expect(lines.at(-1)).toEqual({ complete: true, kind: 'eof' });
    await app.close();
  });
  it('requires control for export and refuses service principals on every route', async () => {
    const { app, prisma, http } = await setup();
    prisma.workflowRun.findFirst.mockResolvedValueOnce(null as never);
    expect((await app.inject({ headers: AUTH, url: `${path}/export` })).statusCode).toBe(404);
    for (const url of [
      path,
      `${path}/export`,
      `/api/v1/workflow-runs/${RUN}/http-calls/${http.id}`,
    ]) {
      const response = await app.inject({ headers: { authorization: 'Bearer ats_service' }, url });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    }
    await app.close();
  });
});
