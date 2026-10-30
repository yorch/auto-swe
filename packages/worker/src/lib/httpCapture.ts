import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { SSRF_BLOCKED_CODE, setGuardedFetchObserver } from '@auto-swe/shared/lib/guardedDispatcher';
import { metrics, trace } from '@opentelemetry/api';
import type { ActivityInterceptors } from '@temporalio/worker';
import {
  currentActivityType,
  currentAttempt,
  currentTemporalRunId,
  currentWorkflowId,
  currentWorkflowRunId,
} from './activityContext.js';
import { logWarn } from './activityLog.js';
import { currentNodeTag, nodeTagColumns } from './activityNodeTag.js';
import { redactJsonValues, redactString } from './agentTracer.js';
import { maskCredentialShapes } from './redactToken.js';
import { currentSpendOwner } from './spendOwner.js';
import { currentTranscriptRecorder, sanitizedPath } from './transcriptRecorder.js';

type Purpose =
  | 'model'
  | 'embedding'
  | 'scm'
  | 'connector'
  | 'mcp'
  | 'callback'
  | 'egress'
  | 'other';
type Row = NonNullable<Parameters<typeof prisma.workflowHttpCall.createMany>[0]>['data'];
type CallRow = Exclude<Row, Row[]>;
const storage = new AsyncLocalStorage<HttpCapture>();
const tags = new AsyncLocalStorage<Purpose>();
const nested = new AsyncLocalStorage<boolean>();
const failures = metrics.getMeter('auto-swe-worker').createCounter('http_capture.persist_failures');

export function withHttpPurpose<T>(purpose: Purpose, body: () => T): T {
  return tags.run(purpose, body);
}

export function runWithHttpCapture<T>(capture: HttpCapture, body: () => T): T {
  return storage.run(capture, body);
}

function failure(err: unknown): void {
  failures.add(1);
  logWarn('HTTP capture persistence failed', { error: maskCredentialShapes(String(err)) });
}

interface CapturedBody {
  body?: string;
  bytes?: number;
  truncated: boolean;
}

