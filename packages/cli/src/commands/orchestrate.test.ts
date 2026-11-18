import { ORCHESTRATION_REFUSAL_CODES } from '@auto-swe/shared/lib/orchestration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../lib/time.js';
import { runOrchestrateCommand } from './orchestrate.js';

// Polling sleeps resolve at once; the tests assert the interval they asked for instead.
vi.mock('../lib/time.js', () => ({ sleep: vi.fn(async () => undefined) }));

const ENV = { apiUrl: 'http://gw', token: 't' };
const REPO_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEAM_ID = '770e8400-e29b-41d4-a716-446655440000';
const ORCH_ID = '880e8400-e29b-41d4-a716-446655440000';
const CHILD_ID = '990e8400-e29b-41d4-a716-446655440000';
const CHILD_TWO = 'aa0e8400-e29b-41d4-a716-446655440000';
const APPROVAL_ID = 'bb0e8400-e29b-41d4-a716-446655440000';
const CONN_ID = 'cc0e8400-e29b-41d4-a716-446655440000';

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

interface Reply {
  status?: number;
  body: unknown;
}

type Responder = (c: Call) => Reply;

function detail(overrides: Record<string, unknown> = {}) {
  return {
    allowlist: ['contentWriter'],
    budget: {
      monthlyRemainingUsd: 12.5,
      percentUsed: 42,
      remainingUsd: null,
      tier: 'STANDARD',
      tokens: { cap: 2_000_000, kind: 'input', used: 840_000 },
    },
    budgetTier: 'STANDARD',
    canControl: true,
    childCount: 0,
    children: [],
    connections: [],
    cost: { childrenUsd: 0, orchestratorUsd: 0.5, totalUsd: 0.5 },
    costUsd: 0.5,
    createdAt: '2026-11-17T10:00:00.000Z',
    id: ORCH_ID,
    launchedById: 'u1',
    launchedByName: 'Ada',
    pendingApprovals: [],
    pendingAttach: null,
    repoAttachedAt: null,
    repoId: null,
    repoName: null,
    runningChildCount: 0,
    status: 'ACTIVE',
    teamId: TEAM_ID,
    teamName: 'payments',
    title: 'Investigate the retry logic',
    updatedAt: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

function message(id: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    authorId: null,
    body,
    childId: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    id,
    kind: 'TEXT',
    payload: null,
    role: 'USER',
    ...extra,
  };
}

/** Answers successive calls to one route with the given replies, repeating the last one. */
function sequence(replies: Reply[]): () => Reply {
  let i = 0;
  return () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    if (reply === undefined) {
      throw new Error('sequence needs at least one reply');
    }
    return reply;
  };
}

