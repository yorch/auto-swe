/**
 * Agent transcript capture — records one activity attempt's model traffic at
 * full fidelity for debugging, evals, training data, and audit.
 *
 * One `TranscriptRecorder` per activity attempt, bound to the attempt's async
 * context by `activityTranscriptInterceptor` (registered LAST so the node-tag
 * ALS and the activity span are already bound). `recordingFetch` wraps the
 * fetch every in-process model call goes through (lib/models.ts) and the
 * embedding fetch (lib/embeddings.ts, vectors omitted), and records each
 * exchange as an `http_call`; a proxied Claude Code turn's exchanges arrive
 * through the model proxy's `onExchange`, and a non-proxied one's SDK messages
 * arrive as `harness_message` records, plus the session-file delta the turn
 * wrote (`harness_session_file`). Every Claude Code turn starts with a
 * `harness_turn` record of the options it ran with.
 *
 * Records are serialized NDJSON lines — `{ seq, ts, kind, … }`, secrets
 * redacted by `redactJsonValues` and NEVER truncated — flushed to gzipped
 * parts (`WorkflowArtifact` rows with no runId, so run deletion cannot cascade
 * them) when the buffer reaches {@link PART_FLUSH_BYTES}, every
 * {@link FLUSH_INTERVAL_MS} while non-empty, and at close. Per-part sha256 and
 * a transcript-level hash of the part hashes give the export path something
 * to verify.
 *
 * Persistence is best-effort + alert: any write failure logs, counts
 * `transcript.persist_failures`, writes a `transcript.persist_failed` trace
 * event, and never throws into the activity.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { putArtifact } from '@auto-swe/shared/lib/artifactStore';
import { CancelledFailure } from '@temporalio/activity';
import type { ActivityInterceptors } from '@temporalio/worker';
import {
  currentActivityType,
  currentAttempt,
  currentTemporalRunId,
  currentWorkflowId,
} from './activityContext.js';
import { logWarn } from './activityLog.js';
import { currentNodeTag, nodeTagColumns } from './activityNodeTag.js';
import { AgentTracer, redactJsonValues } from './agentTracer.js';
import { recordTranscriptPersistFailure } from './metrics.js';
import { currentSpendOwner } from './spendOwner.js';

const gzipAsync = promisify(gzip);

/** Flush the buffered records as one part once they reach this many uncompressed bytes. */
const PART_FLUSH_BYTES = 8 * 1024 * 1024;
/** Flush a non-empty buffer at least this often, so a quiet turn still lands its records. */
const FLUSH_INTERVAL_MS = 30_000;
/**
 * How long close() waits for in-flight response captures (a model response
 * still streaming through `recordingFetch` when the activity body returned).
 * Records that arrive after it lands are too late for this transcript.
 */
const CLOSE_CAPTURE_WAIT_MS = 10_000;
/**
 * How long the interceptor lets close() take before returning without it —
 * persistence is best-effort, so a hung artifact store must not hold the
 * activity past its own timeout. The write continues in the background.
 */
const CLOSE_WAIT_BOUND_MS = 30_000;
/**
 * One serialized record may not exceed this. Over-limit http_call records are
 * stored with `request` / `response.body` replaced by
 * `{ truncated: true, originalBytes, head }` (head = first 1 MiB of the
 * serialized value) plus a `record_truncated` marker — an unbounded model
 * response must not let one record own the whole transcript's budget.
 */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const TRUNCATED_HEAD_BYTES = 1024 * 1024;

const PART_KIND = 'agent-transcript-part';
const PART_CONTENT_TYPE = 'application/x-ndjson+gzip';

/** Query parameters that carry credentials; everything else is kept. */
const SECRET_QUERY_PARAMS = new Set([
  'access_token',
  'api-key',
  'api_key',
  'apikey',
  'client_secret',
  'credential',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
  'x-api-key',
]);

/** An `x-amz-*` parameter (S3 presignatures carry credentials there). */
function isSecretParam(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_QUERY_PARAMS.has(n) || n.startsWith('x-amz-');
}

