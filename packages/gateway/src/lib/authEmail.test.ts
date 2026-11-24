import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emailConfig = vi.hoisted(() => ({
  value: {
    authFromEmail: null as string | null,
    resendApiKey: null as string | null,
    smtpHost: null as string | null,
    smtpPass: null as string | null,
    smtpPort: undefined as number | undefined,
    smtpUser: null as string | null,
  },
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveAuthEmailConfig: () => emailConfig.value,
}));

import {
  AuthEmailTransportError,
  authEmailAvailable,
  deliverAuthEmail,
  emailTransportConfigured,
  sendViaConfiguredTransport,
} from './authEmail.js';

const URL_WITH_TOKEN = 'https://api.example.com/api/auth/magic-link/verify?token=SECRET-TOKEN';

const message = {
  expiresIn: '10 min',
  html: '<p>link</p>',
  kind: 'magic-link' as const,
  subject: 'Sign in',
  text: `Sign in: ${URL_WITH_TOKEN}`,
  to: 'a@example.com',
  url: URL_WITH_TOKEN,
};

function allConsoleOutput(...spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
}

describe('deliverAuthEmail', () => {
  const originalEnv = process.env.NODE_ENV;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emailConfig.value = {
      authFromEmail: null,
      resendApiKey: null,
      smtpHost: null,
      smtpPass: null,
      smtpPort: undefined,
      smtpUser: null,
    };
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('prints the link for copy-paste in development when no transport is configured', async () => {
    process.env.NODE_ENV = 'development';
    await deliverAuthEmail(message);
    expect(allConsoleOutput(log)).toContain(URL_WITH_TOKEN);
  });

  it('in production with no transport, throws and never logs the URL', async () => {
    process.env.NODE_ENV = 'production';
    await expect(deliverAuthEmail(message)).rejects.toBeInstanceOf(AuthEmailTransportError);
    expect(allConsoleOutput(log, warn, error)).not.toContain('SECRET-TOKEN');
    expect(error).toHaveBeenCalled();
  });

  it('treats an unset NODE_ENV as production', async () => {
    delete process.env.NODE_ENV;
    await expect(deliverAuthEmail(message)).rejects.toBeInstanceOf(AuthEmailTransportError);
    expect(allConsoleOutput(log, warn, error)).not.toContain('SECRET-TOKEN');
  });

  it('in production, a failing Resend call throws instead of falling back to the log', async () => {
    process.env.NODE_ENV = 'production';
    emailConfig.value = { ...emailConfig.value, authFromEmail: 'auth@x', resendApiKey: 're_1' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 }))
    );
    await expect(deliverAuthEmail(message)).rejects.toThrow(/Resend returned 503/);
    expect(allConsoleOutput(log, warn, error)).not.toContain('SECRET-TOKEN');
  });

  it('sends through Resend when configured', async () => {
    process.env.NODE_ENV = 'production';
    emailConfig.value = { ...emailConfig.value, authFromEmail: 'auth@x', resendApiKey: 're_1' };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deliverAuthEmail(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('reports magic-link as unavailable in production with no transport', () => {
    process.env.NODE_ENV = 'production';
    expect(authEmailAvailable()).toBe(false);
    emailConfig.value = { ...emailConfig.value, authFromEmail: 'auth@x', resendApiKey: 're_1' };
    expect(authEmailAvailable()).toBe(true);
    process.env.NODE_ENV = 'development';
    emailConfig.value = { ...emailConfig.value, resendApiKey: null };
    expect(authEmailAvailable()).toBe(true);
  });
});

describe('shared transport', () => {
  const originalEnv = process.env.NODE_ENV;
  const body = { html: '<p>x</p>', subject: 's', text: 'x', to: 'a@example.com' };

  beforeEach(() => {
    emailConfig.value = {
      authFromEmail: 'auth@x',
      resendApiKey: 're_1',
      smtpHost: null,
      smtpPass: null,
      smtpPort: undefined,
      smtpUser: null,
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 }))
    );
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports whether a transport is configured', () => {
    expect(emailTransportConfigured()).toBe(true);
    emailConfig.value = { ...emailConfig.value, resendApiKey: null };
    expect(emailTransportConfigured()).toBe(false);
  });

  it('collects failures for a best-effort caller and throws for a strict one', async () => {
    const lenient = await sendViaConfiguredTransport(body, { continueOnError: true });
    expect(lenient).toMatchObject({ sent: false });
    await expect(sendViaConfiguredTransport(body, { continueOnError: false })).rejects.toThrow(
      /Resend returned 503/
    );
  });

  it('keeps the sign-in path strict: production still throws, with and without a transport', async () => {
    process.env.NODE_ENV = 'production';
    const auth = {
      ...body,
      expiresIn: '10 min',
      kind: 'password-reset' as const,
      url: 'https://x/reset?token=T',
    };
    await expect(deliverAuthEmail(auth)).rejects.toThrow(/Resend returned 503/);
    emailConfig.value = { ...emailConfig.value, resendApiKey: null };
    await expect(deliverAuthEmail(auth)).rejects.toBeInstanceOf(AuthEmailTransportError);
  });
});
