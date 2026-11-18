/**
 * An incremental parser for a `text/event-stream` body, following the WHATWG rules: lines end in
 * LF, CR or CRLF; `:` starts a comment; `data` lines join with a newline; an `id` persists until
 * another replaces it; a blank line dispatches. Fed decoded text in chunks of any size.
 *
 * Bounded: a line longer than `SSE_MAX_LINE_CHARS`, or an event whose `data` lines add up to more
 * than `SSE_MAX_EVENT_CHARS`, throws `SseLimitError`. A server that never ends a line would
 * otherwise grow the buffer without bound. The web dashboard and the CLI share this one parser, and
 * both treat that error as a failed connection (backoff or fallback to polling).
 */

/** The longest line (or unterminated pending line) the parser holds. */
export const SSE_MAX_LINE_CHARS = 256 * 1024;
/** The most `data` an event may accumulate before its blank line. */
export const SSE_MAX_EVENT_CHARS = 1024 * 1024;

export class SseLimitError extends Error {
  constructor(what: 'line' | 'event') {
    super(`The event stream sent an oversize ${what}`);
    this.name = 'SseLimitError';
  }
}

export interface SseEvent {
  /** The event name; `message` when the stream names none. */
  event: string;
  data: string;
  /** The last `id:` seen on the stream so far (empty before any). */
  id: string;
}

export interface SseChunkResult {
  events: SseEvent[];
  /** A `retry:` field (milliseconds) read in this chunk, if any. */
  retry?: number;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private dataChars = 0;
  private id = '';
  private started = false;
  private lastWasCr = false;

  /** The last event id the stream set; what a reconnect sends as `Last-Event-ID`. */
  get lastEventId(): string {
    return this.id;
  }

  push(text: string): SseChunkResult {
    let chunk = text;
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.startsWith('﻿')) {
        chunk = chunk.slice(1);
      }
    }
    // A CRLF split across chunks must not read as two line ends.
    if (this.lastWasCr && chunk.startsWith('\n')) {
      chunk = chunk.slice(1);
    }
    if (chunk.length > 0) {
      this.lastWasCr = chunk.endsWith('\r');
    }
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let retry: number | undefined;
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) {
        break;
      }
      // A lone CR at the very end may be the first half of a CRLF: wait for the next chunk.
      if (m[0] === '\r' && m.index + 1 === this.buffer.length) {
        const line = this.buffer.slice(0, m.index);
        this.buffer = '';
        const r = this.line(line, events);
        retry = r ?? retry;
        break;
      }
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const r = this.line(line, events);
      retry = r ?? retry;
    }
    if (this.buffer.length > SSE_MAX_LINE_CHARS) {
      throw new SseLimitError('line');
    }
    return retry === undefined ? { events } : { events, retry };
  }

  private line(line: string, out: SseEvent[]): number | undefined {
    if (line.length > SSE_MAX_LINE_CHARS) {
      throw new SseLimitError('line');
    }
    if (line === '') {
      if (this.data.length > 0) {
        out.push({ data: this.data.join('\n'), event: this.event || 'message', id: this.id });
      }
      this.data = [];
      this.dataChars = 0;
      this.event = '';
      return undefined;
    }
    if (line.startsWith(':')) {
      return undefined;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.event = value;
        return undefined;
      case 'data':
        this.dataChars += value.length + 1;
        if (this.dataChars > SSE_MAX_EVENT_CHARS) {
          throw new SseLimitError('event');
        }
        this.data.push(value);
        return undefined;
      case 'id':
        if (!value.includes('\0')) {
          this.id = value;
        }
        return undefined;
      case 'retry':
        return /^\d+$/.test(value) ? Number(value) : undefined;
      default:
        return undefined;
    }
  }
}