export type ActivityOutcome = 'succeeded' | 'failed' | 'cancelled';

/** One `http_call` record's payload (sans seq/ts/kind, which the recorder stamps). */
export interface HttpCallRecord {
  method: string;
  host: string;
  path: string;
  status?: number;
  durationMs: number;
  request?: unknown;
  response?: { contentType: string | null; body: unknown };
  /** Set by the proxy when it stopped accumulating the body at MAX_RECORD_BYTES. */
  responseTruncated?: boolean;
  error?: string;
  agentKeys?: string[];
  /** `embedding`: an embedding call — recorded, but not counted as a model call. */
  purpose?: 'embedding';
}

/** A Claude Code turn's configuration, as the runtime passed it to the SDK. */
export interface HarnessTurnRecord {
  runtime: 'claude-code';
  proxied: boolean;
  model: string;
  /**
   * `append` is the prompt text appended to the preset — on the adapter's
   * first turn in this transcript and whenever its sha256 changes; otherwise
   * `unchanged: true` with the same sha256. A prompt too long for the command
   * line is staged as a file the harness is pointed at — `stagedPath` names
   * it, and `append` still holds the full text.
   */
  systemPrompt: {
    preset: 'claude_code';
    /** sha256 of the appended prompt text, on every turn. */
    sha256: string;
    stagedPath?: string;
  } & ({ append: string } | { unchanged: true });
  tools: string[];
  maxTurns: number;
  /** Server names only — never URLs, headers, or credentials. */
  mcpServers: string[];
  loadProjectSettings: boolean;
  effort?: string;
}

/** The bytes a non-proxied Claude Code turn added to its session JSONL file. */
export interface HarnessSessionFileRecord {
  runtime: 'claude-code';
  sessionId: string;
  path: string;
  /** Byte offset in the file where this delta starts. */
  offset: number;
  /** Bytes delivered by the read (what `lines` was parsed from). */
  bytes: number;
  /** The read stopped at the per-turn cap; the rest follows on a later turn. */
  truncated: boolean;
  /** The file was smaller than the recorded offset (rewritten), so it was read from 0. */
  reset?: true;
  /** Parsed JSONL objects; an unparseable line is kept as its string. */
  lines: unknown[];
}

const storage = new AsyncLocalStorage<TranscriptRecorder>();

/** The recorder for the activity attempt this async context belongs to, if any. */
export function currentTranscriptRecorder(): TranscriptRecorder | undefined {
  return storage.getStore();
}

/** Run `body` with `recorder` as the active transcript recorder (tests). */
export function runWithTranscriptRecorder<T>(recorder: TranscriptRecorder, body: () => T): T {
  return storage.run(recorder, body);
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `{ truncated, originalBytes, head }` stand-in for an over-limit field value. */
function truncatedValue(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    serialized = '';
  }
  return {
    head: serialized.slice(0, TRUNCATED_HEAD_BYTES),
    originalBytes: Buffer.byteLength(serialized),
    truncated: true,
  };
}

/** Path plus query, minus every query parameter that could carry a credential. */
function sanitizedPath(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (isSecretParam(name)) {
        parsed.searchParams.delete(name);
      }
    }
    const query = parsed.searchParams.toString();
    return { host: parsed.host, path: query ? `${parsed.pathname}?${query}` : parsed.pathname };
  } catch {
    return { host: '', path: url };
  }
}

export class TranscriptRecorder {
  private seq = 0;
  private lines: string[] = [];
  private bufferedBytes = 0;
  private recordCount = 0;
  private partSeq = 0;
  private partHashes: string[] = [];
  private sizeBytes = 0;
  private maxBytes = 0;
  private modelCallCount = 0;
  private agentKeys = new Set<string>();
  private assistantMessageId: string | undefined;
  private runtime = 'ai-sdk';
  private rowId: string | undefined;
  /** First-record setup; resolves false when capture is disabled or the create failed. */
  private openPromise: Promise<boolean> | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private truncated = false;
  private partWriteFailed = false;
  private closed = false;
  /** The row's final update has run; nothing more can be recorded anywhere. */
  private finalized = false;
  /** Response captures `recordingFetch` is still reading in the background. */
  private captures = new Set<Promise<void>>();
  private lateRecordWarned = false;
  /** True while close()'s final flush can still pick up lines pushed now. */
  private linesSnapshotPending = true;

