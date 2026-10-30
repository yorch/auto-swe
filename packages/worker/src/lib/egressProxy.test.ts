import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  contexts: [] as string[],
  current: (): string => 'workflow',
  fail: false,
  rows: [] as Record<string, unknown>[],
  stall: false,
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    workflowHttpCall: {
      createMany: vi.fn(async ({ data }) => {
        if (h.stall) {
          await new Promise(() => {});
        }
        if (h.fail) {
          throw new Error('database down');
        }
        h.rows.push(...data);
        h.contexts.push(h.current());
      }),
    },
  },
}));
vi.mock('./activityContext.js', () => ({
  currentActivityType: () => 'shellStep',
  currentAttempt: () => 3,
  currentTemporalRunId: () => 'temporal',
  currentWorkflowId: () => h.current(),
  currentWorkflowRunId: async () => 'run',
}));
vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org', teamId: 'team' }),
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import { runWithActivityNodeTag } from './activityNodeTag.js';
import { createEgressProxy, type EgressRegistration, egressHostAllowed } from './egressProxy.js';

const context = new AsyncLocalStorage<string>();
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  h.rows.length = 0;
  h.contexts.length = 0;
  h.fail = false;
  h.stall = false;
  h.current = () => context.getStore() ?? 'outside';
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});
async function setup(
  extra: Partial<Parameters<typeof createEgressProxy>[0]> = {},
  allowlist: string[] = []
) {
  const proxy = createEgressProxy({
    advertisedUrl: (port) => `http://127.0.0.1:${port}`,
    guard: { classify: () => 'ok', resolver: async () => [{ address: '127.0.0.1', family: 4 }] },
    listenHost: '127.0.0.1',
    listenPort: 0,
    ...extra,
  });
  cleanups.push(() => proxy.close());
  const reg = await context.run('registered-workflow', () =>
    runWithActivityNodeTag({ recordingId: 'recording', specNodeId: 'node', stepAttempt: 2 }, () =>
      proxy.register(allowlist)
    )
  );
  return { proxy, reg };
}
const auth = (reg: EgressRegistration) =>
  `Basic ${Buffer.from(`egress:${reg.token}`).toString('base64')}`;
