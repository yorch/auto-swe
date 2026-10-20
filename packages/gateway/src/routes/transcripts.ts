import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { getArtifact } from '@auto-swe/shared/lib/artifactStore';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { normalizeTranscriptRecord } from '@auto-swe/shared/lib/transcripts/normalize';
import { scrubPii } from '@auto-swe/shared/lib/transcripts/piiScrub';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendError } from '../lib/httpErrors.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from '../lib/runVisibility.js';
import { requireAuth, requireCaller } from '../plugins/auth.js';

/**
 * Agent transcripts — the recorded model traffic of activity attempts
 * (docs/transcripts.md). Content is stored gzipped in artifacts; reads verify
 * each part's sha256 against the gzipped bytes before emitting its records.
 *
 * Authorization: list/metadata follow the run's visibility; full content
 * needs run *control* (owning team / requester) or ADMIN — shared-repo
 * teammates can see a run but not its raw model traffic. A transcript with no
 * run is ADMIN-only. Service principals get 403 on every route. A caller who
 * cannot see or control gets 404, matching the traces route.
 *
 * Every content/export stream ends with a `{"kind":"eof","complete":true}`
 * sentinel; a corruption or store failure ends it with an `integrity_error` /
 * `stream_error` line and a destroyed socket instead.
 */

const gunzipAsync = promisify(gunzip);
/** A part must not decompress beyond this — bounds one artifact's blast radius. */
const MAX_PART_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

const RunIdParam = z.object({ id: z.string().uuid() });
const TranscriptIdParam = z.object({ id: z.string().uuid() });