async function bodyCapture(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
  json = false
): Promise<CapturedBody> {
  if (!stream || !max) {
    return { truncated: false };
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 2000);
    timer.unref();
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (!chunk) {
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
      const { value, done } = chunk;
      if (done) {
        break;
      }
      bytes += value.length;
      chunks.push(Buffer.from(value));
      if (bytes > max) {
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
    let body = Buffer.concat(chunks).toString('utf8');
    try {
      body = JSON.stringify(redactJsonValues(JSON.parse(body)));
    } catch {
      if (json) {
        return { bytes, truncated: true };
      }
      body = maskCredentialShapes(redactString(body));
    }
    const redacted = Buffer.from(body);
    return {
      body: new TextDecoder().decode(redacted.subarray(0, max), { stream: true }),
      bytes: truncated ? undefined : bytes,
      truncated: truncated || redacted.length > max,
    };
  } catch {
    return { truncated: true };
  } finally {
    clearTimeout(timer);
  }
}

function textBody(contentType: string | null): boolean {
  return !!contentType && /text\/|json|xml|javascript|x-www-form-urlencoded/.test(contentType);
}

export class HttpCapture {
  private rows: CallRow[] = [];
  private pending = new Set<Promise<void>>();
  private chain = Promise.resolve();
  private closed = false;
  constructor(readonly maxBytes: number) {}

  track(work: Promise<CallRow>): void {
    const pending = work
      .then((row) => {
        if (this.closed) {
          return;
        }
        this.rows.push(row);
        if (this.rows.length >= 100) {
          this.scheduleFlush();
        }
      })
      .catch(failure)
      .finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  private scheduleFlush(): void {
    const batch = this.rows.splice(0, 100);
    if (!batch.length) {
      return;
    }
    this.chain = this.chain
      .then(async () => {
        await prisma.workflowHttpCall.createMany({ data: batch, skipDuplicates: true });
      })
      .catch(failure);
  }

  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
          timer.unref();
        }),
      ]);
      this.closed = true;
      while (this.rows.length) {
        this.scheduleFlush();
      }
      await this.chain;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function capturingFetch(inner: typeof fetch, purpose?: Purpose): typeof fetch {
  return (async (input, init) => {
    const capture = storage.getStore();
    if (!capture || nested.getStore()) {
      return inner(input, init);
    }
    const selected = purpose ?? tags.getStore() ?? 'other';
    const model = selected === 'model' || selected === 'embedding';
    const recorder = currentTranscriptRecorder();
    const startedAt = new Date();
    const start = performance.now();
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    const span = trace.getActiveSpan()?.spanContext();
    const base = {
      ...nodeTagColumns(currentNodeTag()),
      activityType: currentActivityType(),
      attempt: currentAttempt(),
      host: url.hostname,
      id: randomUUID(),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      otelSpanId: span?.spanId,
      otelTraceId: span?.traceId,
      path: sanitizedPath(url.href).path,
      port: url.port ? Number(url.port) : undefined,
      purpose: selected,
      scheme: url.protocol.slice(0, -1),
      source: 'worker',
      startedAt,
      temporalRunId: currentTemporalRunId(),
      workflowId: currentWorkflowId(),
    };
    const owner = currentSpendOwner();
    const run = currentWorkflowRunId();
    let request: Request | undefined;
    if (!model && capture.maxBytes && !(init?.body instanceof ReadableStream)) {
      try {
        request = new Request(input instanceof Request ? input.clone() : input, init);
      } catch {
        /* Non-replayable bodies are metadata-only. */
      }
    }
    const requestCapture: Promise<CapturedBody> =
      request && textBody(request.headers.get('content-type'))
        ? bodyCapture(
            request.body,
            capture.maxBytes,
            (request.headers.get('content-type') ?? '').includes('json')
          )
        : Promise.resolve({ truncated: false });
    const finish = async (response?: Response, error?: unknown): Promise<CallRow> => {
      const durationMs = Math.round(performance.now() - start);
      const responseCapture: Promise<CapturedBody> =
        response && !model && textBody(response.headers.get('content-type'))
          ? bodyCapture(
              response.clone().body,
              capture.maxBytes,
              (response.headers.get('content-type') ?? '').includes('json')
            )
          : Promise.resolve({ truncated: false });
      const [req, res, ownerIds, runId] = await Promise.all([
        requestCapture,
        responseCapture,
        owner,
        run,
      ]);
      return {
        ...base,
        ...ownerIds,
        blocked: (error as { code?: string } | undefined)?.code === SSRF_BLOCKED_CODE,
        blockReason:
          (error as { code?: string } | undefined)?.code === SSRF_BLOCKED_CODE
            ? maskCredentialShapes(String(error))
            : undefined,
        bodiesTruncated: req.truncated || res.truncated,
        durationMs,
        error: error ? maskCredentialShapes(String(error)) : undefined,
        requestBody: req.body,
        requestBytes: req.bytes,
        responseBody: res.body,
        responseBytes: res.bytes,
        runId,
        status: response?.status,
        transcriptId: model ? await recorder?.transcriptId() : undefined,
      };
    };
    try {
      const response = await nested.run(true, () => inner(input, init));
      capture.track(finish(response));
      return response;
    } catch (err) {
      capture.track(finish(undefined, err));
      throw err;
    }
  }) as typeof fetch;
}

export function installHttpCapture(): void {
  globalThis.fetch = capturingFetch(globalThis.fetch);
  setGuardedFetchObserver((inner) => capturingFetch(inner));
}

export function activityHttpCaptureInterceptor(): ActivityInterceptors {
  return {
    inbound: {
      async execute(input, next) {
        let enabled: boolean;
        let max: number;
        try {
          [enabled, max] = await Promise.all([
            resolveSetting('workflow.httpCaptureEnabled', {}),
            resolveSetting('workflow.httpCaptureBodyMaxBytes', {}),
          ]);
        } catch (err) {
          failure(err);
          return next(input);
        }
        if (!enabled) {
          return next(input);
        }
        const capture = new HttpCapture(max);
        try {
          return await storage.run(capture, () => next(input));
        } finally {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              capture.close(),
              new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                  failure('close timeout');
                  resolve();
                }, 10000);
                timer.unref();
              }),
            ]);
          } catch (err) {
            failure(err);
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
          }
        }
      },
    },
  };
}