  /**
   * A background capture `recordingFetch` is running for this recorder. close()
   * waits for the set to drain (bounded) so the attempt's last model call is
   * not lost to a race between the response ending and the activity returning.
   */
  trackCapture(capture: Promise<void>): void {
    this.captures.add(capture);
    void capture.finally(() => this.captures.delete(capture));
  }

  /**
   * The model call the proxy or fetch layer saw end. Counts toward
   * `modelCallCount`, except token counting and embedding calls.
   */
  addHttpCall(record: HttpCallRecord): void {
    const rec =
      record.responseTruncated && record.response
        ? {
            ...record,
            response: { ...record.response, body: truncatedValue(record.response.body) },
          }
        : record;
    if (
      this.append('http_call', rec) &&
      rec.purpose !== 'embedding' &&
      !rec.path.split('?')[0]?.endsWith('/count_tokens')
    ) {
      this.modelCallCount += 1;
    }
  }

  /** A Claude Code SDK stream message — only ever called for a non-proxied turn. */
  addHarnessMessage(message: unknown): void {
    this.append('harness_message', { message, runtime: 'claude-code' });
  }

  /** A Claude Code turn's configuration, recorded as the turn starts. */
  addHarnessTurn(record: HarnessTurnRecord): void {
    this.append('harness_turn', record);
  }

  /**
   * What a non-proxied Claude Code turn appended to its session file. True
   * only when the record itself landed in the buffer — false when it was
   * dropped (closed, past the transcript cap) or replaced by a bare
   * `record_truncated` marker, so the caller knows not to advance its offset.
   */
  addHarnessSessionFile(record: HarnessSessionFileRecord): boolean {
    return this.append('harness_session_file', record) === 'stored';
  }

  /** False once nothing more can be recorded (closed, or past the transcript cap). */
  acceptsRecords(): boolean {
    return !this.closed && !this.truncated;
  }

  /** 'ai-sdk' | 'claude-code'; stamps the row's runtime column. */
  setRuntime(runtime: string): void {
    this.runtime = runtime;
  }

  /** Deduped onto the row at close; called by `persistActivityTrace`. */
  noteAgentKey(key: string): void {
    this.agentKeys.add(key);
  }

  /** The assistant reply this attempt's turn was for; called by `persistActivityTrace`. */
  noteAssistantMessageId(id: string | undefined): void {
    this.assistantMessageId ??= id;
  }

  /**
   * A record arrived after close began. If the row's final flush has not run
   * yet, a `record_dropped` marker can still make it into the last part; after
   * that, the only trace of the drop is a log and the counter.
   */
  private recordDropped(): void {
    // Marker only if the final flush has not snapshotted the buffer — after
    // that nothing would write the line, so it is log + counter only.
    if (!this.finalized && this.linesSnapshotPending) {
      this.lines.push(
        JSON.stringify({
          detail: 'record arrived after the activity ended; dropped',
          event: 'record_dropped',
          kind: 'marker',
          seq: this.seq,
          ts: new Date().toISOString(),
        })
      );
      this.seq += 1;
      this.recordCount += 1;
      return;
    }
    if (!this.lateRecordWarned) {
      this.lateRecordWarned = true;
      logWarn('agent transcript record dropped: arrived after the row was closed');
      recordTranscriptPersistFailure('close');
    }
  }