async function request(
  reg: EgressRegistration,
  path: string,
  authorization: string | undefined = auth(reg),
  body = ''
) {
  const url = new URL(reg.url);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      {
        headers: {
          ...(authorization ? { 'Proxy-Authorization': authorization } : {}),
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        hostname: url.hostname,
        method: body ? 'POST' : 'GET',
        path,
        port: url.port,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function connect(reg: EgressRegistration, target: string, authorization = auth(reg)) {
  const url = new URL(reg.url);
  const socket = net.connect(Number(url.port), url.hostname);
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization}\r\n\r\n`
  );
  const [reply] = await once(socket, 'data');
  return { reply: String(reply), socket };
}
async function echoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}
describe('egress proxy', () => {
  it('matches exact hosts and wildcard subdomains, not suffix impostors', () => {
    expect(egressHostAllowed('API.Example.com.', ['*.example.com'])).toBe(true);
    for (const host of ['example.com', 'evil-example.com', 'example.com.evil']) {
      expect(egressHostAllowed(host, ['*.example.com'])).toBe(false);
    }
    expect(egressHostAllowed('anything', [])).toBe(true);
  });
  it('forwards HTTP metadata without credentials or bodies and pins the checked address', async () => {
    let upstreamHeaders: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((req, res) => {
      upstreamHeaders = req.headers;
      req.resume();
      req.on('end', () => res.end('result'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const { reg } = await setup();
    expect(
      await request(reg, `http://public.invalid:${port}/path?token=secret&x=1`, auth(reg), 'hello')
    ).toEqual({ status: 200, text: 'result' });
    await reg.release();
    expect(upstreamHeaders?.host).toBe(`public.invalid:${port}`);
    expect(upstreamHeaders?.['proxy-authorization']).toBeUndefined();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      attempt: 3,
      host: 'public.invalid',
      method: 'POST',
      orgId: 'org',
      purpose: 'egress',
      recordingId: 'recording',
      requestBytes: 5,
      responseBytes: 6,
      runId: 'run',
      source: 'egress_proxy',
      specNodeId: 'node',
      status: 200,
      stepAttempt: 2,
      teamId: 'team',
      workflowId: 'registered-workflow',
    });
    expect(String(h.rows[0]?.path)).not.toContain('secret');
    expect(h.rows[0]).not.toHaveProperty('requestBody');
    expect(h.rows[0]).not.toHaveProperty('headers');
    expect(h.contexts).toEqual(['registered-workflow']);
  });
  it('tunnels TCP, counts bytes and persists on release', async () => {
    const port = await echoServer();
    const { reg } = await setup({}, ['public.invalid']);
    const { socket, reply } = await connect(reg, `public.invalid:${port}`);
    expect(reply).toContain('200 Connection Established');
    socket.write('hello');
    expect(String((await once(socket, 'data'))[0])).toBe('hello');
    expect(h.rows).toEqual([]);
    const closed = once(socket, 'close');
    await reg.release();
    await closed;
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      error: 'registration released',
      method: 'CONNECT',
      port,
      requestBytes: 5,
      responseBytes: 5,
      scheme: 'tcp',
    });
    expect(h.rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect((await request(reg, 'http://public.invalid')).status).toBe(407);
  });
  it('records normally closed tunnels once', async () => {
    const port = await echoServer();
    const { reg } = await setup();
    const { socket } = await connect(reg, `public.invalid:${port}`);
    socket.end();
    await once(socket, 'close');
    await reg.release();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.error).toBeUndefined();
  });
  it('refuses missing or unknown tokens without rows, including CONNECT', async () => {
    const { reg } = await setup();
    expect((await request(reg, 'http://example.com', '')).status).toBe(407);
    expect((await request(reg, 'http://example.com', 'Basic ZWdyZXNzOmJhZA==')).status).toBe(407);
    const { socket, reply } = await connect(reg, 'example.com:443', 'Basic ZWdyZXNzOmJhZA==');
    expect(reply).toContain('407');
    socket.destroy();
    await reg.release();
    expect(h.rows).toEqual([]);
  });
  it('records allowlist denials for HTTP and CONNECT with HTTPS scheme on 443', async () => {
    const { reg } = await setup({}, ['allowed.invalid']);
    expect((await request(reg, 'http://denied.invalid/path')).status).toBe(403);
    const { socket, reply } = await connect(reg, 'denied.invalid:443');
    expect(reply).toContain('403');
    socket.destroy();
    await reg.release();
    expect(h.rows).toHaveLength(2);
    expect(h.rows[1]).toMatchObject({ blocked: true, port: 443, scheme: 'https', status: 403 });
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1'])(
    'blocks resolved private/metadata address %s',
    async (address) => {
      const { reg } = await setup({
        guard: { resolver: async () => [{ address, family: address.includes(':') ? 6 : 4 }] },
      });
      const { socket, reply } = await connect(reg, 'public.invalid:443');
      expect(reply).toContain('403');
      socket.destroy();
      await reg.release();
      expect(h.rows[0]).toMatchObject({ blocked: true, status: 403 });
    }
  );
  it('bounds concurrent tunnels and expires idle ones', async () => {
    const port = await echoServer();
    const { reg } = await setup({ idleTimeoutMs: 60, maxConcurrent: 1 });
    const first = await connect(reg, `public.invalid:${port}`);
    const second = await connect(reg, `public.invalid:${port}`);
    expect(second.reply).toContain('429');
    second.socket.destroy();
    await once(first.socket, 'close');
    await reg.release();
    expect(h.rows).toHaveLength(2);
    expect(h.rows.some((row) => row.error === 'tunnel idle timeout')).toBe(true);
  });
  it('swallows persistence failures', async () => {
    const { reg } = await setup({}, ['allowed']);
    h.fail = true;
    expect((await request(reg, 'http://denied.invalid')).status).toBe(403);
    await expect(reg.release()).resolves.toBeUndefined();
  });
  it('bounds release when a metadata write stalls', async () => {
    const { reg } = await setup({ releaseTimeoutMs: 20 }, ['allowed']);
    h.stall = true;
    expect((await request(reg, 'http://denied.invalid')).status).toBe(403);
    await expect(reg.release()).resolves.toBeUndefined();
  });
});
