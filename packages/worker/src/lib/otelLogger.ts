import { type AnyValue, logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { Logger, LogLevel, LogMetadata } from '@temporalio/worker';

const LEVELS: readonly LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  DEBUG: SeverityNumber.DEBUG,
  ERROR: SeverityNumber.ERROR,
  INFO: SeverityNumber.INFO,
  TRACE: SeverityNumber.TRACE,
  WARN: SeverityNumber.WARN,
};

/**
 * Metadata keys left off the exported record. Temporal's activity metadata
 * carries `taskToken`: an opaque per-attempt token, different on every attempt,
 * that nobody searches by and that only bloats each Loki line.
 */
const DROPPED_KEYS: ReadonlySet<string> = new Set(['taskToken']);

/**
 * `JSON.stringify` replacer that keeps what an `Error` says. Its `name`,
 * `message` and `stack` are non-enumerable, so a plain stringify writes `{}` —
 * and Temporal logs every activity failure as `{ error, ... }`. It applies at
 * any depth, so a nested error or a `cause` keeps its message too.
 */
function errorReplacer(_key: string, value: unknown): unknown {
  if (!(value instanceof Error)) {
    return value;
  }
  return {
    ...value,
    ...(value.cause === undefined ? {} : { cause: value.cause }),
    message: value.message,
    name: value.name,
    stack: value.stack,
  };
}

function attribute(value: unknown): AnyValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as AnyValue;
  }
  try {
    return JSON.stringify(value, errorReplacer);
  } catch {
    return String(value);
  }
}

/**
 * The record's attributes: Temporal's metadata minus {@link DROPPED_KEYS}, plus
 * the OpenTelemetry `exception.*` attributes for the first top-level `Error`,
 * so Grafana shows a failure's type and message without parsing JSON.
 */
function attributes(meta: LogMetadata | undefined): Record<string, AnyValue> {
  const out: Record<string, AnyValue> = {};
  let exception: Error | undefined;
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (DROPPED_KEYS.has(key)) {
      continue;
    }
    out[key] = attribute(value);
    if (!exception && value instanceof Error) {
      exception = value;
    }
  }
  if (exception) {
    out['exception.type'] = exception.name;
    out['exception.message'] = exception.message;
    if (exception.stack) {
      out['exception.stacktrace'] = exception.stack;
    }
  }
  return out;
}

/**
 * The worker's Temporal Runtime logger: everything the SDK logs, and everything
 * activities log through `@temporalio/activity`'s `log` (`lib/activityLog.ts`),
 * goes to `inner` — stderr, as before — and is also emitted as an OpenTelemetry
 * log record, exported over OTLP to Loki.
 *
 * An activity logs synchronously inside its own async context, so the record
 * picks up the active span — the `activity.<type>` span — and carries its trace
 * and span id: Grafana links the line to the trace. Temporal's metadata
 * (workflow id, activity type, attempt, …) becomes the record's attributes; an
 * `Error` in it is exported with its message and stack, not as `{}`.
 */
export class OtelForwardingLogger implements Logger {
  private readonly otel = logs.getLogger('auto-swe-worker');
  private readonly threshold: number;

  constructor(private readonly inner: Logger & { level: LogLevel }) {
    this.threshold = LEVELS.indexOf(inner.level);
  }

  log(level: LogLevel, message: string, meta?: LogMetadata): void {
    this.inner.log(level, message, meta);
    if (LEVELS.indexOf(level) < this.threshold) {
      return;
    }
    this.otel.emit({
      attributes: attributes(meta),
      body: message,
      severityNumber: SEVERITY[level],
      severityText: level,
    });
  }

  trace(message: string, meta?: LogMetadata): void {
    this.log('TRACE', message, meta);
  }

  debug(message: string, meta?: LogMetadata): void {
    this.log('DEBUG', message, meta);
  }

  info(message: string, meta?: LogMetadata): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: LogMetadata): void {
    this.log('WARN', message, meta);
  }

  error(message: string, meta?: LogMetadata): void {
    this.log('ERROR', message, meta);
  }
}
