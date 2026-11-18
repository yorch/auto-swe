import { describe, expect, it } from 'vitest';
import { SSE_MAX_EVENT_CHARS, SSE_MAX_LINE_CHARS, SseLimitError, SseParser } from './sse.js';

describe('SseParser', () => {
  it('parses named events with ids and ignores comments', () => {
    const p = new SseParser();
    const r = p.push('retry: 3000\n\n: ping\n\nid: c1\nevent: message\ndata: {"a":1}\n\n');
    expect(r.retry).toBe(3000);
    expect(r.events).toEqual([{ data: '{"a":1}', event: 'message', id: 'c1' }]);
    expect(p.lastEventId).toBe('c1');
  });

  it('survives chunk boundaries anywhere, including inside CRLF', () => {
    const body =
      'id: x\r\nevent: child\r\ndata: one\r\ndata: two\r\n\r\nevent: status\ndata: s\n\n';
    for (let cut = 1; cut < body.length; cut += 1) {
      const p = new SseParser();
      const events = [...p.push(body.slice(0, cut)).events, ...p.push(body.slice(cut)).events];
      expect(events).toEqual([
        { data: 'one\ntwo', event: 'child', id: 'x' },
        { data: 's', event: 'status', id: 'x' },
      ]);
    }
  });

  it('keeps the id across events and drops a malformed retry', () => {
    const p = new SseParser();
    p.push('id: a\ndata: 1\n\n');
    expect(p.push('retry: soon\ndata: 2\n\n').events).toEqual([
      { data: '2', event: 'message', id: 'a' },
    ]);
  });

  it('refuses a line that never ends once it passes the line cap', () => {
    const p = new SseParser();
    expect(() => {
      for (let i = 0; i < 10; i += 1) {
        p.push(`data: ${'x'.repeat(SSE_MAX_LINE_CHARS / 8)}`);
      }
    }).toThrow(SseLimitError);
  });

  it('refuses one oversize terminated line in a single chunk', () => {
    expect(() => new SseParser().push(`data: ${'x'.repeat(SSE_MAX_LINE_CHARS + 1)}\n\n`)).toThrow(
      SseLimitError
    );
  });

  it('refuses an event whose data lines add past the event cap, but not a large legal one', () => {
    const line = `data: ${'y'.repeat(100_000)}\n`;
    const p = new SseParser();
    const lines = Math.ceil(SSE_MAX_EVENT_CHARS / 100_000) + 1;
    expect(() => p.push(line.repeat(lines))).toThrow(SseLimitError);
    const ok = new SseParser().push(`${line.repeat(5)}\n`);
    expect(ok.events).toHaveLength(1);
    // The count restarts with each event.
    const q = new SseParser();
    for (let i = 0; i < 4; i += 1) {
      expect(q.push(`${line.repeat(5)}\n`).events).toHaveLength(1);
    }
  });
});
