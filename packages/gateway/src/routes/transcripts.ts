import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { getArtifact } from '@auto-swe/shared/lib/artifactStore';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { normalizeTranscriptRecord } from '@auto-swe/shared/lib/transcripts/normalize';
import { scrubPii } from '@auto-swe/shared/lib/transcripts/piiScrub';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendError } from '../lib/httpErrors.js';
import {
  recordTranscriptAccessLogFailure,
  TRANSCRIPT_ACCESS_ACTIONS,
  type TranscriptAccessAction,
} from '../lib/metrics.js';
import { booleanQueryParam } from '../lib/queryParams.js';
import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from '../lib/runVisibility.js';
import {
  type DownloadLinkClaims,
  signDownloadLink,
  verifyDownloadLink,
} from '../lib/transcriptDownloadLink.js';
import {
  hasRole,
  type JwtPayload,
  loadTokenUser,
  RBAC_OPTIONS,
  type RBACOptions,
  requireAuth,
  requireCaller,
} from '../plugins/auth.js';

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
 *
 * Every content read, export, verification and legal-hold change writes a
 * `TranscriptAccessLog` row (before a stream starts; its outcome is filled in
 * when the stream ends). A failed write never blocks the access: it is logged
 * and counted (`transcript.access_log_failures`) — allow + alert.
 *
 * The content route alone also accepts a signed download link (`?dl=`) instead
 * of a credential, so a browser can stream it natively; the link's user is
 * re-loaded and re-authorized when it is used (lib/transcriptDownloadLink.ts).
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
  /** A signed download link token; see `contentAuthHook`. */
  dl: z.string().optional(),
  format: z.enum(['raw', 'normalized']).default('raw'),
  scrubPii: booleanQueryParam(false),
});

const DownloadLinkBody = z.object({
  format: z.enum(['raw', 'normalized']),
  scrubPii: z.boolean(),
});

const AccessLogQuery = z.object({
  action: z.enum(TRANSCRIPT_ACCESS_ACTIONS).optional(),
  actorId: z.string().min(1).max(200).optional(),
  from: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  runId: z.string().uuid().optional(),
  to: z.string().datetime().optional(),
  transcriptId: z.string().uuid().optional(),
});

const AccessLogRowSchema = z.object({
  action: z.string(),
  actor: z.object({ email: z.string(), name: z.string().nullable() }).nullable(),
  actorId: z.string().nullable(),
  actorRole: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  ip: z.string().nullable(),
  outcome: z.string(),
  params: z.record(z.string(), z.unknown()).nullable(),
  runId: z.string().nullable(),
  scope: z.string(),
  transcriptId: z.string().nullable(),
  userAgent: z.string().nullable(),
});

type AccessOutcome = 'started' | 'ok' | 'integrity_error' | 'stream_error' | 'aborted' | 'denied';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The verified download link a content request presented, if any. */
const downloadLinks = new WeakMap<FastifyRequest, DownloadLinkClaims>();

/**
 * The content route's authentication: `requireAuth(fallback)` as usual, unless
 * the request carries `dl` — then the signed link is the credential. It must
 * verify, be unexpired and name this transcript; its user must still exist,
 * be active (as `requireAuth` checks a bearer token's user) and meet the
 * fallback's role. The handler then re-runs the same authorization as for any
 * caller and checks the link's format and PII choice against the query. Only
 * a route using this hook accepts `dl`; everywhere else it is an ignored
 * query parameter.
 *
 * The hook carries `fallback` under {@link RBAC_OPTIONS}, so the registration
 * check that refuses `serviceScopes` behind an unreachable role sees it exactly
 * as it would see the `requireAuth` hook itself.
 */