const TranscriptMetaSchema = z.object({
  activityOutcome: z.string().nullable(),
  activityType: z.string(),
  agentKeys: z.array(z.string()),
  attempt: z.number(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  legalHold: z.boolean(),
  modelCallCount: z.number(),
  runHold: z.boolean(),
  runId: z.string().nullable(),
  runtime: z.string(),
  sha256: z.string().nullable(),
  sizeBytes: z.number(),
  specNodeId: z.string().nullable(),
  status: z.string(),
  transcriptHold: z.boolean(),
  workflowId: z.string(),
});

const ContentQuery = z.object({
  format: z.enum(['raw', 'normalized']).default('raw'),
  scrubPii: booleanQueryParam(false),
});

const LegalHoldBody = z.object({ reason: z.string().min(1).max(500) });

const ExportQuery = z.object({
  activityType: z.string().optional(),
  agentKey: z.string().optional(),
  format: z.enum(['raw', 'normalized']).default('raw'),
  from: z.string().datetime(),
  scrubPii: booleanQueryParam(false),
  to: z.string().datetime(),
});

const EXPORT_MAX_RANGE_DAYS = 31;
const EXPORT_BATCH = 50;

interface TranscriptRow {
  activityOutcome: string | null;
  activityType: string;
  agentKeys: string[];
  attempt: number;
  closedAt: Date | null;
  createdAt: Date;
  id: string;
  legalHold: boolean;
  runLegalHold: boolean;
  modelCallCount: number;
  runId: string | null;
  runtime: string;
  sha256: string | null;
  sizeBytes: number;
  specNodeId: string | null;
  status: string;
  workflowId: string;
}

interface PartRow {
  artifactId: string;
  seq: number;
  sha256: string;
}

function toMeta(row: TranscriptRow) {
  return {
    activityOutcome: row.activityOutcome,
    activityType: row.activityType,
    agentKeys: row.agentKeys,
    attempt: row.attempt,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    legalHold: row.legalHold || row.runLegalHold,
    modelCallCount: row.modelCallCount,
    runHold: row.runLegalHold,
    runId: row.runId,
    runtime: row.runtime,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    specNodeId: row.specNodeId,
    status: row.status,
    transcriptHold: row.legalHold,
    workflowId: row.workflowId,
  };
}

type PartOutcome =
  | { kind: 'ok'; lines: string[] }
  | { kind: 'integrity_error'; reason: 'sha_mismatch' | 'too_large' | 'corrupt' | 'read_failed' };

/**
 * A gzipped part's NDJSON lines. The sha256 is verified against the gzipped
 * bytes first; a part that fails — or decompresses past the bound — is an
 * integrity error, not a stream of bad records.
 */
async function partLines(part: PartRow): Promise<PartOutcome> {
  let body: Buffer;
  try {
    body = (await getArtifact(part.artifactId)).body;
  } catch {
    return { kind: 'integrity_error', reason: 'read_failed' };
  }
  if (createHash('sha256').update(body).digest('hex') !== part.sha256) {
    return { kind: 'integrity_error', reason: 'sha_mismatch' };
  }
  let text: string;
  try {
    text = (await gunzipAsync(body, { maxOutputLength: MAX_PART_UNCOMPRESSED_BYTES })).toString(
      'utf8'
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      kind: 'integrity_error',
      reason:
        code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? 'too_large' : 'corrupt',
    };
  }
  return { kind: 'ok', lines: text.split('\n').filter((l) => l !== '') };
}

/** Map one raw record into the response shape for the chosen format. */
function mapRecord(record: unknown, format: 'raw' | 'normalized', doScrubPii: boolean): unknown {
  if (format === 'normalized') {
    const normalized = normalizeTranscriptRecord(record as never);
    return {
      normalized: normalized && doScrubPii ? scrubPii(normalized) : normalized,
      record: doScrubPii ? scrubPii(record) : record,
    };
  }
  return doScrubPii ? scrubPii(record) : record;
}

export const transcriptRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const serviceRefused = (reply: FastifyReply) =>
    sendError(
      reply,
      403,
      'TRANSCRIPTS_NOT_AVAILABLE',
      'Service principals cannot read transcripts'
    );

  /**
   * Load a transcript the caller may read at the requested level.
   * `level: 'view'` — its run's visibility filter; runless → ADMIN.
   * `level: 'control'` — its run's control filter (or ADMIN); runless → ADMIN.
   * A caller short of the bar gets 404, same as an invisible run.
   */
  async function readableTranscript(
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    level: 'view' | 'control'
  ): Promise<TranscriptRow | null> {
    const caller = requireCaller(request);
    if (caller.kind === 'service') {
      await serviceRefused(reply);
      return null;
    }
    const user = caller.user;
    const transcript = (await runUnscoped(
      'transcript read is authorized by its run’s visibility or admin role',
      ['AgentTranscript'],
      () => fastify.prisma.agentTranscript.findUnique({ where: { id } })
    )) as TranscriptRow | null;
    if (!transcript) {
      await sendError(reply, 404, 'TRANSCRIPT_NOT_FOUND', 'Transcript not found');
      return null;
    }
    if (transcript.runId) {
      const runFilter =
        level === 'control'
          ? buildWorkflowRunControlFilter(user, request.repoAccessGate)
          : buildWorkflowRunVisibilityFilter(user, request.repoAccessGate);
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: { id: transcript.runId, ...runFilter },
      });
      if (!run) {
        await sendError(reply, 404, 'TRANSCRIPT_NOT_FOUND', 'Transcript not found');
        return null;
      }
      return transcript;
    }
    if (user.role !== 'ADMIN') {
      await sendError(reply, 404, 'TRANSCRIPT_NOT_FOUND', 'Transcript not found');
      return null;
    }
    return transcript;
  }

  async function transcriptParts(transcriptId: string): Promise<PartRow[]> {
    return runUnscoped('transcript parts read after authorization', ['AgentTranscript'], () =>
      fastify.prisma.agentTranscriptPart.findMany({
        orderBy: { seq: 'asc' },
        select: { artifactId: true, seq: true, sha256: true },
        where: { transcriptId },
      })
    );
  }

  /**
   * One transcript's records as NDJSON lines (already `wrap`-mapped), ending
   * with the eof sentinel — or an `integrity_error` line, after which the
   * caller must drop the connection.
   */
  async function* contentLines(
    request: FastifyRequest,
    transcript: TranscriptRow,
    format: 'raw' | 'normalized',
    doScrubPii: boolean,
    wrap: (record: unknown, transcript: TranscriptRow) => unknown,
    onIntegrityFailure?: () => void
  ): AsyncGenerator<string> {
    for (const part of await transcriptParts(transcript.id)) {
      const outcome = await partLines(part);
      if (outcome.kind === 'integrity_error') {
        request.log.warn(
          { partSeq: part.seq, reason: outcome.reason, transcriptId: transcript.id },
          'transcript part failed integrity verification'
        );
        yield `${JSON.stringify({
          kind: 'integrity_error',
          partSeq: part.seq,
          reason: outcome.reason,
        })}\n`;
        // No eof sentinel follows — the socket dies so the caller cannot
        // mistake a partial stream for the whole transcript.
        onIntegrityFailure?.();
        return;
      }
      for (const line of outcome.lines) {
        yield `${JSON.stringify(wrap(mapRecord(JSON.parse(line), format, doScrubPii), transcript))}\n`;
      }
    }
    yield `${JSON.stringify({ complete: true, kind: 'eof' })}\n`;
  }

  // ── List a run's transcripts ──
  app.get(
    '/api/v1/workflow-runs/:id/transcripts',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: RunIdParam,
        response: { 200: z.object({ data: z.array(TranscriptMetaSchema) }) },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      if (caller.kind === 'service') {
        return serviceRefused(reply);
      }
      const run = await fastify.prisma.workflowRun.findFirst({
        select: { id: true },
        where: {
          id: request.params.id,
          ...buildWorkflowRunVisibilityFilter(caller.user, request.repoAccessGate),
        },
      });
      if (!run) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      const transcripts = (await runUnscoped(
        'transcript list is scoped by a run the caller was authorized to read',
        ['AgentTranscript'],
        () =>
          fastify.prisma.agentTranscript.findMany({
            orderBy: { createdAt: 'asc' },
            where: { runId: run.id },
          })
      )) as TranscriptRow[];
      return { data: transcripts.map(toMeta) };
    }
  );

  // ── Transcript metadata + parts ──
  app.get(
    '/api/v1/transcripts/:id',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: {
        params: TranscriptIdParam,
        response: {
          200: z.object({
            parts: z.array(
              z.object({
                recordCount: z.number(),
                seq: z.number(),
                sha256: z.string(),
                sizeBytes: z.number(),
              })
            ),
            transcript: TranscriptMetaSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const transcript = await readableTranscript(request, reply, request.params.id, 'view');
      if (!transcript) {
        return;
      }
      const parts = await runUnscoped(
        'transcript parts read after authorization',
        ['AgentTranscript'],
        () =>
          fastify.prisma.agentTranscriptPart.findMany({
            orderBy: { seq: 'asc' },
            select: { recordCount: true, seq: true, sha256: true, sizeBytes: true },
            where: { transcriptId: transcript.id },
          })
      );
      return { parts, transcript: toMeta(transcript) };
    }
  );

  // ── Transcript content stream (run control or ADMIN) ──
  app.get(
    '/api/v1/transcripts/:id/content',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { params: TranscriptIdParam, querystring: ContentQuery },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      const transcript = await readableTranscript(request, reply, request.params.id, 'control');
      if (!transcript) {
        return;
      }
      const { format, scrubPii: doScrubPii } = request.query;
      request.log.info(
        {
          action: 'transcript_content_read',
          actorId: caller.kind === 'user' ? caller.user.sub : null,
          format,
          scrubPii: doScrubPii,
          transcriptId: transcript.id,
        },
        'transcript content read'
      );
      const lines = contentLines(
        request,
        transcript,
        format,
        doScrubPii,
        (record) => record,
        () => {
          // Destroy the transport so the transfer visibly ends short — the
          // missing eof line is the signal for clients that see the write.
          if (reply.raw.socket instanceof Socket) {
            reply.raw.socket.destroy();
          }
        }
      );
      return reply
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="transcript-${transcript.id}-${format}.ndjson"`
        )
        .send(
          Readable.from(
            (async function* () {
              try {
                yield* lines;
              } catch (err) {
                yield `${JSON.stringify({ error: String(err), kind: 'stream_error' })}\n`;
                if (reply.raw.socket instanceof Socket) {
                  reply.raw.socket.destroy();
                }
              }
            })()
          )
        );
    }
  );

  // ── Integrity verification ──
  app.post(
    '/api/v1/transcripts/:id/verify',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: TranscriptIdParam },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      if (caller.kind === 'service') {
        return serviceRefused(reply);
      }
      const transcript = (await runUnscoped(
        'transcript verify is admin-only',
        ['AgentTranscript'],
        () => fastify.prisma.agentTranscript.findUnique({ where: { id: request.params.id } })
      )) as TranscriptRow | null;
      if (!transcript) {
        return sendError(reply, 404, 'TRANSCRIPT_NOT_FOUND', 'Transcript not found');
      }
      const partResults: { ok: boolean; seq: number }[] = [];
      const hashes: string[] = [];
      for (const part of await transcriptParts(transcript.id)) {
        const { body } = await getArtifact(part.artifactId);
        const ok = createHash('sha256').update(body).digest('hex') === part.sha256;
        partResults.push({ ok, seq: part.seq });
        if (ok) {
          hashes.push(part.sha256);
        }
      }
      const sha256Matches =
        transcript.sha256 !== null &&
        createHash('sha256').update(hashes.join('\n')).digest('hex') === transcript.sha256;
      return {
        ok: partResults.every((p) => p.ok) && sha256Matches,
        parts: partResults,
        sha256Matches,
      };
    }
  );

  // ── Legal hold (ADMIN) ──
  const applyHold = async (
    request: FastifyRequest,
    reply: FastifyReply,
    target: { runId: string } | { transcriptId: string },
    held: boolean,
    reason: string | null
  ) => {
    const caller = requireCaller(request);
    if (caller.kind === 'service') {
      return serviceRefused(reply);
    }
    const user = caller.user;
    const now = new Date();
    const runHoldData = {
      runLegalHold: held,
      runLegalHoldAt: held ? now : null,
      runLegalHoldById: held ? user.sub : null,
      runLegalHoldReason: reason,
    };
    const holdData = {
      legalHold: held,
      legalHoldAt: held ? now : null,
      legalHoldById: held ? user.sub : null,
      legalHoldReason: reason,
    };
    if ('runId' in target) {
      const run = await fastify.prisma.workflowRun.findUnique({
        select: { id: true },
        where: { id: target.runId },
      });
      if (!run) {
        return sendError(reply, 404, 'RUN_NOT_FOUND', 'Workflow run not found');
      }
      await runUnscoped(
        'legal hold updates every transcript of a run the admin was authorized to hold',
        ['AgentTranscript'],
        () =>
          fastify.prisma.$transaction([
            fastify.prisma.workflowRun.update({
              data: {
                transcriptLegalHold: held,
                transcriptLegalHoldAt: held ? now : null,
                transcriptLegalHoldById: held ? user.sub : null,
                transcriptLegalHoldReason: reason,
              },
              where: { id: run.id },
            }),
            fastify.prisma.agentTranscript.updateMany({
              data: runHoldData,
              where: { runId: run.id },
            }),
          ])
      );
      request.log.info(
        {
          action: held ? 'transcript_legal_hold_set' : 'transcript_legal_hold_cleared',
          actorId: user.sub,
          reason,
          runId: run.id,
        },
        'transcript legal hold change'
      );
    } else {
      const transcript = (await runUnscoped(
        'transcript legal hold is admin-only',
        ['AgentTranscript'],
        () => fastify.prisma.agentTranscript.findUnique({ where: { id: target.transcriptId } })
      )) as TranscriptRow | null;
      if (!transcript) {
        return sendError(reply, 404, 'TRANSCRIPT_NOT_FOUND', 'Transcript not found');
      }
      await runUnscoped('transcript legal hold update', ['AgentTranscript'], () =>
        fastify.prisma.agentTranscript.update({ data: holdData, where: { id: transcript.id } })
      );
      request.log.info(
        {
          action: held ? 'transcript_legal_hold_set' : 'transcript_legal_hold_cleared',
          actorId: user.sub,
          reason,
          transcriptId: transcript.id,
        },
        'transcript legal hold change'
      );
    }
    return { legalHold: held, reason };
  };

  app.put(
    '/api/v1/workflow-runs/:id/transcripts/legal-hold',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: LegalHoldBody, params: RunIdParam },
    },
    (request, reply) =>
      applyHold(request, reply, { runId: request.params.id }, true, request.body.reason)
  );
  app.delete(
    '/api/v1/workflow-runs/:id/transcripts/legal-hold',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: RunIdParam },
    },
    (request, reply) => applyHold(request, reply, { runId: request.params.id }, false, null)
  );
  app.put(
    '/api/v1/transcripts/:id/legal-hold',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: LegalHoldBody, params: TranscriptIdParam },
    },
    (request, reply) =>
      applyHold(request, reply, { transcriptId: request.params.id }, true, request.body.reason)
  );
  app.delete(
    '/api/v1/transcripts/:id/legal-hold',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: TranscriptIdParam },
    },
    (request, reply) => applyHold(request, reply, { transcriptId: request.params.id }, false, null)
  );

  // ── Admin export ──
  app.get(
    '/api/v1/platform/transcripts/export',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { querystring: ExportQuery },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      if (caller.kind === 'service') {
        return serviceRefused(reply);
      }
      const { activityType, agentKey, format, from, scrubPii: doScrubPii, to } = request.query;
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (
        toDate <= fromDate ||
        toDate.getTime() - fromDate.getTime() > EXPORT_MAX_RANGE_DAYS * 86_400_000
      ) {
        return sendError(
          reply,
          400,
          'INVALID_RANGE',
          'to must be after from, and the range may not exceed 31 days'
        );
      }
      request.log.info(
        {
          action: 'transcript_export',
          activityType,
          actorId: caller.user.sub,
          agentKey,
          format,
          from,
          scrubPii: doScrubPii,
          to,
        },
        'transcript export'
      );
      async function* lines(): AsyncGenerator<string> {
        let cursor: { createdAt: Date; id: string } | null = null;
        for (;;) {
          const batch = (await runUnscoped(
            'admin transcript export reads every tenant’s transcripts',
            ['AgentTranscript'],
            () =>
              fastify.prisma.agentTranscript.findMany({
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: EXPORT_BATCH,
                where: {
                  ...(activityType ? { activityType } : {}),
                  ...(agentKey ? { agentKeys: { has: agentKey } } : {}),
                  createdAt: { gte: fromDate, lt: toDate },
                  ...(cursor
                    ? {
                        OR: [
                          { createdAt: { gt: cursor.createdAt } },
                          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                        ],
                      }
                    : {}),
                },
              })
          )) as TranscriptRow[];
          if (batch.length === 0) {
            break;
          }
          for (const transcript of batch) {
            for (const part of await transcriptParts(transcript.id)) {
              const outcome = await partLines(part);
              if (outcome.kind === 'integrity_error') {
                request.log.warn(
                  { partSeq: part.seq, reason: outcome.reason, transcriptId: transcript.id },
                  'transcript part failed integrity verification during export'
                );
                yield `${JSON.stringify({
                  kind: 'integrity_error',
                  partSeq: part.seq,
                  reason: outcome.reason,
                  transcriptId: transcript.id,
                })}\n`;
                break;
              }
              for (const line of outcome.lines) {
                yield `${JSON.stringify({
                  record: mapRecord(JSON.parse(line), format, doScrubPii),
                  transcript: toMeta(transcript),
                })}\n`;
              }
            }
            cursor = { createdAt: transcript.createdAt, id: transcript.id };
          }
          if (batch.length < EXPORT_BATCH) {
            break;
          }
        }
        yield `${JSON.stringify({ complete: true, kind: 'eof' })}\n`;
      }
      return reply
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="transcripts-export-${from}-${to}.ndjson"`
        )
        .send(
          Readable.from(
            (async function* () {
              try {
                yield* lines();
              } catch (err) {
                yield `${JSON.stringify({ error: String(err), kind: 'stream_error' })}\n`;
                if (reply.raw.socket instanceof Socket) {
                  reply.raw.socket.destroy();
                }
              }
            })()
          )
        );
    }
  );
};
