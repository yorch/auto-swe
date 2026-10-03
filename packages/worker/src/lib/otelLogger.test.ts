import { trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { DefaultLogger } from '@temporalio/worker';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OtelForwardingLogger } from './otelLogger.js';

const records = new InMemoryLogRecordExporter();
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: records })],
});
logs.setGlobalLoggerProvider(loggerProvider);
// For the context manager: a record takes its trace from the active span.
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
});
tracerProvider.register();

const lines: Array<{ level: string; message: string }> = [];
const inner = new DefaultLogger('INFO', (entry) => {
  lines.push({ level: entry.level, message: entry.message });
});

beforeEach(() => {
  records.reset();
  lines.length = 0;
});

afterAll(async () => {
  logs.disable();
  await loggerProvider.shutdown();
  await tracerProvider.shutdown();
});

describe('OtelForwardingLogger', () => {
  it('keeps the stderr line and exports a record carrying the active span and the metadata', () => {
    const logger = new OtelForwardingLogger(inner);
    const span = trace.getTracer('test').startActiveSpan('activity.runLint', (s) => {
      logger.warn('lint failed', { attempt: 2, details: { files: 3 }, workflowId: 'wf-1' });
      s.end();
      return s;
    });

    expect(lines).toEqual([{ level: 'WARN', message: 'lint failed' }]);
    const [record] = records.getFinishedLogRecords();
    expect(record?.body).toBe('lint failed');
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    expect(record?.severityText).toBe('WARN');
    expect(record?.attributes).toEqual({
      attempt: 2,
      details: '{"files":3}',
      workflowId: 'wf-1',
    });
    expect(record?.spanContext?.traceId).toBe(span.spanContext().traceId);
    expect(record?.spanContext?.spanId).toBe(span.spanContext().spanId);
  });

  it("exports an Error's type, message and stack instead of {}, at any depth", () => {
    const logger = new OtelForwardingLogger(inner);
    const cause = new Error('socket hang up');
    const error = new TypeError('fetch failed', { cause });
    // Temporal's shape for a failed activity.
    logger.warn('Activity failed', { activityType: 'runLint', error, nested: { inner: cause } });

    const attrs = records.getFinishedLogRecords()[0]?.attributes ?? {};
    expect(attrs['exception.type']).toBe('TypeError');
    expect(attrs['exception.message']).toBe('fetch failed');
    expect(attrs['exception.stacktrace']).toBe(error.stack);
    const serialized = JSON.parse(attrs.error as string);
    expect(serialized).toMatchObject({
      cause: { message: 'socket hang up', name: 'Error' },
      message: 'fetch failed',
      name: 'TypeError',
    });
    expect(serialized.stack).toBe(error.stack);
    expect(JSON.parse(attrs.nested as string)).toMatchObject({
      inner: { message: 'socket hang up' },
    });
  });

  it("does not export Temporal's opaque task token", () => {
    const logger = new OtelForwardingLogger(inner);
    logger.info('Activity started', { activityType: 'runLint', taskToken: 'CiQ2YjE0…' });

    expect(records.getFinishedLogRecords()[0]?.attributes).toEqual({ activityType: 'runLint' });
  });

  it("exports nothing below the inner logger's level", () => {
    const write = vi.fn();
    new OtelForwardingLogger(new DefaultLogger('INFO', write)).debug('noise');

    expect(write).not.toHaveBeenCalled();
    expect(records.getFinishedLogRecords()).toEqual([]);
  });
});
