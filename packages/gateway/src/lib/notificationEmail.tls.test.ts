/**
 * The SMTP transport against REAL loopback servers speaking TLS: implicit TLS (port 465 style),
 * STARTTLS (587 style) and AUTH, for both the unbounded (sign-in) and the bounded (notification)
 * profile. The bounded profile hands nodemailer a socket it owns so it can destroy it at the
 * deadline; these tests prove that doing so left nodemailer's TLS handling intact: the handshake
 * happens, the certificate and the host name are verified, SNI is sent, credentials only go over
 * the secured channel, and a stalled connection is closed at the deadline.
 *
 * Trusting the throwaway CA needs `NODE_EXTRA_CA_CERTS`, which Node reads once at process start and
 * which the code under test deliberately gives no way to weaken. So the outer suite generates the
 * certificates with openssl, then re-runs THIS FILE in a child vitest process started with that
 * variable; the inner suite (selected by SMTP_TLS_CERT_DIR) starts the servers and does the sends.
 * No key material is written inside the repository.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendViaConfiguredTransport } from './authEmail.js';
import { sendNotificationEmailsEach } from './notificationEmail.js';

const here = fileURLToPath(import.meta.url);
const CERT_DIR_ENV = 'SMTP_TLS_CERT_DIR';
const certDir = process.env[CERT_DIR_ENV];

// ─── Certificates (outer process) ─────────────────────────────────────────────

function openssl(cwd: string, ...args: string[]): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function makeCa(dir: string, name: string): void {
  openssl(
    dir,
    ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
    ...['-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=${name}`],
    ...['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=keyCertSign']
  );
}

function makeLeaf(dir: string, name: string, caName: string, san: string): void {
  openssl(
    dir,
    ...['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
    ...['-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=leaf']
  );
  writeFileSync(
    path.join(dir, `${name}.ext`),
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`
  );
  openssl(
    dir,
    ...['x509', '-req', '-in', `${name}.csr`, '-CA', `${caName}.pem`, '-CAkey', `${caName}.key`],
    ...['-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`]
  );
}

function generateCertificates(dir: string): void {
  makeCa(dir, 'trusted-ca');
  makeCa(dir, 'other-ca');
  // Valid for the loopback address and the name `localhost`.
  makeLeaf(dir, 'good', 'trusted-ca', 'DNS:localhost,IP:127.0.0.1');
  // Chains to the trusted CA but names some other host.
  makeLeaf(dir, 'wronghost', 'trusted-ca', 'DNS:smtp.elsewhere.test');
  // Right names, but issued by a CA nobody trusts.
  makeLeaf(dir, 'untrusted', 'other-ca', 'DNS:localhost,IP:127.0.0.1');
}

// ─── A small SMTP server ──────────────────────────────────────────────────────

type Mode = 'plain' | 'implicit' | 'starttls';

interface ServerOptions {
  mode: Mode;
  /** Certificate file stem in the cert directory (implicit and starttls). */
  cert?: string;
  /** Require AUTH before MAIL FROM and accept exactly these credentials. */
  auth?: { user: string; pass: string; mechanisms: string[] };
  /**
   * starttls mode only: a relay that cannot upgrade. It does not advertise STARTTLS and refuses the
   * command (502), which is what a relay without it, or one an attacker strips it from, answers.
   */
  hideStartTls?: boolean;
  /** Go silent: never answer from this point on. */
  stall?: 'handshake' | 'greeting' | 'after-starttls' | 'data';
}

interface Delivered {
  from: string;
  to: string[];
  data: string;
  encrypted: boolean;
  authenticated: boolean;
}

interface Recorded {
  connections: number;
  closed: number;
  commands: string[];
  /** AUTH attempts: was the channel encrypted when the credentials arrived? */
  auths: Array<{ encrypted: boolean; mechanism: string; user: string; pass: string; ok: boolean }>;
  /** MAIL FROM lines that arrived, and whether each was encrypted. */
  mailEncrypted: boolean[];
  refusedMail: number;
  delivered: Delivered[];
  servernames: Array<string | false>;
  handshakeErrors: number;
}

