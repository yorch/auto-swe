import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    authFromEmail: 'reports@example.test',
    resendApiKey: null as string | null,
    smtpHost: 'mail.example.test' as string | null,
    smtpPass: null as string | null,
    smtpPort: 587 as number | null,
    smtpUser: null as string | null,
  },
  createTransport: vi.fn(),
  sendMail: vi.fn(async () => undefined),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveAuthEmailConfig: () => mocks.config,
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: mocks.createTransport },
}));

import { sendReportDigestEmail } from './reportDigestEmail.js';

const email = {
  html: '<table><tr><td>Digest</td></tr></table>',
  listUnsubscribeUrl: 'https://example.test/unsubscribe?token=recipient-token',
  subject: 'Weekly report',
  text: 'Digest text',
  to: 'digest@example.test',
};

beforeEach(() => {
  Object.assign(mocks.config, {
    authFromEmail: 'reports@example.test',
    resendApiKey: null,
    smtpHost: 'mail.example.test',
    smtpPass: null,
    smtpPort: 587,
    smtpUser: null,
  });
  mocks.sendMail.mockClear();
  mocks.createTransport.mockReset();
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendReportDigestEmail', () => {
  it('adds RFC 8058 unsubscribe headers to SMTP messages', async () => {
    await sendReportDigestEmail(email);

    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          'List-Unsubscribe': `<${email.listUnsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        html: email.html,
        text: email.text,
      })
    );
  });

  it('adds RFC 8058 unsubscribe headers to Resend messages', async () => {
    mocks.config.smtpHost = null;
    mocks.config.smtpPort = null;
    mocks.config.resendApiKey = 'resend-key';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await sendReportDigestEmail(email);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        body: expect.stringContaining(`"List-Unsubscribe":"<${email.listUnsubscribeUrl}>"`),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        body: expect.stringContaining('"List-Unsubscribe-Post":"List-Unsubscribe=One-Click"'),
      })
    );
  });
});