describe('auto-swe orchestrate', () => {
  let out: string[];
  let err: string[];
  let calls: Call[];
  let signals: AbortSignal[];
  let originalOut: typeof process.stdout.write;
  let originalErr: typeof process.stderr.write;
  let originalFetch: typeof globalThis.fetch;
  let originalWebUrl: string | undefined;
  let responder: Responder;
  /** Answers `GET …/events`; by default the stream is unavailable, so following polls. */
  let events: (c: Call) => Response;

  beforeEach(() => {
    out = [];
    err = [];
    calls = [];
    signals = [];
    vi.mocked(sleep).mockClear();
    originalOut = process.stdout.write;
    originalErr = process.stderr.write;
    originalFetch = globalThis.fetch;
    originalWebUrl = process.env.AUTO_SWE_WEB_URL;
    delete process.env.AUTO_SWE_WEB_URL;
    process.stdout.write = ((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    responder = () => ({
      body: { error: { code: 'NOT_FOUND', message: 'no route' } },
      status: 404,
    });
    events = () =>
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no stream' } }), {
        status: 404,
      });
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/events')) {
        const streamCall: Call = {
          headers: (init?.headers ?? {}) as Record<string, string>,
          method: String(init?.method ?? 'GET'),
          url: String(url),
        };
        calls.push(streamCall);
        signals.push(init?.signal as AbortSignal);
        return events(streamCall);
      }
      const call: Call = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        method: String(init?.method ?? 'GET'),
        url: String(url),
      };
      calls.push(call);
      const r = responder(call);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    globalThis.fetch = originalFetch;
    if (originalWebUrl === undefined) {
      delete process.env.AUTO_SWE_WEB_URL;
    } else {
      process.env.AUTO_SWE_WEB_URL = originalWebUrl;
    }
  });

  const run = (args: string[]) => runOrchestrateCommand(args, ENV);
  const stdout = () => out.join('');
  const stderr = () => err.join('');
  const posts = () => calls.filter((c) => c.method === 'POST');
  const launchOk = {
    body: { data: { orchestrationId: ORCH_ID, status: 'ACTIVE', workflowId: `orch-${ORCH_ID}` } },
    status: 201,
  };
  const repoLookup = {
    body: {
      data: [{ id: REPO_ID, organizationName: 'acme', repoName: 'payments' }],
      meta: { total: 1 },
    },
  };

  describe('start', () => {
    it('resolves the repository, sends repeated agents and connections, and prints the id and link', async () => {
      responder = (c) => {
        if (c.method === 'GET' && c.url.includes('/api/v1/repositories')) {
          return repoLookup;
        }
        return launchOk;
      };
      const code = await run([
        'start',
        'Investigate the retry logic',
        '--repo=acme/payments',
        '--agent=contentWriter',
        '--agent',
        'reviewer@3',
        `--connection=${CONN_ID}`,
        '--budget-tier=large',
      ]);
      expect(code).toBe(0);
      const launch = posts()[0];
      expect(launch?.url).toBe('http://gw/api/v1/orchestrations');
      expect(launch?.body).toEqual({
        allowlist: ['contentWriter', 'reviewer@3'],
        budgetTier: 'LARGE',
        connectionIds: [CONN_ID],
        deliveryDefault: 'none',
        repoId: REPO_ID,
        task: 'Investigate the retry logic',
      });
      expect(launch?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
      expect(stdout()).toContain(`Orchestration: ${ORCH_ID}`);
      expect(stdout()).toContain(`http://localhost:3000/orchestrations/${ORCH_ID}`);
      expect(stdout()).toContain(`auto-swe orchestrate messages ${ORCH_ID} --follow`);
    });

    it('omits connectionIds when none are given and reads AUTO_SWE_WEB_URL for the link', async () => {
      process.env.AUTO_SWE_WEB_URL = 'https://auto.example.com/';
      responder = (c) => (c.url.includes('repositories') ? repoLookup : launchOk);
      expect(
        await run(['start', 'Check it', '--repo=acme/payments', '--agent=contentWriter'])
      ).toBe(0);
      expect(posts()[0]?.body).not.toHaveProperty('connectionIds');
      expect(stdout()).toContain(`https://auto.example.com/orchestrations/${ORCH_ID}`);
    });

    it('starts a repo-less orchestration with --team and sends no repoId', async () => {
      responder = (c) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        return launchOk;
      };
      expect(
        await run([
          'start',
          'Summarise the incident',
          '--team=payments',
          '--agent=contentWriter',
          '--deliver=branch',
        ])
      ).toBe(0);
      expect(posts()[0]?.body).toEqual({
        allowlist: ['contentWriter'],
        budgetTier: 'STANDARD',
        deliveryDefault: 'branch',
        task: 'Summarise the incident',
        teamId: TEAM_ID,
      });
    });

    it('sends no allowlist without --agent and names the applied default in the output', async () => {
      responder = (c) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        return {
          body: {
            data: {
              allowlist: ['implementer', 'reviewer'],
              orchestrationId: ORCH_ID,
              status: 'ACTIVE',
              workflowId: `orch-${ORCH_ID}`,
              writeCapable: ['implementer'],
            },
          },
          status: 201,
        };
      };
      expect(await run(['start', 'Do it', '--team=payments'])).toBe(0);
      expect(posts()[0]?.body).not.toHaveProperty('allowlist');
      expect(stdout()).toContain(
        'Agents:        implementer (can change files), reviewer (platform default)'
      );
    });

    it('does not call a named allowlist the default', async () => {
      responder = (c) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        return {
          body: {
            data: {
              allowlist: ['reviewer'],
              orchestrationId: ORCH_ID,
              status: 'ACTIVE',
              workflowId: `orch-${ORCH_ID}`,
            },
          },
          status: 201,
        };
      };
      expect(await run(['start', 'Do it', '--team=payments', '--agent=reviewer'])).toBe(0);
      expect(stdout()).toContain('Agents:        reviewer\n');
    });

    it('explains an ALLOWLIST_REQUIRED refusal in plain words', async () => {
      responder = (c) =>
        c.url.endsWith('/api/v1/teams')
          ? { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } }
          : {
              body: { error: { code: 'ALLOWLIST_REQUIRED', message: 'raw' } },
              status: 400,
            };
      expect(await run(['start', 'Do it', '--team=payments'])).not.toBe(0);
      expect(stderr()).toContain('pass at least one --agent=<key>');
    });

    it('refuses a repo-less start without --team before any request', async () => {
      expect(await run(['start', 'Do it', '--agent=contentWriter'])).toBe(1);
      expect(stderr()).toContain('needs the team that owns it');
      expect(calls).toHaveLength(0);
    });

    it('refuses an unknown team slug', async () => {
      responder = () => ({ body: { data: [] } });
      expect(await run(['start', 'Do it', '--team=nobody', '--agent=contentWriter'])).toBe(1);
      expect(stderr()).toContain('No team with slug "nobody"');
      expect(posts()).toHaveLength(0);
    });

    it('uses a caller-supplied Idempotency-Key', async () => {
      responder = (c) => (c.url.includes('repositories') ? repoLookup : launchOk);
      await run([
        'start',
        'Do it',
        '--repo=acme/payments',
        '--agent=contentWriter',
        '--idempotency-key=launch-42',
      ]);
      expect(posts()[0]?.headers['Idempotency-Key']).toBe('launch-42');
    });

    it('prints only the launch response with --json', async () => {
      responder = (c) => (c.url.includes('repositories') ? repoLookup : launchOk);
      expect(
        await run(['start', 'Do it', '--repo=acme/payments', '--agent=contentWriter', '--json'])
      ).toBe(0);
      expect(JSON.parse(stdout())).toEqual(launchOk.body.data);
    });

    it('refuses --json together with --wait', async () => {
      responder = (c) => (c.url.includes('repositories') ? repoLookup : launchOk);
      expect(
        await run([
          'start',
          'Do it',
          '--repo=acme/payments',
          '--agent=contentWriter',
          '--json',
          '--wait',
        ])
      ).toBe(1);
      expect(stderr()).toContain('cannot be combined');
      expect(posts()).toHaveLength(0);
    });

    it.each([
      [
        'a bad budget tier',
        ['start', 'Do it', '--team=payments', '--agent=a', '--budget-tier=HUGE'],
      ],
      ['a bad delivery', ['start', 'Do it', '--team=payments', '--agent=a', '--deliver=merge']],
      [
        'a non-UUID connection',
        ['start', 'Do it', '--team=payments', '--agent=a', '--connection=nope'],
      ],
      ['a malformed agent key', ['start', 'Do it', '--team=payments', '--agent=bad key!']],
      ['an empty task', ['start', '   ', '--team=payments', '--agent=a']],
      ['an unquoted task', ['start', 'Do', 'it', '--team=payments', '--agent=a']],
      ['no task', ['start', '--team=payments', '--agent=a']],
      ['a bare --agent', ['start', 'Do it', '--agent', '--team=payments']],
      ['an unknown flag', ['start', 'Do it', '--team=payments', '--agent=a', '--frobnicate=1']],
    ])('refuses %s without a request', async (_label, args) => {
      expect(await run(args)).toBe(1);
      expect(calls).toHaveLength(0);
      expect(stderr()).not.toBe('');
    });

    it('follows the transcript with --wait until WAITING, polling every 3 seconds', async () => {
      responder = (c) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        if (c.method === 'POST') {
          return launchOk;
        }
        if (c.url.includes('/messages')) {
          if (c.url.includes('after=')) {
            return { body: { data: [], next: null } };
          }
          return {
            body: {
              data: [
                message('m1', 'Investigate the retry logic'),
                message('m2', 'Two readers are on it', { role: 'ORCHESTRATOR' }),
              ],
              next: 'cursor-2',
            },
          };
        }
        return { body: { data: detail({ status: 'WAITING' }) } };
      };
      expect(
        await run([
          'start',
          'Investigate the retry logic',
          '--team=payments',
          '--agent=a',
          '--wait',
        ])
      ).toBe(0);
      expect(stdout()).toContain('user: Investigate the retry logic');
      expect(stdout()).toContain('orchestrator: Two readers are on it');
      expect(stdout()).toContain('waiting for a person');
      expect(stderr()).toContain('[WAITING]');
      expect(vi.mocked(sleep)).not.toHaveBeenCalled();
    });
  });

  describe('--wait and --follow loops', () => {
    it('sleeps 3 seconds between polls and exits 2 when --wait ends in FAILED', async () => {
      let polls = 0;
      responder = (c) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        if (c.method === 'POST') {
          return launchOk;
        }
        if (c.url.includes('/messages')) {
          return { body: { data: [], next: null } };
        }
        polls++;
        return { body: { data: detail({ status: polls < 3 ? 'ACTIVE' : 'FAILED' }) } };
      };
      expect(await run(['start', 'Do it', '--team=payments', '--agent=a', '--wait'])).toBe(2);
      expect(vi.mocked(sleep)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sleep)).toHaveBeenCalledWith(3000);
      expect(stderr()).toContain('[FAILED]');
    });

    it('--follow exits 0 on a FAILED orchestration: following is a read, not a verdict', async () => {
      responder = (c) => {
        if (c.url.includes('/messages')) {
          return { body: { data: [], next: null } };
        }
        return { body: { data: detail({ status: 'FAILED' }) } };
      };
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(vi.mocked(sleep)).not.toHaveBeenCalled();
    });

    it('--follow keeps polling through WAITING and stops at COMPLETED', async () => {
      const statuses = sequence([
        { body: { data: detail({ status: 'ACTIVE' }) } },
        { body: { data: detail({ status: 'WAITING' }) } },
        { body: { data: detail({ status: 'COMPLETED' }) } },
      ]);
      responder = (c) => {
        if (c.url.includes('/messages')) {
          return { body: { data: [], next: null } };
        }
        return statuses();
      };
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(vi.mocked(sleep)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sleep)).toHaveBeenNthCalledWith(1, 3000);
      expect(stderr()).toContain('[COMPLETED]');
    });

    it('prints the attach request and approval notices once, with the exact commands', async () => {
      responder = (c) => {
        if (c.url.includes('/messages')) {
          return { body: { data: [], next: null } };
        }
        return {
          body: {
            data: detail({
              canControl: true,
              pendingApprovals: [
                {
                  argumentsDigest: 'title: string(42 chars)',
                  childId: CHILD_ID,
                  connectionId: CONN_ID,
                  connectionName: 'Tracker',
                  createdAt: '2026-11-17T10:00:00.000Z',
                  expiresAt: '2026-11-17T10:10:00.000Z',
                  id: APPROVAL_ID,
                  status: 'PENDING',
                  toolName: 'create_issue',
                },
              ],
              pendingAttach: {
                candidateRepoId: REPO_ID,
                candidateRepoName: 'acme/payments',
                messageId: 'm-attach',
                reason: 'The fix lives in payments',
              },
              status: 'COMPLETED',
            }),
          },
        };
      };
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      const text = stdout();
      expect(text).toContain(`auto-swe orchestrate attach ${ORCH_ID} --repo=acme/payments`);
      expect(text).toContain(`auto-swe orchestrate decline ${ORCH_ID}`);
      expect(text).toContain(`auto-swe orchestrate approve ${ORCH_ID} ${APPROVAL_ID}`);
      expect(text).toContain(`auto-swe orchestrate deny ${ORCH_ID} ${APPROVAL_ID}`);
      // Each request is announced once even though the status stays WAITING across polls.
      expect(text.match(/Needs a person/g)).toHaveLength(2);
    });

    it('tells a viewer who is not the launcher to wait rather than printing commands', async () => {
      responder = (c) => {
        if (c.url.includes('/messages')) {
          return { body: { data: [], next: null } };
        }
        return {
          body: {
            data: detail({
              canControl: false,
              pendingAttach: { candidateRepoId: null, messageId: 'm1', reason: 'Needs code' },
              status: 'COMPLETED',
            }),
          },
        };
      };
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(stdout()).toContain('Waiting for the launcher to attach or decline it.');
      expect(stdout()).not.toContain('auto-swe orchestrate attach');
    });
  });

  describe('streaming --wait and --follow', () => {
    const enc = new TextEncoder();
    const frame = (event: string, id: string, data: unknown) =>
      `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    /** An event-stream response: `chunks` are written, then it closes or hangs until aborted. */
    function eventStream(chunks: string[], end: 'close' | 'hang', init?: ResponseInit) {
      return (c: Call & { signal?: AbortSignal }) => {
        const signal = signals[signals.length - 1];
        void c;
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            for (const chunk of chunks) {
              ctrl.enqueue(enc.encode(chunk));
            }
            if (end === 'close') {
              ctrl.close();
            }
            signal?.addEventListener('abort', () => {
              try {
                ctrl.error(new TypeError('terminated'));
              } catch {
                // Already closed.
              }
            });
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          status: 200,
          ...init,
        });
      };
    }
    /** The detail is ACTIVE for `active` reads, then `status`: the stream's last batch ends it. */
    const restDetail = (status: string, active = 0) => {
      let reads = 0;
      responder = (c) => {
        if (c.url.includes('/messages')) {
          return { body: { data: [], next: null } };
        }
        reads += 1;
        return { body: { data: detail({ status: reads > active ? status : 'ACTIVE' }) } };
      };
    };
    const streamCalls = () => calls.filter((c) => c.url.includes('/events'));
    const m = (id: string, body: string) => message(id, body, { role: 'ORCHESTRATOR' });

    it('prints streamed messages, sends the token and never polls or sleeps', async () => {
      restDetail('COMPLETED', 2);
      events = eventStream(
        [
          'retry: 3000\n\n',
          frame('message', 'c1', m('m1', 'first')),
          frame('message', 'c2', m('m2', 'second')),
          frame('status', 'c2', { status: 'COMPLETED' }),
        ],
        'hang'
      );
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(stdout()).toBe('orchestrator: first\norchestrator: second\n');
      expect(stderr()).toContain('[COMPLETED]');
      expect(vi.mocked(sleep)).not.toHaveBeenCalled();
      expect(streamCalls()[0]?.headers).toMatchObject({
        Accept: 'text/event-stream',
        Authorization: 'Bearer t',
      });
      expect(streamCalls()[0]?.headers['Last-Event-ID']).toBeUndefined();
      // The stream is closed once the orchestration is over: it holds one of the user's four slots.
      expect(signals[0]?.aborted).toBe(true);
    });

    it('--json prints one message object per line, exactly as polling does', async () => {
      restDetail('COMPLETED', 1);
      events = eventStream(
        [frame('message', 'c1', m('m1', 'first')), frame('status', 'c1', { status: 'COMPLETED' })],
        'hang'
      );
      expect(await run(['messages', ORCH_ID, '--follow', '--json'])).toBe(0);
      expect(
        stdout()
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l).id)
      ).toEqual(['m1']);
    });

    it('--wait stops at WAITING with exit 0 and at FAILED with exit 2', async () => {
      const launch = (c: Call) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        return c.method === 'POST' ? launchOk : null;
      };
      for (const [status, code] of [
        ['WAITING', 0],
        ['FAILED', 2],
      ] as const) {
        out = [];
        responder = (c) =>
          launch(c) ??
          (c.url.includes('/messages')
            ? { body: { data: [], next: null } }
            : { body: { data: detail({ status }) } });
        events = eventStream([frame('status', 'c0', { status })], 'hang');
        expect(await run(['start', 'Do it', '--team=payments', '--agent=a', '--wait'])).toBe(code);
        expect(streamCalls().length).toBeGreaterThan(0);
      }
      expect(vi.mocked(sleep)).not.toHaveBeenCalled();
    });

    it('resumes from the last event id after a drop without repeating a message', async () => {
      let n = 0;
      restDetail('COMPLETED', 3);
      events = (c) => {
        n += 1;
        return n === 1
          ? eventStream([frame('message', 'c1', m('m1', 'one'))], 'close')(c)
          : eventStream(
              [
                frame('message', 'c1', m('m1', 'one')),
                frame('message', 'c2', m('m2', 'two')),
                frame('status', 'c2', { status: 'COMPLETED' }),
              ],
              'hang'
            )(c);
      };
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(streamCalls()).toHaveLength(2);
      expect(streamCalls()[1]?.headers['Last-Event-ID']).toBe('c1');
      expect(stdout()).toBe('orchestrator: one\norchestrator: two\n');
      expect(vi.mocked(sleep)).toHaveBeenCalledTimes(1);
      const delay = vi.mocked(sleep).mock.calls[0]?.[0] ?? 0;
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    });

    it('reconnects at once, without sleeping, when the server ends the stream at its time limit', async () => {
      let n = 0;
      restDetail('COMPLETED', 1);
      events = (c) => {
        n += 1;
        return n === 1
          ? eventStream(
              [frame('message', 'c1', m('m1', 'one')), frame('done', 'c1', { reason: 'timeout' })],
              'hang'
            )(c)
          : eventStream([frame('status', 'c1', { status: 'COMPLETED' })], 'hang')(c);
      };
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(streamCalls()[1]?.headers['Last-Event-ID']).toBe('c1');
      expect(vi.mocked(sleep)).not.toHaveBeenCalled();
    });

    it('falls back to polling, with the same output, when the stream is refused (429)', async () => {
      const statuses = sequence([
        { body: { data: detail({ status: 'ACTIVE' }) } },
        { body: { data: detail({ status: 'COMPLETED' }) } },
      ]);
      let pages = 0;
      responder = (c) => {
        if (c.url.includes('/messages')) {
          pages += 1;
          return {
            body:
              pages === 1 ? { data: [m('m1', 'polled')], next: 'cur' } : { data: [], next: null },
          };
        }
        return statuses();
      };
      events = () =>
        new Response(JSON.stringify({ error: { code: 'TOO_MANY_STREAMS' } }), { status: 429 });
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(streamCalls()).toHaveLength(1);
      expect(vi.mocked(sleep)).toHaveBeenCalledWith(3000);
      expect(stdout()).toBe('orchestrator: polled\n');
      expect(stderr()).toContain('[COMPLETED]');
    });

    it('falls back to polling when a proxy answers 200 without an event stream', async () => {
      restDetail('COMPLETED');
      events = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      expect(streamCalls()).toHaveLength(1);
      expect(stderr()).toContain('[COMPLETED]');
    });

    it('hands over to polling after repeated drops, from the stream cursor and with no duplicate', async () => {
      let reads = 0;
      const pages: string[] = [];
      responder = (c) => {
        if (c.url.includes('/messages')) {
          pages.push(c.url);
          return {
            body:
              pages.length === 1
                ? { data: [m('m1', 'one'), m('m2', 'two')], next: 'c2' }
                : { data: [], next: null },
          };
        }
        reads += 1;
        return { body: { data: detail({ status: reads > 6 ? 'COMPLETED' : 'ACTIVE' }) } };
      };
      events = (c) => eventStream([frame('message', 'c1', m('m1', 'one'))], 'close')(c);
      expect(await run(['messages', ORCH_ID, '--follow'])).toBe(0);
      // A first message from the stream, then every reconnect fails to progress: 1 + 5 retries.
      expect(streamCalls()).toHaveLength(6);
      expect(stdout()).toBe('orchestrator: one\norchestrator: two\n');
      expect(pages[0]).toContain('after=c1');
    });

    it('closes the stream and exits 130 on Ctrl-C, leaving no listener behind', async () => {
      restDetail('ACTIVE');
      events = eventStream([': ping\n\n'], 'hang');
      const before = process.listenerCount('SIGINT');
      const running = run(['messages', ORCH_ID, '--follow']);
      await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
      await vi.waitFor(() => expect(process.listenerCount('SIGINT')).toBe(before + 1));
      process.emit('SIGINT');
      expect(await running).toBe(130);
      expect(signals[0]?.aborted).toBe(true);
      expect(process.listenerCount('SIGINT')).toBe(before);
    });

    it('exits 130 on the FIRST Ctrl-C during the reconnect backoff, leaving no listener', async () => {
      vi.useFakeTimers();
      const before = process.listenerCount('SIGINT');
      try {
        restDetail('ACTIVE');
        events = (c) => eventStream([frame('message', 'c1', m('m1', 'one'))], 'close')(c);
        // A backoff that never ends on its own: only the interrupt can finish it.
        vi.mocked(sleep).mockImplementationOnce(() => new Promise<void>(() => undefined));
        const running = run(['messages', ORCH_ID, '--follow']);
        await vi.waitFor(() => expect(vi.mocked(sleep)).toHaveBeenCalledTimes(1));
        process.emit('SIGINT');
        expect(await running).toBe(130);
        expect(streamCalls()).toHaveLength(1);
        expect(process.listenerCount('SIGINT')).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it('exits 130 on the first Ctrl-C while a REST read inside a batch is in flight', async () => {
      restDetail('ACTIVE');
      events = eventStream([frame('status', 'c1', { status: 'ACTIVE' })], 'hang');
      const base = globalThis.fetch;
      let streamed = false;
      let hungReads = 0;
      globalThis.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
        if (String(url).includes('/events')) {
          streamed = true;
          return base(url, init);
        }
        if (streamed) {
          hungReads += 1;
          return new Promise<Response>(() => undefined);
        }
        return base(url, init);
      }) as unknown as typeof fetch;
      const before = process.listenerCount('SIGINT');
      const running = run(['messages', ORCH_ID, '--follow']);
      await vi.waitFor(() => expect(hungReads).toBe(1));
      process.emit('SIGINT');
      expect(await running).toBe(130);
      expect(process.listenerCount('SIGINT')).toBe(before);
    });

    it('treats 45 seconds of silence as a dead stream and polls instead', async () => {
      vi.useFakeTimers();
      try {
        restDetail('COMPLETED');
        events = eventStream([], 'hang');
        const running = run(['messages', ORCH_ID, '--follow']);
        for (let i = 0; i < 7; i += 1) {
          await vi.advanceTimersByTimeAsync(45_000);
        }
        expect(await running).toBe(0);
        // Five retries after the first silent stream, then polling.
        expect(streamCalls()).toHaveLength(6);
        expect(stderr()).toContain('[COMPLETED]');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('list', () => {
    it('passes the team and status as query parameters and prints one row per orchestration', async () => {
      responder = (c) => {
        if (c.url.endsWith('/api/v1/teams')) {
          return { body: { data: [{ id: TEAM_ID, slug: 'payments' }] } };
        }
        return {
          body: {
            data: [
              {
                childCount: 3,
                costUsd: 1.25,
                id: ORCH_ID,
                repoName: 'acme/payments',
                runningChildCount: 1,
                status: 'WAITING',
                title: 'Investigate the retry logic',
              },
            ],
            limit: 25,
            offset: 0,
            total: 1,
          },
        };
      };
      expect(await run(['list', '--team=payments', '--status=waiting'])).toBe(0);
      const listCall = calls.find((c) => c.url.includes('/api/v1/orchestrations?'));
      expect(listCall?.url).toContain(`teamId=${TEAM_ID}`);
      expect(listCall?.url).toContain('status=WAITING');
      expect(stdout()).toContain(ORCH_ID);
      expect(stdout()).toContain('1/3');
      expect(stdout()).toContain('$1.25');
      expect(stdout()).toContain('Investigate the retry logic');
    });

    it('prints the page data as JSON with --json', async () => {
      responder = () => ({ body: { data: [{ id: ORCH_ID }], total: 1 } });
      expect(await run(['list', '--json'])).toBe(0);
      expect(JSON.parse(stdout())).toEqual([{ id: ORCH_ID }]);
    });

    it('says so when there are none', async () => {
      responder = () => ({ body: { data: [] } });
      expect(await run(['list'])).toBe(0);
      expect(stdout()).toBe('No orchestrations.\n');
    });

    it('rejects an unknown status before any request', async () => {
      expect(await run(['list', '--status=PAUSED'])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(stderr()).toContain('--status must be one of');
    });
  });

  describe('show', () => {
    it('prints the budget readout: percent of the token cap and the monthly USD left', async () => {
      responder = () => ({ body: { data: detail() } });
      expect(await run(['show', ORCH_ID])).toBe(0);
      expect(stdout()).toContain(
        'Budget:        STANDARD, 42% used (840,000 of 2,000,000 input tokens), $12.50 remaining this month'
      );
    });

    it('omits the monthly USD figure when no budget is set', async () => {
      responder = () => ({
        body: {
          data: detail({
            budget: {
              percentUsed: 5,
              remainingUsd: null,
              tier: 'STANDARD',
              tokens: { cap: 1000, kind: 'output', used: 50 },
            },
          }),
        },
      });
      expect(await run(['show', ORCH_ID])).toBe(0);
      expect(stdout()).toContain('5% used (50 of 1,000 output tokens)');
      expect(stdout()).not.toContain('this month');
    });

    it('renders the children table, the billing split and the pending requests', async () => {
      responder = () => ({
        body: {
          data: detail({
            billing: { childrenTeamName: 'platform', orchestratorTeamName: 'payments' },
            children: [
              {
                agentKey: 'contentWriter',
                branch: 'auto/agent-1',
                costUsd: 0.4,
                createdAt: '2026-11-17T10:00:00.000Z',
                finishedAt: null,
                id: CHILD_ID,
                label: 'reader one',
                pathScopes: [],
                prUrl: null,
                result: null,
                role: 'READER',
                runId: null,
                status: 'RUNNING',
                undeliveredSteering: 0,
                workRequestId: 'w1',
              },
              {
                agentKey: 'implementer',
                branch: 'auto/agent-2',
                costUsd: 1.1,
                createdAt: '2026-11-17T10:00:00.000Z',
                finishedAt: '2026-11-17T10:30:00.000Z',
                id: CHILD_TWO,
                label: 'writer one',
                pathScopes: ['src/payments/**'],
                prUrl: 'https://github.com/acme/payments/pull/9',
                result: null,
                role: 'WRITER',
                runId: 'r2',
                status: 'COMPLETED',
                undeliveredSteering: 0,
                workRequestId: 'w2',
              },
            ],
            cost: { childrenUsd: 1.5, orchestratorUsd: 0.5, totalUsd: 2 },
            pendingApprovals: [
              {
                argumentsDigest: 'x',
                childId: CHILD_ID,
                connectionId: CONN_ID,
                connectionName: 'Tracker',
                createdAt: '2026-11-17T10:00:00.000Z',
                expiresAt: '2026-11-17T10:10:00.000Z',
                id: APPROVAL_ID,
                status: 'PENDING',
                toolName: 'create_issue',
              },
            ],
            repoAttachedAt: '2026-11-17T10:05:00.000Z',
            repoId: REPO_ID,
            repoName: 'acme/payments',
          }),
        },
      });
      expect(await run(['show', ORCH_ID])).toBe(0);
      const text = stdout();
      expect(text).toContain('Repository:    acme/payments (attached)');
      expect(text).toContain('orchestrator turns to payments; children to platform');
      expect(text).toContain('Agents (1 running of 2):');
      expect(text).toContain(CHILD_ID);
      expect(text).toContain(CHILD_TWO);
      expect(text).toContain('writer src/payments/**');
      expect(text).toContain('https://github.com/acme/payments/pull/9');
      expect(text).toContain('$2.00');
      expect(text).toContain(`auto-swe orchestrate approve ${ORCH_ID} ${APPROVAL_ID}`);
    });

    it('shows "none (read-only)" for a repo-less orchestration with no children', async () => {
      responder = () => ({ body: { data: detail() } });
      expect(await run(['show', ORCH_ID])).toBe(0);
      expect(stdout()).toContain('Repository:    none (read-only)');
      expect(stdout()).toContain('Agents: none yet.');
    });

    it('prints the detail as JSON with --json', async () => {
      responder = () => ({ body: { data: detail() } });
      expect(await run(['show', ORCH_ID, '--json'])).toBe(0);
      expect(JSON.parse(stdout()).id).toBe(ORCH_ID);
    });

    it('refuses an id that is not a UUID before any request', async () => {
      expect(await run(['show', 'not-a-uuid'])).toBe(1);
      expect(calls).toHaveLength(0);
      expect(stderr()).toContain('Orchestration id must be a UUID');
    });
  });

  describe('messages', () => {
    it('follows the cursor across pages and prints each message as "role: body"', async () => {
      responder = (c) => {
        if (c.url.includes('after=c1')) {
          return {
            body: {
              data: [message('m3', 'Done with the search', { role: 'ORCHESTRATOR' })],
              next: 'c2',
            },
          };
        }
        if (c.url.includes('after=c2')) {
          return { body: { data: [], next: null } };
        }
        return {
          body: {
            data: [
              message('m1', 'Find the retry code'),
              message('m2', 'On it', { role: 'ORCHESTRATOR' }),
            ],
            next: 'c1',
          },
        };
      };
      expect(await run(['messages', ORCH_ID])).toBe(0);
      expect(stdout()).toBe(
        'user: Find the retry code\norchestrator: On it\norchestrator: Done with the search\n'
      );
      const queries = calls.map((c) => c.url.split('/messages')[1]);
      expect(queries).toEqual(['', '?after=c1', '?after=c2']);
    });

    it('names the child a message is addressed to', async () => {
      let first = true;
      responder = () => {
        if (first) {
          first = false;
          return {
            body: {
              data: [message('m1', 'Focus on the tests', { childId: CHILD_ID })],
              next: 'c1',
            },
          };
        }
        return { body: { data: [], next: null } };
      };
      expect(await run(['messages', ORCH_ID])).toBe(0);
      expect(stdout()).toBe(`user (child ${CHILD_ID}): Focus on the tests\n`);
    });

    it('writes one JSON object per message with --json', async () => {
      let first = true;
      responder = () => {
        if (first) {
          first = false;
          return { body: { data: [message('m1', 'Hi'), message('m2', 'Hello')], next: 'c2' } };
        }
        return { body: { data: [], next: null } };
      };
      expect(await run(['messages', ORCH_ID, '--json'])).toBe(0);
      const lines = stdout().trim().split('\n');
      expect(lines.map((l) => JSON.parse(l).id)).toEqual(['m1', 'm2']);
    });

    it('refuses without an id', async () => {
      expect(await run(['messages'])).toBe(1);
      expect(calls).toHaveLength(0);
    });
  });

  describe('talking to the orchestrator and its agents', () => {
    it('say posts the trimmed body to the orchestration messages route', async () => {
      responder = () => ({ body: { data: message('m9', 'Use the tests') }, status: 201 });
      expect(await run(['say', ORCH_ID, '  Use the tests  '])).toBe(0);
      expect(posts()[0]?.url).toBe(`http://gw/api/v1/orchestrations/${ORCH_ID}/messages`);
      expect(posts()[0]?.body).toEqual({ body: 'Use the tests' });
      expect(stdout()).toContain('Message sent to the orchestrator.');
    });

    it('say refuses an empty message before any request', async () => {
      expect(await run(['say', ORCH_ID, '   '])).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it('steer posts to the child route and names the child', async () => {
      responder = () => ({ body: { data: message('m9', 'Skip the cache') }, status: 201 });
      expect(await run(['steer', ORCH_ID, CHILD_ID, 'Skip the cache'])).toBe(0);
      expect(posts()[0]?.url).toBe(
        `http://gw/api/v1/orchestrations/${ORCH_ID}/children/${CHILD_ID}/messages`
      );
      expect(posts()[0]?.body).toEqual({ body: 'Skip the cache' });
      expect(stdout()).toContain(`child ${CHILD_ID}`);
    });

    it('steer refuses a missing child id', async () => {
      expect(await run(['steer', ORCH_ID, 'Skip the cache'])).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it('cancel-agent posts to the child cancel route', async () => {
      responder = () => ({ body: { data: {} } });
      expect(await run(['cancel-agent', ORCH_ID, CHILD_ID])).toBe(0);
      expect(posts()[0]?.url).toBe(
        `http://gw/api/v1/orchestrations/${ORCH_ID}/children/${CHILD_ID}/cancel`
      );
    });

    it('cancel and end post to their orchestration routes', async () => {
      responder = () => ({ body: { data: {} } });
      expect(await run(['cancel', ORCH_ID])).toBe(0);
      expect(await run(['end', ORCH_ID])).toBe(0);
      expect(posts().map((c) => c.url)).toEqual([
        `http://gw/api/v1/orchestrations/${ORCH_ID}/cancel`,
        `http://gw/api/v1/orchestrations/${ORCH_ID}/end`,
      ]);
    });
  });

  describe('human acts', () => {
    it('attach resolves --repo, posts the repository id, and reminds the user it is their decision', async () => {
      responder = (c) => (c.url.includes('repositories') ? repoLookup : { body: { data: {} } });
      expect(await run(['attach', ORCH_ID, '--repo=acme/payments'])).toBe(0);
      expect(posts()[0]?.url).toBe(`http://gw/api/v1/orchestrations/${ORCH_ID}/attach`);
      expect(posts()[0]?.body).toEqual({ repoId: REPO_ID });
      expect(stderr()).toContain('human decision, recorded under your account');
    });

    it('attach needs --repo', async () => {
      expect(await run(['attach', ORCH_ID])).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it('decline posts to the decline route', async () => {
      responder = () => ({ body: { data: {} } });
      expect(await run(['decline', ORCH_ID])).toBe(0);
      expect(posts()[0]?.url).toBe(`http://gw/api/v1/orchestrations/${ORCH_ID}/attach/decline`);
      expect(stderr()).toContain('human decision');
    });

    it('approve and deny post the matching decision to the approval route', async () => {
      responder = () => ({ body: { data: {} } });
      expect(await run(['approve', ORCH_ID, APPROVAL_ID])).toBe(0);
      expect(await run(['deny', ORCH_ID, APPROVAL_ID])).toBe(0);
      expect(posts().map((c) => c.body)).toEqual([{ decision: 'APPROVE' }, { decision: 'DENY' }]);
      expect(posts()[0]?.url).toBe(
        `http://gw/api/v1/orchestrations/${ORCH_ID}/approvals/${APPROVAL_ID}`
      );
    });

    it('approve refuses a non-UUID approval id', async () => {
      expect(await run(['approve', ORCH_ID, 'nope'])).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it('states in the help text which commands are human acts', async () => {
      expect(await run(['help'])).toBe(0);
      expect(stdout()).toContain('HUMAN ACTS');
      expect(stdout()).toContain('orchestrate approve <id> <approvalId>');
    });
  });

  describe('refusals and errors', () => {
    it('renders a refusal as its plain sentence, keeping the code, and exits 2', async () => {
      responder = () => ({
        body: { error: { code: 'ORCHESTRATION_DISABLED', message: 'raw gateway text' } },
        status: 403,
      });
      expect(await run(['cancel', ORCH_ID])).toBe(2);
      expect(stderr()).toBe(
        'ORCHESTRATION_DISABLED: Orchestrated runs are turned off on this platform.\n'
      );
    });

    it.each(ORCHESTRATION_REFUSAL_CODES)('gives %s a plain sentence', async (code) => {
      responder = () => ({ body: { error: { code, message: 'raw gateway text' } }, status: 409 });
      expect(await run(['end', ORCH_ID])).toBe(2);
      expect(stderr()).toContain(`${code}: `);
      expect(stderr()).not.toContain('raw gateway text');
    });

    it.each([
      'ORCHESTRATION_DISABLED',
      'TEAM_REPO_MISMATCH',
      'REPO_REQUIRED',
      'NOT_LAUNCHER',
      'ORCHESTRATION_NOT_ACTIVE',
      'NO_PENDING_ATTACH',
      'REPO_ALREADY_ATTACHED',
      'APPROVAL_NOT_PENDING',
    ])('gives the common gateway refusal %s a plain sentence', async (code) => {
      responder = () => ({ body: { error: { code, message: 'raw gateway text' } }, status: 409 });
      expect(await run(['end', ORCH_ID])).toBe(2);
      expect(stderr()).toContain(`${code}: `);
      expect(stderr()).not.toContain('raw gateway text');
    });

    it('passes an unknown error through with its code and message', async () => {
      responder = () => ({ body: { error: { code: 'INTERNAL', message: 'boom' } }, status: 500 });
      expect(await run(['end', ORCH_ID])).toBe(2);
      expect(stderr()).toBe('INTERNAL: boom\n');
    });
  });

  it('prints help for no subcommand and for help, and rejects an unknown subcommand', async () => {
    expect(await run([])).toBe(0);
    expect(stdout()).toContain('orchestrate start');
    expect(await run(['frobnicate'])).toBe(1);
    expect(stderr()).toContain('Unknown subcommand: orchestrate frobnicate');
  });
});