  /**
   * Buffer one record. `stored`: the record's line (fields possibly shrunk);
   * `replaced`: only a bare `record_truncated` marker stands in for it; false:
   * nothing was recorded.
   */
  private append(kind: string, payload: object): 'stored' | 'replaced' | false {
    if (this.closed) {
      this.recordDropped();
      return false;
    }
    if (this.truncated) {
      return false;
    }
    const redacted = redactJsonValues(payload) as Record<string, unknown>;
    const seq = this.seq;
    let line = JSON.stringify({ kind, seq, ts: new Date().toISOString(), ...redacted });
    let markerAfter = false;
    let outcome: 'stored' | 'replaced' = 'stored';
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      // A single unbounded field must not own the whole transcript: replace
      // request/response.body with a head + size marker, and say so.
      const shrunk = { ...redacted };
      if ('request' in shrunk) {
        shrunk.request = truncatedValue(shrunk.request);
      }
      const resp = shrunk.response;
      if (resp && typeof resp === 'object' && 'body' in resp) {
        shrunk.response = {
          ...(resp as Record<string, unknown>),
          body: truncatedValue((resp as Record<string, unknown>).body),
        };
      }
      line = JSON.stringify({ kind, seq, ts: new Date().toISOString(), ...shrunk });
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        line = JSON.stringify({
          detail: 'record exceeded MAX_RECORD_BYTES after field truncation',
          event: 'record_truncated',
          kind,
          seq,
          ts: new Date().toISOString(),
        });
        outcome = 'replaced';
      } else {
        markerAfter = true;
      }
    }
    const lineBytes = Buffer.byteLength(line) + 1;
    // Flush first when this record would push the buffer past the threshold —
    // a part stays under PART_FLUSH_BYTES plus one record.
    if (this.bufferedBytes > 0 && this.bufferedBytes + lineBytes > PART_FLUSH_BYTES) {
      this.scheduleFlush();
    }
    this.seq += 1;
    this.lines.push(line);
    this.bufferedBytes += lineBytes;
    this.recordCount += 1;
    if (markerAfter) {
      // Marker follows the record, with the next seq.
      this.appendMarker('record_truncated', 'record exceeded MAX_RECORD_BYTES; fields truncated');
    }
    // Lazy: the row does not exist until there is something to put in it.
    this.openPromise ??= this.open();
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.scheduleFlush();
      }, FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
    if (this.bufferedBytes >= PART_FLUSH_BYTES) {
      this.scheduleFlush();
    }
    return outcome;
  }

  /** A `marker` bookkeeping record; never itself truncated or a trigger for one. */
  private appendMarker(event: string, detail: string): void {
    const line = JSON.stringify({
      detail,
      event,
      kind: 'marker',
      seq: this.seq,
      ts: new Date().toISOString(),
    });
    this.seq += 1;
    this.lines.push(line);
    this.bufferedBytes += Buffer.byteLength(line) + 1;
    this.recordCount += 1;
  }

  /**
   * First record: check the capture switch, gather the attempt's context, and
   * open the row. A failure at any point turns recording off rather than
   * reaching the activity — and leaves its mark on the metrics counter.
   */
  private async open(): Promise<boolean> {
    try {
      if (!(await resolveSetting('workflow.transcriptCaptureEnabled', {}))) {
        return false;
      }
      const [run, owner, maxBytes] = await Promise.all([
        prisma.workflowRun
          .findUnique({
            select: {
              id: true,
              transcriptLegalHold: true,
              transcriptLegalHoldAt: true,
              transcriptLegalHoldById: true,
              transcriptLegalHoldReason: true,
            },
            where: { workflowId: currentWorkflowId() },
          })
          .then(
            (r) => r,
            () => null
          ),
        currentSpendOwner(),
        resolveSetting('workflow.transcriptMaxBytes', {}),
      ]);
      this.maxBytes = maxBytes;
      // Same rule as persistActivityTrace: a failed run lookup cannot tell a
      // runless workflow from one with a run, so its row carries no owner.
      const ids = run ? { ...owner, runId: run.id ?? null } : { runId: null };
      const row = await prisma.agentTranscript.create({
        data: {
          ...ids,
          ...nodeTagColumns(currentNodeTag()),
          activityType: currentActivityType(),
          assistantMessageId: this.assistantMessageId ?? null,
          attempt: currentAttempt(),
          // The run's hold copies into runLegalHold* — the per-transcript
          // legalHold* columns stay an independent scope.
          runLegalHold: run?.transcriptLegalHold ?? false,
          runLegalHoldAt: run?.transcriptLegalHold ? run.transcriptLegalHoldAt : null,
          runLegalHoldById: run?.transcriptLegalHold ? run.transcriptLegalHoldById : null,
          runLegalHoldReason: run?.transcriptLegalHold ? run.transcriptLegalHoldReason : null,
          runtime: this.runtime,
          temporalRunId: currentTemporalRunId(),
          workflowId: currentWorkflowId(),
        },
      });
      this.rowId = row.id;
      return true;
    } catch (err) {
      await this.persistFailure('create', err);
      return false;
    }
  }

  /** Flush the buffer as a part, serialized with every other write this recorder makes. */
  private scheduleFlush(): void {
    // flush() reports its own failures; the catch keeps a rejection out of
    // both the unhandled-rejection path and the chain itself.
    this.flushChain = this.flushChain.then(() => this.flush()).catch(() => {});
  }

  private async flush(): Promise<void> {
    if (this.lines.length === 0) {
      return;
    }
    const open = this.openPromise ? await this.openPromise : false;
    if (!open || !this.rowId) {
      this.lines = [];
      this.bufferedBytes = 0;
      this.recordCount = 0;
      return;
    }
    const lines = this.lines;
    const recordCount = this.recordCount;
    this.lines = [];
    this.bufferedBytes = 0;
    this.recordCount = 0;
    // From the snapshot on, a record arriving post-close cannot be written:
    // recordDropped() falls back to log + counter.
    this.linesSnapshotPending = false;
    try {
      const body = await gzipAsync(`${lines.join('\n')}\n`);
      const hash = sha256Hex(body);
      // No runId: run deletion must not cascade a transcript's payload.
      const artifact = await putArtifact({ body, contentType: PART_CONTENT_TYPE, kind: PART_KIND });
      await prisma.agentTranscriptPart.create({
        data: {
          artifactId: artifact.id,
          recordCount,
          seq: this.partSeq,
          sha256: hash,
          sizeBytes: body.byteLength,
          transcriptId: this.rowId,
        },
      });
      this.partSeq += 1;
      this.partHashes.push(hash);
      this.sizeBytes += body.byteLength;
      // Bump the row each part: `updatedAt` is what the retention sweep reads
      // to tell a live transcript from one its worker abandoned, and the run
      // page shows progress mid-attempt.
      await prisma.agentTranscript.update({
        data: { modelCallCount: this.modelCallCount, sizeBytes: this.sizeBytes },
        where: { id: this.rowId },
      });
      if (!this.truncated && this.sizeBytes > this.maxBytes) {
        // The cap is on compressed bytes; a part that lands past it writes one
        // last marker and the rest of the attempt goes unrecorded.
        this.truncated = true;
        this.lines.push(
          JSON.stringify({
            detail: `transcript exceeded workflow.transcriptMaxBytes (${this.maxBytes})`,
            event: 'truncated',
            kind: 'marker',
            seq: this.seq,
            ts: new Date().toISOString(),
          })
        );
        this.recordCount += 1;
        await this.flush();
      }
    } catch (err) {
      // The buffer is lost with the failed write; the row says so at close.
      this.partWriteFailed = true;
      await this.persistFailure('part', err);
    }
  }

  /**
   * Final flush, then close the row. Never throws: transcript persistence is
   * best-effort and the activity's own outcome is already decided.
   */
  async close(outcome: ActivityOutcome): Promise<void> {
    if (this.closed) {
      return;
    }
    // Drain response captures still reading in the background (bounded): the
    // activity's last model call lands here, not in a `record_dropped` marker.
    if (this.captures.size > 0) {
      let wait: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.captures]),
          new Promise((resolve) => {
            wait = setTimeout(resolve, CLOSE_CAPTURE_WAIT_MS);
            wait.unref();
          }),
        ]);
      } finally {
        if (wait) {
          clearTimeout(wait);
        }
      }
    }
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      await this.flushChain.then(() => this.flush());
      if (!this.rowId) {
        this.finalized = true;
        return;
      }
      const status = this.partWriteFailed
        ? 'incomplete'
        : this.truncated
          ? 'truncated'
          : 'complete';
      await prisma.agentTranscript.update({
        data: {
          activityOutcome: outcome,
          agentKeys: [...this.agentKeys],
          assistantMessageId: this.assistantMessageId ?? null,
          closedAt: new Date(),
          modelCallCount: this.modelCallCount,
          runtime: this.runtime,
          sha256: this.partHashes.length > 0 ? sha256Hex(this.partHashes.join('\n')) : null,
          sizeBytes: this.sizeBytes,
          status,
        },
        where: { id: this.rowId },
      });
      this.finalized = true;
    } catch (err) {
      this.finalized = true;
      await this.persistFailure('close', err);
    }
  }

  /**
   * Best-effort + alert: log, count, and leave a `transcript.persist_failed`
   * trace event on the activity so the failure is visible where the activity's
   * other events are. Never throws.
   */
  private async persistFailure(stage: 'create' | 'part' | 'close', err: unknown): Promise<void> {
    try {
      logWarn('agent transcript write failed', {
        error: err instanceof Error ? err.message : String(err),
        stage,
      });
      recordTranscriptPersistFailure(stage);
      // Lazy import: activityContext imports this module for noteAgentKey.
      const { persistActivityTrace } = await import('./activityContext.js');
      const tracer = new AgentTracer();
      tracer.addActivityEvent({
        error: err instanceof Error ? err.message : String(err),
        name: 'transcript.persist_failed',
        outputJson: { stage },
      });
      await persistActivityTrace(tracer, 'transcript-recorder');
    } catch {
      // The alert itself failed — the counter already counted.
    }
  }
}