interface SmtpServer {
  port: number;
  rec: Recorded;
  close: () => Promise<void>;
}

function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

async function startServer(options: ServerOptions, dir: string): Promise<SmtpServer> {
  const rec: Recorded = {
    auths: [],
    closed: 0,
    commands: [],
    connections: 0,
    delivered: [],
    handshakeErrors: 0,
    mailEncrypted: [],
    refusedMail: 0,
    servernames: [],
  };
  const sockets = new Set<net.Socket>();
  const secureContext = options.cert
    ? tls.createSecureContext({
        cert: readFileSync(path.join(dir, `${options.cert}.pem`)),
        key: readFileSync(path.join(dir, `${options.cert}.key`)),
      })
    : undefined;

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    rec.connections += 1;
    // `close` of the underlying connection, once, however many wrappers sit on it.
    socket.once('close', () => {
      rec.closed += 1;
      sockets.delete(socket);
    });
  };

  const serve = (sock: net.Socket, encrypted: boolean, silent: boolean, greet = true) => {
    let buf = '';
    let data: string | null = null;
    let authed = false;
    let from = '';
    let to: string[] = [];
    let loginStep: 'user' | 'pass' | null = null;
    let loginUser = '';
    const send = (line: string) => sock.write(`${line}\r\n`);
    const checkCredentials = (mechanism: string, user: string, pass: string) => {
      const ok = options.auth?.user === user && options.auth?.pass === pass;
      rec.auths.push({ encrypted, mechanism, ok, pass, user });
      authed = ok;
      send(ok ? '235 2.7.0 Accepted' : '535 5.7.8 Bad credentials');
    };
    const handle = (line: string) => {
      rec.commands.push(encrypted ? `(tls) ${line}` : line);
      if (loginStep === 'user') {
        loginUser = Buffer.from(line, 'base64').toString();
        loginStep = 'pass';
        send(`334 ${b64('Password:')}`);
        return;
      }
      if (loginStep === 'pass') {
        loginStep = null;
        checkCredentials('LOGIN', loginUser, Buffer.from(line, 'base64').toString());
        return;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        const caps = ['localhost', 'SIZE 10485760', '8BITMIME'];
        if (options.auth) {
          caps.push(`AUTH ${options.auth.mechanisms.join(' ')}`);
        }
        if (options.mode === 'starttls' && !encrypted && !options.hideStartTls) {
          caps.push('STARTTLS');
        }
        for (const [i, cap] of caps.entries()) {
          send(`250${i === caps.length - 1 ? ' ' : '-'}${cap}`);
        }
      } else if (upper === 'STARTTLS') {
        if (!secureContext || options.hideStartTls) {
          send('502 not available');
          return;
        }
        send('220 2.0.0 Ready to start TLS');
        sock.removeAllListeners('data');
        const wrapped = new tls.TLSSocket(sock, { isServer: true, secureContext });
        wrapped.on('error', () => {
          rec.handshakeErrors += 1;
        });
        wrapped.once('secure', () => rec.servernames.push(wrapped.servername ?? false));
        serve(wrapped, true, options.stall === 'after-starttls', false);
      } else if (upper.startsWith('AUTH PLAIN')) {
        const initial = line.slice('AUTH PLAIN'.length).trim();
        const [, user = '', pass = ''] = Buffer.from(initial, 'base64').toString().split('\0');
        checkCredentials('PLAIN', user, pass);
      } else if (upper.startsWith('AUTH LOGIN')) {
        const initial = line.slice('AUTH LOGIN'.length).trim();
        if (initial) {
          loginUser = Buffer.from(initial, 'base64').toString();
          loginStep = 'pass';
          send(`334 ${b64('Password:')}`);
        } else {
          loginStep = 'user';
          send(`334 ${b64('Username:')}`);
        }
      } else if (upper.startsWith('MAIL FROM:')) {
        rec.mailEncrypted.push(encrypted);
        if (options.auth && !authed) {
          rec.refusedMail += 1;
          send('530 5.7.0 Authentication required');
          return;
        }
        from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        to = [];
        send('250 OK');
      } else if (upper.startsWith('RCPT TO:')) {
        to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        send('250 OK');
      } else if (upper === 'DATA') {
        if (options.stall === 'data') {
          return;
        }
        data = '';
        send('354 End data with <CR><LF>.<CR><LF>');
      } else if (upper === 'QUIT') {
        send('221 Bye');
        sock.end();
      } else if (upper === 'RSET' || upper === 'NOOP') {
        send('250 OK');
      } else {
        send('502 not implemented');
      }
    };
    const pump = () => {
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) {
            return;
          }
          data += buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          rec.delivered.push({ authenticated: authed, data, encrypted, from, to });
          data = null;
          send('250 2.0.0 Queued');
          continue;
        }
        const eol = buf.indexOf('\r\n');
        if (eol === -1) {
          return;
        }
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        handle(line);
      }
    };
    sock.on('error', () => undefined);
    if (silent) {
      // Read and discard, so the server notices when the client closes the connection.
      sock.resume();
      return;
    }
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      pump();
    });
    if (greet && options.stall !== 'greeting') {
      send('220 localhost ESMTP test');
    }
  };

  let server: net.Server;
  if (options.mode === 'implicit') {
    if (!options.cert) {
      throw new Error('implicit TLS needs a certificate');
    }
    const tlsServer = tls.createServer(
      {
        cert: readFileSync(path.join(dir, `${options.cert}.pem`)),
        key: readFileSync(path.join(dir, `${options.cert}.key`)),
      },
      (sock) => {
        rec.servernames.push(sock.servername ?? false);
        serve(sock, true, false);
      }
    );
    tlsServer.on('tlsClientError', () => {
      rec.handshakeErrors += 1;
    });
    tlsServer.on('connection', track);
    server = tlsServer;
  } else {
    server = net.createServer((sock) => {
      track(sock);
      if (options.stall === 'handshake') {
        sock.on('error', () => undefined);
        sock.resume();
        return;
      }
      serve(sock, false, false);
    });
  }
  // Stalling the handshake of an implicit server: accept the TCP connection and never speak TLS.
  if (options.mode === 'implicit' && options.stall === 'handshake') {
    server.close();
    server = net.createServer((sock) => {
      track(sock);
      sock.on('error', () => undefined);
      sock.resume();
    });
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    port: (server.address() as net.AddressInfo).port,
    rec,
  };
}

