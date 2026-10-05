import { describe, expect, it } from 'vitest';
import {
  derivedTraceId,
  parseTraceparent,
  workflowSpanContext,
  workflowSpanId,
} from './workflowSpan.js';

const HEX16 = /^[0-9a-f]{16}$/;
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';

describe('workflowSpanId', () => {
  it('is deterministic, 16 hex digits and non-zero', () => {
    const id = workflowSpanId('wf-1', 'run-1');
    expect(id).toBe(workflowSpanId('wf-1', 'run-1'));
    expect(id).toMatch(HEX16);
    expect(id).not.toBe('0000000000000000');
  });

  it('differs per run and per workflow', () => {
    const ids = new Set([
      workflowSpanId('wf-1', 'run-1'),
      workflowSpanId('wf-1', 'run-2'),
      workflowSpanId('wf-2', 'run-1'),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('parseTraceparent', () => {
  it('splits a valid header', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({
      flags: '01',
      spanId: PARENT,
      traceId: TRACE,
    });
  });

  it('reads the first four fields of a higher version, and writes version 00', () => {
    expect(parseTraceparent(`cc-${TRACE}-${PARENT}-01-extra`)).toEqual({
      flags: '01',
      spanId: PARENT,
      traceId: TRACE,
    });
    const ctx = workflowSpanContext(
      { traceparent: `cc-${TRACE}-${PARENT}-01-extra` },
      'wf-1',
      'run-1',
      'run-0'
    );
    expect(ctx.parentSpanId).toBe(PARENT);
    expect(ctx.carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it.each([
    `00-${TRACE}-${PARENT}-01-extra`,
    `ff-${TRACE}-${PARENT}-01`,
    undefined,
    'garbage',
    `00-${'0'.repeat(32)}-${PARENT}-01`,
    `00-${TRACE}-${'0'.repeat(16)}-01`,
  ])('rejects %s', (value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });
});

describe('workflowSpanContext', () => {
  it("re-parents the starter's carrier on the workflow span, keeping trace, flags and tracestate", () => {
    const ctx = workflowSpanContext(
      { traceparent: `00-${TRACE}-${PARENT}-00`, tracestate: 'a=b' },
      'wf-1',
      'run-1',
      'run-0'
    );
    const spanId = workflowSpanId('wf-1', 'run-1');
    expect(ctx.carrier).toEqual({ traceparent: `00-${TRACE}-${spanId}-00`, tracestate: 'a=b' });
    expect(ctx).toMatchObject({ flags: '00', parentSpanId: PARENT, spanId, traceId: TRACE });
  });

  it('makes the workflow span the root of a derived, sampled trace when there is no starter', () => {
    const ctx = workflowSpanContext(undefined, 'wf-1', 'run-2', 'run-1');
    expect(ctx.traceId).toBe(derivedTraceId('wf-1', 'run-1'));
    expect(ctx.parentSpanId).toBeUndefined();
    expect(ctx.flags).toBe('01');
    expect(ctx.carrier).toEqual({
      traceparent: `00-${ctx.traceId}-${workflowSpanId('wf-1', 'run-2')}-01`,
    });
  });

  it('carries every other key of the starter carrier through unchanged', () => {
    const ctx = workflowSpanContext(
      { baggage: 'user=1', traceparent: `00-${TRACE}-${PARENT}-01` },
      'wf-1',
      'run-1',
      'run-0'
    );
    expect(ctx.carrier.baggage).toBe('user=1');
    expect(ctx.carrier.traceparent).toContain(workflowSpanId('wf-1', 'run-1'));
  });

  it('treats a malformed carrier as none', () => {
    const ctx = workflowSpanContext({ traceparent: 'nope' }, 'wf-1', 'run-1', 'run-1');
    expect(ctx.traceId).toBe(derivedTraceId('wf-1', 'run-1'));
    expect(ctx.parentSpanId).toBeUndefined();
  });
});
