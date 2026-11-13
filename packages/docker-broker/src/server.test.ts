import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { type AddressInfo, createServer as netServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config, OWNER_LABEL, PROFILE_LABEL, type Profile } from './config.ts';
import { type ObjectValue, parseJson } from './json.ts';
import { Broker, SIGNATURE } from './server.ts';

const address = (server: http.Server) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const listen = (server: http.Server) =>
  new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
function base(profile: Profile = 'workspace'): ObjectValue {
  return {
    Cmd: ['sleep', 'infinity'],
    HostConfig: {
      CapDrop: ['ALL'],
      Memory: 128 * 1024 ** 2,
      MemorySwappiness: -1,
      NanoCpus: 1e9,
      NetworkMode: 'bridge',
      PidsLimit: 64,
      SecurityOpt: ['no-new-privileges'],
    },
    Image: 'alpine:3.20',
    Labels: { [PROFILE_LABEL]: profile },
    User: '1000:1000',
  };
}
describe('Docker policy broker', () => {
  let daemon: http.Server;
  let broker: Broker;
  let directory: string;
  let counter: number;
  let containers: Map<string, ObjectValue>;
  let volumes: Map<string, ObjectValue>;
  let forwarded: { method: string; path: string; body: ObjectValue }[];
  let waiting: http.ServerResponse | undefined;
  const call = async (method: string, target: string, input?: unknown, raw = false) => {
    const data = input === undefined ? undefined : raw ? String(input) : JSON.stringify(input);
    return new Promise<{
      status: number;
      body: ObjectValue;
      text: string;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const request = http.request(
        new URL(target, address(broker.server)),
        {
          headers:
            data === undefined
              ? {}
              : {
                  'content-length': Buffer.byteLength(data),
                  'content-type': raw ? 'application/octet-stream' : 'application/json',
                },
          method,
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => {
            text += String(chunk);
          });
          response.on('end', () =>
            resolve({
              body: text ? (JSON.parse(text) as ObjectValue) : {},
              headers: response.headers,
              status: response.statusCode ?? 0,
              text,
            })
          );
        }
      );
      request.on('error', reject);
      request.end(data);
    });
  };
  const create = async (body = base()) => {
    const response = await call('POST', `/v1.50/containers/create?name=test-${randomUUID()}`, body);
    expect(response.status, response.text).toBe(201);
    return String(response.body.Id);
  };
  const volume = async () => {
    const response = await call('POST', '/volumes/create', { Driver: 'local', DriverOpts: {} });
    expect(response.status).toBe(201);
    return String(response.body.Name);
  };
  beforeEach(async () => {
    counter = 1;
    containers = new Map();
    volumes = new Map();
    forwarded = [];
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-test-'));
    daemon = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const body =
          bytes.length && req.headers['content-type'] === 'application/json'
            ? (JSON.parse(bytes.toString()) as ObjectValue)
            : {};
        const target = (req.url ?? '').replace(/^\/v[0-9.]+/, '').split('?')[0] ?? '';
        forwarded.push({ body, method: req.method ?? '', path: target });
        if (target.endsWith('/wait') && req.url?.includes('next-exit')) {
          waiting = res;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.flushHeaders();
          return;
        }
        if (target.endsWith('/start') && waiting) {
          waiting.end('{"StatusCode":0}');
          waiting = undefined;
        }
        let result: unknown = {};
        let status = 200;
        if (target === '/containers/create') {
          const id = (counter++).toString(16).padStart(64, '0');
          containers.set(id, {
            Config: { Labels: body.Labels, User: body.User ?? '' },
            HostsPath: `/daemon/containers/${id}/hosts`,
            Id: id,
            Name: `/${new URL(req.url ?? '', 'http://daemon').searchParams.get('name')}`,
          });
          result = { Id: id };
          status = 201;
        } else if (target === '/containers/json') {
          result = [...containers.values()].map((container) => ({
            Id: container.Id,
            Labels: (container.Config as ObjectValue).Labels,
          }));
        } else if (target === '/volumes/create') {
          volumes.set(String(body.Name), body);
          result = body;
          status = 201;
        } else if (target === '/volumes') {
          result = { Volumes: [...volumes.values()] };
        } else if (/^\/containers\/[^/]+\/json$/.test(target)) {
          result = containers.get(target.split('/')[2] ?? '') ?? {};
        } else if (/^\/containers\/[^/]+\/exec$/.test(target)) {
          result = { Id: (counter++).toString(16).padStart(64, '0') };
          status = 201;
        } else if (req.method === 'DELETE') {
          status = 204;
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 204 ? undefined : JSON.stringify(result));
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await listen(daemon);
    broker = new Broker(
      config({ DOCKER_BROKER_STATE_DIR: directory, DOCKER_BROKER_UPSTREAM: address(daemon) })
    );
    await broker.initialize();
    await listen(broker.server);
  });
  afterEach(async () => {
    await close(broker.server);
    await close(daemon);
    await fs.rm(directory, { force: true, recursive: true });
  });

  it.each<Profile>([
    'workspace',
    'probe',
    'service',
    'iptables',
    'pid-cleanup',
    'hosts-writer',
    'holder',
    'author',
    'git-helper',
  ])('accepts the bounded %s profile', async (profile) => {
    const target = await create();
    const vol = await volume();
    const input = base(profile);
    const host = input.HostConfig as ObjectValue;
    if (profile === 'service' || profile === 'iptables') {
      host.NetworkMode = `container:${target}`;
    }
    if (profile === 'service') {
      host.CapAdd = ['CHOWN', 'SETUID', 'SETGID', 'FOWNER', 'DAC_OVERRIDE'];
    }
    if (profile === 'iptables') {
      host.CapAdd = ['NET_ADMIN'];
    }
    if (profile === 'pid-cleanup') {
      host.NetworkMode = 'none';
      host.PidMode = `container:${target}`;
      host.CapAdd = ['KILL', 'SYS_PTRACE'];
    }
    if (['pid-cleanup', 'hosts-writer', 'holder', 'author'].includes(profile)) {
      host.ReadonlyRootfs = true;
    }
    if (['holder', 'author'].includes(profile)) {
      host.Tmpfs = { '/tmp': 'size=64m,mode=1777' };
    }
    if (profile === 'author') {
      host.NetworkMode = 'none';
    }
    if (profile === 'hosts-writer') {
      host.NetworkMode = 'none';
      input.User = '0:0';
      input.Labels = { [PROFILE_LABEL]: profile, 'auto-swe.target': target };
      input.Cmd = [
        '/usr/bin/env',
        '-i',
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        '/bin/sh',
        '-ec',
        'cat > /asw-hosts',
      ];
    }
    if (profile === 'author' || profile === 'git-helper') {
      host.Binds = [`${vol}:/workspace:rw`];
    }
    await create(input);
    if (profile === 'hosts-writer') {
      expect((forwarded.at(-2)?.body.HostConfig as ObjectValue | undefined)?.Mounts).toEqual([
        {
          ReadOnly: false,
          Source: `/daemon/containers/${target}/hosts`,
          Target: '/asw-hosts',
          Type: 'bind',
        },
      ]);
    }
    host.Privileged = true;
    expect((await call('POST', '/containers/create', input)).status).toBe(403);
  });
  it.each([
    ['privileged', { Privileged: true }],
    ['host bind', { Binds: ['/:/workspace:rw'] }],
    ['socket bind', { Binds: ['/var/run/docker.sock:/socket:rw'] }],
    ['host pid', { PidMode: 'host' }],
    ['host net', { NetworkMode: 'host' }],
    ['host IPC', { IpcMode: 'host' }],
    ['host userns', { UsernsMode: 'host' }],
    ['host cgroupns', { CgroupnsMode: 'host' }],
    ['devices', { Devices: [{ PathInContainer: '/dev/kmsg', PathOnHost: '/dev/kmsg' }] }],
    ['GPU', { DeviceRequests: [{ Count: -1 }] }],
    ['seccomp', { SecurityOpt: ['seccomp=unconfined'] }],
    ['apparmor', { SecurityOpt: ['apparmor=unconfined'] }],
    ['extra caps', { CapAdd: ['SYS_ADMIN'] }],
    ['sysctls', { Sysctls: { 'kernel.foo': '1' } }],
    ['cgroup parent', { CgroupParent: '/' }],
    ['masked paths', { MaskedPaths: [] }],
    ['readonly paths', { ReadonlyPaths: [] }],
    ['runtime', { Runtime: 'evil' }],
    ['mounts', { Mounts: [{ Source: '/', Target: '/host', Type: 'bind' }] }],
    ['all ports', { PublishAllPorts: true }],
    ['tmpfs', { Tmpfs: { '/host': 'size=1g' } }],
    ['unknown', { Unknown: true }],
  ])('rejects %s', async (_name, change) => {
    const input = base();
    Object.assign(input.HostConfig as ObjectValue, change);
    expect((await call('POST', '/containers/create', input)).status).toBe(403);
  });
  it('rejects forged labels, unknown top-level keys, duplicate and escaped duplicate keys', async () => {
    for (const change of [
      { Labels: { [PROFILE_LABEL]: 'workspace', [OWNER_LABEL]: 'forged' } },
      { Unexpected: false },
    ]) {
      expect((await call('POST', '/containers/create', { ...base(), ...change })).status).toBe(403);
    }
    for (const raw of [
      '{"Image":"alpine","Image":"other"}',
      '{"HostConfig":{"Privileged":false,"Privileged":true}}',
      '{"a":0,"\\u0061":1}',
    ]) {
      expect((await call('POST', '/containers/create', raw, true)).status).toBe(403);
    }
  });
  it('rejects invalid/empty JSON and oversized bodies', async () => {
    for (const raw of ['', '{', '{}{}', '{"a":NaN}']) {
      expect((await call('POST', '/containers/create', raw, true)).status).toBe(403);
    }
    expect(
      (await call('POST', '/containers/create', ' '.repeat(broker.config.maxJson + 1), true)).status
    ).toBe(403);
  });
  it.each([
    '/containers/x/../create',
    '/containers/%2e%2e/create',
    '/%63ontainers/create',
    '/containers%2fcreate',
    '//containers/create',
    '/build',
    '/images/load',
    '/plugins',
    '/containers/create?name=a&name=b',
  ])('refuses path/query trick %s', async (target) => {
    // URL construction normalizes dot segments, so send the request target verbatim.
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        address(broker.server),
        { method: 'POST', path: target },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        }
      );
      request.on('error', reject);
      request.end('{}');
    });
    expect(status).toBe(403);
  });
  it('restricts volume driver options and issues names, without leaking its label', async () => {
    for (const value of [
      { Name: 'caller-name' },
      { Driver: 'nfs' },
      { DriverOpts: { device: '/', o: 'bind', type: 'none' } },
      { Labels: { [OWNER_LABEL]: 'forged' } },
    ]) {
      expect((await call('POST', '/volumes/create', value)).status).toBe(403);
    }
    const name = await volume();
    expect(name).toMatch(/^asw-volume-/);
    const response = await call('GET', `/volumes/${name}`);
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(OWNER_LABEL);
    expect((await call('DELETE', `/volumes/${name}?force=1`)).status).toBe(204);
    expect((await call('GET', `/volumes/${name}`)).status).toBe(403);
  });
  it('denies all non-owned objects and foreign namespace/volume joins', async () => {
    for (const [method, target] of [
      ['GET', '/containers/foreign/json'],
      ['POST', '/containers/foreign/start'],
      ['POST', '/containers/foreign/exec'],
      ['GET', '/containers/foreign/archive?path=/'],
      ['PUT', '/containers/foreign/archive?path=/'],
      ['DELETE', '/containers/foreign'],
      ['GET', '/volumes/foreign'],
      ['DELETE', '/volumes/foreign'],
      ['GET', `/exec/${'f'.repeat(64)}/json`],
    ]) {
      const response = await call(method ?? '', target ?? '', method === 'POST' ? {} : undefined);
      expect(response.status).toBe(403);
      expect(response.text).toContain(SIGNATURE);
    }
    const input = base('iptables');
    Object.assign(input.HostConfig as ObjectValue, {
      CapAdd: ['NET_ADMIN'],
      NetworkMode: 'container:foreign',
    });
    expect((await call('POST', '/containers/create', input)).status).toBe(403);
    const author = base('author');
    Object.assign(author.HostConfig as ObjectValue, {
      Binds: ['foreign:/workspace:rw'],
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'size=64m,mode=1777' },
    });
    expect((await call('POST', '/containers/create', author)).status).toBe(403);
  });
  it('permits the owned lifecycle, archive streaming and image pull/inspect only', async () => {
    const id = await create();
    for (const action of ['start', 'wait', 'kill', 'pause', 'unpause']) {
      expect((await call('POST', `/containers/${id}/${action}`)).status).toBe(200);
    }
    for (const target of [
      `/containers/${id}/json`,
      `/containers/${id}/logs?stdout=1`,
      `/containers/${id}/archive?path=/workspace`,
      '/_ping',
      '/version',
      '/images/alpine:3.20/json',
    ]) {
      expect((await call('GET', target)).status).toBe(200);
    }
    expect(
      (await call('PUT', `/containers/${id}/archive?path=/workspace`, 'tar bytes', true)).status
    ).toBe(200);
    expect((await call('POST', '/images/create?fromImage=alpine&tag=3.20')).status).toBe(200);
    expect((await call('POST', '/images/create?fromSrc=http://evil')).status).toBe(403);
    expect((await call('POST', '/images/create?fromImage=evil.example/image')).status).toBe(403);
    expect((await call('POST', `/containers/${id}/update`, {})).status).toBe(403);
    expect((await call('DELETE', `/containers/${id}?force=1`)).status).toBe(204);
    expect((await call('GET', `/containers/${id}/json`)).status).toBe(403);
  });
  it('never permits host or unowned shared namespaces even in configured networks', async () => {
    broker.config.networks.push('host', 'container:foreign');
    for (const network of ['host', 'container:foreign']) {
      const input = base();
      (input.HostConfig as ObjectValue).NetworkMode = network;
      expect((await call('POST', '/containers/create', input)).status).toBe(403);
    }
  });
  it('enforces the root phase, rejects aliases, persists exec ownership and phase across restart', async () => {
    const id = await create();
    const exec = (user: string, extra = {}) =>
      call('POST', `/containers/${id}/exec`, { Cmd: ['id'], User: user, ...extra });
    expect((await exec('root')).status).toBe(201);
    expect((await exec('0:1000')).status).toBe(201);
    expect((await exec('0', { Privileged: true })).status).toBe(403);
    expect((await exec('administrator')).status).toBe(403);
    expect((await exec('0000')).status).toBe(403);
    const nonroot = await exec('1000');
    expect(nonroot.status).toBe(201);
    const execId = String(nonroot.body.Id);
    expect((await exec('0')).status).toBe(403);
    expect((await exec('0:1000')).status).toBe(403);
    expect((await exec('root:1000')).status).toBe(403);
    await close(broker.server);
    broker = new Broker(broker.config);
    await broker.initialize();
    await listen(broker.server);
    expect((await exec('0')).status).toBe(403);
    expect((await call('GET', `/exec/${execId}/json`)).status).toBe(200);
    expect(
      (await call('POST', `/exec/${execId}/start`, { Detach: false, Tty: false })).status
    ).toBe(200);
    expect(
      (await call('POST', `/exec/${execId}/start`, { Detach: false, Extra: true, Tty: false }))
        .status
    ).toBe(403);
    expect((await call('GET', '/containers/json?all=1')).text).not.toContain(OWNER_LABEL);
  });
  it.each([{ name: ['fixture'] }, { name: { fixture: true } }])(
    'accepts Docker CLI filter encodings (%j)',
    async (filters) => {
      await create();
      expect(
        (
          await call(
            'GET',
            `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}`
          )
        ).status
      ).toBe(200);
    }
  );
  it('rejects invalid and reserved filter entries', async () => {
    for (const filters of [
      { name: { fixture: false } },
      { label: { 'io.auto-swe.broker.owner': true } },
      { label: ['io.auto-swe.broker.owner'] },
    ]) {
      expect(
        (
          await call(
            'GET',
            `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}`
          )
        ).status
      ).toBe(403);
    }
  });
  it('flushes wait headers before exit so the Docker client can start the container', async () => {
    const id = await create();
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        new URL(`/containers/${id}/wait?condition=next-exit`, address(broker.server)),
        { method: 'POST' },
        (response) => {
          response.resume();
          response.on('end', resolve);
          response.on('error', reject);
          void call('POST', `/containers/${id}/start`)
            .then((result) => {
              expect(result.status).toBe(200);
            })
            .catch(reject);
        }
      );
      request.on('error', reject);
      request.end();
    });
  });
  it('limits archive uploads before forwarding their body', async () => {
    const id = await create();
    broker.config.maxStream = 16;
    expect(
      (await call('PUT', `/containers/${id}/archive?path=/workspace`, 'x'.repeat(17), true)).status
    ).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        new URL(`/containers/${id}/archive?path=/workspace`, address(broker.server)),
        { method: 'PUT' },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        }
      );
      request.on('error', reject);
      request.write('x'.repeat(17));
      request.end();
    });
    expect(status).toBe(403);
  });
  it.each([
    { bounded: false, kind: 'attach' },
    { bounded: false, kind: 'exec' },
    { bounded: true, kind: 'attach' },
    { bounded: true, kind: 'exec' },
  ])('preserves and bounds upgraded streams ($kind/$bounded)', async ({ kind, bounded }) => {
    if (bounded) {
      broker.config.maxStream = 3;
    }
    const id = await create();
    const exec =
      kind === 'exec'
        ? await call('POST', `/containers/${id}/exec`, {
            AttachStdin: true,
            AttachStdout: true,
            Cmd: ['cat'],
          })
        : undefined;
    const sockets = new Set<Socket>();
    const fake = netServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let bytes = Buffer.alloc(0);
      let upgraded = false;
      socket.on('data', (chunk: Buffer) => {
        if (upgraded) {
          socket.end(chunk);
          return;
        }
        bytes = Buffer.concat([bytes, chunk]);
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0) {
          return;
        }
        const size = Number(
          /content-length: (\d+)/i.exec(bytes.subarray(0, end).toString())?.[1] ?? 0
        );
        if (bytes.length < end + 4 + size) {
          return;
        }
        if (process.env.DOCKER_BROKER_TRACE === 'true') {
          console.info(`raw fake upgrade: body=${size} received=${bytes.length - end - 4}`);
        }
        upgraded = true;
        socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nready');
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    broker.config.upstream = new URL(`http://127.0.0.1:${(fake.address() as AddressInfo).port}`);
    const endpoint =
      kind === 'exec'
        ? `/exec/${String(exec?.body.Id)}/start`
        : `/containers/${id}/attach?stdin=1&stdout=1&stream=1`;
    const body = kind === 'exec' ? JSON.stringify({ Detach: false, Tty: false }) : '';
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const request = http.request(new URL(endpoint, address(broker.server)), {
          headers: {
            connection: 'Upgrade',
            'content-length': Buffer.byteLength(body),
            'content-type': 'application/json',
            upgrade: 'tcp',
          },
          method: 'POST',
        });
        request.on('error', reject);
        request.on('upgrade', (_response, socket, head) => {
          let output = head.toString();
          let sent = false;
          const send = () => {
            if (!sent && output.includes('ready')) {
              sent = true;
              socket.write('stdin');
            }
          };
          socket.on('data', (data: Buffer) => {
            output += data.toString();
            send();
          });
          socket.on('end', () => {
            socket.destroy();
            resolve(output);
          });
          socket.on('error', reject);
          send();
        });
        request.on('response', (response) => {
          let error = '';
          response.on('data', (data: Buffer) => {
            error += data.toString();
          });
          response.on('end', () =>
            reject(new Error(`upgrade refused: ${response.statusCode} ${error}`))
          );
        });
        request.end(body);
      });
      expect(output).toBe(bounded ? '' : 'readystdin');
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
  it('keeps already-root container execs working after a non-root exec', async () => {
    const input = base();
    input.User = '0';
    const id = await create(input);
    expect(
      (await call('POST', `/containers/${id}/exec`, { Cmd: ['id'], User: '1000' })).status
    ).toBe(201);
    expect((await call('POST', `/containers/${id}/exec`, { Cmd: ['id'], User: '0' })).status).toBe(
      201
    );
  });
});
describe('strict JSON parser', () => {
  it('handles escapes, literals, arrays, Unicode and rejects malformed/duplicate nesting', () => {
    const text = '{"a":[true,false,null,-1.2e3,"x\\"y",{"😀":"é"}]}';
    expect(parseJson(Buffer.from(text))).toEqual(JSON.parse(text));
    for (const text of ['[1,]', '{"a":1,}', '01', '{"a":{"x":1,"x":2}}']) {
      expect(() => parseJson(Buffer.from(text))).toThrow();
    }
    expect(() => parseJson(Buffer.from([0xff]))).toThrow();
  });
});
