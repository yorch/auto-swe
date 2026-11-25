import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  configured: false,
  send: vi.fn(
    async (_message?: unknown, _options?: { signal?: AbortSignal }) =>
      ({ sent: true }) as { sent: true } | { sent: false; failures: string[] }
  ),
}));

vi.mock('./authEmail.js', () => ({
  emailTransportConfigured: () => transport.configured,
  sendViaConfiguredTransport: transport.send,
}));

import { escapeHtml, sendNotificationEmailsEach } from './notificationEmail.js';

const msg = { html: '<p>SECRET-BODY</p>', subject: 's', text: 'SECRET-BODY', to: 'a@example.com' };

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe(
      '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;'
    );
  });
});

describe('sendNotificationEmailsEach', () => {
  beforeEach(() => {
    transport.configured = true;
    transport.send.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks for the bounded transport (finite SMTP timeouts) on every send', async () => {
    transport.send.mockImplementation(async () => ({ sent: true }));
    const out = await sendNotificationEmailsEach('k', [msg]);
    expect(out).toEqual({ configured: true, delivered: ['a@example.com'], failed: 0, unknown: 0 });
    expect(transport.send).toHaveBeenCalledWith(msg, {
      bounded: true,
      continueOnError: true,
      signal: expect.any(AbortSignal),
    });
  });

  it('gives up on a message that outlasts its deadline and counts it as not accepted', async () => {
    transport.send.mockImplementation(() => new Promise(() => undefined));
    // The deadline is a timer, so the test moves a fake clock past it instead of waiting.
    vi.useFakeTimers();
    const pending = sendNotificationEmailsEach('k', [msg, msg], 20);
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out).toEqual({ configured: true, delivered: [], failed: 2, unknown: 2 });
  });

  it('aborts the send at the deadline, so its socket is destroyed and its fallback never starts', async () => {
    const signals: AbortSignal[] = [];
    transport.send.mockImplementation((_message, options) => {
      signals.push(options?.signal as AbortSignal);
      return new Promise(() => undefined);
    });
    vi.useFakeTimers();
    const pending = sendNotificationEmailsEach('k', [msg], 50);
    await vi.advanceTimersByTimeAsync(49);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(await pending).toMatchObject({ delivered: [], failed: 1, unknown: 1 });
  });

  it('counts a send that fails BECAUSE the deadline tore it down as unknown, not refused', async () => {
    transport.send.mockImplementation(
      (_message, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () =>
            resolve({ failures: ['SMTP: Connection closed'], sent: false })
          );
        })
    );
    vi.useFakeTimers();
    const pending = sendNotificationEmailsEach('k', [msg], 50);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ failed: 1, unknown: 1 });
  });

  it('counts a definite refusal as failed but not unknown', async () => {
    transport.send.mockResolvedValue({ failures: ['SMTP: 550'], sent: false });
    expect(await sendNotificationEmailsEach('k', [msg])).toMatchObject({ failed: 1, unknown: 0 });
  });

  it('does not treat a send that finished just as the deadline fires as lost', async () => {
    transport.send.mockResolvedValue({ sent: true });
    expect(await sendNotificationEmailsEach('k', [msg], 50)).toMatchObject({
      delivered: ['a@example.com'],
      unknown: 0,
    });
  });
});