async function waitFor(condition: () => boolean, ms = 3000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

// ─── The inner suite ──────────────────────────────────────────────────────────

const message = {
  html: '<p>html body marker</p>',
  subject: 'Join request decided',
  text: 'text body marker',
  to: 'person@example.com',
};

const ENV_KEYS = [
  'AUTH_FROM_EMAIL',
  'RESEND_API_KEY',
  'SMTP_HOST',
  'SMTP_PASS',
  'SMTP_PORT',
  'SMTP_REQUIRE_TLS',
  'SMTP_USER',
];

type Profile = 'unbounded' | 'bounded';
const PROFILES: Profile[] = ['unbounded', 'bounded'];

function configure(port: number, extra: { host?: string; user?: string; pass?: string } = {}) {
  process.env.AUTH_FROM_EMAIL = 'noreply@example.com';
  process.env.SMTP_HOST = extra.host ?? '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  if (extra.user) {
    process.env.SMTP_USER = extra.user;
    process.env.SMTP_PASS = extra.pass ?? '';
  }
}

async function attempt(profile: Profile) {
  return sendViaConfiguredTransport(message, {
    bounded: profile === 'bounded',
    continueOnError: true,
  });
}

function expectMessage(delivered: Delivered | undefined): void {
  expect(delivered).toBeDefined();
  expect(delivered?.from).toBe('noreply@example.com');
  expect(delivered?.to).toEqual(['person@example.com']);
  expect(delivered?.data).toContain('Subject: Join request decided');
  expect(delivered?.data).toContain('text body marker');
  expect(delivered?.data).toContain('html body marker');
}

