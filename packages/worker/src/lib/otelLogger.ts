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

function attribute(value: unknown): AnyValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value as AnyValue;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
 * (workflow id, activity type, attempt, …) becomes the record's attributes.
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
      attributes: Object.fromEntries(Object.entries(meta ?? {}).map(([k, v]) => [k, attribute(v)])),
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
