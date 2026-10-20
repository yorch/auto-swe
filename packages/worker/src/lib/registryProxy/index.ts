/**
 * A read-only npm registry proxy in the worker.
 *
 * A workspace registers and gets a random token and the proxy's address in
 * place of every registry's real credential: the container never holds an
 * upstream token, and a token read out of it is good only at this proxy, only
 * for this workspace's lifetime, and — in `lockfile` access mode — only for
 * the package@version pairs committed on the base ref. GET and HEAD only.
 *
 * URL layout: `<baseUrl>/npm/<registryId>/<npm path>`, where the npm path is
 * either a packument `/<name>` (`pkg`, `@scope/pkg`, `@scope%2fpkg`) or a
 * tarball `/<name>/-/<file>.tgz`. Everything else is a JSON 404; other methods
 * are 405; an unknown token is 401; until the registration's allowlist is set
 * it answers 503 ("not ready"), a state `createWorkspace` never lets the agent
 * reach because it returns only once the allowlist is in place.
 *
 * Modelled on `agents/claudeCode/modelProxy.ts`.
 */
import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { TarballCache } from './cache.js';

export { TarballCache } from './cache.js';

/** Packuments are buffered for the tarball-URL rewrite; a bigger one is an upstream bug, not a stream. */
const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;

/** npm's own package-name shape; nothing here can start with `.` or `_` or carry a separator. */
const NAME_RE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const TARBALL_RE = /^[a-z0-9~-][a-z0-9._~-]*\.tgz$/i;
/** A path-prefix segment (a non-registry directory like Artifactory's `api/npm/npm-remote`). */
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const MAX_PREFIX_SEGMENTS = 8;

/** One upstream registry a registration fronts, with its decrypted credential. */
export interface ResolvedRegistry {
  id: string;
  name: string;
  upstreamUrl: string;
  authKind: 'bearer' | 'basic';
  allowPrivateNetwork: boolean;
  /** The decrypted token (bearer) or `user:password` (basic). Never leaves the worker. */
  token: string | null;
  /** npm scopes this registry claimed in resolution (`@acme`). */
  scopes: string[];
  /** Whether this registry won the unscoped/default key. */
  isDefault: boolean;
}

/** A denial reported to the registering activity for its run log. */
export interface RegistryDenial {
  registryId: string;
  name: string;
  version?: string;
  reason: 'not-in-lockfile' | 'no-versions' | 'registry-unknown';
}

interface Registration {
  registries: Map<string, ResolvedRegistry>;
  /** Per registry: its allowlist, or `null` for an `open` registry. */
  allowlists: Map<string, Map<string, Set<string>> | null> | undefined;
  onDenied(d: RegistryDenial): void;
  inFlight: Set<Promise<void>>;
}

export interface RegistryRegistration {
  /** `http://…` a workspace reaches the proxy at; per-registry URLs append `/npm/<registryId>`. */
  baseUrl: string;
  /** The bearer token the container presents. Digest only is kept. */
  token: string;
  /**
   * Makes the registration serve: until called it answers 503 for every
   * request. The map keys are registry ids; a `null` value opens that
   * registry (the `open` access mode).
   */
  setAllowlist(map: Map<string, Map<string, Set<string>> | null>): void;
  /** Revokes the token and waits for in-flight requests to end. */
  release(): Promise<void>;
}

