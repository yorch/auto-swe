import { Readable } from 'node:stream';
import type { Prisma } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { RUN_ACTIVITY_KINDS, type RunActivityItem } from '@auto-swe/shared/types/api';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendError } from '../lib/httpErrors.js';
import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from '../lib/runVisibility.js';
import { requireAuth, requireCaller } from '../plugins/auth.js';

const Params = z.object({ id: z.string().uuid() });
const CursorValue = z.object({
  id: z
    .string()
    .regex(
      /^(?:(?:trace|http):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:step|human):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[01])$/
    ),
  ts: z.iso.datetime(),
});
const Query = z.object({
  cursor: z
    .string()
    .max(1024)
    .transform((value, ctx) => {
      try {
        return CursorValue.parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid activity cursor' });
        return z.NEVER;
      }
    })
    .optional(),
  kinds: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(RUN_ACTIVITY_KINDS)).min(1))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  recordingId: z.string().min(1).max(512).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  specNodeId: z.string().min(1).max(512).optional(),
});
type ActivityQuery = z.infer<typeof Query>;
type Cursor = z.infer<typeof CursorValue>;
const encodeCursor = (item: RunActivityItem) =>
  Buffer.from(JSON.stringify({ id: item.id, ts: item.ts })).toString('base64url');
const compactError = (value: string | null) => value?.slice(0, 4096) ?? null;