function isCancellation(err: unknown): boolean {
  return err instanceof CancelledFailure || (err as Error | undefined)?.name === 'AbortError';
}

/**
 * One recorder per activity attempt. Register LAST in the worker's `activity`
 * interceptor array so it runs inside the node-tag ALS and the activity span
 * (`currentNodeTag()` must answer at first record, and the span must exist
 * for the failure trace event's trace/span ids).
 */
export function activityTranscriptInterceptor(): ActivityInterceptors {
  return {
    inbound: {
      async execute(input, next) {
        const recorder = new TranscriptRecorder();
        let outcome: ActivityOutcome = 'succeeded';
        try {
          return await storage.run(recorder, () => next(input));
        } catch (err) {
          outcome = isCancellation(err) ? 'cancelled' : 'failed';
          throw err;
        } finally {
          // Bounded: persistence is best-effort, so a hung artifact store must
          // not hold the activity past its own StartToClose timeout. The close
          // keeps running in the background.
          let wait: NodeJS.Timeout | undefined;
          let done = false;
          try {
            done = await Promise.race([
              recorder.close(outcome).then(() => true),
              new Promise<false>((resolve) => {
                wait = setTimeout(() => resolve(false), CLOSE_WAIT_BOUND_MS);
                wait.unref();
              }),
            ]);
          } finally {
            if (wait) {
              clearTimeout(wait);
            }
          }
          if (!done) {
            logWarn('agent transcript close exceeded its bound; it continues in the background', {
              boundMs: CLOSE_WAIT_BOUND_MS,
            });
            recordTranscriptPersistFailure('close');
          }
        }
      },
    },
  };
}