describe.skipIf(!certDir)('SMTP over TLS (child process, throwaway CA trusted)', () => {
  const dir = certDir as string;
  const saved: Record<string, string | undefined> = {};
  const servers: SmtpServer[] = [];
  const secureOverride = { value: undefined as boolean | undefined };

  const start = async (options: ServerOptions) => {
    const server = await startServer(options, dir);
    servers.push(server);
    return server;
  };

  beforeAll(() => {
    // The module derives `secure` from port 465, which an unprivileged test cannot bind: force the
    // flag onto the options the module built, and nothing else, so everything else is the real path.
    const original = nodemailer.createTransport.bind(nodemailer) as (o: object) => unknown;
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(((options: object) =>
      original(
        secureOverride.value === undefined ? options : { ...options, secure: secureOverride.value }
      )) as unknown as typeof nodemailer.createTransport);
  });
  afterAll(() => vi.restoreAllMocks());
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    secureOverride.value = undefined;
  });
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('derives implicit TLS from port 465 and STARTTLS otherwise, in both profiles', async () => {
    const created: Array<Record<string, unknown>> = [];
    vi.mocked(nodemailer.createTransport).mockImplementationOnce(((options: object) => {
      created.push(options as Record<string, unknown>);
      return { close: () => undefined, sendMail: async () => ({ accepted: ['a'], rejected: [] }) };
    }) as unknown as typeof nodemailer.createTransport);
    configure(465, { host: 'smtp.example.test' });
    await attempt('bounded');
    vi.mocked(nodemailer.createTransport).mockImplementationOnce(((options: object) => {
      created.push(options as Record<string, unknown>);
      return { close: () => undefined, sendMail: async () => ({ accepted: ['a'], rejected: [] }) };
    }) as unknown as typeof nodemailer.createTransport);
    configure(587, { host: 'smtp2.example.test' });
    await attempt('bounded');
    expect(created[0]).toMatchObject({ host: 'smtp.example.test', port: 465, secure: true });
    expect(created[1]).toMatchObject({ host: 'smtp2.example.test', port: 587, secure: false });
  });

  describe.each(PROFILES)('%s profile', (profile) => {
    it('delivers over plain, unauthenticated SMTP', async () => {
      const server = await start({ mode: 'plain' });
      configure(server.port);
      expect(await attempt(profile)).toEqual({ sent: true });
      expectMessage(server.rec.delivered[0]);
      expect(server.rec.delivered[0]?.encrypted).toBe(false);
    });

    it('delivers over implicit TLS (secure: true), verifying the certificate', async () => {
      const server = await start({ cert: 'good', mode: 'implicit' });
      secureOverride.value = true;
      configure(server.port);
      expect(await attempt(profile)).toEqual({ sent: true });
      expectMessage(server.rec.delivered[0]);
      expect(server.rec.delivered[0]?.encrypted).toBe(true);
    });

    it('sends SNI for a host name and checks the certificate against it', async () => {
      const server = await start({ cert: 'good', mode: 'implicit' });
      secureOverride.value = true;
      configure(server.port, { host: 'localhost' });
      expect(await attempt(profile)).toEqual({ sent: true });
      expect(server.rec.servernames).toEqual(['localhost']);
    });

    it('upgrades with STARTTLS and sends the message only over the secured channel', async () => {
      const server = await start({ cert: 'good', mode: 'starttls' });
      configure(server.port);
      expect(await attempt(profile)).toEqual({ sent: true });
      expectMessage(server.rec.delivered[0]);
      expect(server.rec.delivered[0]?.encrypted).toBe(true);
      expect(server.rec.mailEncrypted).toEqual([true]);
    });

    it.each(['implicit', 'starttls'] as const)(
      'authenticates (%s) before MAIL FROM, credentials only over TLS',
      async (mode) => {
        for (const mechanisms of [['PLAIN'], ['LOGIN']]) {
          const server = await start({
            auth: { mechanisms, pass: 's3cret', user: 'mailer' },
            cert: 'good',
            mode,
          });
          secureOverride.value = mode === 'implicit' ? true : undefined;
          configure(server.port, { pass: 's3cret', user: 'mailer' });
          expect(await attempt(profile)).toEqual({ sent: true });
          expect(server.rec.auths).toHaveLength(1);
          expect(server.rec.auths[0]).toMatchObject({ encrypted: true, ok: true, user: 'mailer' });
          expect(server.rec.refusedMail).toBe(0);
          expectMessage(server.rec.delivered[0]);
          expect(server.rec.delivered[0]?.authenticated).toBe(true);
        }
      }
    );

    it('refuses to send when AUTH is required and the credentials are wrong', async () => {
      const server = await start({
        auth: { mechanisms: ['PLAIN'], pass: 's3cret', user: 'mailer' },
        cert: 'good',
        mode: 'starttls',
      });
      configure(server.port, { pass: 'wrong', user: 'mailer' });
      const result = await attempt(profile);
      expect(result.sent).toBe(false);
      expect(server.rec.delivered).toHaveLength(0);
    });

    it('sends no message and no credentials when AUTH is required but none are configured', async () => {
      const server = await start({
        auth: { mechanisms: ['PLAIN'], pass: 's3cret', user: 'mailer' },
        cert: 'good',
        mode: 'starttls',
      });
      configure(server.port);
      const result = await attempt(profile);
      expect(result.sent).toBe(false);
      expect(server.rec.delivered).toHaveLength(0);
      expect(server.rec.refusedMail).toBe(1);
    });

    it.each([
      ['implicit', 'untrusted'],
      ['starttls', 'untrusted'],
      ['implicit', 'wronghost'],
      ['starttls', 'wronghost'],
    ] as const)(
      'refuses a %s server with a %s certificate, before MAIL FROM or AUTH',
      async (mode, cert) => {
        const server = await start({
          auth: { mechanisms: ['PLAIN'], pass: 's3cret', user: 'mailer' },
          cert,
          mode,
        });
        secureOverride.value = mode === 'implicit' ? true : undefined;
        configure(server.port, { pass: 's3cret', user: 'mailer' });
        const result = await attempt(profile);
        expect(result.sent).toBe(false);
        expect(server.rec.delivered).toHaveLength(0);
        expect(server.rec.auths).toHaveLength(0);
        expect(server.rec.mailEncrypted).toHaveLength(0);
      }
    );

    it('refuses a certificate that does not name the host connected to (IP not in the SAN)', async () => {
      const server = await start({ cert: 'wronghost', mode: 'implicit' });
      secureOverride.value = true;
      configure(server.port, { host: 'localhost' });
      const result = await attempt(profile);
      expect(result.sent).toBe(false);
      expect(server.rec.delivered).toHaveLength(0);
    });

    it('does not downgrade a STARTTLS server whose handshake fails to plaintext', async () => {
      const server = await start({ cert: 'untrusted', mode: 'starttls' });
      configure(server.port);
      expect((await attempt(profile)).sent).toBe(false);
      expect(server.rec.commands.filter((c) => c.startsWith('MAIL'))).toHaveLength(0);
    });
  });

  it('is exactly as permissive as the unbounded profile when a relay offers no STARTTLS', async () => {
    // With SMTP_REQUIRE_TLS unset, a relay that does not advertise STARTTLS on a non-465 port is
    // used in plaintext, by both profiles. Parity is the point (the bounded profile must not be
    // weaker); the switch above is what closes it.
    const outcomes: Record<Profile, { sent: boolean; encrypted: boolean | undefined }> = {
      bounded: { encrypted: undefined, sent: false },
      unbounded: { encrypted: undefined, sent: false },
    };
    for (const profile of PROFILES) {
      const server = await start({ cert: 'good', hideStartTls: true, mode: 'starttls' });
      configure(server.port);
      const result = await attempt(profile);
      outcomes[profile] = { encrypted: server.rec.delivered[0]?.encrypted, sent: result.sent };
    }
    expect(outcomes.bounded).toEqual(outcomes.unbounded);
  });

  describe('SMTP_REQUIRE_TLS', () => {
    /** Nothing but the greeting and capability exchange may have crossed the wire in clear. */
    const expectNothingSensitiveInClear = (server: SmtpServer) => {
      expect(server.rec.delivered).toHaveLength(0);
      expect(server.rec.auths).toHaveLength(0);
      expect(server.rec.mailEncrypted).toHaveLength(0);
      expect(server.rec.commands.filter((c) => /^(AUTH|MAIL|RCPT|DATA)/i.test(c))).toEqual([]);
    };
    const creds = { pass: 's3cret', user: 'mailer' } as const;
    const authRelay = { auth: { mechanisms: ['PLAIN', 'LOGIN'], ...creds } };

    describe.each(PROFILES)('%s profile', (profile) => {
      it('refuses a relay that does not offer STARTTLS: no AUTH, no message, nothing in clear', async () => {
        const server = await start({
          ...authRelay,
          cert: 'good',
          hideStartTls: true,
          mode: 'starttls',
        });
        configure(server.port, creds);
        process.env.SMTP_REQUIRE_TLS = 'true';
        expect((await attempt(profile)).sent).toBe(false);
        expectNothingSensitiveInClear(server);
      });

      it('refuses a plain relay (no TLS at all) the same way', async () => {
        const server = await start({ ...authRelay, mode: 'plain' });
        configure(server.port, creds);
        process.env.SMTP_REQUIRE_TLS = '1';
        expect((await attempt(profile)).sent).toBe(false);
        expectNothingSensitiveInClear(server);
      });

      it('refuses when the STARTTLS command itself is stripped (advertised, then refused)', async () => {
        // Advertises STARTTLS but has no certificate, so it answers the command with a 502: what
        // an attacker who blocks the upgrade looks like to the client.
        const server = await start({ ...authRelay, mode: 'starttls' });
        configure(server.port, creds);
        process.env.SMTP_REQUIRE_TLS = 'true';
        expect((await attempt(profile)).sent).toBe(false);
        expectNothingSensitiveInClear(server);
      });

      it('still delivers through a relay that upgrades, with AUTH only over TLS', async () => {
        const server = await start({ ...authRelay, cert: 'good', mode: 'starttls' });
        configure(server.port, creds);
        process.env.SMTP_REQUIRE_TLS = 'true';
        expect(await attempt(profile)).toEqual({ sent: true });
        expect(server.rec.auths).toHaveLength(1);
        expect(server.rec.auths[0]).toMatchObject({ encrypted: true, ok: true });
        expect(server.rec.mailEncrypted).toEqual([true]);
        expectMessage(server.rec.delivered[0]);
        expect(server.rec.delivered[0]?.encrypted).toBe(true);
      });

      it('leaves implicit TLS (port 465) working', async () => {
        const server = await start({ ...authRelay, cert: 'good', mode: 'implicit' });
        secureOverride.value = true;
        configure(server.port, creds);
        process.env.SMTP_REQUIRE_TLS = 'true';
        expect(await attempt(profile)).toEqual({ sent: true });
        expect(server.rec.delivered[0]?.encrypted).toBe(true);
      });

      it('does not require TLS when the switch is explicitly off', async () => {
        const server = await start({ cert: 'good', hideStartTls: true, mode: 'starttls' });
        configure(server.port);
        process.env.SMTP_REQUIRE_TLS = 'false';
        expect(await attempt(profile)).toEqual({ sent: true });
        expect(server.rec.delivered[0]?.encrypted).toBe(false);
      });

      it('treats a value it cannot read as on, so a typo never opens a plaintext path', async () => {
        const server = await start({ cert: 'good', hideStartTls: true, mode: 'starttls' });
        configure(server.port);
        process.env.SMTP_REQUIRE_TLS = 'ture';
        expect((await attempt(profile)).sent).toBe(false);
        expect(server.rec.delivered).toHaveLength(0);
      });
    });

    it('throws for sign-in email (it shares the transport) instead of sending in clear', async () => {
      const server = await start({
        ...authRelay,
        cert: 'good',
        hideStartTls: true,
        mode: 'starttls',
      });
      configure(server.port, creds);
      process.env.SMTP_REQUIRE_TLS = 'true';
      await expect(
        sendViaConfiguredTransport(message, { continueOnError: false })
      ).rejects.toThrow();
      expectNothingSensitiveInClear(server);
    });

    it('is a refusal, not an unknown outcome, for the notification path', async () => {
      const server = await start({
        ...authRelay,
        cert: 'good',
        hideStartTls: true,
        mode: 'starttls',
      });
      configure(server.port, creds);
      process.env.SMTP_REQUIRE_TLS = 'true';
      const result = await sendNotificationEmailsEach('test', [message], 5000);
      expect(result).toMatchObject({ configured: true, delivered: [], failed: 1, unknown: 0 });
      expectNothingSensitiveInClear(server);
    });

    it('does not rebuild the shared sign-in transporter around a stale setting', async () => {
      const plain = await start({ cert: 'good', hideStartTls: true, mode: 'starttls' });
      configure(plain.port);
      expect((await sendViaConfiguredTransport(message, { continueOnError: true })).sent).toBe(
        true
      );
      process.env.SMTP_REQUIRE_TLS = 'true';
      expect((await sendViaConfiguredTransport(message, { continueOnError: true })).sent).toBe(
        false
      );
      expect(plain.rec.delivered).toHaveLength(1);
    });
  });

  describe('the deadline over TLS', () => {
    const fetchSpy = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    it.each([
      ['implicit', 'handshake'],
      ['implicit', 'greeting'],
      ['implicit', 'data'],
      ['starttls', 'after-starttls'],
      ['starttls', 'data'],
    ] as const)(
      'destroys the socket of a %s server that stalls (%s) and never tries Resend',
      async (mode, stall) => {
        const spy = fetchSpy();
        const server = await start({ cert: 'good', mode, stall });
        secureOverride.value = mode === 'implicit' ? true : undefined;
        configure(server.port);
        process.env.RESEND_API_KEY = 'rk-test';
        const result = await sendNotificationEmailsEach('test', [message], 400);
        expect(result).toMatchObject({ configured: true, delivered: [], failed: 1, unknown: 1 });
        // The server sees the connection end promptly, not at its own or nodemailer's timeout.
        expect(await waitFor(() => server.rec.closed >= 1, 2000)).toBe(true);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    );
  });
});

