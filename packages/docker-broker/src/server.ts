import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { Transform } from 'node:stream';
import {
  allowedImage,
  type Config,
  OWNER_LABEL,
  OWNER_PREFIX,
  PROFILE_LABEL,
  type Profile,
  TARGET_LABEL,
} from './config.ts';
import { Denied, keys, object, parseJson } from './json.ts';
import {
  bool,
  check,
  containerCreate,
  labels,
  type OwnedContainer,
  querySchema,
  rootUser,
  route,
} from './policy.ts';

export const SIGNATURE = 'ASW_DOCKER_BROKER_DENIED';
export class UpstreamError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}
const JSON_LIMIT = 32 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const TIMEOUT = 65 * 60 * 1000;
interface State {
  owner: string;
  execs: Record<string, string>;
  sealed: string[];
}
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith(OWNER_PREFIX))
        .map(([key, item]) => [key, scrub(item)])
    );
  }
  return value;
}
async function collect(stream: AsyncIterable<Buffer | string>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    check(size <= limit, 'body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function limiter(max: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > max ? new Error('broker stream limit') : null, chunk);
    },
  });
}
function headers(input: http.IncomingHttpHeaders, upgrade = false): http.OutgoingHttpHeaders {
  const result = { ...input };
  for (const key of [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
  ]) {
    delete result[key];
  }
  if (upgrade) {
    result.connection = 'Upgrade';
    result.upgrade = 'tcp';
  }
  return result;
}
export class Broker {
  private state: State = { execs: {}, owner: '', sealed: [] };
  private readonly containers = new Map<string, OwnedContainer>();
  private readonly names = new Map<string, string>();
  private readonly volumes = new Set<string>();
  private saving = Promise.resolve();
  readonly server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void this.request(req, res).catch((error: unknown) => this.deny(res, error));
  });
  readonly config: Config;
  constructor(config: Config) {
    this.config = config;
    this.server.requestTimeout = TIMEOUT;
    this.server.headersTimeout = 10_000;
    this.server.on('upgrade', (req, socket, head) => {
      socket.pause();
      void this.upgrade(req, socket, head).catch((error: unknown) => {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nX-ASW-Docker-Broker: deny\r\n\r\n${JSON.stringify({ message: `${SIGNATURE}: ${error instanceof Denied ? error.message : 'unavailable'}` })}`
        );
      });
    });
  }
  private deny(res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(error instanceof Denied ? 403 : 503, {
      connection: 'close',
      'content-type': 'application/json',
      'x-asw-docker-broker': 'deny',
    });
    res.end(
      JSON.stringify({
        message: `${SIGNATURE}: ${error instanceof Denied ? error.message : 'unavailable'}`,
      })
    );
  }
  private async save(): Promise<void> {
    const data = JSON.stringify(this.state);
    this.saving = this.saving.then(async () => {
      const file = path.join(this.config.stateDir, 'state.json');
      const temporary = `${file}.${randomUUID()}`;
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    });
    await this.saving;
  }
  async initialize(): Promise<void> {
    this.containers.clear();
    this.names.clear();
    this.volumes.clear();
    await fs.mkdir(this.config.stateDir, { mode: 0o700, recursive: true });
    try {
      const state = object(
        JSON.parse(await fs.readFile(path.join(this.config.stateDir, 'state.json'), 'utf8'))
      );
      check(
        typeof state.owner === 'string' && /^[a-f0-9]{64}$/.test(state.owner),
        'invalid ownership state'
      );
      check(
        Array.isArray(state.sealed) && state.sealed.every((id) => typeof id === 'string'),
        'invalid phase state'
      );
      const execs = object(state.execs);
      check(
        Object.values(execs).every((id) => typeof id === 'string'),
        'invalid exec state'
      );
      this.state = {
        execs: execs as Record<string, string>,
        owner: state.owner,
        sealed: state.sealed as string[],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.state.owner = randomBytes(32).toString('hex');
      await this.save();
    }
    const containers = await this.json('GET', '/containers/json?all=1');
    check(Array.isArray(containers), 'invalid daemon listing');
    for (const entry of containers) {
      const container = object(entry);
      if (
        object(container.Labels ?? {})[OWNER_LABEL] === this.state.owner &&
        typeof container.Id === 'string'
      ) {
        await this.remember(container.Id);
      }
    }
    const volumes = object(await this.json('GET', '/volumes'));
    for (const entry of (volumes.Volumes ?? []) as unknown[]) {
      const volume = object(entry);
      if (
        object(volume.Labels ?? {})[OWNER_LABEL] === this.state.owner &&
        typeof volume.Name === 'string'
      ) {
        this.volumes.add(volume.Name);
      }
    }
  }
  private upstream(
    method: string,
    target: string,
    input: http.OutgoingHttpHeaders = {}
  ): http.ClientRequest {
    const request = http.request(new URL(target, this.config.upstream), { headers: input, method });
    request.setTimeout(TIMEOUT, () => request.destroy(new Error('broker upstream timeout')));
    return request;
  }
  private async json(method: string, target: string, body?: unknown): Promise<unknown> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = this.upstream(
        method,
        target,
        data ? { 'content-length': data.length, 'content-type': 'application/json' } : {}
      );
      request.setTimeout(10_000, () => request.destroy(new Error('timeout')));
      request.on('error', (error: NodeJS.ErrnoException) =>
        reject(
          new UpstreamError(
            `Docker upstream ${method} ${target}: ${error.code ?? 'unreachable'}`,
            true
          )
        )
      );
      request.on('response', (response) => {
        void collect(response, JSON_LIMIT)
          .then((bytes) => {
            if ((response.statusCode ?? 500) >= 400) {
              throw new UpstreamError(
                `Docker upstream ${method} ${target}: HTTP ${response.statusCode ?? 0}`,
                (response.statusCode ?? 500) >= 500
              );
            }
            resolve(bytes.length ? (JSON.parse(bytes.toString()) as unknown) : {});
          })
          .catch(reject);
      });
      request.end(data);
    });
  }
  private async remember(id: string): Promise<void> {
    const info = object(await this.json('GET', `/containers/${id}/json`));
    const config = object(info.Config);
    check(object(config.Labels ?? {})[OWNER_LABEL] === this.state.owner, 'container not owned');
    const profile = object(config.Labels)[PROFILE_LABEL] as Profile;
    this.containers.set(id, {
      hostsPath: String(info.HostsPath ?? ''),
      id,
      profile,
      user: String(config.User ?? ''),
    });
    this.names.set(String(info.Name ?? '').replace(/^\//, ''), id);
  }
  container(name: string): OwnedContainer {
    check(ID.test(name), 'invalid container ID');
    const id = this.names.get(name) ?? name;
    const exact = this.containers.get(id);
    if (exact) {
      return exact;
    }
    const matches = [...this.containers.values()].filter((container) =>
      container.id.startsWith(id)
    );
    check(matches.length === 1, 'container not owned');
    const found = matches[0];
    check(found, 'container not owned');
    return found;
  }
  volume(name: string): string {
    check(this.volumes.has(name), 'volume not owned');
    return name;
  }
  private async authorize(
    method: string,
    raw: string,
    body?: Buffer
  ): Promise<{ target: string; body?: Buffer; json: boolean; action?: string; id?: string }> {
    const { path: endpoint, query, version } = route(method, raw);
    if (['GET', 'HEAD', 'DELETE'].includes(method)) {
      check(!body?.length, 'body forbidden');
    }
    const parsed = () => parseJson(body ?? Buffer.alloc(0));
    const result = (
      target = endpoint,
      data = body,
      json = false,
      action?: string,
      id?: string
    ) => ({
      action,
      body: data,
      id,
      json,
      target: `${version}${target}${query.size ? `?${query}` : ''}`,
    });
    if (
      ((method === 'GET' || method === 'HEAD') && endpoint === '/_ping') ||
      (method === 'GET' && endpoint === '/version')
    ) {
      querySchema(query, {});
      check(!body?.length, 'body forbidden');
      return result();
    }
    if (method === 'POST' && endpoint === '/containers/create') {
      querySchema(query, { name: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/ });
      const input = parsed();
      const tags = labels(object(input).Labels);
      if (tags[PROFILE_LABEL] === 'hosts-writer') {
        await this.remember(this.container(tags[TARGET_LABEL] ?? '').id);
      }
      const value = await containerCreate(input, this.config, this);
      value.Labels = { ...labels(value.Labels), [OWNER_LABEL]: this.state.owner };
      return result(endpoint, Buffer.from(JSON.stringify(value)), true, 'container-create');
    }
    if (method === 'POST' && endpoint === '/volumes/create') {
      querySchema(query, {});
      const value = object(parsed());
      keys(value, ['Name', 'Driver', 'DriverOpts', 'Labels', 'ClusterVolumeSpec']);
      check(value.Name === undefined || value.Name === '', 'volume names are broker-issued');
      check(
        value.Driver === undefined || value.Driver === '' || value.Driver === 'local',
        'volume driver forbidden'
      );
      check(
        value.DriverOpts === undefined ||
          value.DriverOpts === null ||
          Object.keys(object(value.DriverOpts)).length === 0,
        'volume options forbidden'
      );
      check(
        value.ClusterVolumeSpec === undefined || value.ClusterVolumeSpec === null,
        'cluster volume forbidden'
      );
      const tag = labels(value.Labels);
      const name = `asw-volume-${randomUUID()}`;
      return result(
        endpoint,
        Buffer.from(
          JSON.stringify({
            Driver: 'local',
            Labels: { ...tag, [OWNER_LABEL]: this.state.owner },
            Name: name,
          })
        ),
        true,
        'volume-create'
      );
    }
    if (method === 'GET' && (endpoint === '/containers/json' || endpoint === '/volumes')) {
      querySchema(query, { all: bool, filters: /^.{0,8192}$/, limit: /^-?\d{1,5}$/, size: bool });
      if (query.has('filters')) {
        const filters = object(parseJson(Buffer.from(query.get('filters') ?? '')));
        keys(filters, ['label', 'name', 'status']);
        for (const values of Object.values(filters)) {
          const entries = Array.isArray(values)
            ? values
            : Object.entries(object(values)).map(([key, enabled]) => {
                check(enabled === true, 'filter forbidden');
                return key;
              });
          check(
            entries.every((value) => typeof value === 'string' && !value.includes(OWNER_PREFIX)),
            'filter forbidden'
          );
        }
      }
      return result(
        endpoint,
        undefined,
        true,
        endpoint === '/volumes' ? 'volume-list' : 'container-list'
      );
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(endpoint);
    if (volume && (method === 'GET' || method === 'DELETE')) {
      const name = this.volume(volume[1] ?? '');
      querySchema(query, method === 'DELETE' ? { force: bool } : {});
      return result(
        `/volumes/${name}`,
        undefined,
        method === 'GET',
        method === 'DELETE' ? 'volume-delete' : undefined,
        name
      );
    }
    if (method === 'POST' && endpoint === '/images/create') {
      querySchema(query, {
        fromImage: /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/,
        platform: /^(?:linux\/)?(?:amd64|arm64)(?:\/v8)?$/,
        tag: /^[a-zA-Z0-9_.:@-]{1,256}$/,
      });
      check(
        query.has('fromImage') && allowedImage(query.get('fromImage') ?? '', this.config),
        'image not allowed'
      );
      check(!body?.length, 'image import forbidden');
      return result();
    }
    const image = /^\/images\/(.+)\/json$/.exec(endpoint);
    if (method === 'GET' && image) {
      querySchema(query, {});
      check(allowedImage(image[1] ?? '', this.config), 'image not allowed');
      return result(endpoint, undefined, true);
    }
    const container = /^\/containers\/([^/]+)(?:\/([a-z]+))?$/.exec(endpoint);
    if (container) {
      const target = this.container(container[1] ?? '');
      const action = container[2] ?? '';
      const base = `/containers/${target.id}`;
      if (method === 'POST' && action === 'exec') {
        querySchema(query, {});
        const exec = object(parsed());
        keys(exec, [
          'AttachStdin',
          'AttachStdout',
          'AttachStderr',
          'DetachKeys',
          'Tty',
          'Env',
          'Cmd',
          'Privileged',
          'User',
          'WorkingDir',
          'ConsoleSize',
        ]);
        check(
          exec.Privileged === undefined || exec.Privileged === false,
          'privileged exec forbidden'
        );
        check(
          Array.isArray(exec.Cmd) &&
            exec.Cmd.length > 0 &&
            exec.Cmd.every((part) => typeof part === 'string'),
          'invalid exec command'
        );
        check(
          exec.Env === undefined ||
            exec.Env === null ||
            (Array.isArray(exec.Env) && exec.Env.every((part) => typeof part === 'string')),
          'invalid exec env'
        );
        for (const field of ['AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty']) {
          check(
            exec[field] === undefined || typeof exec[field] === 'boolean',
            'invalid exec boolean'
          );
        }
        for (const field of ['DetachKeys', 'User', 'WorkingDir']) {
          check(
            exec[field] === undefined || typeof exec[field] === 'string',
            'invalid exec string'
          );
        }
        check(
          !exec.User ||
            /^(?:root|0|[1-9][0-9]{0,9})(?::(?:root|0|[1-9][0-9]{0,9}))?$/.test(String(exec.User)),
          'explicit exec user must be canonical'
        );
        check(
          exec.ConsoleSize === undefined ||
            exec.ConsoleSize === null ||
            (Array.isArray(exec.ConsoleSize) &&
              exec.ConsoleSize.length === 2 &&
              exec.ConsoleSize.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 10000)),
          'invalid exec size'
        );
        const user = String(exec.User || target.user);
        if (rootUser(user) && !rootUser(target.user)) {
          check(
            ['workspace', 'probe'].includes(target.profile) &&
              !this.state.sealed.includes(target.id),
            'root exec phase closed'
          );
        } else if (!rootUser(user) && !this.state.sealed.includes(target.id)) {
          this.state.sealed.push(target.id);
          await this.save();
        }
        return result(`${base}/exec`, body, true, 'exec-create', target.id);
      }
      if (action === 'archive' && (method === 'GET' || method === 'PUT' || method === 'HEAD')) {
        querySchema(query, { copyUIDGID: bool, noOverwriteDirNonDir: bool, path: /^\/.{0,4096}$/ });
        check(query.has('path'), 'archive path required');
        check(
          !['hosts-writer', 'iptables', 'pid-cleanup'].includes(target.profile),
          'helper archive forbidden'
        );
        return result(`${base}/archive`, body);
      }
      const operations: Record<
        string,
        { method: string; query: Record<string, RegExp>; json?: boolean }
      > = {
        '': { method: 'DELETE', query: { force: bool, link: /^(?:false|0)$/, v: bool } },
        attach: {
          method: 'POST',
          query: {
            detachKeys: /^.{0,64}$/,
            logs: bool,
            stderr: bool,
            stdin: bool,
            stdout: bool,
            stream: bool,
          },
        },
        json: { json: true, method: 'GET', query: { size: bool } },
        kill: {
          method: 'POST',
          query: { signal: /^(?:SIG)?(?:KILL|TERM|INT|HUP|USR1|USR2|QUIT)$|^[1-9][0-9]?$/ },
        },
        logs: {
          method: 'GET',
          query: {
            details: bool,
            follow: bool,
            since: /^-?\d+(?:\.\d+)?$/,
            stderr: bool,
            stdout: bool,
            tail: /^(?:all|\d+)$/,
            timestamps: bool,
            until: /^-?\d+(?:\.\d+)?$/,
          },
        },
        pause: { method: 'POST', query: {} },
        start: { method: 'POST', query: {} },
        unpause: { method: 'POST', query: {} },
        wait: { method: 'POST', query: { condition: /^(?:not-running|next-exit|removed)$/ } },
      };
      const operation = operations[action];
      check(operation?.method === method, 'container operation forbidden');
      querySchema(query, operation.query);
      check(!body?.length, 'body forbidden');
      return result(
        `${base}${action ? `/${action}` : ''}`,
        undefined,
        operation.json ?? false,
        action === '' ? 'container-delete' : undefined,
        target.id
      );
    }
    const exec = /^\/exec\/([a-f0-9]{64})\/(start|json)$/.exec(endpoint);
    if (exec) {
      const id = exec[1] ?? '';
      const containerId = this.state.execs[id];
      check(containerId, 'exec not owned');
      this.container(containerId);
      querySchema(query, {});
      if (method === 'GET' && exec[2] === 'json') {
        return result(endpoint, undefined, true);
      }
      check(method === 'POST' && exec[2] === 'start', 'exec operation forbidden');
      const start = object(parsed());
      keys(start, ['Detach', 'Tty', 'ConsoleSize']);
      check(
        typeof start.Detach === 'boolean' && typeof start.Tty === 'boolean',
        'invalid exec start'
      );
      check(
        start.ConsoleSize === undefined ||
          start.ConsoleSize === null ||
          (Array.isArray(start.ConsoleSize) &&
            start.ConsoleSize.length === 2 &&
            start.ConsoleSize.every((n) => Number.isSafeInteger(n) && n >= 0 && n < 10000)),
        'invalid exec size'
      );
      return result();
    }
    throw new Denied('endpoint forbidden');
  }
  private async responseAction(
    action: string | undefined,
    value: unknown,
    id?: string
  ): Promise<unknown> {
    if (action === 'container-create') {
      await this.remember(String(object(value).Id));
    }
    if (action === 'volume-create') {
      this.volumes.add(String(object(value).Name));
    }
    if (action === 'exec-create') {
      check(id, 'missing exec target');
      this.state.execs[String(object(value).Id)] = id;
      await this.save();
    }
    if (action === 'container-list') {
      check(Array.isArray(value), 'invalid listing');
      value = value.filter((item) => this.containers.has(String(object(item).Id)));
    }
    if (action === 'volume-list') {
      const list = object(value);
      value = {
        ...list,
        Volumes: ((list.Volumes ?? []) as unknown[]).filter((item) =>
          this.volumes.has(String(object(item).Name))
        ),
      };
    }
    if (action === 'container-delete' && id) {
      this.containers.delete(id);
      this.state.sealed = this.state.sealed.filter((value) => value !== id);
      this.state.execs = Object.fromEntries(
        Object.entries(this.state.execs).filter(([, target]) => target !== id)
      );
      await this.save();
    }
    if (action === 'volume-delete' && id) {
      this.volumes.delete(id);
    }
    return scrub(value);
  }
  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? '';
    const streaming = req.method === 'PUT' && /\/archive(?:\?|$)/.test(raw);
    if (
      Number(req.headers['content-length'] ?? 0) >
      (streaming ? this.config.maxStream : this.config.maxJson)
    ) {
      throw new Denied('body too large');
    }
    const body = streaming ? undefined : await collect(req, this.config.maxJson);
    const authorized = await this.authorize(req.method ?? '', raw, body);
    const outgoing = headers(req.headers);
    if (!streaming) {
      outgoing['content-length'] = authorized.body?.length ?? 0;
    }
    const upstream = this.upstream(req.method ?? '', authorized.target, outgoing);
    upstream.on('error', (error) => this.deny(res, error));
    res.on('close', () => {
      if (!res.writableEnded) {
        upstream.destroy();
      }
    });
    upstream.on('response', (response) => {
      void (async () => {
        if (authorized.json) {
          const bytes = await collect(response, JSON_LIMIT);
          let value: unknown = bytes.length ? JSON.parse(bytes.toString()) : {};
          if ((response.statusCode ?? 500) < 400) {
            value = await this.responseAction(authorized.action, value, authorized.id);
          }
          const data = Buffer.from(JSON.stringify(scrub(value)));
          res.writeHead(response.statusCode ?? 502, {
            ...headers(response.headers),
            'content-length': data.length,
          });
          res.end(data);
        } else {
          if ((response.statusCode ?? 500) < 400 && authorized.action) {
            await this.responseAction(authorized.action, {}, authorized.id);
          }
          res.writeHead(response.statusCode ?? 502, headers(response.headers));
          res.flushHeaders();
          const cap = limiter(this.config.maxStream);
          cap.on('error', () => {
            response.destroy();
            res.destroy();
          });
          response.pipe(cap).pipe(res);
        }
      })().catch((error: unknown) => this.deny(res, error));
    });
    if (streaming) {
      const cap = limiter(this.config.maxStream);
      cap.on('error', () => {
        upstream.destroy();
        this.deny(res, new Denied('stream too large'));
      });
      req.on('error', () => upstream.destroy());
      req.pipe(cap).pipe(upstream);
    } else {
      upstream.end(authorized.body);
    }
  }
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const trace = (step: string) => {
      if (process.env.DOCKER_BROKER_TRACE === 'true') {
        console.info(
          `broker upgrade ${step}: head=${head.length} length=${req.headers['content-length'] ?? 0}`
        );
      }
    };
    trace('received');
    check(req.headers.upgrade?.toLowerCase() === 'tcp', 'upgrade protocol forbidden');
    const length = Number(req.headers['content-length'] ?? 0);
    check(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= this.config.maxJson &&
        req.headers['transfer-encoding'] === undefined,
      'invalid upgrade body'
    );
    req.socket.setTimeout(10_000, () => req.socket.destroy());
    const body = length ? await collect(req, this.config.maxJson) : Buffer.alloc(0);
    check(body.length === length, 'incomplete upgrade body');
    trace('authorize');
    const authorized = await this.authorize(req.method ?? '', req.url ?? '', body);
    trace('authorized');
    const endpoint = route(req.method ?? '', req.url ?? '').path;
    check(
      /^\/exec\/[a-f0-9]{64}\/start$/.test(endpoint) ||
        /^\/containers\/[^/]+\/attach$/.test(endpoint),
      'upgrade endpoint forbidden'
    );
    const outgoing = headers(req.headers, true);
    outgoing['content-length'] = authorized.body?.length ?? 0;
    const upstream = this.upstream(req.method ?? '', authorized.target, outgoing);
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    const connect = (response: IncomingMessage, peer: Duplex, extra: Buffer, status: number) => {
      const lines = Object.entries(headers(response.headers, status === 101))
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      socket.write(
        `HTTP/1.1 ${status} ${response.statusMessage ?? 'OK'}\r\n${lines.join('\r\n')}\r\n\r\n`
      );
      const incoming = limiter(this.config.maxStream);
      const outgoing = limiter(this.config.maxStream);
      const close = () => {
        peer.destroy();
        socket.destroy();
      };
      for (const stream of [incoming, outgoing, peer]) {
        stream.on('error', close);
      }
      peer.setMaxListeners(20);
      req.socket.setTimeout(TIMEOUT, close);
      peer.on('close', () => socket.end());
      socket.once('close', () => peer.destroy());
      incoming.pipe(peer);
      outgoing.pipe(socket);
      if (head.length) {
        incoming.write(head);
      }
      if (extra.length) {
        outgoing.write(extra);
      }
      socket.pipe(incoming);
      peer.pipe(outgoing);
      socket.resume();
    };
    upstream.on('upgrade', (response, peer, extra) =>
      connect(response, peer, extra, response.statusCode ?? 101)
    );
    upstream.on('response', (response) => {
      // A refused upgrade must remain a normal, bounded HTTP error.
      void collect(response, this.config.maxJson)
        .then((bytes) =>
          socket.end(
            `HTTP/1.1 ${response.statusCode ?? 502} Error\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n${bytes.toString()}`
          )
        )
        .catch(() => socket.destroy());
    });
    upstream.end(authorized.body);
  }
}
