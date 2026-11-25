import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { NOTIFICATION_BACKOFF_MS } from '@auto-swe/shared/lib/teamJoinRequests';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Whether a bot token resolves for a team channel is the Slack integration's business (a database
// row or the environment); the transports themselves, SMTP and the Slack post, stay real.
const slackTokens = vi.hoisted(() => ({
  /** How many transactions are open while a lookup runs (set by the test that checks it). */
  openTransactions: (): number => 0,
  resolve: async (channel: string): Promise<string | null> => {
    slackTokens.seenInTransaction.push(slackTokens.openTransactions());
    if (channel.startsWith('C-THROWS')) {
      throw new Error('the Slack configuration cannot be decrypted');
    }
    return channel.startsWith('C-NOTOKEN') ? null : 'xoxb-it-token';
  },
  seenInTransaction: [] as number[],
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveSlackBotTokenForSlackChannel: (channel: string) => slackTokens.resolve(channel),
}));

import type { JwtPayload } from '../plugins/auth.js';
import {
  claimDueNotifications,
  purgeOldNotifications,
  type RunOnceOptions,
  runOnce,
} from '../plugins/joinRequestNotificationPoller.js';
import { joinRequestNotificationRoutes } from '../routes/joinRequestNotifications.js';
import { reachedKey, resetDeliveryWarningsForTests } from './joinRequestNotifier.js';
import {
  enqueueJoinRequestNotifications,
  resetOutboxWarningsForTests,
  SLACK_LOOKUP_LOG_INTERVAL_MS,
} from './joinRequestOutbox.js';
import {
  approveAtOrgStep,
  approveAtTeamStep,
  closeOpenJoinRequests,
  createJoinRequest,
  rejectAtOrgStep,
  rejectAtTeamStep,
  withdrawRequest,
} from './teamJoinRequests.js';

/**
 * The join-request notification outbox against real Postgres and real transports: the rows commit
 * (or roll back) with the request, the poller claims with `FOR UPDATE SKIP LOCKED` so replicas
 * never take one row twice, a crashed claimer's rows come back, failures back off and end as
 * `FAILED`, an admin can retry, retention purges, and the delivered bytes are what an SMTP server
 * and a Slack-shaped HTTP server, both started inside this test, actually receive.
 *
 * Opt in with `JOIN_REQUEST_OUTBOX_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has
 * been run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.JOIN_REQUEST_OUTBOX_PG_TEST === '1';

/* ── Test servers ──────────────────────────────────────────────────────────── */

interface SmtpMessage {
  from: string;
  to: string[];
  /** The DATA section, dot-unstuffed and with quoted-printable decoded. */
  data: string;
  subject: string;
}

/** A minimal SMTP server: EHLO, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT. Records what it is sent. */
class SmtpSink {
  readonly messages: SmtpMessage[] = [];
  /** Recipients (lower-cased) the server refuses with a 550. */
  readonly refuse = new Set<string>();
  /** Holds queued by `holdNextAccept`; the next accepted messages take them in order. */
  private readonly heldAccepts: Array<{ arrive: () => void; released: Promise<void> }> = [];
  port = 0;
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  /** Client connections the server still has open. */
  get openConnections(): number {
    return this.sockets.size;
  }

  async start(port = 0): Promise<void> {
    this.server = net.createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /**
   * Makes the next accepted message wait for the test: the sink has read it (it is in `messages`)
   * but does not say 250 until `release()`. `arrived` resolves the moment the sink holds it, so a
   * test waits on that instead of sleeping. Holds are taken in the order they are made.
   */
  holdNextAccept(): { arrived: Promise<void>; release: () => void } {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.heldAccepts.push({ arrive, released });
    return { arrived, release };
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    );
    this.server = undefined;
    this.heldAccepts.length = 0;
  }

  private serve(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write('220 sink ESMTP ready\r\n');
    let buffer = '';
    let inData = false;
    let from = '';
    let to: string[] = [];
    const address = (line: string) => /<([^>]*)>/.exec(line)?.[1] ?? '';
    const handle = () => {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) {
            return;
          }
          const raw = buffer.slice(0, end).replaceAll('\r\n..', '\r\n.');
          buffer = buffer.slice(end + 5);
          inData = false;
          const data = raw
            .replaceAll('=\r\n', '')
            .replaceAll(/=([0-9A-F]{2})/g, (_m, h: string) =>
              String.fromCharCode(Number.parseInt(h, 16))
            );
          const headers = raw.split('\r\n\r\n')[0]?.replaceAll(/\r\n[ \t]+/g, ' ') ?? '';
          const subject = /^Subject: (.*)$/im.exec(headers)?.[1] ?? '';
          this.messages.push({ data, from, subject, to });
          from = '';
          to = [];
          const held = this.heldAccepts.shift();
          if (held) {
            held.arrive();
            void held.released.then(() => socket.write('250 2.0.0 queued\r\n'));
          } else {
            socket.write('250 2.0.0 queued\r\n');
          }
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) {
          return;
        }
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.toUpperCase();
        if (verb.startsWith('EHLO') || verb.startsWith('HELO')) {
          socket.write('250-sink\r\n250 8BITMIME\r\n');
        } else if (verb.startsWith('MAIL FROM')) {
          from = address(line);
          socket.write('250 2.1.0 ok\r\n');
        } else if (verb.startsWith('RCPT TO')) {
          const rcpt = address(line);
          if (this.refuse.has(rcpt.toLowerCase())) {
            socket.write('550 5.1.1 no such user\r\n');
          } else {
            to.push(rcpt);
            socket.write('250 2.1.5 ok\r\n');
          }
        } else if (verb === 'DATA') {
          if (to.length === 0) {
            socket.write('554 5.5.1 no valid recipients\r\n');
          } else {
            inData = true;
            socket.write('354 end with <CRLF>.<CRLF>\r\n');
          }
        } else if (verb === 'RSET' || verb === 'NOOP') {
          socket.write('250 ok\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('502 5.5.2 not implemented\r\n');
        }
      }
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      handle();
    });
  }
}

interface SlackCall {
  authorization: string | undefined;
  body: { channel?: string; text?: string };
  url: string;
}

/** An HTTP server shaped like Slack's `chat.postMessage`. */
class SlackStub {
  readonly calls: SlackCall[] = [];
  /** What the next call answers: `ok`, a Slack error code, or a redirect to `redirectTo`. */
  answer: { error: string } | { redirectTo: string } | 'ok' = 'ok';
  port = 0;
  private server: http.Server | undefined;

  get base(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        this.calls.push({
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : {},
          url: req.url ?? '',
        });
        const answer = this.answer;
        if (typeof answer === 'object' && 'redirectTo' in answer) {
          res.writeHead(302, { location: answer.redirectTo });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            answer === 'ok'
              ? { ok: true, ts: '1700000000.000100' }
              : { error: answer.error, ok: false }
          )
        );
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    );
    this.server = undefined;
  }
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/**
 * Waits for `promise`, and FAILS if it has not settled in `ms`. The bound is only a ceiling for a
 * state that never arrives; a test that reaches the state continues the moment it does.
 */