function capturedBody(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf8');
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString('utf8');
  }
  return undefined;
}

/** The stand-in a recorded embedding vector is replaced with. */
function omittedVector(vector: unknown): unknown {
  return Array.isArray(vector) ? { dimensions: vector.length, omitted: 'vector' } : vector;
}

/**
 * An embedding response body with every vector replaced by
 * `{ omitted: 'vector', dimensions }`: OpenAI and OpenAI-compatible
 * `data[].embedding`, Google `embedding.values` (`:embedContent`) and
 * `embeddings[].values` (`:batchEmbedContents`). Everything else is kept.
 */
export function omitEmbeddingVectors(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const withValues = (item: unknown): unknown =>
    typeof item === 'object' && item !== null && 'values' in item
      ? { ...item, values: omittedVector((item as { values: unknown }).values) }
      : item;
  if (Array.isArray(out.data)) {
    out.data = out.data.map((item: unknown) =>
      typeof item === 'object' && item !== null && 'embedding' in item
        ? { ...item, embedding: omittedVector((item as { embedding: unknown }).embedding) }
        : item
    );
  }
  if (out.embedding !== undefined) {
    out.embedding = withValues(out.embedding);
  }
  if (Array.isArray(out.embeddings)) {
    out.embeddings = out.embeddings.map(withValues);
  }
  return out;
}