export function contentAuthHook(fallback: RBACOptions) {
  const authenticate = requireAuth(fallback);
  const requiredRole = fallback.requiredRole ?? 'ENGINEER';
  const hook = async (request: FastifyRequest, reply: FastifyReply) => {
    const dl = (request.query as Record<string, unknown> | undefined)?.dl;
    if (dl === undefined) {
      return authenticate(request, reply);
    }
    const verified = typeof dl === 'string' ? verifyDownloadLink(dl) : null;
    if (verified?.ok === false && verified.reason === 'expired') {
      // Genuine but stale: its subject is identified, so the refusal is logged.
      downloadLinks.set(request, verified.claims);
      return sendError(reply, 401, 'DOWNLOAD_LINK_EXPIRED', 'This download link has expired');
    }
    if (!verified?.ok) {
      return sendError(reply, 401, 'DOWNLOAD_LINK_INVALID', 'This download link is not valid');
    }
    const { claims } = verified;
    downloadLinks.set(request, claims);
    if (claims.tid !== (request.params as { id?: string }).id) {
      return sendError(reply, 401, 'DOWNLOAD_LINK_INVALID', 'This download link is not valid');
    }
    const user = await loadTokenUser(request.server.prisma, claims.sub);
    if (!user?.isActive || !hasRole(user.role, requiredRole)) {
      return sendError(
        reply,
        401,
        'DOWNLOAD_LINK_INVALID',
        'The user this download link was issued to can no longer use it'
      );
    }
    request.user = {
      exp: claims.exp,
      iat: Math.floor(Date.now() / 1000),
      role: user.role,
      ...(user.slackId ? { slackId: user.slackId } : {}),
      sub: claims.sub,
    };
    // As `requireAuth` does: the run filters read the gate off the request.
    const gate = await resolveRepoAccessGateOrLastKnown();
    request.repoAccessGate = gate ?? { mode: 'off', staleAfterHours: 0 };
  };
  return Object.assign(hook, { [RBAC_OPTIONS]: fallback });
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
   * Write one access-log row and return its id, or null when the write failed.
   * Never throws: the access goes ahead regardless (allow + alert), and the
   * failure is logged and counted instead.
   */
  async function writeAccessLog(
    request: FastifyRequest,
    actor: { sub: string; role: string | null } | null,
    entry: {
      action: TranscriptAccessAction;
      scope: 'transcript' | 'run' | 'export';
      transcriptId?: string | null;
      runId?: string | null;
      params: Record<string, unknown>;
      outcome?: AccessOutcome;
    }
  ): Promise<string | null> {
    const finished = entry.outcome !== undefined && entry.outcome !== 'started';
    try {
      const row = await fastify.prisma.transcriptAccessLog.create({
        data: {
          action: entry.action,
          actorId: actor?.sub ?? null,
          actorRole: actor?.role ?? null,
          completedAt: finished ? new Date() : null,
          ip: request.ip ?? null,
          outcome: entry.outcome ?? 'started',
          params: entry.params as object,
          runId: entry.runId ?? null,
          scope: entry.scope,
          transcriptId: entry.transcriptId ?? null,
          userAgent: request.headers['user-agent']?.slice(0, 1000) ?? null,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      request.log.warn(
        { action: entry.action, err, transcriptId: entry.transcriptId ?? null },
        'transcript access log write failed; the access is allowed'
      );
      recordTranscriptAccessLogFailure(entry.action);
      return null;
    }
  }

  /** Record how an access ended. Never throws, like {@link writeAccessLog}. */
  async function completeAccessLog(
    request: FastifyRequest,
    id: string | null,
    action: TranscriptAccessAction,
    outcome: Exclude<AccessOutcome, 'started'>
  ): Promise<void> {
    if (!id) {
      return;
    }
    try {
      await fastify.prisma.transcriptAccessLog.update({
        data: { completedAt: new Date(), outcome },
        where: { id },
      });
    } catch (err) {
      request.log.warn(
        { action, err, outcome },
        'transcript access log outcome update failed; the access is allowed'
      );
      recordTranscriptAccessLogFailure(action);
    }
  }

  /**
   * Track one streamed access from before its log row is written to the end of
   * the response. The response listeners are registered first, so a client
   * that leaves while the row is still being inserted is recorded too, and the
   * outcome is settled by the response alone — whether or not the stream's
   * generator ever runs:
   *
   * - `ok` once the response has finished (every byte handed to the socket);
   * - `integrity_error` / `stream_error` when the source reported one;
   * - `aborted` when the response closed before it finished.
   */
  function accessTracker(
    request: FastifyRequest,
    reply: FastifyReply,
    action: TranscriptAccessAction
  ) {
    let reported: 'integrity_error' | 'stream_error' | null = null;
    let logId: Promise<string | null> = Promise.resolve(null);
    let settled = false;
    const settle = (outcome: Exclude<AccessOutcome, 'started'>) => {
      if (settled) {
        return;
      }
      settled = true;
      void logId.then((id) => completeAccessLog(request, id, action, outcome));
    };
    reply.raw.once('finish', () => settle(reported ?? 'ok'));
    reply.raw.once('close', () =>
      settle(reported ?? (reply.raw.writableFinished ? 'ok' : 'aborted'))
    );
    return {
      integrityError: () => {
        reported = 'integrity_error';
      },
      /** Write the `started` row; the returned promise never rejects. */
      open: (actor: JwtPayload, entry: Omit<Parameters<typeof writeAccessLog>[2], 'action'>) => {
        logId = writeAccessLog(request, actor, { ...entry, action });
        return logId;
      },
      streamError: () => {
        reported = 'stream_error';
      },
    };
  }

  /**
   * An NDJSON line source as a response body. A thrown source error ends the
   * stream with a `stream_error` line and a destroyed socket. The source calls
   * `integrityError()` when it emitted an `integrity_error` line, and
   * `destroy()` to cut the transfer short.
   */
  function ndjsonBody(
    reply: FastifyReply,
    tracker: ReturnType<typeof accessTracker>,
    source: (signals: { integrityError: () => void; destroy: () => void }) => AsyncGenerator<string>
  ): Readable {
    const destroySocket = () => {
      if (reply.raw.socket instanceof Socket) {
        reply.raw.socket.destroy();
      }
    };
    return Readable.from(
      (async function* () {
        try {
          yield* source({ destroy: destroySocket, integrityError: tracker.integrityError });
        } catch (err) {
          tracker.streamError();
          yield `${JSON.stringify({ error: String(err), kind: 'stream_error' })}\n`;
          destroySocket();
        }
      })()
    );
  }

  /**
   * A 401 or 404 on a route naming a transcript is recorded as `denied`
   * (after the response, so the answer itself reveals nothing) when the actor
   * is identified: the authenticated user, or the subject of a download link
   * whose signature verified. An unidentified caller's refusal writes no row.
   */
  const logDenied =
    (action: TranscriptAccessAction) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (reply.statusCode !== 401 && reply.statusCode !== 404) {
        return;
      }
      const id = (request.params as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        return;
      }
      const link = downloadLinks.get(request);
      const actor = request.user
        ? { role: request.user.role, sub: request.user.sub }
        : link
          ? { role: null, sub: link.sub }
          : null;
      // Only an identified caller's refusal is recorded: an anonymous one would
      // let anyone grow the table. The request log still has it.
      if (!actor) {
        return;
      }
      const query = request.query as Record<string, unknown> | undefined;
      await writeAccessLog(request, actor, {
        action,
        outcome: 'denied',
        params: {
          status: reply.statusCode,
          via: query?.dl !== undefined ? 'download_link' : 'api',
        },
        scope: 'transcript',
        transcriptId: id,
      });
    };

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
      onRequest: contentAuthHook({ requiredRole: 'ENGINEER' }),
      onResponse: logDenied('content_read'),
      schema: { params: TranscriptIdParam, querystring: ContentQuery },
    },
    async (request, reply) => {
      const link = downloadLinks.get(request);
      const { format, scrubPii: doScrubPii } = request.query;
      if (link && (link.fmt !== format || link.pii !== doScrubPii)) {
        return sendError(
          reply,
          401,
          'DOWNLOAD_LINK_INVALID',
          'This download link was issued for a different format or PII setting'
        );
      }
      const caller = requireCaller(request);
      const transcript = await readableTranscript(request, reply, request.params.id, 'control');
      if (!transcript || caller.kind !== 'user') {
        return;
      }
      const via = link ? 'download_link' : 'api';
      request.log.info(
        {
          action: 'transcript_content_read',
          actorId: caller.user.sub,
          format,
          scrubPii: doScrubPii,
          transcriptId: transcript.id,
          via,
        },
        'transcript content read'
      );
      const tracker = accessTracker(request, reply, 'content_read');
      await tracker.open(caller.user, {
        params: { format, scrubPii: doScrubPii, via },
        runId: transcript.runId,
        scope: 'transcript',
        transcriptId: transcript.id,
      });
      return reply
        .header('Content-Type', 'application/x-ndjson; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="transcript-${transcript.id}-${format}.ndjson"`
        )
        .send(
          ndjsonBody(reply, tracker, ({ destroy, integrityError }) =>
            contentLines(
              request,
              transcript,
              format,
              doScrubPii,
              (record) => record,
              () => {
                integrityError();
                destroy();
              }
            )
          )
        );
    }
  );

  // ── Signed download link for the content stream (run control or ADMIN) ──
  app.post(
    '/api/v1/transcripts/:id/download-link',
    {
      config: { serviceScopes: ['runs:read'] },
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      onResponse: logDenied('download_link'),
      schema: {
        body: DownloadLinkBody,
        params: TranscriptIdParam,
        response: { 200: z.object({ expiresAt: z.string(), url: z.string() }) },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(request);
      // The same bar as the content route itself, so a link is never issued
      // for a stream its holder could not read directly.
      const transcript = await readableTranscript(request, reply, request.params.id, 'control');
      if (!transcript || caller.kind !== 'user') {
        return;
      }
      const { format, scrubPii: doScrubPii } = request.body;
      const { expiresAt, token } = signDownloadLink({
        fmt: format,
        pii: doScrubPii,
        sub: caller.user.sub,
        tid: transcript.id,
      });
      await writeAccessLog(request, caller.user, {
        action: 'download_link',
        outcome: 'ok',
        params: { format, scrubPii: doScrubPii, via: 'api' },
        runId: transcript.runId,
        scope: 'transcript',
        transcriptId: transcript.id,
      });
      const qs = `format=${format}&scrubPii=${doScrubPii}&dl=${encodeURIComponent(token)}`;
      return {
        expiresAt: expiresAt.toISOString(),
        url: `/api/v1/transcripts/${transcript.id}/content?${qs}`,
      };
    }
  );

  // ── Integrity verification ──
  app.post(
    '/api/v1/transcripts/:id/verify',
    {
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
      const logId = await writeAccessLog(request, caller.user, {
        action: 'verify',
        params: { via: 'api' },
        runId: transcript.runId,
        scope: 'transcript',
        transcriptId: transcript.id,
      });
      const partResults: { ok: boolean; seq: number }[] = [];
      const hashes: string[] = [];
      try {
        for (const part of await transcriptParts(transcript.id)) {
          const { body } = await getArtifact(part.artifactId);
          const ok = createHash('sha256').update(body).digest('hex') === part.sha256;
          partResults.push({ ok, seq: part.seq });
          if (ok) {
            hashes.push(part.sha256);
          }
        }
      } catch (err) {
        await completeAccessLog(request, logId, 'verify', 'stream_error');
        throw err;
      }
      const sha256Matches =
        transcript.sha256 !== null &&
        createHash('sha256').update(hashes.join('\n')).digest('hex') === transcript.sha256;
      const ok = partResults.every((p) => p.ok) && sha256Matches;
      await completeAccessLog(request, logId, 'verify', ok ? 'ok' : 'integrity_error');
      return { ok, parts: partResults, sha256Matches };
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
      await writeAccessLog(request, user, {
        action: held ? 'legal_hold_set' : 'legal_hold_cleared',
        outcome: 'ok',
        params: { reason },
        runId: run.id,
        scope: 'run',
      });
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
      await writeAccessLog(request, user, {
        action: held ? 'legal_hold_set' : 'legal_hold_cleared',
        outcome: 'ok',
        params: { reason },
        runId: transcript.runId,
        scope: 'transcript',
        transcriptId: transcript.id,
      });
    }
    return { legalHold: held, reason };
  };

  app.put(
    '/api/v1/workflow-runs/:id/transcripts/legal-hold',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: LegalHoldBody, params: RunIdParam },
    },
    (request, reply) =>
      applyHold(request, reply, { runId: request.params.id }, true, request.body.reason)
  );
  app.delete(
    '/api/v1/workflow-runs/:id/transcripts/legal-hold',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: RunIdParam },
    },
    (request, reply) => applyHold(request, reply, { runId: request.params.id }, false, null)
  );
  app.put(
    '/api/v1/transcripts/:id/legal-hold',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { body: LegalHoldBody, params: TranscriptIdParam },
    },
    (request, reply) =>
      applyHold(request, reply, { transcriptId: request.params.id }, true, request.body.reason)
  );
  app.delete(
    '/api/v1/transcripts/:id/legal-hold',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: { params: TranscriptIdParam },
    },
    (request, reply) => applyHold(request, reply, { transcriptId: request.params.id }, false, null)
  );

  // ── Admin export ──
  app.get(
    '/api/v1/platform/transcripts/export',
    {
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
      const tracker = accessTracker(request, reply, 'export');
      await tracker.open(caller.user, {
        params: {
          activityType: activityType ?? null,
          agentKey: agentKey ?? null,
          format,
          from,
          scrubPii: doScrubPii,
          to,
          via: 'api',
        },
        scope: 'export',
      });
      // Export carries on past a corrupt transcript (its integrity_error line
      // names it), so the stream still ends with eof; the log records it.
      async function* lines(integrityError: () => void): AsyncGenerator<string> {
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
                integrityError();
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
        .send(ndjsonBody(reply, tracker, ({ integrityError }) => lines(integrityError)));
    }
  );

  // ── Access audit log (ADMIN) ──
  app.get(
    '/api/v1/platform/transcripts/access-log',
    {
      onRequest: requireAuth({ requiredRole: 'ADMIN' }),
      schema: {
        querystring: AccessLogQuery,
        response: { 200: z.object({ data: z.array(AccessLogRowSchema), total: z.number() }) },
      },
    },
    async (request) => {
      const { action, actorId, from, limit, offset, runId, to, transcriptId } = request.query;
      const where = {
        ...(action ? { action } : {}),
        ...(actorId ? { actorId } : {}),
        ...(runId ? { runId } : {}),
        ...(transcriptId ? { transcriptId } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lt: new Date(to) } : {}),
              },
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        fastify.prisma.transcriptAccessLog.findMany({
          // `id` breaks ties so an offset page boundary cannot repeat or skip rows.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
          where,
        }),
        fastify.prisma.transcriptAccessLog.count({ where }),
      ]);
      // A second lookup rather than a relation: the log has no foreign key to
      // User, so a deleted actor's rows keep their id and render without an email.
      const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
      const actors = actorIds.length
        ? await fastify.prisma.user.findMany({
            select: { email: true, id: true, name: true },
            where: { id: { in: actorIds } },
          })
        : [];
      const actorById = new Map(actors.map((a) => [a.id, { email: a.email, name: a.name }]));
      return {
        data: rows.map((row) => ({
          action: row.action,
          actor: row.actorId ? (actorById.get(row.actorId) ?? null) : null,
          actorId: row.actorId,
          actorRole: row.actorRole,
          completedAt: row.completedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          ip: row.ip,
          outcome: row.outcome,
          params: (row.params as Record<string, unknown> | null) ?? null,
          runId: row.runId,
          scope: row.scope,
          transcriptId: row.transcriptId,
          userAgent: row.userAgent,
        })),
        total,
      };
    }
  );
};
