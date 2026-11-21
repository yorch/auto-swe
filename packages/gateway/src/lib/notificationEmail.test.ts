import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  configured: false,
  send: vi.fn(async () => ({ sent: true }) as { sent: true } | { sent: false; failures: string[] }),
}));

vi.mock('./authEmail.js', () => ({
  emailTransportConfigured: () => transport.configured,
  sendViaConfiguredTransport: transport.send,
}));

import {
  escapeHtml,
  resetNotificationEmailWarning,
  sendNotificationEmails,
} from './notificationEmail.js';

const msg = { html: '<p>SECRET-BODY</p>', subject: 's', text: 'SECRET-BODY', to: 'a@example.com' };

describe('sendNotificationEmails', () => {
  const originalEnv = process.env.NODE_ENV;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transport.configured = false;
    resetNotificationEmailWarning();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('in development with no transport logs only the kind and count, never the body', async () => {
    process.env.NODE_ENV = 'development';
    await sendNotificationEmails('k', [msg, msg]);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('[k]');
    expect(out).toContain('2 recipient');
    expect(out).not.toContain('SECRET-BODY');
    expect(out).not.toContain('a@example.com');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('in production with no transport warns once per process, not per message', async () => {
    process.env.NODE_ENV = 'production';
    await sendNotificationEmails('k', [msg, msg]);
    await sendNotificationEmails('k', [msg]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('sends each message through the shared transport and counts accepted ones', async () => {
    transport.configured = true;
    const sent = await sendNotificationEmails('k', [msg, msg]);
    expect(sent).toBe(2);
    expect(transport.send).toHaveBeenCalledWith(msg, { continueOnError: true });
  });

  it('swallows a thrown transport error and keeps going without logging the body', async () => {
    transport.configured = true;
    transport.send.mockRejectedValueOnce(new Error('smtp down'));
    const sent = await sendNotificationEmails('k', [msg, msg]);
    expect(sent).toBe(1);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('SECRET-BODY');
  });

  it('logs a reported failure without the body', async () => {
    transport.configured = true;
    transport.send.mockResolvedValueOnce({
      failures: ['Resend: Resend returned 503'],
      sent: false,
    });
    expect(await sendNotificationEmails('k', [msg])).toBe(0);
    expect(warn.mock.calls.flat().join('\n')).toContain('503');
  });
});

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<script>"a" & 'b'</script>`)).toBe(
      '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;'
    );
  });
});