// ─── The outer suite: certificates, then the inner suite under NODE_EXTRA_CA_CERTS ──────────

describe.skipIf(Boolean(certDir))('SMTP over TLS', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'smtp-tls-'));
    mkdirSync(dir, { recursive: true });
    generateCertificates(dir);
  });
  afterAll(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it('passes the TLS, STARTTLS, AUTH, verification and deadline scenarios (child process)', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('VITEST') || key.startsWith('SMTP_') || key === 'AUTH_FROM_EMAIL') {
        delete env[key];
      }
    }
    // CI forces colour on; the summary line is matched below as plain text.
    delete env.FORCE_COLOR;
    env.NO_COLOR = '1';
    env[CERT_DIR_ENV] = dir;
    env.NODE_EXTRA_CA_CERTS = path.join(dir, 'trusted-ca.pem');
    const root = path.resolve(path.dirname(here), '../../../..');
    const vitestBin = path.join(root, 'node_modules/vitest/vitest.mjs');
    const result = spawnSync(
      process.execPath,
      [vitestBin, 'run', '--root', root, path.relative(root, here)],
      { cwd: root, encoding: 'utf8', env, timeout: 150_000 }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/Tests\s+\d+ passed/);
    expect(result.status, output).toBe(0);
  }, 180_000);
});
