import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPagerDutyIncident,
  PAGERDUTY_ALERT_BODY_MAX_CHARS,
  PAGERDUTY_NOTE_CONTENT_MAX_CHARS,
  PAGERDUTY_NOTE_MAX_CHARS,
  postPagerDutyNote,
} from './pagerduty.js';

const connection = { apiToken: 'pd-token', config: { fromEmail: 'oncall@example.com' } };

function respond(body: unknown, status = 200) {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function headersOf(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

describe('pagerduty connector', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads an incident with its alerts, log entries and notes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/alerts')) {
        return respond({
          alerts: [
            {
              body: { details: 'x'.repeat(PAGERDUTY_ALERT_BODY_MAX_CHARS + 10) },
              created_at: '2026-01-01T00:00:00Z',
              id: 'A1',
              severity: 'critical',
              summary: 'High error rate',
            },
          ],
        });
      }
      if (url.endsWith('/notes')) {
        return respond({
          notes: [
            {
              content: 'n'.repeat(PAGERDUTY_NOTE_CONTENT_MAX_CHARS + 10),
              created_at: '2026-01-01T00:05:00Z',
              id: 'N1',
              user: { id: 'PU1', summary: 'Ada Responder' },
            },
          ],
        });
      }
      if (url.includes('/log_entries')) {
        return respond({ log_entries: [{ summary: 'Triggered', type: 'trigger_log_entry' }] });
      }
      return respond({
        incident: {
          html_url: 'https://acme.pagerduty.com/incidents/Q1',
          number: 7,
          service: { id: 'PSVC1', summary: 'checkout' },
          status: 'triggered',
          title: 'Checkout is down',
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchPagerDutyIncident(connection, 'Q1ABC');
    expect(result.incident).toMatchObject({
      id: 'Q1ABC',
      number: 7,
      service: { id: 'PSVC1', name: 'checkout' },
      title: 'Checkout is down',
    });
    expect(result.alerts[0]?.summary).toBe('High error rate');
    expect(String(result.alerts[0]?.body)).toContain('(truncated)');
    expect(result.logEntries).toEqual([
      { createdAt: null, summary: 'Triggered', type: 'trigger_log_entry' },
    ]);
    expect(result.notes).toEqual([
      {
        author: 'Ada Responder',
        content: `${'n'.repeat(PAGERDUTY_NOTE_CONTENT_MAX_CHARS)}… (truncated)`,
        createdAt: '2026-01-01T00:05:00Z',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
      'https://api.pagerduty.com/incidents/Q1ABC/notes'
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.pagerduty.com/incidents/Q1ABC');
    expect(init.redirect).toBe('error');
    expect(headersOf(fetchMock.mock.calls[0] as unknown[])).toMatchObject({
      Accept: 'application/vnd.pagerduty+json;version=2',
      Authorization: 'Token token=pd-token',
    });
  });

  it('posts a note as the configured user, capped in length', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ note: { id: 'N1' } }, 201));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await postPagerDutyNote(
      connection,
      'Q1ABC',
      `  ${'d'.repeat(PAGERDUTY_NOTE_MAX_CHARS + 5)}  `
    );
    expect(result).toEqual({ incidentId: 'Q1ABC', noteId: 'N1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.pagerduty.com/incidents/Q1ABC/notes');
    expect(init.method).toBe('POST');
    expect(headersOf(fetchMock.mock.calls[0])).toMatchObject({ From: 'oncall@example.com' });
    const sent = JSON.parse(String(init.body)) as { note: { content: string } };
    expect(sent.note.content).toHaveLength(PAGERDUTY_NOTE_MAX_CHARS);
  });

  it('refuses a note without a from email or content, and a malformed incident id', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      postPagerDutyNote({ apiToken: 'x', config: {} }, 'Q1ABC', 'hello')
    ).rejects.toThrow('fromEmail');
    await expect(postPagerDutyNote(connection, 'Q1ABC', '   ')).rejects.toThrow('empty');
    await expect(fetchPagerDutyIncident(connection, '../users')).rejects.toThrow(
      'uppercase letters or digits'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies API failures', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(respond({}, 401)) as unknown as typeof fetch;
    await expect(postPagerDutyNote(connection, 'Q1', 'n')).rejects.toMatchObject({
      nonRetryable: true,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(respond({}, 429)) as unknown as typeof fetch;
    await expect(postPagerDutyNote(connection, 'Q1', 'n')).rejects.toMatchObject({
      nonRetryable: false,
      type: 'PagerDutyTransientError',
    });
  });
});