export interface RegistryProxy {
  register(ws: {
    registries: ResolvedRegistry[];
    onDenied(d: RegistryDenial): void;
  }): Promise<RegistryRegistration>;
  /** Starts listening (registering does too) and resolves to the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Which registered registry serves `name`: a scoped name whose scope a
 * registry claimed goes there; everything else goes to the default.
 */
function routeRegistry(reg: Registration, name: string): ResolvedRegistry | undefined {
  const scope = name.startsWith('@') ? `@${name.slice(1).split('/')[0]?.toLowerCase()}` : null;
  if (scope) {
    for (const r of reg.registries.values()) {
      if (r.scopes.includes(scope)) {
        return r;
      }
    }
  }
  return [...reg.registries.values()].find((r) => r.isDefault);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  error: string,
  reasonPhrase?: string
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, reasonPhrase, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

function denyMessage(name: string, version: string | undefined): string {
  return `auto-swe: ${name}${version ? `@${version}` : ''} is not in the repository's committed lockfiles; this workspace can only install dependencies committed on the base branch`;
}

/**
 * The npm name and tarball file a request path asks for, or null. Two forms:
 * `/<name>` (packument) and `/<prefix…>/<name>/-/<file>` (tarball). The prefix
 * exists because npm's `replace-registry-host=always` keeps a lockfile
 * `resolved` URL's *path* and swaps only the origin — a lockfile written
 * against `https://art/api/npm/npm-remote/…` arrives with those segments
 * intact. Prefix segments are validated (no dot-segments, plain characters,
 * at most 8) and then discarded. The file may carry a `@scope/` prefix
 * (literal or `%40s%2f`); it is stripped here.
 *
 * `name` is returned decoded (`@s/p`); `tarball` decoded and unscoped.
 */
function packageNameOf(urlPath: string): { name: string; tarball: string | null } | null {
  const decode = (seg: string): string | null => {
    // A malformed escape (`%zz`) throws URIError — an agent can send one on
    // purpose, and it must be a 404, not an uncaught exception in the listener.
    try {
      return decodeURIComponent(seg);
    } catch {
      return null;
    }
  };
  const parts = urlPath.split('/');
  if (parts[0] !== '' || parts.length < 2) {
    return null;
  }
  const segs = parts.slice(1);

  // Tarball: `…/<name>/-/<file>` — the last bare '-' segment is the boundary.
  const dash = segs.lastIndexOf('-');
  if (dash < 0) {
    // Packument: exactly `/<name>`.
    if (segs.length !== 1) {
      return null;
    }
    const raw = decode(segs[0] ?? '');
    if (raw === null) {
      return null;
    }
    const name = raw.startsWith('%40') ? `@${raw.slice(3)}` : raw;
    return NAME_RE.test(name) ? { name, tarball: null } : null;
  }
  if (dash === 0) {
    return null;
  }
  const fileSegs = segs.slice(dash + 1);
  let fileRaw = fileSegs.join('/');
  const decodedFile = decode(fileRaw);
  if (decodedFile === null) {
    return null;
  }
  fileRaw = decodedFile;
  // Strip an `@scope/` file prefix (literal after decode, or `%40s%2f` raw).
  const slash = fileRaw.lastIndexOf('/');
  if (slash >= 0) {
    if (!fileRaw.startsWith('@')) {
      return null;
    }
    fileRaw = fileRaw.slice(slash + 1);
  }
  if (!TARBALL_RE.test(fileRaw)) {
    return null;
  }
  // The name is the segment(s) immediately before the '-' marker: a bare
  // `pkg`, or a scoped form occupying one segment (`@s%2fp`, `%40s%2fp`) or
  // two (`@s/p`).
  let nameSegs = 1;
  const tail = segs[dash - 1] ?? '';
  if (!tail.startsWith('@') && !tail.startsWith('%40') && !tail.toLowerCase().includes('%2f')) {
    const scopeSeg = segs[dash - 2];
    if (scopeSeg !== undefined && scopeSeg.startsWith('@')) {
      nameSegs = 2;
    }
  }
  const rawName = decode(segs.slice(dash - nameSegs, dash).join('/'));
  if (rawName === null) {
    return null;
  }
  const name = rawName.startsWith('%40') ? `@${rawName.slice(3)}` : rawName;
  if (!NAME_RE.test(name)) {
    return null;
  }
  // The remaining leading segments are a registry-path prefix; they are
  // validated (no dot-segments, no escapes — decode must round-trip) and
  // then discarded.
  const prefix = segs.slice(0, dash - nameSegs);
  if (prefix.length > MAX_PREFIX_SEGMENTS) {
    return null;
  }
  for (const seg of prefix) {
    const decoded = decode(seg);
    if (
      decoded === null ||
      !PREFIX_SEGMENT_RE.test(decoded) ||
      decoded === '.' ||
      decoded === '..'
    ) {
      return null;
    }
  }
  return { name, tarball: fileRaw };
}

/**
 * The version a tarball file name encodes: `<unscoped>-<version>.tgz`, where
 * the unscoped name is the part after the last `/` of the package name.
 */
export function tarballVersion(name: string, file: string): string | null {
  const unscoped = name.split('/').pop() ?? '';
  if (!file.startsWith(`${unscoped}-`) || !file.endsWith('.tgz')) {
    return null;
  }
  return file.slice(unscoped.length + 1, -'.tgz'.length);
}

interface FilteredPackument {
  body: Buffer;
  denied: { name: string; version?: string } | undefined;
}

/**
 * Rewrite a packument for the proxy: every `versions[v].dist.tarball` points
 * back here, and in lockfile mode versions not in the allowlist are dropped
 * (with their `dist-tags` and `time` entries). `denied` is set when nothing
 * survives the filter — a lockfile-mode client then sees the denial, not an
 * empty document.
 */
export function filterPackument(
  raw: Buffer,
  opts: {
    allowlist: Map<string, Set<string>> | null;
    baseUrl: string;
    name: string;
    registryId: string;
  }
): FilteredPackument {
  let doc: {
    'dist-tags'?: Record<string, string>;
    time?: Record<string, string>;
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    // Not a JSON packument — hand it through untouched.
    return { body: raw, denied: undefined };
  }
  const versions = doc.versions;
  if (!versions || typeof versions !== 'object') {
    return { body: raw, denied: undefined };
  }
  if (opts.allowlist) {
    const allowed = opts.allowlist.get(opts.name);
    const kept = new Set(Object.keys(versions).filter((v) => allowed?.has(v)));
    for (const v of Object.keys(versions)) {
      if (!kept.has(v)) {
        delete versions[v];
      }
    }
    if (kept.size === 0) {
      return { body: raw, denied: { name: opts.name } };
    }
    if (doc['dist-tags']) {
      const lastKept = Object.keys(versions).at(-1);
      for (const [tag, v] of Object.entries(doc['dist-tags'])) {
        if (kept.has(v)) {
          continue;
        }
        if (tag === 'latest' && lastKept) {
          doc['dist-tags'][tag] = lastKept;
        } else {
          delete doc['dist-tags'][tag];
        }
      }
    }
    if (doc.time) {
      for (const k of Object.keys(doc.time)) {
        if (k !== 'created' && k !== 'modified' && !kept.has(k)) {
          delete doc.time[k];
        }
      }
    }
  }
  for (const v of Object.values(versions)) {
    const tarball = v.dist?.tarball;
    if (typeof tarball === 'string') {
      const file = tarball.split('/').pop();
      if (file) {
        v.dist = {
          ...v.dist,
          tarball: `${opts.baseUrl}/npm/${opts.registryId}/${opts.name}/-/${file}`,
        };
      }
    }
  }
  return { body: Buffer.from(JSON.stringify(doc)), denied: undefined };
}

export function createRegistryProxy(options: {
  listenHost: string;
  listenPort: number;
  advertisedUrl: string | ((port: number) => string);
  /** Replaces the per-registry guarded fetch. Tests only. */
  upstreamFetch?: typeof fetch;
  /** Tarball cache; `createRegistryCache(dir, maxBytes)` when enabled. */
  cache?: TarballCache;
}): RegistryProxy {
  const registrations = new Map<string, Registration>();

  const upstreamFetchFor = (reg: ResolvedRegistry): typeof fetch =>
    options.upstreamFetch ?? createGuardedFetch({ allowPrivate: reg.allowPrivateNetwork });

  async function serve(
    reg: Registration,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    registry: ResolvedRegistry,
    name: string,
    tarballFile: string | null
  ): Promise<void> {
    const allowlist = reg.allowlists?.get(registry.id);
    // In lockfile mode a tarball's version is on the file name.
    let version: string | undefined;
    if (reg.allowlists && allowlist !== null && tarballFile) {
      version = tarballVersion(name, tarballFile) ?? undefined;
      if (!version || !allowlist?.get(name)?.has(version)) {
        reg.onDenied({ name, reason: 'not-in-lockfile', registryId: registry.id, version });
        sendJson(res, 403, denyMessage(name, version), denyMessage(name, version));
        return;
      }
    }
    if (reg.allowlists && allowlist !== null && !tarballFile) {
      // Packument filtering happens after the fetch — the upstream answer
      // decides what survives — but a name absent from the allowlist can be
      // denied without asking.
      if (!allowlist?.has(name)) {
        reg.onDenied({ name, reason: 'not-in-lockfile', registryId: registry.id });
        sendJson(res, 403, denyMessage(name, undefined), denyMessage(name, undefined));
        return;
      }
    }

    // Built from the validated name. Packuments encode the scope separator as
    // %2f (npm's own addressing); tarballs keep the literal slash form every
    // registry stores.
    const upstreamPath = `${registry.upstreamUrl}/${
      tarballFile ? name : name.replace('/', '%2f')
    }${tarballFile ? `/-/${tarballFile}` : ''}`;

    // A cached tarball answers from disk and never reaches the upstream.
    if (tarballFile && req.method === 'GET' && options.cache) {
      const hit = await options.cache.get(registry.id, upstreamPath).catch(() => null);
      if (hit) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const stream = hit.createStream();
        stream.pipe(res);
        return;
      }
    }

    const headers: Record<string, string> = {};
    const accept = req.headers.accept;
    if (typeof accept === 'string') {
      headers.accept = accept;
    }
    if (!tarballFile) {
      headers['accept-encoding'] = 'identity';
    }
    if (registry.token) {
      headers.authorization =
        registry.authKind === 'basic'
          ? `Basic ${Buffer.from(registry.token).toString('base64')}`
          : `Bearer ${registry.token}`;
    }

    let upstream: Response;
    try {
      upstream = await upstreamFetchFor(registry)(upstreamPath, {
        headers,
        method: req.method ?? 'GET',
        redirect: 'error',
      });
    } catch {
      sendJson(res, 502, 'the upstream registry could not be reached');
      return;
    }

    if (tarballFile) {
      // Streamed, and cached only on a complete 200 GET.
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        ...(upstream.headers.get('content-length')
          ? { 'content-length': upstream.headers.get('content-length') as string }
          : {}),
      });
      const cacheStream =
        req.method === 'GET' && upstream.status === 200 && options.cache && upstream.body
          ? await options.cache.startWrite(registry.id, upstreamPath).catch(() => null)
          : null;
      try {
        if (upstream.body) {
          for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
            const wrote = cacheStream ? await cacheStream.write(chunk) : Promise.resolve();
            const flushed = res.write(chunk);
            await wrote;
            if (!flushed) {
              await new Promise<void>((resolve) => {
                const done = () => {
                  res.off('drain', done);
                  res.off('close', done);
                  resolve();
                };
                res.on('drain', done);
                res.on('close', done);
              });
            }
          }
          res.end();
          await cacheStream?.commit().catch(() => {});
        } else {
          res.end();
          await cacheStream?.abort().catch(() => {});
        }
      } catch {
        res.destroy();
        await cacheStream?.abort().catch(() => {});
      }
      return;
    }

    // Packument: buffered (64 MiB cap), tarball URLs rewritten, allowlist applied.
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > MAX_PACKUMENT_BYTES) {
            sendJson(res, 502, 'the upstream packument is too large to proxy');
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch {
      sendJson(res, 502, 'the upstream registry could not be reached');
      return;
    }
    if (upstream.status !== 200) {
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(Buffer.concat(chunks));
      return;
    }
    const filtered = filterPackument(Buffer.concat(chunks), {
      allowlist: reg.allowlists ? (allowlist ?? null) : null,
      baseUrl: advertised(),
      name,
      registryId: registry.id,
    });
    if (filtered.denied) {
      reg.onDenied({ name, reason: 'no-versions', registryId: registry.id });
      sendJson(res, 403, denyMessage(name, undefined));
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(filtered.body);
  }

  const advertised = (): string => {
    if (typeof options.advertisedUrl === 'string') {
      return options.advertisedUrl;
    }
    const port = (server.address() as AddressInfo | null)?.port ?? options.listenPort;
    return options.advertisedUrl(port);
  };

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch {
      // The pre-dispatch path above is small but not provably total
      // (`new URL` on odd input, decode of odd escapes); a throw is a 500, not
      // a crashed worker.
      sendJson(res, 500, 'the request could not be parsed');
    }
  });

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const reg = token ? registrations.get(digest(token)) : undefined;
    if (!reg) {
      sendJson(res, 401, 'unknown or expired token');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://proxy');
    const m = /^\/npm\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) {
      sendJson(res, 404, 'only /npm/<registry>/… paths exist here');
      return;
    }
    // The URL's <id> only proves membership — the caller may legitimately
    // address a scoped tarball through the default registry's id (npm's
    // replace-registry-host keeps the default registry origin for every
    // resolved URL, scope or not). The upstream is picked by package name.
    const urlRegistry = reg.registries.get(m[1] ?? '');
    if (!urlRegistry) {
      sendJson(res, 404, 'unknown registry');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, 'read-only: GET and HEAD only');
      return;
    }
    if (!reg.allowlists) {
      sendJson(res, 503, 'the registry allowlist is not ready yet');
      return;
    }
    const parsed = packageNameOf(m[2] ?? '');
    if (!parsed) {
      sendJson(res, 404, 'unrecognized npm path');
      return;
    }
    const registry = routeRegistry(reg, parsed.name);
    if (!registry) {
      sendJson(res, 404, `no registry serves ${parsed.name}`);
      return;
    }
    const call = serve(reg, req, res, registry, parsed.name, parsed.tarball).catch(() => {
      sendJson(res, 502, 'the upstream registry could not be reached');
    });
    reg.inFlight.add(call);
    void call.finally(() => reg.inFlight.delete(call));
  }
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let listening: Promise<number> | undefined;
  const listen = () => {
    listening ??= new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.listenPort, options.listenHost, () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    }).catch((err: unknown) => {
      listening = undefined;
      throw err;
    });
    return listening;
  };

  return {
    async close() {
      if (listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
      }
    },
    listen,
    async register(ws) {
      const port = await listen();
      const baseUrl =
        typeof options.advertisedUrl === 'function'
          ? options.advertisedUrl(port)
          : options.advertisedUrl;
      const token = randomBytes(32).toString('hex');
      const key = digest(token);
      const reg: Registration = {
        allowlists: undefined,
        inFlight: new Set(),
        onDenied: AsyncResource.bind(ws.onDenied),
        registries: new Map(ws.registries.map((r) => [r.id, r])),
      };
      registrations.set(key, reg);
      let released: Promise<void> | undefined;
      return {
        baseUrl,
        release: () => {
          released ??= (async () => {
            registrations.delete(key);
            await Promise.allSettled([...reg.inFlight]);
          })();
          return released;
        },
        setAllowlist(map) {
          reg.allowlists = map;
        },
        token,
      };
    },
  };
}

let shared: RegistryProxy | null | undefined;

/**
 * The worker's registry proxy, started on first use, or `null` when the
 * deployment has not configured one (`REGISTRY_PROXY_PORT`): workspaces then
 * get no registry wiring at all.
 */
export function workerRegistryProxy(): RegistryProxy | null {
  if (shared === undefined) {
    const config = resolveWorkspaceInfra().registryProxy;
    shared = config
      ? createRegistryProxy({
          advertisedUrl: config.url,
          cache: config.cacheDir
            ? new TarballCache(config.cacheDir, config.cacheMaxBytes)
            : undefined,
          listenHost: config.bindHost,
          listenPort: config.port,
        })
      : null;
  }
  return shared;
}