/**
 * Wrap a model-call fetch so every exchange is recorded on the active
 * transcript. The caller's response is returned untouched and un-delayed; the
 * recorder reads `response.clone()` to completion in the background and
 * records when it ends — or with an `error` when the body aborts. A call whose
 * fetch itself throws is recorded the same way. Pass-through when no activity
 * is recording.
 *
 * `purpose: 'embedding'` marks the records as embedding calls (not counted as
 * model calls) and records the response with its vectors omitted
 * ({@link omitEmbeddingVectors}); the request — the embedded inputs — is kept
 * in full.
 */
export function recordingFetch(
  inner: typeof fetch,
  opts: { maxRecordBytes?: number; purpose?: 'embedding' } = {}
): typeof fetch {
  const cap = opts.maxRecordBytes ?? MAX_RECORD_BYTES;
  const purpose = opts.purpose;
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const recorder = currentTranscriptRecorder();
    if (!recorder) {
      return inner(input, init);
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { host, path } = sanitizedPath(url);
    const method =
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    // The body lives on init or, for a Request input, on the request itself.
    let requestBody: string | undefined = capturedBody(init?.body);
    if (requestBody === undefined && typeof input === 'object' && 'clone' in input) {
      try {
        requestBody = await (input as Request).clone().text();
      } catch {
        requestBody = undefined;
      }
    }
    const request = requestBody !== undefined ? tryParseJson(requestBody) : undefined;
    const start = performance.now();
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (err) {
      recorder.addHttpCall({
        durationMs: Math.round(performance.now() - start),
        error: err instanceof Error ? err.message : String(err),
        host,
        method,
        path,
        ...(purpose ? { purpose } : {}),
        request,
      });
      throw err;
    }
    const contentType = response.headers.get('content-type');
    const status = response.status;
    // Tracked so close() can wait for this read before it writes the last part —
    // otherwise the attempt's final model call races the activity's return.
    recorder.trackCapture(
      (async () => {
        let bodyText = '';
        let error: string | undefined;
        let capped = false;
        try {
          const clone = response.clone();
          const reader = clone.body?.getReader();
          if (!reader) {
            bodyText = await clone.text();
          } else {
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              // Read but do not accumulate past the cap — a runaway stream
              // cannot pin the worker's memory.
              if (Buffer.byteLength(bodyText) < cap) {
                bodyText += decoder.decode(value, { stream: true });
              } else {
                capped = true;
                await reader.cancel();
                break;
              }
            }
            if (!capped) {
              bodyText += decoder.decode();
            }
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        recorder.addHttpCall({
          durationMs: Math.round(performance.now() - start),
          error,
          host,
          method,
          path,
          ...(purpose ? { purpose } : {}),
          request,
          response: {
            // An embedding response is stripped of its vectors whatever its
            // content-type says, whenever it parses as JSON.
            body:
              purpose === 'embedding'
                ? omitEmbeddingVectors(bodyText ? tryParseJson(bodyText) : bodyText)
                : bodyText && (contentType ?? '').includes('json')
                  ? tryParseJson(bodyText)
                  : bodyText,
            contentType,
          },
          responseTruncated: capped || undefined,
          status,
        });
      })()
    );
    return response;
  };
  return wrapped as typeof fetch;
}