const Text = z.string().nullable();
const NumberValue = z.number().nullable();
const HttpMetadataSchema = z.object({
  blocked: z.boolean(),
  blockReason: Text,
  durationMs: NumberValue,
  error: Text,
  host: z.string(),
  method: z.string(),
  path: z.string(),
  port: NumberValue,
  purpose: z.string(),
  requestBytes: NumberValue,
  responseBytes: NumberValue,
  scheme: z.string(),
  source: z.string(),
  status: NumberValue,
  transcriptId: Text,
});
const BaseSchema = z.object({
  agentKey: z.string().optional(),
  attempt: NumberValue,
  id: z.string(),
  recordingId: Text,
  specNodeId: Text,
  stepAttempt: NumberValue,
  summary: z.string(),
  ts: z.iso.datetime(),
});
const TraceDetailSchema = z.object({
  costUsd: NumberValue,
  durationMs: NumberValue,
  error: Text,
  inputTokens: NumberValue,
  model: Text,
  outputTokens: NumberValue,
  toolName: Text,
});
const ActivitySchema = z.discriminatedUnion('kind', [
  BaseSchema.extend({
    detail: HttpMetadataSchema.extend({ callId: z.string(), hasBodies: z.boolean() }),
    kind: z.literal('http_call'),
  }),
  BaseSchema.extend({
    detail: z.object({
      error: Text,
      nodeType: Text,
      phase: z.enum(['started', 'ended']),
      status: z.string(),
      stepName: Text,
    }),
    kind: z.literal('step'),
  }),
  BaseSchema.extend({
    detail: z.object({
      humanKind: z.string(),
      phase: z.enum(['requested', 'resolved']),
      resolvedBy: Text,
      resolvedVia: Text,
      status: z.string(),
    }),
    kind: z.literal('human_step'),
  }),
  ...(['tool_call', 'llm_response', 'activity_event'] as const).map((kind) =>
    BaseSchema.extend({ detail: TraceDetailSchema, kind: z.literal(kind) })
  ),
]);
const HttpRowSchema = HttpMetadataSchema.extend({
  activityType: Text,
  attempt: z.number(),
  bodiesTruncated: z.boolean(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  orgId: Text,
  otelSpanId: Text,
  otelTraceId: Text,
  recordingId: Text,
  requestBody: Text.optional(),
  responseBody: Text.optional(),
  runId: Text,
  specNodeId: Text,
  startedAt: z.iso.datetime(),
  stepAttempt: NumberValue,
  teamId: Text,
  temporalRunId: Text,
  workflowId: z.string(),
});

/** Each phase is a separate ordered stream; its suffix breaks ties within a source row. */
export function activityAfter(
  field: string,
  prefix: string,
  suffix: string,
  cursor?: Cursor
): Record<string, unknown> {
  if (!cursor) {
    return {};
  }
  const at = new Date(cursor.ts);
  const end = new Date(at.getTime() + 1);
  let equal: Record<string, unknown> | undefined;
  if (cursor.id.startsWith(prefix)) {
    const id = cursor.id.slice(prefix.length, prefix.length + 36);
    equal = {
      [field]: { gte: at, lt: end },
      id: { [suffix > cursor.id.slice(prefix.length + 36) ? 'gte' : 'gt']: id },
    };
  } else if (prefix > cursor.id) {
    equal = { [field]: { gte: at, lt: end } };
  }
  return { OR: [{ [field]: { gte: end } }, ...(equal ? [equal] : [])] };
}

type Bucket = { start: Date; end: Date };
/** Prisma dates have millisecond precision; finish a cut bucket in ID order. */
async function readStream<T>(
  read: (bucket?: Bucket) => Promise<T[]>,
  field: keyof T,
  limit: number
): Promise<T[]> {
  const rows = await read();
  const last = rows.at(-1)?.[field];
  if (rows.length <= limit || !(last instanceof Date)) {
    return rows;
  }
  const bucket = { end: new Date(last.getTime() + 1), start: last };
  const boundary = await read(bucket);
  return [
    ...rows.filter(
      (row) => row[field] instanceof Date && (row[field] as Date).getTime() < last.getTime()
    ),
    ...boundary,
  ];
}

const StepSelect = {
  attempt: true,
  endedAt: true,
  error: true,
  id: true,
  nodeId: true,
  nodeType: true,
  specNodeId: true,
  startedAt: true,
  status: true,
  stepName: true,
} satisfies Prisma.WorkflowStepSelect;
const TraceSelect = {
  agentKey: true,
  attempt: true,
  costUsd: true,
  createdAt: true,
  durationMs: true,
  error: true,
  id: true,
  inputTokens: true,
  model: true,
  outputTokens: true,
  recordingId: true,
  specNodeId: true,
  stepAttempt: true,
  toolName: true,
  type: true,
} satisfies Prisma.AgentTraceSelect;
const HttpSelect = {
  attempt: true,
  blocked: true,
  blockReason: true,
  durationMs: true,
  error: true,
  host: true,
  id: true,
  method: true,
  path: true,
  port: true,
  purpose: true,
  recordingId: true,
  requestBytes: true,
  responseBytes: true,
  scheme: true,
  source: true,
  specNodeId: true,
  startedAt: true,
  status: true,
  stepAttempt: true,
  transcriptId: true,
} satisfies Prisma.WorkflowHttpCallSelect;
const HumanSelect = {
  id: true,
  kind: true,
  nodeId: true,
  requestedAt: true,
  resolvedAt: true,
  resolvedBy: true,
  resolvedVia: true,
  status: true,
  title: true,
} satisfies Prisma.WorkflowHumanStepSelect;

async function readPage(app: FastifyInstance, runId: string, query: ActivityQuery, until?: Date) {
  const { cursor, limit, recordingId, specNodeId, since } = query;
  const wants = (kind: (typeof RUN_ACTIVITY_KINDS)[number]) =>
    !query.kinds || query.kinds.includes(kind);
  const recordingWhere = (field: string) =>
    recordingId
      ? { OR: [{ [field]: recordingId }, { [field]: { startsWith: `${recordingId}[` } }] }
      : {};
  const linkage = { ...recordingWhere('recordingId'), ...(specNodeId ? { specNodeId } : {}) };
  const timeWhere = (field: string, prefix: string, suffix = '', bucket?: Bucket) => ({
    AND: [
      {
        [field]: {
          gte: new Date(since ?? '0001-01-01T00:00:00Z'),
          ...(until ? { lte: until } : {}),
        },
      },
      activityAfter(field, prefix, suffix, cursor),
      ...(bucket ? [{ [field]: { gte: bucket.start, lt: bucket.end } }] : []),
    ],
  });
  const stepLink = [
    recordingWhere('nodeId'),
    ...(specNodeId ? [{ OR: [{ specNodeId }, { nodeId: specNodeId, specNodeId: null }] }] : []),
  ];
  const order = (field: string) => [{ [field]: 'asc' as const }, { id: 'asc' as const }];
  const events = await runUnscoped(
    'activity sources scoped by an authorized run',
    ['AgentTrace', 'WorkflowHttpCall'],
    async () => {
      const items: RunActivityItem[] = [];
      await Promise.all([
        ...(['startedAt', 'endedAt'] as const).map(async (field, phaseIndex) => {
          if (!wants('step')) {
            return;
          }
          const rows = await readStream(
            (bucket) =>
              app.prisma.workflowStep.findMany({
                orderBy: bucket ? [{ id: 'asc' }] : order(field),
                select: StepSelect,
                take: limit + 1,
                where: {
                  AND: [...stepLink, timeWhere(field, 'step:', `:${phaseIndex}`, bucket)],
                  runId,
                },
              }),
            field,
            limit
          );
          for (const row of rows) {
            const timestamp = row[field];
            if (!timestamp) {
              continue;
            }
            items.push({
              attempt: row.attempt,
              detail: {
                error: phaseIndex ? compactError(row.error) : null,
                nodeType: row.nodeType,
                phase: phaseIndex ? 'ended' : 'started',
                status: phaseIndex ? row.status : 'RUNNING',
                stepName: row.stepName,
              },
              id: `step:${row.id}:${phaseIndex}`,
              kind: 'step',
              recordingId: row.nodeId,
              specNodeId: row.specNodeId ?? row.nodeId,
              stepAttempt: row.attempt,
              summary: `${row.stepName ?? row.specNodeId ?? row.nodeId} ${phaseIndex ? row.status.toLowerCase() : 'started'}`,
              ts: timestamp.toISOString(),
            });
          }
        }),
        (async () => {
          const kinds = (['tool_call', 'llm_response', 'activity_event'] as const).filter(wants);
          if (!kinds.length) {
            return;
          }
          const rows = await readStream(
            (bucket) =>
              app.prisma.agentTrace.findMany({
                orderBy: bucket ? [{ id: 'asc' }] : order('createdAt'),
                select: TraceSelect,
                take: limit + 1,
                where: {
                  runId,
                  ...linkage,
                  type: { in: kinds },
                  ...timeWhere('createdAt', 'trace:', '', bucket),
                },
              }),
            'createdAt',
            limit
          );
          for (const row of rows) {
            if (!kinds.includes(row.type as (typeof kinds)[number])) {
              continue;
            }
            items.push({
              agentKey: row.agentKey,
              attempt: row.attempt,
              detail: {
                costUsd: row.costUsd,
                durationMs: row.durationMs,
                error: compactError(row.error),
                inputTokens: row.inputTokens,
                model: row.model,
                outputTokens: row.outputTokens,
                toolName: row.toolName,
              },
              id: `trace:${row.id}`,
              kind: row.type as 'tool_call' | 'llm_response' | 'activity_event',
              recordingId: row.recordingId,
              specNodeId: row.specNodeId,
              stepAttempt: row.stepAttempt,
              summary: (row.toolName ?? row.model ?? row.agentKey).slice(0, 512),
              ts: row.createdAt.toISOString(),
            });
          }
        })(),
        (async () => {
          if (!wants('http_call')) {
            return;
          }
          const rows = await readStream(
            (bucket) =>
              app.prisma.workflowHttpCall.findMany({
                orderBy: bucket ? [{ id: 'asc' }] : order('startedAt'),
                select: HttpSelect,
                take: limit + 1,
                where: { runId, ...linkage, ...timeWhere('startedAt', 'http:', '', bucket) },
              }),
            'startedAt',
            limit
          );
          for (const row of rows) {
            const { id, recordingId, specNodeId, stepAttempt, attempt, startedAt, ...detail } = row;
            items.push({
              attempt,
              detail: {
                ...detail,
                callId: id,
                error: compactError(detail.error),
                hasBodies: false,
              },
              id: `http:${id}`,
              kind: 'http_call',
              recordingId,
              specNodeId,
              stepAttempt,
              summary:
                `${row.method} ${row.host}${row.path} ${row.blocked ? 'blocked' : (row.status ?? '')}`.slice(
                  0,
                  1024
                ),
              ts: startedAt.toISOString(),
            });
          }
        })(),
        (async () => {
          if (!wants('human_step')) {
            return;
          }
          const matchingSteps = specNodeId
            ? await app.prisma.workflowStep.findMany({
                select: { nodeId: true, specNodeId: true },
                where: { runId, ...(specNodeId ? { specNodeId } : {}) },
              })
            : [];
          const specByRecording = new Map(
            matchingSteps.map((step) => [step.nodeId, step.specNodeId ?? step.nodeId])
          );
          await Promise.all(
            (['requestedAt', 'resolvedAt'] as const).map(async (field, phaseIndex) => {
              const rows = await readStream(
                (bucket) =>
                  app.prisma.workflowHumanStep.findMany({
                    orderBy: bucket ? [{ id: 'asc' }] : order(field),
                    select: HumanSelect,
                    take: limit + 1,
                    where: {
                      AND: [
                        recordingWhere('nodeId'),
                        specNodeId
                          ? { nodeId: { in: [specNodeId, ...specByRecording.keys()] } }
                          : {},
                        timeWhere(field, 'human:', `:${phaseIndex}`, bucket),
                      ],
                      runId,
                    },
                  }),
                field,
                limit
              );
              if (!specNodeId && rows.length) {
                const steps = await app.prisma.workflowStep.findMany({
                  select: { nodeId: true, specNodeId: true },
                  where: { nodeId: { in: [...new Set(rows.map((row) => row.nodeId))] }, runId },
                });
                for (const step of steps) {
                  specByRecording.set(step.nodeId, step.specNodeId ?? step.nodeId);
                }
              }
              for (const row of rows) {
                const timestamp = row[field];
                if (!timestamp) {
                  continue;
                }
                items.push({
                  attempt: null,
                  detail: {
                    humanKind: row.kind,
                    phase: phaseIndex ? 'resolved' : 'requested',
                    resolvedBy: phaseIndex ? row.resolvedBy : null,
                    resolvedVia: phaseIndex ? row.resolvedVia : null,
                    status: phaseIndex ? row.status : 'PENDING',
                  },
                  id: `human:${row.id}:${phaseIndex}`,
                  kind: 'human_step',
                  recordingId: row.nodeId,
                  specNodeId: specByRecording.get(row.nodeId) ?? row.nodeId,
                  stepAttempt: null,
                  summary: `${phaseIndex ? 'Resolved' : 'Requested'}: ${row.title}`.slice(0, 512),
                  ts: timestamp.toISOString(),
                });
              }
            })
          );
        })(),
      ]);
      return items;
    }
  );
  events.sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const data = events.slice(0, limit);
  const httpIds = data.flatMap((item) => (item.kind === 'http_call' ? [item.detail.callId] : []));
  if (httpIds.length) {
    const bodies = await runUnscoped(
      'body presence only for authorized activity page',
      ['WorkflowHttpCall'],
      () =>
        app.prisma.workflowHttpCall.findMany({
          select: { id: true },
          where: {
            id: { in: httpIds },
            OR: [{ requestBody: { not: null } }, { responseBody: { not: null } }],
            runId,
          },
        })
    );
    const ids = new Set(bodies.map((row) => row.id));
    for (const item of data) {
      if (item.kind === 'http_call') {
        item.detail.hasBodies = ids.has(item.detail.callId);
      }
    }
  }
  const last = data.at(-1);
  return { data, nextCursor: events.length > limit && last ? encodeCursor(last) : null };
}

export const runActivityRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const auth = requireAuth({ requiredRole: 'ENGINEER' });
  app.get(
    '/:id/activity',
    {
      onRequest: auth,
      schema: {
        params: Params,
        querystring: Query,
        response: {
          200: z.object({ data: z.array(ActivitySchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      if (caller.kind === 'service') {
        return sendError(reply, 403, 'FORBIDDEN', 'Service principals cannot read activity');
      }
      const run = await app.prisma.workflowRun.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(caller.user, request.repoAccessGate),
        },
      });
      if (!run) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      return readPage(app, run.id, request.query);
    }
  );
  app.get(
    '/:id/http-calls/:callId',
    {
      onRequest: auth,
      schema: {
        params: Params.extend({ callId: z.string().uuid() }),
        response: { 200: z.object({ data: HttpRowSchema }) },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      if (caller.kind === 'service') {
        return sendError(reply, 403, 'FORBIDDEN', 'Service principals cannot read HTTP calls');
      }
      const id = request.params.id;
      const visible = await app.prisma.workflowRun.findFirst({
        select: { id: true },
        where: { id, ...buildWorkflowRunVisibilityFilter(caller.user, request.repoAccessGate) },
      });
      if (!visible) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      const control = await app.prisma.workflowRun.findFirst({
        select: { id: true },
        where: { id, ...buildWorkflowRunControlFilter(caller.user, request.repoAccessGate) },
      });
      const row = await runUnscoped(
        'HTTP detail scoped by an authorized run, bodies gated by control',
        ['WorkflowHttpCall'],
        () =>
          app.prisma.workflowHttpCall.findFirst({
            omit: { requestBody: !control, responseBody: !control },
            where: { id: request.params.callId, runId: id },
          })
      );
      if (!row) {
        return sendError(reply, 404, 'HTTP_CALL_NOT_FOUND', 'HTTP call not found');
      }
      return {
        data: {
          ...row,
          createdAt: row.createdAt.toISOString(),
          startedAt: row.startedAt.toISOString(),
        },
      };
    }
  );
  app.get(
    '/:id/activity/export',
    { onRequest: auth, schema: { params: Params, querystring: Query } },
    async (request, reply) => {
      const caller = requireCaller(request);
      if (caller.kind === 'service') {
        return sendError(reply, 403, 'FORBIDDEN', 'Service principals cannot export activity');
      }
      const run = await app.prisma.workflowRun.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...buildWorkflowRunControlFilter(caller.user, request.repoAccessGate),
        },
      });
      if (!run) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      request.log.info(
        {
          action: 'run_activity_export',
          actorId: caller.user.sub,
          kinds: request.query.kinds,
          recordingId: request.query.recordingId,
          runId: run.id,
          since: request.query.since,
          specNodeId: request.query.specNodeId,
        },
        'run activity export'
      );
      const until = new Date();
      const runId = run.id;
      async function* lines() {
        let cursor = request.query.cursor;
        do {
          const page = await readPage(app, runId, { ...request.query, cursor }, until);
          for (const item of page.data) {
            yield `${JSON.stringify(item)}\n`;
          }
          cursor = page.nextCursor
            ? CursorValue.parse(JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString()))
            : undefined;
        } while (cursor);
        yield `${JSON.stringify({ complete: true, kind: 'eof' })}\n`;
      }
      return reply
        .type('application/x-ndjson')
        .header('content-disposition', `attachment; filename="run-${run.id}-activity.ndjson"`)
        .send(Readable.from(lines()));
    }
  );
};
