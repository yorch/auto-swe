import type net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const smtp = vi.hoisted(() => ({
  close: vi.fn(),
  created: [] as Array<Record<string, unknown>>,
  resendApiKey: null as string | null,
  sendMail: async (): Promise<{ accepted: string[]; rejected: string[] }> => ({
    accepted: ['a@example.com'],
    rejected: [],
  }),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      smtp.created.push(options);
      return { close: smtp.close, sendMail: () => smtp.sendMail() };
    },
  },
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveAuthEmailConfig: () => ({
    authFromEmail: 'noreply@example.com',
    resendApiKey: smtp.resendApiKey,
    smtpHost: 'smtp.example.com',
    smtpPass: null,
    smtpPort: 587,
    smtpUser: null,
  }),
}));

import { NOTIFICATION_SMTP_TIMEOUTS, sendViaConfiguredTransport } from './authEmail.js';

const message = { html: '<p>x</p>', subject: 's', text: 'x', to: 'a@example.com' };

describe('SMTP timeouts', () => {
  beforeEach(() => {
    smtp.created.length = 0;
  });

  it('bounds the notification path with finite connection, greeting and socket timeouts', async () => {
    // A distinct host per test would rebuild the transporter; the cache is per profile.
    await sendViaConfiguredTransport(message, { bounded: true, continueOnError: true });
    const options = smtp.created.at(-1);
    expect(options).toMatchObject(NOTIFICATION_SMTP_TIMEOUTS);
    for (const value of Object.values(NOTIFICATION_SMTP_TIMEOUTS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(30_000);
    }
  });

  it('leaves the sign-in and password-reset transport on nodemailer defaults', async () => {
    await sendViaConfiguredTransport(message, { continueOnError: false });
    const options = smtp.created.at(-1) as Record<string, unknown>;
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty('connectionTimeout');
    expect(options).not.toHaveProperty('greetingTimeout');
    expect(options).not.toHaveProperty('socketTimeout');
  });
});

describe('the notification deadline', () => {
  const never = () => new Promise<never>(() => undefined);

  beforeEach(() => {
    smtp.created.length = 0;
    smtp.close.mockClear();
    smtp.resendApiKey = 'rk-test';
  });
  afterEach(() => {
    smtp.resendApiKey = null;
    smtp.sendMail = async () => ({ accepted: ['a@example.com'], rejected: [] });
    vi.restoreAllMocks();
  });

  it('destroys the SMTP socket and closes the transporter when the deadline fires, and never falls back to Resend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const deadline = new AbortController();
    // A relay that has not answered: the send fails only because the deadline tore it down.
    let rejectSend: (err: Error) => void = () => undefined;
    smtp.sendMail = () =>
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    const pending = sendViaConfiguredTransport(message, {
      bounded: true,
      continueOnError: true,
      signal: deadline.signal,
    });
    await vi.waitFor(() => expect(smtp.created).toHaveLength(1));
    const socket = smtp.created[0]?.socket as net.Socket;
    expect(socket.destroyed).toBe(false);

    deadline.abort();
    expect(socket.destroyed).toBe(true);
    expect(smtp.close).toHaveBeenCalledTimes(1);
    // The destroyed socket makes nodemailer fail the send; that failure must end it, not start Resend.
    rejectSend(new Error('Connection closed'));
    expect(await pending).toMatchObject({ sent: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('starts nothing once the deadline has already passed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    smtp.sendMail = never;
    const result = await sendViaConfiguredTransport(message, {
      bounded: true,
      continueOnError: true,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ sent: false });
    expect(smtp.created).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still falls back to Resend after an SMTP failure while the deadline has not fired', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    smtp.sendMail = async () => {
      throw new Error('smtp down');
    };
    const result = await sendViaConfiguredTransport(message, {
      bounded: true,
      continueOnError: true,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ sent: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves the unbounded sign-in path alone: an aborted signal is ignored', async () => {
    smtp.resendApiKey = null;
    const sendMail = vi.fn(async () => ({ accepted: ['a@example.com'], rejected: [] }));
    smtp.sendMail = sendMail;
    const result = await sendViaConfiguredTransport(message, {
      continueOnError: false,
      signal: AbortSignal.abort(),
    });
    expect(result).toEqual({ sent: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