async function within<T>(promise: Promise<T>, what: string, ms = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A promise and the function that settles it. */
function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/* ── The suite ─────────────────────────────────────────────────────────────── */

describe.skipIf(!enabled)('join-request notification outbox against Postgres', () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (label: string) => `ob-${suffix}-${label}`;
  const fastify = { prisma } as unknown as FastifyInstance;
  const ctx = {};
  const orgIds: string[] = [];
  const teamIds: string[] = [];
  const userIds: string[] = [];
  const settingKeys = new Set<string>();
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'AUTH_FROM_EMAIL',
    'RESEND_API_KEY',
    'CORS_ORIGIN',
  ];

  const actorOf = (id: string): JwtPayload => ({ exp: 0, iat: 0, role: 'USER', sub: id });

  async function makeUser(label: string, userName?: string) {
    const user = await prisma.user.create({
      data: { email: `${name(label)}@example.test`, name: userName ?? `User ${label}` },
    });
    userIds.push(user.id);
    return user;
  }
  async function makeOrg(label: string) {
    const org = await prisma.organization.create({
      data: { name: name(`org-${label}`), slug: name(`org-${label}`) },
    });
    orgIds.push(org.id);
    return org.id;
  }
  async function makeTeam(label: string, orgId: string, slackNotifyChannel: string | null = null) {
    const team = await prisma.team.create({
      data: { name: name(`team-${label}`), orgId, slackNotifyChannel, slug: name(`team-${label}`) },
    });
    teamIds.push(team.id);
    return team;
  }
  const inOrg = (userId: string, orgId: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') =>
    prisma.organizationMembership.create({ data: { orgId, role, userId } });
  const onTeam = (userId: string, teamId: string, role: 'ADMIN' | 'LEAD' | 'MEMBER') =>
    prisma.teamMembership.create({ data: { role, teamId, userId } });

  /** The GLOBAL rows a key held before this suite first touched it, put back by `restoreGlobals`. */
  const originalGlobals = new Map<string, unknown[]>();
  async function setGlobal(key: string, value: unknown) {
    if (!originalGlobals.has(key)) {
      const before = await runUnscoped(
        'test fixture: remember a platform-wide setting',
        ['ConfigSetting'],
        () =>
          prisma.configSetting.findMany({
            select: { value: true },
            where: { key, scope: 'GLOBAL' },
          })
      );
      originalGlobals.set(
        key,
        before.map((r) => r.value)
      );
    }
    settingKeys.add(key);
    await clearGlobal(key);
    await prisma.configSetting.create({ data: { key, scope: 'GLOBAL', value: value as never } });
    invalidateSettingsCache();
  }
  async function clearGlobal(key: string) {
    await runUnscoped('test fixture: a platform-wide setting', ['ConfigSetting'], () =>
      prisma.configSetting.deleteMany({ where: { key, scope: 'GLOBAL' } })
    );
    invalidateSettingsCache();
  }

  /** Deletes what a test set and puts back the rows the database held before it. */
  async function restoreGlobals() {
    for (const key of settingKeys) {
      await clearGlobal(key);
      for (const value of originalGlobals.get(key) ?? []) {
        await runUnscoped('test fixture: restore a platform-wide setting', ['ConfigSetting'], () =>
          prisma.configSetting.create({ data: { key, scope: 'GLOBAL', value: value as never } })
        );
      }
      originalGlobals.delete(key);
    }
    settingKeys.clear();
    invalidateSettingsCache();
  }

  let orgA: string;
  let orgB: string;
  let lead: { id: string; email: string | null };
  let teamAdmin: { id: string; email: string | null };
  let orgAdmin: { id: string; email: string | null };
  let platformAdmin: { id: string };
  let app: FastifyInstance;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.CORS_ORIGIN = 'https://app.test.example';
    orgA = await makeOrg('a');
    orgB = await makeOrg('b');
    lead = await makeUser('lead', 'Lena Lead');
    teamAdmin = await makeUser('team-admin', 'Tim Admin');
    orgAdmin = await makeUser('org-admin', 'Olga Admin');
    platformAdmin = await makeUser('platform-admin');
    for (const u of [lead, teamAdmin]) {
      await inOrg(u.id, orgA);
    }
    await inOrg(orgAdmin.id, orgA, 'ADMIN');

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9_999_999_999,
        iat: 0,
        role: token === platformAdmin.id ? 'ADMIN' : 'USER',
        sub: token,
      }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    await app.register(joinRequestNotificationRoutes, { prefix: '/api/v1/platform' });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    process.env.CORS_ORIGIN = 'https://app.test.example';
    await restoreGlobals();
    resetDeliveryWarningsForTests();
    resetOutboxWarningsForTests();
    // Nothing a test left behind may be claimed by the next one.
    await runUnscoped('test fixture: outbox rows', ['TeamJoinRequest'], () =>
      prisma.joinRequestNotification.deleteMany({
        where: { request: { team: { orgId: { in: orgIds } } } },
      })
    );
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    await restoreGlobals();
    await runUnscoped(
      'test fixture: throwaway database',
      ['OrganizationMembership', 'Team', 'TeamJoinRequest', 'TeamMembership'],
      async () => {
        await prisma.joinRequestNotification.deleteMany({
          where: { request: { team: { orgId: { in: orgIds } } } },
        });
        await prisma.teamJoinRequest.deleteMany({ where: { team: { orgId: { in: orgIds } } } });
        await prisma.teamMembership.deleteMany({ where: { team: { orgId: { in: orgIds } } } });
        await prisma.team.deleteMany({ where: { orgId: { in: orgIds } } });
        await prisma.organizationMembership.deleteMany({ where: { orgId: { in: orgIds } } });
      }
    );
    await prisma.configAuditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
  });

  /** A team in org A led by `lead` and administered by `teamAdmin`, and a requester in org A. */
  async function scenario(
    label: string,
    opts: { channel?: string | null; requesterOrg?: string | null } = {}
  ) {
    const team = await makeTeam(label, orgA, opts.channel ?? null);
    await onTeam(lead.id, team.id, 'LEAD');
    await onTeam(teamAdmin.id, team.id, 'ADMIN');
    const requester = await makeUser(`req-${label}`, `Req ${label}`);
    if (opts.requesterOrg !== null) {
      await inOrg(requester.id, opts.requesterOrg ?? orgA);
    }
    return { requester, team };
  }

  const create = (userId: string, teamId: string, message = 'hi') =>
    createJoinRequest(fastify, { actor: actorOf(userId), context: ctx, message, teamId });
  const approve = (reviewer: string, teamId: string, requestId: string) =>
    approveAtTeamStep(fastify, { actor: actorOf(reviewer), context: ctx, requestId, teamId });

  async function created(userId: string, teamId: string, message?: string) {
    const out = await create(userId, teamId, message);
    if (!out.ok) {
      throw new Error(`setup failed: ${out.code}`);
    }
    return out.request.id;
  }

  const rowsOf = (requestId: string) =>
    prisma.joinRequestNotification.findMany({
      orderBy: [{ event: 'asc' }, { audience: 'asc' }],
      where: { requestId },
    });
  const shape = async (requestId: string) =>
    (await rowsOf(requestId))
      .map((r) => `${r.event}/${r.audience}/${r.channel}/${r.status}`)
      .sort();

  /** A request row that is not open, so any number can exist for one user and team. */
  const closedRequest = (userId: string, teamId: string) =>
    prisma.teamJoinRequest.create({ data: { status: 'REJECTED', teamId, userId } });

  async function queue(count: number, teamId: string, userId: string) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const request = await closedRequest(userId, teamId);
      const row = await prisma.joinRequestNotification.create({
        data: { audience: 'REQUESTER', channel: 'EMAIL', event: 'REJECTED', requestId: request.id },
      });
      ids.push(row.id);
    }
    return ids;
  }

  const quiet = { log: { error: () => undefined, warn: () => undefined } } as const;

  /* ── Writing ─────────────────────────────────────────────────────────────── */

  it('enqueues idempotently: a second enqueue of the same event writes nothing', async () => {
    const { requester, team } = await scenario('idem');
    const request = await closedRequest(requester.id, team.id);
    const input = {
      event: 'PENDING_ORG' as const,
      requestId: request.id,
      reviewerEmailEnabled: true,
      team: { hasSlackChannel: false },
    };
    const first = await prisma.$transaction((tx) => enqueueJoinRequestNotifications(tx, input));
    const second = await prisma.$transaction((tx) => enqueueJoinRequestNotifications(tx, input));
    expect([first, second]).toEqual([2, 0]);
    expect(await shape(request.id)).toEqual([
      'PENDING_ORG/ORG_ADMINS/EMAIL/PENDING',
      'PENDING_ORG/REQUESTER/EMAIL/PENDING',
    ]);
  });

  it('leaves no row when the transaction around the enqueue rolls back', async () => {
    const { requester, team } = await scenario('rb-unit');
    const request = await closedRequest(requester.id, team.id);
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueJoinRequestNotifications(tx, {
          event: 'REJECTED',
          requestId: request.id,
          reviewerEmailEnabled: true,
          team: { hasSlackChannel: false },
        });
        throw new Error('rolled back');
      })
    ).rejects.toThrow('rolled back');
    expect(await rowsOf(request.id)).toEqual([]);
  });

  it('leaves neither the request nor its notice when the service transaction fails after queueing', async () => {
    const { requester, team } = await scenario('rb-service');
    const real = prisma.$transaction.bind(prisma) as (
      fn: unknown,
      opts?: unknown
    ) => Promise<unknown>;
    vi.spyOn(prisma, '$transaction').mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown
    ) =>
      real(async (tx: unknown) => {
        await fn(tx);
        throw new Error('commit failed');
      }, opts)) as never);
    await expect(create(requester.id, team.id)).rejects.toThrow('commit failed');
    vi.restoreAllMocks();
    expect(
      await runUnscoped('test fixture: count', ['TeamJoinRequest'], () =>
        prisma.teamJoinRequest.count({ where: { teamId: team.id } })
      )
    ).toBe(0);
    expect(
      await prisma.joinRequestNotification.count({ where: { request: { teamId: team.id } } })
    ).toBe(0);
  });

  /** Runs `body` with every `joinRequestNotification.createMany` made on a transaction client failing. */
  async function withFailingQueue<T>(body: () => Promise<T>): Promise<T> {
    const real = prisma.$transaction.bind(prisma) as (
      fn: unknown,
      opts?: unknown
    ) => Promise<unknown>;
    vi.spyOn(prisma, '$transaction').mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown
    ) =>
      real(
        (tx: object) =>
          fn(
            new Proxy(tx, {
              get: (target, prop, receiver) =>
                prop === 'joinRequestNotification'
                  ? {
                      createMany: async () => {
                        throw new Error('queue down');
                      },
                    }
                  : Reflect.get(target, prop, receiver),
            })
          ),
        opts
      )) as never);
    try {
      return await body();
    } finally {
      vi.restoreAllMocks();
    }
  }

  /** Runs `body` with every audit write made on a transaction client failing (after the notice is queued). */
  async function withFailingAudit<T>(body: () => Promise<T>): Promise<T> {
    const real = prisma.$transaction.bind(prisma) as (
      fn: unknown,
      opts?: unknown
    ) => Promise<unknown>;
    vi.spyOn(prisma, '$transaction').mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown
    ) =>
      real(
        (tx: object) =>
          fn(
            new Proxy(tx, {
              get: (target, prop, receiver) =>
                prop === 'configAuditLog'
                  ? {
                      create: async () => {
                        throw new Error('audit down');
                      },
                    }
                  : Reflect.get(target, prop, receiver),
            })
          ),
        opts
      )) as never);
    try {
      return await body();
    } finally {
      vi.restoreAllMocks();
    }
  }

  const statusOf = (requestId: string) =>
    runUnscoped(
      'test fixture: one request',
      ['TeamJoinRequest'],
      async () =>
        (await prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: requestId } })).status
    );

  /**
   * Every decision queues its notice inside the transaction that decides: when the audit write that
   * follows fails, the decision and the notice roll back together; when it commits, exactly the
   * expected rows exist. Each case is one decision of the two-step flow.
   */
  const decisions: Array<{
    name: string;
    /** The requester belongs to another organization, so the request needs the organization step. */
    crossOrg?: boolean;
    /** Brings the request to the state the decision starts from. */
    prepare?: 'to-org-step';
    start: 'PENDING_TEAM' | 'PENDING_ORG';
    run: (w: { requestId: string; teamId: string }) => Promise<{ ok: boolean }>;
    added: string[];
    end: string;
  }> = [
    {
      added: ['APPROVED/REQUESTER/EMAIL/PENDING'],
      end: 'APPROVED',
      name: 'team-step approval',
      run: (w) => approve(lead.id, w.teamId, w.requestId),
      start: 'PENDING_TEAM',
    },
    {
      added: ['PENDING_ORG/ORG_ADMINS/EMAIL/PENDING', 'PENDING_ORG/REQUESTER/EMAIL/PENDING'],
      crossOrg: true,
      end: 'PENDING_ORG',
      name: 'team-step approval that moves on to the organization',
      run: (w) => approve(lead.id, w.teamId, w.requestId),
      start: 'PENDING_TEAM',
    },
    {
      added: ['REJECTED/REQUESTER/EMAIL/PENDING'],
      end: 'REJECTED',
      name: 'team-step rejection',
      run: (w) =>
        rejectAtTeamStep(fastify, {
          actor: actorOf(lead.id),
          context: ctx,
          requestId: w.requestId,
          teamId: w.teamId,
        }),
      start: 'PENDING_TEAM',
    },
    {
      added: ['APPROVED/REQUESTER/EMAIL/PENDING'],
      crossOrg: true,
      end: 'APPROVED',
      name: 'organization-step approval',
      prepare: 'to-org-step',
      run: (w) =>
        approveAtOrgStep(fastify, {
          actor: actorOf(orgAdmin.id),
          context: ctx,
          orgId: orgA,
          requestId: w.requestId,
        }),
      start: 'PENDING_ORG',
    },
    {
      added: ['REJECTED/REQUESTER/EMAIL/PENDING'],
      crossOrg: true,
      end: 'REJECTED',
      name: 'organization-step rejection',
      prepare: 'to-org-step',
      run: (w) =>
        rejectAtOrgStep(fastify, {
          actor: actorOf(orgAdmin.id),
          context: ctx,
          orgId: orgA,
          requestId: w.requestId,
        }),
      start: 'PENDING_ORG',
    },
  ];

  for (const decision of decisions) {
    it(`${decision.name}: queues its notice inside the deciding transaction`, async () => {
      for (const outcome of ['rolled back', 'committed'] as const) {
        const { requester, team } = await scenario(
          `tx-${decision.name.replaceAll(/\W+/g, '-')}-${outcome === 'committed' ? 'c' : 'r'}`,
          decision.crossOrg ? { requesterOrg: orgB } : {}
        );
        const requestId = await created(requester.id, team.id);
        if (decision.prepare === 'to-org-step') {
          expect((await approve(lead.id, team.id, requestId)).ok).toBe(true);
        }
        const before = await shape(requestId);
        expect(await statusOf(requestId)).toBe(decision.start);
        const wanted = { requestId, teamId: team.id };
        if (outcome === 'rolled back') {
          await expect(withFailingAudit(() => decision.run(wanted))).rejects.toThrow('audit down');
          // The decision is undone and so is the notice it queued.
          expect(await statusOf(requestId)).toBe(decision.start);
          expect(await shape(requestId)).toEqual(before);
        } else {
          expect((await decision.run(wanted)).ok).toBe(true);
          expect(await statusOf(requestId)).toBe(decision.end);
          expect(await shape(requestId)).toEqual([...before, ...decision.added].sort());
        }
      }
    });
  }

  it('undoes the request when its notice cannot be queued, and undoes a decision likewise', async () => {
    const { requester, team } = await scenario('queue-fails');
    await expect(withFailingQueue(() => create(requester.id, team.id))).rejects.toThrow(
      'queue down'
    );
    expect(
      await runUnscoped('test fixture: count', ['TeamJoinRequest'], () =>
        prisma.teamJoinRequest.count({ where: { teamId: team.id } })
      )
    ).toBe(0);

    const requestId = await created(requester.id, team.id);
    await expect(withFailingQueue(() => approve(lead.id, team.id, requestId))).rejects.toThrow(
      'queue down'
    );
    const row = await runUnscoped('test fixture: one request', ['TeamJoinRequest'], () =>
      prisma.teamJoinRequest.findUniqueOrThrow({ where: { id: requestId } })
    );
    expect(row.status).toBe('PENDING_TEAM');
    expect(
      await prisma.teamMembership.count({ where: { teamId: team.id, userId: requester.id } })
    ).toBe(0);
    expect(await shape(requestId)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);
  });

  it('writes the expected rows through the service, and none for a withdrawal or a system close', async () => {
    // New request, no channel: the reviewers are emailed.
    const a = await scenario('svc-a');
    const reqA = await created(a.requester.id, a.team.id);
    expect(await shape(reqA)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);

    // Team approval of a same-organization request: the requester hears.
    expect((await approve(lead.id, a.team.id, reqA)).ok).toBe(true);
    expect(await shape(reqA)).toEqual([
      'APPROVED/REQUESTER/EMAIL/PENDING',
      'CREATED/TEAM_REVIEWERS/EMAIL/PENDING',
    ]);

    // A cross-organization request: the team step queues the requester and the organization's
    // admins, and the organization step the requester's approval.
    const b = await scenario('svc-b', { requesterOrg: orgB });
    const reqB = await created(b.requester.id, b.team.id);
    expect((await approve(lead.id, b.team.id, reqB)).ok).toBe(true);
    expect(await shape(reqB)).toEqual([
      'CREATED/TEAM_REVIEWERS/EMAIL/PENDING',
      'PENDING_ORG/ORG_ADMINS/EMAIL/PENDING',
      'PENDING_ORG/REQUESTER/EMAIL/PENDING',
    ]);
    const orgStep = await approveAtOrgStep(fastify, {
      actor: actorOf(orgAdmin.id),
      context: ctx,
      orgId: orgA,
      requestId: reqB,
    });
    expect(orgStep.ok).toBe(true);
    expect((await shape(reqB)).filter((s) => s.startsWith('APPROVED'))).toEqual([
      'APPROVED/REQUESTER/EMAIL/PENDING',
    ]);

    // A rejection, a withdrawal and a system close.
    const c = await scenario('svc-c');
    const reqC = await created(c.requester.id, c.team.id);
    expect(
      (
        await rejectAtTeamStep(fastify, {
          actor: actorOf(lead.id),
          context: ctx,
          requestId: reqC,
          teamId: c.team.id,
        })
      ).ok
    ).toBe(true);
    expect(await shape(reqC)).toContain('REJECTED/REQUESTER/EMAIL/PENDING');

    const d = await scenario('svc-d');
    const reqD = await created(d.requester.id, d.team.id);
    await withdrawRequest(fastify, {
      actor: actorOf(d.requester.id),
      context: ctx,
      requestId: reqD,
    });
    expect(await shape(reqD)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);

    const e = await scenario('svc-e');
    const reqE = await created(e.requester.id, e.team.id);
    await prisma.$transaction((tx) =>
      closeOpenJoinRequests(fastify, tx, {
        actor: actorOf(platformAdmin.id),
        context: ctx,
        scope: { reason: 'TEAM_DEACTIVATED', teamId: e.team.id },
      })
    );
    expect(await shape(reqE)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);
  });

  it('picks the team channel only when a token resolves for it, else the reviewers; none when reviewer email is off', async () => {
    const withToken = await scenario('ch-ok', { channel: 'C-IT-OK' });
    expect(await shape(await created(withToken.requester.id, withToken.team.id))).toEqual([
      'CREATED/TEAM_CHANNEL/SLACK/PENDING',
    ]);
    const noToken = await scenario('ch-none', { channel: 'C-NOTOKEN' });
    expect(await shape(await created(noToken.requester.id, noToken.team.id))).toEqual([
      'CREATED/TEAM_REVIEWERS/EMAIL/PENDING',
    ]);
    await setGlobal('teams.joinRequestReviewerEmail', false);
    const off = await scenario('ch-off');
    expect(await shape(await created(off.requester.id, off.team.id))).toEqual([]);
  });

  /* ── Claiming ────────────────────────────────────────────────────────────── */

  it('never delivers a row twice when several pollers run at once (repeated rounds)', async () => {
    const { requester, team } = await scenario('conc');
    for (let round = 0; round < 5; round++) {
      const ids = await queue(24, team.id, requester.id);
      const delivered = new Map<string, number>();
      const deliver: NonNullable<RunOnceOptions['deliver']> = async (row) => {
        delivered.set(row.id, (delivered.get(row.id) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: 'delivered', reached: [] };
      };
      const poller = async () => {
        for (;;) {
          const result = await runOnce(prisma, { ...quiet, batchSize: 3, deliver, purge: false });
          if (result.claimed === 0) {
            return;
          }
        }
      };
      await Promise.all([poller(), poller(), poller(), poller()]);
      expect(delivered.size).toBe(ids.length);
      expect([...delivered.values()].every((n) => n === 1)).toBe(true);
      const statuses = await prisma.joinRequestNotification.findMany({
        select: { status: true },
        where: { id: { in: ids } },
      });
      expect(statuses.every((r) => r.status === 'DELIVERED')).toBe(true);
    }
  }, 120_000);

  it('skips a row another claimer holds instead of waiting for it', async () => {
    const { requester, team } = await scenario('skiplocked');
    const [held, ...others] = await queue(3, team.id, requester.id);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        // CLAUDE.md §7 exception: a row lock held across the claim, to see it passed over.
        await tx.$queryRaw`SELECT id FROM join_request_notifications WHERE id = ${held}::uuid FOR UPDATE`;
        locked();
        await hold;
      },
      { timeout: 30_000 }
    );
    await holding;
    try {
      // The holder keeps its lock until this test releases it below, so a claim that waited for the
      // row could never finish: the ceiling turns that into a failure instead of a hang.
      const claimed = await within(
        claimDueNotifications(prisma, new Date(Date.now() + 1000), 10, 60_000),
        'a claim that passes over the locked row'
      );
      expect(claimed.map((r) => r.id).sort()).toEqual([...others].sort());
    } finally {
      release();
      await holder;
    }
  });

  it('leases a claimed row so another poller does not take it, and gives it back after a crash', async () => {
    const { requester, team } = await scenario('lease');
    const [id] = await queue(1, team.id, requester.id);
    const t0 = new Date(Date.now() + 1000);
    // The claimer takes the row, then "crashes": it never records an outcome.
    const claimed = await claimDueNotifications(prisma, t0, 20, 60_000);
    expect(claimed.map((r) => r.id)).toEqual([id]);

    const seen: string[] = [];
    const deliver: NonNullable<RunOnceOptions['deliver']> = async (row) => {
      seen.push(row.id);
      return { kind: 'delivered', reached: [] };
    };
    const during = await runOnce(prisma, {
      ...quiet,
      deliver,
      now: () => new Date(t0.getTime() + 30_000),
      purge: false,
    });
    expect(during.claimed).toBe(0);

    const after = await runOnce(prisma, {
      ...quiet,
      deliver,
      now: () => new Date(t0.getTime() + 61_000),
      purge: false,
    });
    expect(after).toMatchObject({ claimed: 1, delivered: 1 });
    expect(seen).toEqual([id]);
    expect((await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id } })).status).toBe(
      'DELIVERED'
    );
  });

  it('backs off 30 s, 2 min, 10 min, 1 h, 6 h and is FAILED after the sixth failed attempt', async () => {
    const { requester, team } = await scenario('backoff');
    const [id] = await queue(1, team.id, requester.id);
    let now = new Date(Date.now() + 1000);
    await prisma.joinRequestNotification.update({ data: { nextAttemptAt: now }, where: { id } });
    const failing: NonNullable<RunOnceOptions['deliver']> = async () => ({
      code: 'transport_error',
      kind: 'failed',
      reached: [],
    });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = await runOnce(prisma, {
        ...quiet,
        deliver: failing,
        now: () => now,
        purge: false,
      });
      expect(result).toMatchObject({ claimed: 1, failed: 1 });
      const row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id } });
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe('transport_error');
      if (attempt < 6) {
        const delay = NOTIFICATION_BACKOFF_MS[attempt - 1] as number;
        expect(row.status).toBe('PENDING');
        expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + delay);
        // Not due one millisecond early.
        const early = await runOnce(prisma, {
          ...quiet,
          deliver: failing,
          now: () => new Date(row.nextAttemptAt.getTime() - 1),
          purge: false,
        });
        expect(early.claimed).toBe(0);
        now = row.nextAttemptAt;
      } else {
        expect(row.status).toBe('FAILED');
      }
    }
    // A failed row is never claimed again.
    const later = await runOnce(prisma, {
      ...quiet,
      deliver: failing,
      now: () => new Date(now.getTime() + 365 * 86_400_000),
      purge: false,
    });
    expect(later.claimed).toBe(0);
  });

  /* ── Admin routes ────────────────────────────────────────────────────────── */

  it('lists the rows newest first without addresses, filters by status, pages by cursor, and retries a FAILED row', async () => {
    const { requester, team } = await scenario('admin');
    const ids = await queue(3, team.id, requester.id);
    await prisma.joinRequestNotification.update({
      data: {
        attempts: 6,
        lastError: 'transport_error',
        reached: [reachedKey('someone@example.test')],
        status: 'FAILED',
      },
      where: { id: ids[0] as string },
    });
    const call = (method: 'GET' | 'POST', url: string, as = platformAdmin.id) =>
      app.inject({ headers: { authorization: `Bearer ${as}` }, method, url });

    const all = await call('GET', '/api/v1/platform/join-request-notifications?limit=2');
    expect(all.statusCode).toBe(200);
    const page = all.json() as {
      data: Array<Record<string, unknown>>;
      meta: { nextCursor: string | null };
    };
    expect(page.data).toHaveLength(2);
    expect(page.meta.nextCursor).toBeTruthy();
    const next = (
      await call(
        'GET',
        `/api/v1/platform/join-request-notifications?limit=2&cursor=${page.meta.nextCursor}`
      )
    ).json() as { data: Array<{ id: string }> };
    const listed = [...page.data, ...next.data].map((r) => r.id);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.slice(0, 3)).toEqual([...ids].reverse());
    for (const row of page.data) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'attempts',
          'audience',
          'channel',
          'createdAt',
          'deliveredAt',
          'event',
          'id',
          'lastError',
          'nextAttemptAt',
          'requestId',
          'status',
          'teamId',
          'teamName',
          'updatedAt',
        ].sort()
      );
      expect(row.teamName).toBe(team.name);
    }
    expect(all.body).not.toContain('example.test');
    expect(all.body).not.toContain('reached');

    const failed = (
      await call('GET', '/api/v1/platform/join-request-notifications?status=FAILED')
    ).json() as {
      data: Array<{ id: string; status: string }>;
    };
    // Other suites' rows may also be FAILED in a shared database; only this test's own are counted.
    expect(failed.data.map((r) => r.id).filter((id) => ids.includes(id))).toEqual([ids[0]]);
    expect(
      (await call('GET', '/api/v1/platform/join-request-notifications?cursor=%%%')).statusCode
    ).toBe(400);

    // Only a platform admin.
    expect(
      (await call('GET', '/api/v1/platform/join-request-notifications', lead.id)).statusCode
    ).toBe(403);
    expect(
      (await call('POST', `/api/v1/platform/join-request-notifications/${ids[0]}/retry`, lead.id))
        .statusCode
    ).toBe(403);

    // Retry: only FAILED, once.
    const retry = await call('POST', `/api/v1/platform/join-request-notifications/${ids[0]}/retry`);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      data: { attempts: 0, id: ids[0], lastError: null, status: 'PENDING' },
    });
    const row = await prisma.joinRequestNotification.findUniqueOrThrow({
      where: { id: ids[0] as string },
    });
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    const again = await call('POST', `/api/v1/platform/join-request-notifications/${ids[0]}/retry`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'NOTIFICATION_NOT_FAILED' } });
    const pending = await call(
      'POST',
      `/api/v1/platform/join-request-notifications/${ids[1]}/retry`
    );
    expect(pending.statusCode).toBe(409);
    const missing = await call(
      'POST',
      `/api/v1/platform/join-request-notifications/${crypto.randomUUID()}/retry`
    );
    expect(missing.statusCode).toBe(404);
    // The retried row is due: the next tick sends it.
    const delivered: string[] = [];
    await runOnce(prisma, {
      ...quiet,
      deliver: async (r) => {
        delivered.push(r.id);
        return { kind: 'delivered', reached: [] };
      },
      purge: false,
    });
    expect(delivered).toContain(ids[0]);
  });

  /* ── Retention ───────────────────────────────────────────────────────────── */

  it('purges delivered, skipped and failed rows past the retention period, and keeps the rest', async () => {
    const { requester, team } = await scenario('purge');
    const ids = await queue(5, team.id, requester.id);
    const [delivered, skipped, failed, fresh, pending] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    const old = new Date(Date.now() - 10 * 86_400_000);
    await setGlobal('teams.joinRequestNotificationRetentionDays', 7);
    for (const [id, status] of [
      [delivered, 'DELIVERED'],
      [skipped, 'SKIPPED'],
      [failed, 'FAILED'],
    ] as const) {
      await prisma.joinRequestNotification.update({
        data: { status, updatedAt: old },
        where: { id },
      });
    }
    await prisma.joinRequestNotification.update({
      data: { status: 'DELIVERED' },
      where: { id: fresh },
    });
    // A pending row of any age is never deleted (and is not due, so the tick leaves it alone).
    await prisma.joinRequestNotification.update({
      data: { nextAttemptAt: new Date(Date.now() + 86_400_000), updatedAt: old },
      where: { id: pending },
    });
    const result = await runOnce(prisma, quiet);
    expect(result.purged).toBe(3);
    const left = await prisma.joinRequestNotification.findMany({
      select: { id: true },
      where: { id: { in: ids } },
    });
    expect(left.map((r) => r.id).sort()).toEqual([fresh, pending].sort());
  });

  /* ── Skips, with the real delivery ───────────────────────────────────────── */

  it('skips with the fixed codes: kill switch, changed state, inactive requester, no transport', async () => {
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'AUTH_FROM_EMAIL', 'RESEND_API_KEY']) {
      delete process.env[key];
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Kill switch.
    await setGlobal('teams.joinRequestNotifications', false);
    const off = await scenario('skip-off');
    const reqOff = await created(off.requester.id, off.team.id);
    await runOnce(prisma, { ...quiet, purge: false });
    expect((await rowsOf(reqOff)).map((r) => [r.status, r.lastError])).toEqual([
      ['SKIPPED', 'notifications_disabled'],
    ]);
    await clearGlobal('teams.joinRequestNotifications');

    // The request was decided before the poller ran: the "new request" notice is stale; the
    // requester's approval has no email transport.
    const stale = await scenario('skip-stale');
    const reqStale = await created(stale.requester.id, stale.team.id);
    await approve(lead.id, stale.team.id, reqStale);
    await runOnce(prisma, { ...quiet, purge: false });
    expect(
      (await rowsOf(reqStale)).map((r) => `${r.event}:${r.status}:${r.lastError}`).sort()
    ).toEqual([
      'APPROVED:SKIPPED:transport_not_configured',
      'CREATED:SKIPPED:request_state_changed',
    ]);

    // The requester was deactivated.
    const gone = await scenario('skip-gone');
    const reqGone = await created(gone.requester.id, gone.team.id);
    await prisma.user.update({ data: { isActive: false }, where: { id: gone.requester.id } });
    await runOnce(prisma, { ...quiet, purge: false });
    expect((await rowsOf(reqGone)).map((r) => [r.status, r.lastError])).toEqual([
      ['SKIPPED', 'party_inactive'],
    ]);

    // No transport: the reviewers' row is skipped, once, with one warning for the process.
    const bare = await scenario('skip-bare');
    const reqBare = await created(bare.requester.id, bare.team.id);
    const bare2 = await scenario('skip-bare2');
    const reqBare2 = await created(bare2.requester.id, bare2.team.id);
    await runOnce(prisma, { ...quiet, purge: false });
    for (const id of [reqBare, reqBare2]) {
      expect((await rowsOf(id)).map((r) => [r.status, r.lastError, r.attempts])).toEqual([
        ['SKIPPED', 'transport_not_configured', 0],
      ]);
    }
    expect(warn.mock.calls.filter((c) => /no email transport/.test(String(c[0])))).toHaveLength(1);
  });

  /* ── Real transports ─────────────────────────────────────────────────────── */

  describe('real SMTP and Slack-shaped servers', () => {
    const sink = new SmtpSink();
    const slack = new SlackStub();

    beforeAll(async () => {
      await sink.start();
      await slack.start();
    });
    afterAll(async () => {
      await sink.stop();
      await slack.stop();
    });

    const useSink = (port = sink.port) => {
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = String(port);
      process.env.AUTH_FROM_EMAIL = 'noreply@auto-swe.test';
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      delete process.env.RESEND_API_KEY;
    };

    const reset = () => {
      sink.messages.length = 0;
      sink.refuse.clear();
      slack.calls.length = 0;
      slack.answer = 'ok';
    };

    const tick = (at: Date, extra: Partial<RunOnceOptions> = {}) =>
      runOnce(prisma, {
        ...quiet,
        now: () => at,
        purge: false,
        slackApiBase: slack.base,
        ...extra,
      });

    /** Past every backoff, so a retried row is due. */
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    it('emails the reviewers of a team with no channel, naming the requester by name only', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('smtp-rev');
      await prisma.user.update({
        data: { name: 'Ann <!channel> <b>Bold</b>' },
        where: { id: requester.id },
      });
      const requestId = await created(requester.id, team.id, 'let me in <script>alert(1)</script>');
      const result = await tick(later(1));
      expect(result).toMatchObject({ claimed: 1, delivered: 1 });

      expect(sink.messages.map((m) => m.to.join(',')).sort()).toEqual(
        [lead.email, teamAdmin.email].map((e) => e as string).sort()
      );
      for (const message of sink.messages) {
        expect(message.from).toBe('noreply@auto-swe.test');
        expect(message.subject).toBe(`Ann <!channel> <b>Bold</b> asked to join ${team.name}`);
        // Escaped in the HTML part, never as live markup (the plain-text part is not markup).
        const html = message.data.slice(message.data.indexOf('Content-Type: text/html'));
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>Bold</b>');
        expect(html).toContain('Ann &lt;!channel&gt; &lt;b&gt;Bold&lt;/b&gt;');
        expect(message.data).toContain(`https://app.test.example/teams/${team.slug}/members`);
        // The requester's address is nowhere in what the reviewers receive.
        expect(message.data).not.toContain(requester.email as string);
        expect(message.data).not.toContain(name('req-smtp-rev'));
      }

      const [row] = await rowsOf(requestId);
      expect(row).toMatchObject({ attempts: 0, lastError: null, status: 'DELIVERED' });
      expect(row?.deliveredAt).toBeTruthy();
      // What is recorded is a hash per recipient, never an address.
      expect(row?.reached).toEqual(
        [lead.email, teamAdmin.email].map((e) => reachedKey(e as string))
      );
      expect(JSON.stringify(row?.reached)).not.toContain('@');
      expect(slack.calls).toHaveLength(0);
    });

    it('does not send a delivered row again', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('smtp-once');
      await created(requester.id, team.id);
      await tick(later(1));
      expect(sink.messages).toHaveLength(2);
      const again = await tick(later(60));
      expect(again.claimed).toBe(0);
      expect(sink.messages).toHaveLength(2);
    });

    it('retries a refused connection after 30 seconds, then delivers once the server is back', async () => {
      reset();
      useSink(await closedPort());
      const { requester, team } = await scenario('smtp-down');
      const requestId = await created(requester.id, team.id);
      const t0 = later(1);
      const first = await tick(t0);
      expect(first).toMatchObject({ claimed: 1, failed: 1 });
      let row = (await rowsOf(requestId))[0];
      expect(row).toMatchObject({ attempts: 1, lastError: 'transport_error', status: 'PENDING' });
      expect(row?.nextAttemptAt.getTime()).toBe(t0.getTime() + 30_000);
      // The error code is fixed: no message, address or host.
      expect(row?.lastError).not.toMatch(/127\.0\.0\.1|ECONN|@/);
      expect(sink.messages).toHaveLength(0);

      // Not yet due.
      expect((await tick(new Date(t0.getTime() + 29_000))).claimed).toBe(0);

      useSink();
      const second = await tick(new Date(t0.getTime() + 31_000));
      expect(second).toMatchObject({ claimed: 1, delivered: 1 });
      row = (await rowsOf(requestId))[0];
      expect(row).toMatchObject({ lastError: null, status: 'DELIVERED' });
      expect(sink.messages).toHaveLength(2);
    });

    it('retries a partly failed fan-out only for the recipient that failed', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('smtp-partial');
      const requestId = await created(requester.id, team.id);
      sink.refuse.add((teamAdmin.email as string).toLowerCase());
      const t0 = later(1);
      await tick(t0);
      let row = (await rowsOf(requestId))[0];
      expect(row).toMatchObject({ attempts: 1, lastError: 'transport_error', status: 'PENDING' });
      expect(row?.reached).toEqual([reachedKey(lead.email as string)]);
      expect(sink.messages.map((m) => m.to.join(','))).toEqual([lead.email]);

      sink.refuse.clear();
      await tick(new Date(t0.getTime() + 31_000));
      row = (await rowsOf(requestId))[0];
      expect(row?.status).toBe('DELIVERED');
      // The lead was not emailed a second time.
      expect(sink.messages.map((m) => m.to.join(',')).sort()).toEqual(
        [lead.email, teamAdmin.email].map((e) => e as string).sort()
      );
    });

    it('emails the requester a decision, with the note escaped', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('smtp-decision');
      const requestId = await created(requester.id, team.id);
      await tick(later(1)); // the reviewers' notice
      sink.messages.length = 0;
      const out = await approveAtTeamStep(fastify, {
        actor: actorOf(lead.id),
        context: ctx,
        note: 'welcome <!here> & co',
        requestId,
        teamId: team.id,
      });
      expect(out.ok).toBe(true);
      await tick(later(2));
      expect(sink.messages).toHaveLength(1);
      const [message] = sink.messages;
      expect(message?.to).toEqual([requester.email]);
      expect(message?.subject).toBe(`You joined ${team.name}`);
      expect(message?.data).toContain('welcome &lt;!here&gt; &amp; co');
      expect(message?.data).toContain(`https://app.test.example/teams/${team.slug}`);
    });

    it('posts to the team channel through the Slack API with the token, escaped, without the requester address', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('slack-ok', { channel: 'C-IT-OK' });
      await prisma.user.update({ data: { name: 'Ann <!channel>' }, where: { id: requester.id } });
      const requestId = await created(requester.id, team.id, 'hello <!here> <@U123>');
      const result = await tick(later(1));
      expect(result).toMatchObject({ claimed: 1, delivered: 1 });
      expect(slack.calls).toHaveLength(1);
      const [call] = slack.calls;
      expect(call?.url).toBe('/api/chat.postMessage');
      expect(call?.authorization).toBe('Bearer xoxb-it-token');
      expect(call?.body.channel).toBe('C-IT-OK');
      const text = call?.body.text ?? '';
      expect(text).toContain('*Ann &lt;!channel&gt;* asked to join');
      expect(text).toContain('hello &lt;!here&gt; &lt;@U123&gt;');
      expect(text).not.toContain('<!channel>');
      expect(text).not.toContain('<!here>');
      expect(text).toContain(
        `<https://app.test.example/teams/${team.slug}/members|Review the request>`
      );
      expect(JSON.stringify(call)).not.toContain(requester.email as string);
      // Slack takes the place of the reviewers' email.
      expect(sink.messages).toHaveLength(0);
      expect(await shape(requestId)).toEqual(['CREATED/TEAM_CHANNEL/SLACK/DELIVERED']);
    });

    it('retries a Slack error and never sends a delivered post twice', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('slack-err', { channel: 'C-IT-ERR' });
      const requestId = await created(requester.id, team.id);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      slack.answer = { error: 'channel_not_found' };
      const t0 = later(1);
      await tick(t0);
      let row = (await rowsOf(requestId))[0];
      expect(row).toMatchObject({ attempts: 1, lastError: 'slack_error', status: 'PENDING' });
      expect(row?.nextAttemptAt.getTime()).toBe(t0.getTime() + 30_000);

      slack.answer = 'ok';
      await tick(new Date(t0.getTime() + 31_000));
      row = (await rowsOf(requestId))[0];
      expect(row?.status).toBe('DELIVERED');
      expect(slack.calls).toHaveLength(2);
      await tick(new Date(t0.getTime() + 120_000));
      expect(slack.calls).toHaveLength(2);
    });

    it('does not follow a Slack redirect, so the token never reaches another host', async () => {
      reset();
      useSink();
      const elsewhere = new SlackStub();
      await elsewhere.start();
      try {
        const { requester, team } = await scenario('slack-redirect', { channel: 'C-IT-RD' });
        const requestId = await created(requester.id, team.id);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        slack.answer = { redirectTo: `http://127.0.0.1:${elsewhere.port}/api/chat.postMessage` };
        await tick(later(1));
        expect(elsewhere.calls).toHaveLength(0);
        expect((await rowsOf(requestId))[0]).toMatchObject({
          lastError: 'slack_error',
          status: 'PENDING',
        });
      } finally {
        await elsewhere.stop();
      }
    });

    it('falls back to the reviewers by email when the team channel has no token', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('slack-fallback', { channel: 'C-NOTOKEN-1' });
      const requestId = await created(requester.id, team.id);
      expect(await shape(requestId)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);
      await tick(later(1));
      expect(slack.calls).toHaveLength(0);
      expect(sink.messages).toHaveLength(2);
    });

    it('emails the organization admins and the requester when a cross-organization request moves to the organization', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('smtp-org', { requesterOrg: orgB });
      const requestId = await created(requester.id, team.id);
      await tick(later(1));
      sink.messages.length = 0;
      expect((await approve(lead.id, team.id, requestId)).ok).toBe(true);
      await tick(later(2));
      const byRecipient = new Map(sink.messages.map((m) => [m.to.join(','), m]));
      expect([...byRecipient.keys()].sort()).toEqual(
        [orgAdmin.email, requester.email].map((e) => e as string).sort()
      );
      expect(byRecipient.get(orgAdmin.email as string)?.subject).toBe(
        `A request to join ${team.name} needs your approval`
      );
      expect(byRecipient.get(orgAdmin.email as string)?.data).not.toContain(
        requester.email as string
      );
      expect(byRecipient.get(requester.email as string)?.subject).toContain('is waiting for');
    });

    it('emails only the active leads and admins of the team, never members and never an inactive lead', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('smtp-roles');
      const plainMember = await makeUser('roles-member');
      const memberTwo = await makeUser('roles-member-two');
      const inactiveLead = await makeUser('roles-inactive-lead');
      await inOrg(plainMember.id, orgA);
      await onTeam(plainMember.id, team.id, 'MEMBER');
      await onTeam(memberTwo.id, team.id, 'MEMBER');
      await onTeam(inactiveLead.id, team.id, 'LEAD');
      await prisma.user.update({ data: { isActive: false }, where: { id: inactiveLead.id } });
      await created(requester.id, team.id);
      const result = await tick(later(1));
      expect(result).toMatchObject({ claimed: 1, delivered: 1 });
      // `scenario` gives the team its lead and its admin; those two alone are told.
      expect(sink.messages.map((m) => m.to.join(',')).sort()).toEqual(
        [lead.email, teamAdmin.email].map((e) => e as string).sort()
      );
    });

    /* ── Leases, and what a late claimer may write ───────────────────────── */

    /** A team with three active reviewers, and a request waiting for them. */
    async function threeReviewers(label: string) {
      const { requester, team } = await scenario(label);
      const third = await makeUser(`${label}-third`);
      await onTeam(third.id, team.id, 'LEAD');
      const requestId = await created(requester.id, team.id);
      const [row] = await rowsOf(requestId);
      return { requestId, rowId: (row as { id: string }).id, team, third };
    }

    it('stops a poller that lost its lease: it sends no further recipient and records nothing', async () => {
      reset();
      useSink();
      const { requestId, rowId } = await threeReviewers('lease-slow');
      // The sink holds each poller's first message until the test says so, so "mid-send" is a
      // state the test waits for, not a duration it hopes to land in.
      const firstHold = sink.holdNextAccept();
      const secondHold = sink.holdNextAccept();
      try {
        const first = runOnce(prisma, {
          ...quiet,
          leaseMs: 60_000,
          purge: false,
          slackApiBase: slack.base,
        });
        await within(firstHold.arrived, 'the first poller to be inside its first send');
        expect(sink.messages).toHaveLength(1);

        // The first poller's lease has run out as far as a second poller can tell: its clock reads
        // later than the lease end, so the row is due again and the second poller claims it.
        const pastLease = new Date(Date.now() + 10 * 60_000);
        const second = runOnce(prisma, {
          ...quiet,
          leaseMs: 60_000,
          now: () => pastLease,
          purge: false,
        });
        await within(secondHold.arrived, 'the second poller to be inside its first send');
        expect(sink.messages).toHaveLength(2);

        // The first poller's send now completes. It must not write what it reached, and must not
        // go on to a second recipient.
        firstHold.release();
        const firstResult = await within(first, 'the first poller to stop');
        expect(firstResult).toMatchObject({ delivered: 0, failed: 0, leaseLost: 1, skipped: 0 });
        expect(sink.messages).toHaveLength(2);
        // The second poller holds the row and has recorded nothing yet; the first one wrote nothing.
        expect(
          await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } })
        ).toMatchObject({ attempts: 0, reached: [], status: 'PENDING' });

        secondHold.release();
        const secondResult = await within(second, 'the second poller to finish');
        expect(secondResult).toMatchObject({ claimed: 1, delivered: 1 });
      } finally {
        firstHold.release();
        secondHold.release();
      }

      const perRecipient = new Map<string, number>();
      for (const m of sink.messages) {
        perRecipient.set(m.to.join(','), (perRecipient.get(m.to.join(',')) ?? 0) + 1);
      }
      // The recipient in flight when the lease ended is the one unavoidable repeat; nobody else is.
      const counts = [...perRecipient.values()].sort();
      expect(counts).toEqual([1, 1, 2]);
      expect(sink.messages).toHaveLength(4);

      const row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row).toMatchObject({ attempts: 0, lastError: null, status: 'DELIVERED' });
      // The second poller's record stands: all three recipients, not the first poller's one.
      expect(row.reached as string[]).toHaveLength(3);
      expect(await shape(requestId)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/DELIVERED']);
    }, 60_000);

    it('extends the lease before each row of a batch, so a row waiting behind a slow one is not taken', async () => {
      reset();
      const { requester, team } = await scenario('lease-batch');
      const ids = await queue(2, team.id, requester.id);
      const calls = new Map<string, number>();
      // Time is the injected clock. A claim leases both rows to base + LEASE. The claimer reaches
      // the second row once the clock has moved on by 0.9 LEASE, so only a lease extended from
      // that moment reaches past the thief's clock at base + 1.1 LEASE.
      const LEASE = 60_000;
      const base = Date.now() + 1000;
      let clock = new Date(base);
      const inSecond = latch();
      const finishSecond = latch();
      let seen = 0;
      const claimerDeliver: NonNullable<RunOnceOptions['deliver']> = async (row) => {
        calls.set(row.id, (calls.get(row.id) ?? 0) + 1);
        seen += 1;
        if (seen === 1) {
          clock = new Date(base + 0.9 * LEASE);
          return { kind: 'delivered', reached: [] };
        }
        inSecond.open();
        await finishSecond.opened;
        return { kind: 'delivered', reached: [] };
      };
      const thiefDeliver: NonNullable<RunOnceOptions['deliver']> = async (row) => {
        calls.set(row.id, (calls.get(row.id) ?? 0) + 1);
        return { kind: 'delivered', reached: [] };
      };
      try {
        const first = runOnce(prisma, {
          ...quiet,
          batchSize: 2,
          deliver: claimerDeliver,
          leaseMs: LEASE,
          now: () => clock,
          purge: false,
        });
        await within(inSecond.opened, 'the claimer to reach the second row');
        const thief = await runOnce(prisma, {
          ...quiet,
          deliver: thiefDeliver,
          leaseMs: LEASE,
          now: () => new Date(base + 1.1 * LEASE),
          purge: false,
        });
        expect(thief.claimed).toBe(0);
        finishSecond.open();
        await within(first, 'the claimer to finish');
      } finally {
        finishSecond.open();
      }
      expect(ids.map((id) => calls.get(id))).toEqual([1, 1]);
      const rows = await prisma.joinRequestNotification.findMany({
        select: { status: true },
        where: { id: { in: ids } },
      });
      expect(rows.map((r) => r.status)).toEqual(['DELIVERED', 'DELIVERED']);
    }, 60_000);

    it('does not let a late outcome overwrite a row that changed under it', async () => {
      reset();
      const { requester, team } = await scenario('late');
      const run = async (change: (id: string) => Promise<void>) => {
        const [id] = await queue(1, team.id, requester.id);
        const claimed = latch();
        const gate = latch();
        const delivering = runOnce(prisma, {
          ...quiet,
          deliver: async () => {
            // Called only once the row is claimed and its lease extended.
            claimed.open();
            await gate.opened;
            return { kind: 'delivered', reached: ['late'] };
          },
          purge: false,
        });
        try {
          await within(claimed.opened, 'the poller to claim the row');
          // Change it as an admin or a purge would.
          await change(id as string);
        } finally {
          gate.open();
        }
        const result = await within(delivering, 'the poller to finish');
        return { id: id as string, result };
      };

      // An admin retried a failed row: it is PENDING again, due now, with a new lease marker.
      const retried = await run(async (id) => {
        await prisma.joinRequestNotification.update({
          data: { attempts: 6, lastError: 'transport_error', status: 'FAILED' },
          where: { id },
        });
        const res = await app.inject({
          headers: { authorization: `Bearer ${platformAdmin.id}` },
          method: 'POST',
          url: `/api/v1/platform/join-request-notifications/${id}/retry`,
        });
        expect(res.statusCode).toBe(200);
      });
      expect(retried.result.leaseLost).toBe(1);
      expect(
        await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: retried.id } })
      ).toMatchObject({ attempts: 0, lastError: null, status: 'PENDING' });
      // It is due again; take it out so the next case has the poller to itself.
      await prisma.joinRequestNotification.delete({ where: { id: retried.id } });

      // A row that is no longer PENDING keeps the status it has, whatever the late outcome says.
      const closed = await run(async (id) => {
        await prisma.joinRequestNotification.update({
          data: { lastError: 'party_inactive', status: 'SKIPPED' },
          where: { id },
        });
      });
      expect(closed.result.leaseLost).toBe(1);
      expect(
        await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: closed.id } })
      ).toMatchObject({ deliveredAt: null, lastError: 'party_inactive', status: 'SKIPPED' });

      // A purge removed the row: the late outcome writes nothing and creates nothing.
      const purged = await run(async (id) => {
        await prisma.joinRequestNotification.delete({ where: { id } });
      });
      expect(purged.result.leaseLost).toBe(1);
      expect(
        await prisma.joinRequestNotification.findUnique({ where: { id: purged.id } })
      ).toBeNull();
    }, 60_000);

    /* ── What a failure between two recipients must not erase ───────────── */

    /** How many messages the sink holds for one address. */
    const sentTo = (address: string) =>
      sink.messages.filter((m) => m.to.some((t) => t.toLowerCase() === address.toLowerCase()))
        .length;

    /**
     * Makes the Nth call of `kind` (`renew`: a lease extension, `persist`: a `reached` write) on the
     * outbox rows throw once, as a one-off database error would. Returns the restore function.
     */
    function failNth(kind: 'renew' | 'persist', nth: number): () => void {
      const delegate = prisma.joinRequestNotification;
      const real = delegate.updateMany.bind(delegate) as unknown as (args: {
        data: Record<string, unknown>;
      }) => Promise<unknown>;
      let seen = 0;
      const spy = vi.spyOn(delegate, 'updateMany').mockImplementation(((args: {
        data: Record<string, unknown>;
      }) => {
        const isRenew = 'nextAttemptAt' in args.data;
        const isPersist = !isRenew && 'reached' in args.data;
        if ((kind === 'renew' && isRenew) || (kind === 'persist' && isPersist)) {
          seen += 1;
          if (seen === nth) {
            return Promise.reject(new Error('a one-off database error'));
          }
        }
        return real(args);
      }) as never);
      return () => spy.mockRestore();
    }

    it('keeps the recipients already reached when the lease renewal between two recipients throws, and emails only the rest on retry', async () => {
      reset();
      useSink();
      const { requestId, rowId, third } = await threeReviewers('reached-renew');
      // Renewals: the row's (1st), then one before each recipient (2nd, 3rd, 4th). The 4th throws,
      // after the first two recipients were emailed and recorded.
      const restore = failNth('renew', 4);
      const t0 = later(1);
      try {
        const result = await tick(t0);
        expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });
      } finally {
        restore();
      }
      expect(sink.messages).toHaveLength(2);
      let row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row).toMatchObject({ attempts: 1, lastError: 'transport_error', status: 'PENDING' });
      expect([...(row.reached as string[])].sort()).toEqual(
        [reachedKey(lead.email as string), reachedKey(teamAdmin.email as string)].sort()
      );

      await tick(new Date(t0.getTime() + 31_000));
      row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row.status).toBe('DELIVERED');
      // Each of the three reviewers got exactly one copy.
      for (const address of [lead.email, teamAdmin.email, third.email]) {
        expect(sentTo(address as string), address as string).toBe(1);
      }
      expect(await shape(requestId)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/DELIVERED']);
    }, 60_000);

    it('records a recipient that was emailed even when writing it down failed, so the retry does not repeat it', async () => {
      reset();
      useSink();
      const { rowId, third } = await threeReviewers('reached-persist');
      // The third recipient is emailed, then the write that records it throws.
      const restore = failNth('persist', 3);
      const t0 = later(1);
      try {
        await tick(t0);
      } finally {
        restore();
      }
      expect(sink.messages).toHaveLength(3);
      let row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row).toMatchObject({ attempts: 1, status: 'PENDING' });
      expect(row.reached as string[]).toHaveLength(3);

      await tick(new Date(t0.getTime() + 31_000));
      row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row.status).toBe('DELIVERED');
      expect(sink.messages).toHaveLength(3);
      expect(sentTo(third.email as string)).toBe(1);
    }, 60_000);

    /* ── An abandoned send ───────────────────────────────────────────────── */

    it('abandons a send at its deadline for good: socket closed, no Resend fallback, recorded as a failed attempt, and sent again only by the retry', async () => {
      reset();
      useSink();
      // Resend is configured too, so a fallback WOULD be taken if the abandoned send were allowed one.
      process.env.RESEND_API_KEY = 'rk-it-never-used';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      const { requester, team } = await scenario('smtp-late');
      const requestId = await created(requester.id, team.id);
      // The relay reads the first message and then says nothing: its 250 comes only after the
      // deadline, when the sender has already given up.
      const hold = sink.holdNextAccept();
      const t0 = later(1);
      try {
        const result = await tick(t0, { emailDeadlineMs: 400 });
        expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });
        // The late acceptance changes nothing: the row is a failed attempt, not delivered.
        let row = (await rowsOf(requestId))[0];
        expect(row).toMatchObject({ attempts: 1, lastError: 'transport_error', status: 'PENDING' });
        expect(row?.deliveredAt).toBeNull();
        // Only the recipient after the abandoned one is recorded.
        expect(row?.reached).toEqual([reachedKey(teamAdmin.email as string)]);
        await within(
          (async () => {
            while (sink.openConnections > 0) {
              await new Promise((r) => setTimeout(r, 20));
            }
          })(),
          'the abandoned connection to be closed',
          5_000
        );
        hold.release();
        await new Promise((r) => setTimeout(r, 100));
        expect(fetchSpy).not.toHaveBeenCalled();
        row = (await rowsOf(requestId))[0];
        expect(row?.status).toBe('PENDING');
      } finally {
        hold.release();
      }

      // The abandoned message did reach the relay, and the retry sends it again: at-least-once.
      expect(sentTo(lead.email as string)).toBe(1);
      await tick(new Date(t0.getTime() + 31_000));
      expect((await rowsOf(requestId))[0]?.status).toBe('DELIVERED');
      expect(sentTo(lead.email as string)).toBe(2);
      expect(sentTo(teamAdmin.email as string)).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 60_000);

    /* ── Stopping ────────────────────────────────────────────────────────── */

    it('releases the rows it did not start when it is told to stop, and leaves a row whose lease it lost alone', async () => {
      reset();
      const { requester, team } = await scenario('stop-batch');
      const ids = await queue(4, team.id, requester.id);
      const t0 = later(1);
      let stopping = false;
      const delivered: string[] = [];
      const stolenUntil = new Date(t0.getTime() + 3_600_000);
      const result = await runOnce(prisma, {
        ...quiet,
        batchSize: 4,
        deliver: async (row) => {
          delivered.push(row.id);
          // The poller is told to stop while the first row is in flight; meanwhile an admin takes
          // the third row over.
          stopping = true;
          await prisma.joinRequestNotification.update({
            data: { nextAttemptAt: stolenUntil },
            where: { id: ids[2] as string },
          });
          return { kind: 'delivered', reached: [] };
        },
        now: () => t0,
        purge: false,
        shouldStop: () => stopping,
      });
      expect(delivered).toEqual([ids[0]]);
      expect(result).toMatchObject({ claimed: 4, delivered: 1, leaseLost: 1, released: 2 });
      const rows = new Map(
        (await prisma.joinRequestNotification.findMany({ where: { id: { in: ids } } })).map((r) => [
          r.id,
          r,
        ])
      );
      // The in-flight row was recorded normally.
      expect(rows.get(ids[0] as string)).toMatchObject({ attempts: 0, status: 'DELIVERED' });
      // The unstarted ones are due at once, still PENDING, no attempt counted.
      for (const id of [ids[1], ids[3]] as string[]) {
        expect(rows.get(id)).toMatchObject({ attempts: 0, lastError: null, status: 'PENDING' });
        expect(rows.get(id)?.nextAttemptAt.getTime()).toBe(t0.getTime());
      }
      // The row someone else holds keeps what they wrote.
      expect(rows.get(ids[2] as string)?.nextAttemptAt.getTime()).toBe(stolenUntil.getTime());
      // And a poller that is not stopping picks the released ones up at once.
      const next = await runOnce(prisma, {
        ...quiet,
        deliver: async () => ({ kind: 'delivered', reached: [] }),
        now: () => t0,
        purge: false,
      });
      expect(next).toMatchObject({ claimed: 2, delivered: 2 });
    }, 60_000);

    it('starts no new recipient once stopping: the row goes back due at once with what it reached, and no failed attempt', async () => {
      reset();
      useSink();
      const { rowId, third } = await threeReviewers('stop-mid-row');
      const t0 = later(1);
      // Stop as soon as the first recipient has been emailed.
      const result = await tick(t0, { shouldStop: () => sink.messages.length >= 1 });
      expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 0, released: 1 });
      expect(sink.messages).toHaveLength(1);
      let row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row).toMatchObject({ attempts: 0, lastError: null, status: 'PENDING' });
      expect(row.nextAttemptAt.getTime()).toBe(t0.getTime());
      expect(row.reached).toEqual([reachedKey(lead.email as string)]);

      // The next poller sends only the other two.
      await tick(t0);
      row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row.status).toBe('DELIVERED');
      expect(sink.messages).toHaveLength(3);
      expect(sentTo(lead.email as string)).toBe(1);
      expect(sentTo(third.email as string)).toBe(1);
    }, 60_000);

    it('aborts a send in flight when the gateway closes: the row is due at once, no attempt is counted, and the recipients reached stay recorded', async () => {
      reset();
      useSink();
      const { rowId, third } = await threeReviewers('stop-abort');
      // The first recipient is accepted at once; the relay reads the second and then says nothing.
      const pass = sink.holdNextAccept();
      const stuck = sink.holdNextAccept();
      pass.release();
      const controller = new AbortController();
      const t0 = later(1);
      const started = Date.now();
      try {
        const running = tick(t0, {
          shouldStop: () => controller.signal.aborted,
          signal: controller.signal,
        });
        await within(stuck.arrived, 'the relay to hold the second message');
        controller.abort();
        const result = await within(running, 'the tick to end soon after the abort', 10_000);
        // Nowhere near the 90 s message deadline, and not a failed attempt.
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 0, released: 1 });
      } finally {
        stuck.release();
      }
      let row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row).toMatchObject({ attempts: 0, lastError: null, status: 'PENDING' });
      // Due again now, not after the 10 minute lease.
      expect(row.nextAttemptAt.getTime()).toBe(t0.getTime());
      // Only the recipient the relay accepted is recorded; the aborted one is not, and nobody is lost.
      expect(row.reached).toEqual([reachedKey(lead.email as string)]);
      await within(
        (async () => {
          while (sink.openConnections > 0) {
            await new Promise((r) => setTimeout(r, 20));
          }
        })(),
        'the aborted connection to be closed',
        5_000
      );

      // The next poller sends the aborted recipient again (at least once: the relay had read it)
      // and the one never started; the first recipient is not repeated.
      await tick(t0);
      row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row.status).toBe('DELIVERED');
      expect(sentTo(lead.email as string)).toBe(1);
      expect(sentTo(teamAdmin.email as string)).toBe(2);
      expect(sentTo(third.email as string)).toBe(1);
    }, 60_000);

    it('records a recipient under the keyed hash and honours the unkeyed hash an earlier build wrote', async () => {
      reset();
      useSink();
      const { rowId } = await threeReviewers('reached-legacy');
      const legacy = crypto
        .createHash('sha256')
        .update(`join-request-reached:${(lead.email as string).toLowerCase()}`)
        .digest('hex')
        .slice(0, 32);
      await prisma.joinRequestNotification.update({
        data: { reached: [legacy] },
        where: { id: rowId },
      });
      await tick(later(1));
      const row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
      expect(row.status).toBe('DELIVERED');
      // The lead was not emailed again, the other two were.
      expect(sentTo(lead.email as string)).toBe(0);
      expect(sink.messages).toHaveLength(2);
      const reached = row.reached as string[];
      expect(reached).toContain(legacy);
      // What this build wrote is keyed, and carries nothing a plain hash of an address reproduces.
      const written = reached.filter((k) => k !== legacy);
      expect(written).toHaveLength(2);
      for (const key of written) {
        expect(key).toMatch(/^k1:[0-9a-f]{32}$/);
      }
      expect(written).toContain(reachedKey(teamAdmin.email as string));
    }, 60_000);

    it('survives a key rotation without resending, and costs one duplicate once the previous key is dropped', async () => {
      reset();
      useSink();
      const saved = {
        key: process.env.CONFIG_ENCRYPTION_KEY,
        previous: process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS,
        version: process.env.CONFIG_ENCRYPTION_KEY_VERSION,
      };
      const setKeys = (env: Record<string, string | undefined>) => {
        for (const [name, value] of Object.entries(env)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
        _resetKeyCacheForTests();
      };
      try {
        const { rowId } = await threeReviewers('reached-rotate');
        // First poller, under the original key: reaches the lead, then stops.
        const t0 = later(1);
        await tick(t0, { shouldStop: () => sink.messages.length >= 1 });
        expect(sink.messages).toHaveLength(1);

        const leadUnderOriginalKey = reachedKey(lead.email as string);

        // Rotated, previous key still configured: the lead is recognised, the other two are sent.
        const newKey = crypto.randomBytes(32).toString('base64');
        setKeys({
          CONFIG_ENCRYPTION_KEY: newKey,
          CONFIG_ENCRYPTION_KEY_PREVIOUS: saved.key,
          CONFIG_ENCRYPTION_KEY_VERSION: '2',
        });
        await tick(t0);
        let row = await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: rowId } });
        expect(row.status).toBe('DELIVERED');
        expect(sentTo(lead.email as string)).toBe(1);
        expect(sink.messages).toHaveLength(3);
        // The lead's entry keeps the key it was written under; the others are written under the new one.
        expect(row.reached).toContain(leadUnderOriginalKey);
        expect(row.reached).toContain(reachedKey(teamAdmin.email as string));
        expect(reachedKey(lead.email as string)).not.toBe(leadUnderOriginalKey);

        // A row that reached the lead under the ORIGINAL key, read once that key is gone entirely:
        // the lead is no longer recognised and is sent once more. Nobody is missed.
        setKeys({
          CONFIG_ENCRYPTION_KEY: saved.key,
          CONFIG_ENCRYPTION_KEY_PREVIOUS: undefined,
          CONFIG_ENCRYPTION_KEY_VERSION: saved.version,
        });
        const oldKeyLead = leadUnderOriginalKey;
        const second = await threeReviewers('reached-rotate-2');
        await prisma.joinRequestNotification.update({
          data: { reached: [oldKeyLead] },
          where: { id: second.rowId },
        });
        reset();
        setKeys({
          CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
          CONFIG_ENCRYPTION_KEY_VERSION: '3',
        });
        await tick(t0);
        row = await prisma.joinRequestNotification.findUniqueOrThrow({
          where: { id: second.rowId },
        });
        expect(row.status).toBe('DELIVERED');
        expect(sink.messages).toHaveLength(3);
        expect(sentTo(lead.email as string)).toBe(1);
        expect(sentTo(teamAdmin.email as string)).toBe(1);
        expect(sentTo(second.third.email as string)).toBe(1);
      } finally {
        setKeys({
          CONFIG_ENCRYPTION_KEY: saved.key,
          CONFIG_ENCRYPTION_KEY_PREVIOUS: saved.previous,
          CONFIG_ENCRYPTION_KEY_VERSION: saved.version,
        });
      }
    }, 60_000);

    /* ── The mutations that used to survive ──────────────────────────────── */

    it('posts nothing to Slack when the lease is lost between the check of the token and the post', async () => {
      reset();
      useSink();
      const { requester, team } = await scenario('slack-lease', { channel: 'C-IT-LEASE' });
      const requestId = await created(requester.id, team.id);
      const [row] = await rowsOf(requestId);
      const stolenUntil = new Date(Date.now() + 3_600_000);
      const realResolve = slackTokens.resolve;
      // The token lookup runs after the row's own renewal and before the renewal that guards the
      // post, so a change made here is a lease lost at exactly that point.
      slackTokens.resolve = async (channel) => {
        await prisma.joinRequestNotification.update({
          data: { nextAttemptAt: stolenUntil },
          where: { id: (row as { id: string }).id },
        });
        return realResolve(channel);
      };
      try {
        const result = await tick(later(1));
        expect(result).toMatchObject({ claimed: 1, delivered: 0, failed: 0, leaseLost: 1 });
      } finally {
        slackTokens.resolve = realResolve;
      }
      expect(slack.calls).toHaveLength(0);
      expect(
        await prisma.joinRequestNotification.findUniqueOrThrow({
          where: { id: (row as { id: string }).id },
        })
      ).toMatchObject({ attempts: 0, status: 'PENDING' });
    }, 60_000);

    it('does not purge a row that became PENDING between the purge selecting it and deleting it', async () => {
      const { requester, team } = await scenario('purge-race');
      const [id] = await queue(1, team.id, requester.id);
      const old = new Date(Date.now() - 10 * 86_400_000);
      await setGlobal('teams.joinRequestNotificationRetentionDays', 7);
      await prisma.joinRequestNotification.update({
        data: { attempts: 6, lastError: 'transport_error', status: 'FAILED', updatedAt: old },
        where: { id: id as string },
      });
      const delegate = prisma.joinRequestNotification;
      const real = delegate.deleteMany.bind(delegate) as (args: unknown) => Promise<unknown>;
      vi.spyOn(delegate, 'deleteMany').mockImplementation((async (args: unknown) => {
        // An admin's retry lands after the purge chose the row and before it deletes.
        await prisma.joinRequestNotification.update({
          data: { attempts: 0, lastError: null, nextAttemptAt: new Date(), status: 'PENDING' },
          where: { id: id as string },
        });
        return real(args);
      }) as never);
      const purged = await purgeOldNotifications(prisma, new Date());
      vi.restoreAllMocks();
      expect(purged).toBe(0);
      expect(
        await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: id as string } })
      ).toMatchObject({ attempts: 0, status: 'PENDING' });
    });

    /* ── Request creation never waits on, or fails with, the Slack lookup ── */

    it('creates the request with the reviewer-email audience when the Slack lookup throws, logging at most once a minute and never the error text', async () => {
      const { requester, team } = await scenario('slack-throws', { channel: 'C-THROWS-1' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let clock = 5_000_000;
      resetOutboxWarningsForTests(() => clock);
      const notes = () =>
        warn.mock.calls.filter((c) => /Slack configuration could not be read/.test(String(c[0])));
      const requestId = await created(requester.id, team.id);
      expect(await shape(requestId)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);
      expect(notes()).toHaveLength(1);
      expect(String(notes()[0]?.[0])).not.toContain('decrypted');

      // A second failure inside the minute is not logged again.
      clock += SLACK_LOOKUP_LOG_INTERVAL_MS - 1;
      const again = await scenario('slack-throws-2', { channel: 'C-THROWS-2' });
      const againId = await created(again.requester.id, again.team.id);
      expect(await shape(againId)).toEqual(['CREATED/TEAM_REVIEWERS/EMAIL/PENDING']);
      expect(notes()).toHaveLength(1);

      // One after the minute is.
      clock += 2;
      const third = await scenario('slack-throws-3', { channel: 'C-THROWS-3' });
      await created(third.requester.id, third.team.id);
      expect(notes()).toHaveLength(2);
    });

    it('fails the request when the database cannot answer the routing lookup, and leaves no row', async () => {
      const { requester, team } = await scenario('routing-db');
      const real = prisma.team.findUnique.bind(prisma.team) as (args: unknown) => Promise<unknown>;
      vi.spyOn(prisma.team, 'findUnique').mockImplementation(((args: {
        select?: Record<string, unknown>;
      }) => {
        // Only the routing lookup: it selects the Slack channel and nothing else.
        if (Object.keys(args.select ?? {}).join() === 'slackNotifyChannel') {
          return Promise.reject(new Error('the database went away'));
        }
        return real(args);
      }) as never);
      await expect(create(requester.id, team.id)).rejects.toThrow('the database went away');
      vi.restoreAllMocks();
      expect(
        await prisma.teamJoinRequest.count({ where: { teamId: team.id, userId: requester.id } })
      ).toBe(0);
      expect(
        await prisma.joinRequestNotification.count({ where: { request: { teamId: team.id } } })
      ).toBe(0);
    });

    it('looks up the Slack token before the transaction opens, never inside it', async () => {
      const { requester, team } = await scenario('slack-outside-tx', { channel: 'C-IT-TX' });
      let open = 0;
      const real = prisma.$transaction.bind(prisma) as (
        fn: unknown,
        opts?: unknown
      ) => Promise<unknown>;
      vi.spyOn(prisma, '$transaction').mockImplementation(((
        fn: (tx: unknown) => Promise<unknown>,
        opts?: unknown
      ) =>
        real(async (tx: unknown) => {
          open += 1;
          try {
            return await fn(tx);
          } finally {
            open -= 1;
          }
        }, opts)) as never);
      slackTokens.openTransactions = () => open;
      slackTokens.seenInTransaction.length = 0;
      try {
        const requestId = await created(requester.id, team.id);
        expect(await shape(requestId)).toEqual(['CREATED/TEAM_CHANNEL/SLACK/PENDING']);
        expect(slackTokens.seenInTransaction.length).toBeGreaterThan(0);
        expect(slackTokens.seenInTransaction.every((n) => n === 0)).toBe(true);
      } finally {
        slackTokens.openTransactions = () => 0;
      }
    });

    /* ── The admin retry is one transaction ─────────────────────────────── */

    it('re-queues nothing when the retry cannot be audited', async () => {
      const { requester, team } = await scenario('retry-audit');
      const [id] = await queue(1, team.id, requester.id);
      await prisma.joinRequestNotification.update({
        data: { attempts: 6, lastError: 'transport_error', status: 'FAILED' },
        where: { id: id as string },
      });
      const call = () =>
        app.inject({
          headers: { authorization: `Bearer ${platformAdmin.id}` },
          method: 'POST',
          url: `/api/v1/platform/join-request-notifications/${id}/retry`,
        });
      const failed = await withFailingAudit(call);
      expect(failed.statusCode).toBe(500);
      expect(
        await prisma.joinRequestNotification.findUniqueOrThrow({ where: { id: id as string } })
      ).toMatchObject({ attempts: 6, lastError: 'transport_error', status: 'FAILED' });
      // Once the audit works, the same retry goes through and is audited.
      const ok = await call();
      expect(ok.statusCode).toBe(200);
      expect(
        await prisma.configAuditLog.count({
          where: { entityId: id as string, entityType: 'JoinRequestNotification' },
        })
      ).toBe(1);
    });
  });
});
