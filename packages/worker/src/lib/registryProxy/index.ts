/**
 * A read-only npm registry proxy in the worker.
 *
 * A workspace registers and gets a random token and the proxy's address in
 * place of every registry's real credential: the container never holds an
 * upstream token, and a token read out of it is good only at this proxy, only
 * for this workspace's lifetime, and — in `lockfile` access mode — only for
 * the package@version pairs committed on the base ref. GET and HEAD only — plus
 * one POST, the bulk advisory query `npm audit`, `pnpm audit` and `yarn npm audit`
 * send, which `serveAudit` accepts only in a shape that carries nothing but
 * package names and versions the registration may already read.
 *
 * URL layout: `<baseUrl>/npm/<registryId>/<npm path>`, where the npm path is
 * either a packument `/<name>` (`pkg`, `@scope/pkg`, `@scope%2fpkg`), a
 * per-version manifest `/<name>/<version>` (Corepack), or a tarball
 * `/<name>/-/<file>.tgz`. Everything else is a JSON 404; other methods
 * are 405; an unknown token is 401; until the registration's allowlist is set
 * it answers 503 ("not ready"), a state `createWorkspace` never lets the agent
 * reach because it returns only once the allowlist is in place.
 *
 * A second route, `<baseUrl>/go/<registryId>/<GOPROXY path>`, serves Go modules the same way
 * (`goProxy.ts` holds the protocol): GET and HEAD only, the registry credential added
 * server-side, and in `lockfile` mode only the module versions the base ref's `go.sum` names.
 * The Go tool sends credentials from a `GOPROXY` URL as Basic auth, so that route accepts the
 * token as a Basic password as well as a Bearer token; the npm route takes Bearer only.
 *
 * Modelled on `agents/claudeCode/modelProxy.ts`.
 */
import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { TarballCache } from './cache.js';
import {
  type GoProxyKind,
  type GoProxyPath,
  goAllowed,
  goListBody,
  goUpstreamPath,
  parseGoProxyPath,
} from './goProxy.js';
import { Semaphore } from './semaphore.js';

export { TarballCache } from './cache.js';

/** Packuments are buffered for the tarball-URL rewrite; a bigger one is an upstream bug, not a stream. */
const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;

/** A Go module zip past this is cut off mid-stream, which makes the Go tool fail the download. */
const MAX_GO_ZIP_BYTES = 512 * 1024 * 1024;

/** What the Go tool is told each kind of answer is; fixed, never the upstream's own header. */
const GO_CONTENT_TYPES: Record<GoProxyKind, string> = {
  info: 'application/json',
  latest: 'application/json',
  list: 'text/plain; charset=utf-8',
  mod: 'text/plain; charset=utf-8',
  zip: 'application/zip',
};

/**
 * Packument and manifest requests each buffer up to MAX_PACKUMENT_BYTES and then parse and
 * re-serialise it, so one registration runs at most this many at once; the rest wait in a
 * bounded queue for at most the wait below, then get a 503 (npm and Yarn retry it).
 * Tarballs stream and are not counted.
 *
 * The queue holds more than Yarn 4's default `networkConcurrency` (50) so a cold install, which
 * asks for every packument at once, waits its turn and is not turned away. A slot is held across
 * the upstream fetch and the whole body read, so both run under a deadline well inside the queue
 * wait: one slow upstream cannot keep a slot past it, and a client that hangs up frees its slot
 * at once.
 */
const DEFAULT_MAX_BUFFERED_FETCHES = 8;
const DEFAULT_MAX_QUEUED_FETCHES = 64;
const DEFAULT_QUEUE_WAIT_MS = 30_000;
const DEFAULT_UPSTREAM_DEADLINE_MS = 20_000;

/**
 * The only non-GET paths: the audit queries. `npm audit` and `yarn npm audit` send the bulk
 * advisory query; `pnpm audit` sends its dependency tree to the older `audits/quick`
 * endpoint and, if that does not answer 200, to `audits`.
 */
const AUDIT_PATH = '/-/npm/v1/security/advisories/bulk';
const LEGACY_AUDIT_PATHS: ReadonlySet<string> = new Set([
  '/-/npm/v1/security/audits/quick',
  '/-/npm/v1/security/audits',
]);
const isAuditPath = (p: string | undefined): boolean =>
  p === AUDIT_PATH || (p !== undefined && LEGACY_AUDIT_PATHS.has(p));
/** A node of the legacy audit tree, and the whole tree, are bounded. */
const MAX_AUDIT_TREE_DEPTH = 100;
const MAX_AUDIT_TREE_NODES = 200_000;
/** An importer's key in the legacy tree: a workspace path with `/` written `__`, or `.`. */
const IMPORTER_KEY_RE = /^[A-Za-z0-9.][A-Za-z0-9._~@-]{0,199}$/;
/** A lockfile `integrity` value: one or more `sha…-base64` hashes. */
const INTEGRITY_RE = /^[A-Za-z0-9+/=_.-]+(?: [A-Za-z0-9+/=_.-]+)*$/;
/** An audit request, compressed or not, and its answer, are bounded: neither is a stream. */
const MAX_AUDIT_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_BODY_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_PACKAGES = 20_000;

/** npm's own package-name shape; nothing here can start with `.` or `_` or carry a separator. */
const NAME_RE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;
const TARBALL_RE = /^[a-z0-9~-][a-z0-9._~-]*\.tgz$/i;
/** A semver-ish version or dist-tag segment (Corepack also asks for tags in open mode). */
const VERSION_RE = /^[a-z0-9][a-z0-9.+_-]*$/i;
/** A path-prefix segment (a non-registry directory like Artifactory's `api/npm/npm-remote`). */
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const MAX_PREFIX_SEGMENTS = 8;

/** One upstream registry a registration fronts, with its decrypted credential. */
export interface ResolvedRegistry {
  id: string;
  /** Absent means `npm`. A `go` registry is reached only through `/go/<id>`. */
  ecosystem?: 'npm' | 'go';
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
  /** Bounds the registration's concurrent buffered (non-tarball) fetches. */
  buffered: Semaphore;
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

/** A registration may hold registries of both ecosystems; npm routing sees only its own. */
const npmRegistries = (reg: Registration): ResolvedRegistry[] =>
  [...reg.registries.values()].filter((r) => r.ecosystem !== 'go');

/** The npm default registry — never a go one, whatever `isDefault` says. */
const npmDefault = (reg: Registration): ResolvedRegistry | undefined =>
  npmRegistries(reg).find((r) => r.isDefault);

/**
 * Which registered npm registry serves `name`: a scoped name whose scope a
 * registry claimed goes there; everything else goes to the default.
 */
function routeRegistry(reg: Registration, name: string): ResolvedRegistry | undefined {
  const scope = name.startsWith('@') ? `@${name.slice(1).split('/')[0]?.toLowerCase()}` : null;
  if (scope) {
    for (const r of npmRegistries(reg)) {
      if (r.scopes.includes(scope)) {
        return r;
      }
    }
  }
  return npmDefault(reg);
}

/** The token a request presents: `Bearer <token>`, or — Go route only — a Basic password. */
function presentedToken(auth: string | undefined, allowBasic: boolean): string | undefined {
  if (typeof auth !== 'string') {
    return undefined;
  }
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  if (allowBasic && auth.startsWith('Basic ')) {
    // `user:password`; the user name is ignored and the password is the token.
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon < 0 ? undefined : decoded.slice(colon + 1) || undefined;
  }
  return undefined;
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
 * `name` is returned decoded (`@s/p`); `tarball` decoded and unscoped. A
 * third form is the per-version manifest `/<name>/<version>` that Corepack
 * reads when resolving a `packageManager` pin — the scoped name may occupy
 * two literal segments (`@yarnpkg/cli-dist/4.5.0`), and the version must
 * match VERSION_RE (a leading dot is refused, so `..` cannot smuggle).
 */
function packageNameOf(
  urlPath: string
): { name: string; tarball: string | null; version: string | null } | null {
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
    // Packument `/<name>` or version manifest `/<name>/<version>`: the name
    // takes one segment (unscoped, or a scope encoded into it) or two when
    // the scope separator is a literal slash (`@s/p`).
    let nameSegs = 1;
    const first = decode(segs[0] ?? '');
    if (first === null) {
      return null;
    }
    if ((first.startsWith('@') || first.startsWith('%40')) && !first.slice(1).includes('/')) {
      nameSegs = 2;
      if (segs.length < 2) {
        return null;
      }
    }
    const rawName = decode(segs.slice(0, nameSegs).join('/'));
    if (rawName === null) {
      return null;
    }
    const name = rawName.startsWith('%40') ? `@${rawName.slice(3)}` : rawName;
    if (!NAME_RE.test(name)) {
      return null;
    }
    if (segs.length === nameSegs) {
      return { name, tarball: null, version: null };
    }
    if (segs.length !== nameSegs + 1) {
      return null;
    }
    const version = decode(segs[nameSegs] ?? '');
    if (version === null || !VERSION_RE.test(version)) {
      return null;
    }
    return { name, tarball: null, version };
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
    if (scopeSeg?.startsWith('@')) {
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
  return { name, tarball: fileRaw, version: null };
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
    rewriteDistTarball(v.dist, opts);
  }
  return { body: Buffer.from(JSON.stringify(doc)), denied: undefined };
}

/** Point a `dist.tarball` back at this proxy's canonical tarball path. */
function rewriteDistTarball(
  dist: { tarball?: string } | undefined,
  opts: { baseUrl: string; name: string; registryId: string }
): void {
  const tarball = dist?.tarball;
  if (typeof tarball !== 'string') {
    return;
  }
  const file = tarball.split('/').pop();
  if (file && dist) {
    dist.tarball = `${opts.baseUrl}/npm/${opts.registryId}/${opts.name}/-/${file}`;
  }
}

/**
 * The bulk-advisory body as a name → versions map, or the reason it is refused.
 * Only that shape passes — an object of valid package names to arrays of
 * version strings — so the body can carry nothing else.
 */
export function checkAuditBody(text: string): Record<string, string[]> | string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'the audit request is not JSON';
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return 'the audit request must be an object of package names to version lists';
  }
  const entries = Object.entries(doc as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_AUDIT_PACKAGES) {
    return 'the audit request names no packages, or too many';
  }
  const out: Record<string, string[]> = Object.create(null);
  for (const [name, versions] of entries) {
    if (
      !NAME_RE.test(name) ||
      !Array.isArray(versions) ||
      versions.length === 0 ||
      !versions.every((v) => typeof v === 'string' && VERSION_RE.test(v))
    ) {
      return 'the audit request names a package or version that is not well formed';
    }
    out[name] = versions as string[];
  }
  return out;
}

/**
 * The legacy audit body (pnpm's dependency tree) as the name → versions pairs it names, plus
 * the tree to forward, or the reason it is refused.
 *
 * The tree is `{ dependencies: { <importer>: node }, dev: false, install: [], metadata: {},
 * remove: [], requires: {…} }` where a node is `{ dev, integrity, version, dependencies?,
 * requires? }`. Every key outside that set is refused, every name, version and integrity
 * value is held to its charset, and `install`, `remove` and `metadata` must be empty — so,
 * like the bulk body, it carries nothing but the names and versions of a lockfile. What is
 * forwarded is the re-serialised validated tree, not the bytes received.
 */
export function checkLegacyAuditBody(
  text: string
): { body: string; pairs: Record<string, string[]> } | string {
  const refused = 'the audit request is not a dependency tree of well-formed packages';
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'the audit request is not JSON';
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const isEmpty = (v: unknown, array: boolean) =>
    array ? Array.isArray(v) && v.length === 0 : isObject(v) && Object.keys(v).length === 0;
  if (!isObject(doc)) {
    return refused;
  }
  const ROOT_KEYS = new Set(['dependencies', 'dev', 'install', 'metadata', 'remove', 'requires']);
  const NODE_KEYS = new Set(['dependencies', 'dev', 'integrity', 'requires', 'version']);
  if (
    !Object.keys(doc).every((k) => ROOT_KEYS.has(k)) ||
    !isObject(doc.dependencies) ||
    (doc.dev !== undefined && doc.dev !== false) ||
    (doc.install !== undefined && !isEmpty(doc.install, true)) ||
    (doc.remove !== undefined && !isEmpty(doc.remove, true)) ||
    (doc.metadata !== undefined && !isEmpty(doc.metadata, false))
  ) {
    return refused;
  }
  const pairs: Record<string, string[]> = Object.create(null);
  let nodes = 0;
  /** `requires`: dependency name → exact version. */
  const requiresOk = (v: unknown, importer: boolean): boolean =>
    v === undefined ||
    (isObject(v) &&
      Object.entries(v).every(
        ([k, ver]) =>
          (importer ? IMPORTER_KEY_RE.test(k) || NAME_RE.test(k) : NAME_RE.test(k)) &&
          typeof ver === 'string' &&
          VERSION_RE.test(ver)
      ));
  const walk = (deps: Record<string, unknown>, depth: number, importers: boolean): boolean => {
    if (depth > MAX_AUDIT_TREE_DEPTH) {
      return false;
    }
    for (const [key, node] of Object.entries(deps)) {
      nodes += 1;
      if (nodes > MAX_AUDIT_TREE_NODES || !(importers ? IMPORTER_KEY_RE : NAME_RE).test(key)) {
        return false;
      }
      if (
        !isObject(node) ||
        !Object.keys(node).every((k) => NODE_KEYS.has(k)) ||
        typeof node.version !== 'string' ||
        !VERSION_RE.test(node.version) ||
        (node.dev !== undefined && typeof node.dev !== 'boolean') ||
        (node.integrity !== undefined &&
          !(
            typeof node.integrity === 'string' &&
            node.integrity.length <= 1024 &&
            INTEGRITY_RE.test(node.integrity)
          )) ||
        !requiresOk(node.requires, importers)
      ) {
        return false;
      }
      if (!importers) {
        const seen = pairs[key] ?? [];
        if (!seen.includes(node.version)) {
          seen.push(node.version);
        }
        pairs[key] = seen;
      }
      if (node.dependencies !== undefined) {
        if (!isObject(node.dependencies) || !walk(node.dependencies, depth + 1, false)) {
          return false;
        }
      }
    }
    return true;
  };
  if (!requiresOk(doc.requires, true) || !walk(doc.dependencies, 0, true)) {
    return refused;
  }
  if (Object.keys(pairs).length === 0) {
    return 'the audit request names no packages';
  }
  return { body: JSON.stringify(doc), pairs };
}

export function createRegistryProxy(options: {
  listenHost: string;
  listenPort: number;
  advertisedUrl: string | ((port: number) => string);
  /** Replaces the per-registry guarded fetch. Tests only. */
  upstreamFetch?: typeof fetch;
  /** Tarball cache; `createRegistryCache(dir, maxBytes)` when enabled. */
  cache?: TarballCache;
  /** Concurrent buffered packument/manifest fetches per registration (default 8). */
  maxBufferedFetches?: number;
  /** Requests that may wait for one of those slots (default 64); more get a 503. */
  maxQueuedFetches?: number;
  /** Longest a buffered upstream fetch and body read may take before a 502 (default 20 s). */
  upstreamDeadlineMs?: number;
  /** How long a request waits for a slot before a 503 (default 30 s). */
  queueWaitMs?: number;
  /** Largest Go module zip relayed (default 512 MiB); past it the response is cut off. */
  maxGoZipBytes?: number;
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
    tarballFile: string | null,
    versionSeg: string | null
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
    // In lockfile mode a version manifest's version is on the path — tags
    // like `latest` are never allowlisted and so are denied too.
    if (reg.allowlists && allowlist !== null && versionSeg !== null) {
      if (!allowlist?.get(name)?.has(versionSeg)) {
        reg.onDenied({
          name,
          reason: 'not-in-lockfile',
          registryId: registry.id,
          version: versionSeg,
        });
        sendJson(res, 403, denyMessage(name, versionSeg), denyMessage(name, versionSeg));
        return;
      }
    }
    if (reg.allowlists && allowlist !== null && !tarballFile && versionSeg === null) {
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
    }${tarballFile ? `/-/${tarballFile}` : versionSeg !== null ? `/${encodeURIComponent(versionSeg)}` : ''}`;

    // A cached tarball answers from disk and never reaches the upstream.
    if (tarballFile && req.method === 'GET' && options.cache) {
      const hit = await options.cache.get(registry.id, upstreamPath).catch(() => null);
      if (hit) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const stream = hit.createStream();
        // An unhandled stream error would take the whole worker down, and a client that
        // hangs up must not leave the file descriptor open.
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
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

    if (!tarballFile) {
      await serveBuffered(reg, req, res, registry, name, versionSeg, upstreamPath, headers);
      return;
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
          // A client that hung up never drains again; throwing leaves the loop, which cancels
          // the upstream body, and the catch below aborts the cache write.
          if (res.destroyed || res.writableEnded) {
            throw new Error('client closed');
          }
          const wrote = cacheStream ? await cacheStream.write(chunk) : Promise.resolve();
          const flushed = res.write(chunk);
          await wrote;
          if (!flushed && !res.destroyed) {
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
  }

  /**
   * A packument or version manifest: buffered (64 MiB cap), tarball URLs rewritten, allowlist
   * applied (packuments only: a manifest's version already passed the per-version check). It
   * takes a slot only once the cheap checks have passed, and holds it across the upstream fetch
   * and the body read, which run under a deadline and stop when the client hangs up.
   */
  async function serveBuffered(
    reg: Registration,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    registry: ResolvedRegistry,
    name: string,
    versionSeg: string | null,
    upstreamPath: string,
    headers: Record<string, string>
  ): Promise<void> {
    const allowlist = reg.allowlists?.get(registry.id);
    const slot = await reg.buffered.acquire();
    if (slot === null) {
      res.setHeader('retry-after', '5');
      sendJson(res, 503, 'the registry proxy is busy; retry shortly');
      return;
    }
    // The client may have hung up while it waited.
    if (res.destroyed) {
      slot();
      return;
    }
    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(),
      options.upstreamDeadlineMs ?? DEFAULT_UPSTREAM_DEADLINE_MS
    );
    const hangUp = () => abort.abort();
    res.on('close', hangUp);
    let upstream: Response | undefined;
    let failure: string | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      upstream = await upstreamFetchFor(registry)(upstreamPath, {
        headers,
        method: req.method ?? 'GET',
        redirect: 'error',
        signal: abort.signal,
      });
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > MAX_PACKUMENT_BYTES) {
            failure = 'the upstream packument is too large to proxy';
            break;
          }
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch {
      failure = 'the upstream registry could not be reached';
    } finally {
      clearTimeout(deadline);
      res.off('close', hangUp);
      slot();
    }
    if (failure !== undefined || !upstream) {
      if (!res.destroyed) {
        sendJson(res, 502, failure ?? 'the upstream registry could not be reached');
      }
      return;
    }
    if (upstream.status !== 200) {
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(Buffer.concat(chunks));
      return;
    }
    if (versionSeg !== null) {
      // A version manifest is one document: rewrite dist.tarball, keep
      // signatures/integrity/… untouched.
      let doc: { dist?: { tarball?: string } } | undefined;
      try {
        doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        doc = undefined;
      }
      const rewritable = doc && typeof doc === 'object' && doc.dist;
      if (rewritable) {
        rewriteDistTarball(doc?.dist, { baseUrl: advertised(), name, registryId: registry.id });
      }
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      res.end(rewritable ? JSON.stringify(doc) : Buffer.concat(chunks));
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

  /**
   * `POST …/-/npm/v1/security/advisories/bulk`: `{ "<name>": ["<version>", …], … }`, or
   * pnpm's dependency tree at `…/audits/quick` and `…/audits` (`checkLegacyAuditBody`).
   *
   * Accepted only when the body is exactly that shape, so it can carry nothing but
   * names and versions. In lockfile mode each pair must also be one the registration
   * may already read; in open mode the shape is the whole check. Every name must be
   * served by the default registry: the query goes there, and sending it a private
   * scope's package names would disclose them to a registry that does not own them,
   * so such a body is refused rather than trimmed (a trimmed audit would pass for a
   * complete one). The answer is relayed as JSON; nothing else of the upstream's is.
   *
   * It is a buffered fetch like a packument, so it follows the same rules: reading the
   * client's body and the upstream's answer run under the upstream deadline, it takes one of
   * the registration's buffered-fetch slots only after the cheap checks pass (a refused body
   * never waits), and a client that hangs up gives its slot back at once.
   */
  async function serveAudit(
    reg: Registration,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    auditPath: string
  ): Promise<void> {
    const defaultRegistry = npmDefault(reg);
    if (!defaultRegistry) {
      sendJson(res, 404, 'no default registry answers audits');
      return;
    }
    const deadlineMs = options.upstreamDeadlineMs ?? DEFAULT_UPSTREAM_DEADLINE_MS;
    const raw: Buffer[] = [];
    let received = 0;
    // A client that trickles its body is cut off at the same deadline an upstream is.
    const bodyDeadline = setTimeout(() => req.destroy(), deadlineMs);
    try {
      for await (const chunk of req) {
        received += (chunk as Buffer).length;
        if (received > MAX_AUDIT_REQUEST_BYTES) {
          sendJson(res, 413, 'the audit request is too large');
          req.destroy();
          return;
        }
        raw.push(chunk as Buffer);
      }
    } catch {
      if (!res.destroyed) {
        sendJson(res, 408, 'the audit request was not received in time');
      }
      return;
    } finally {
      clearTimeout(bodyDeadline);
    }
    let text: string;
    try {
      const body = Buffer.concat(raw);
      text = (
        req.headers['content-encoding'] === 'gzip'
          ? gunzipSync(body, { maxOutputLength: MAX_AUDIT_REQUEST_BYTES })
          : body
      ).toString('utf8');
    } catch {
      sendJson(res, 400, 'the audit request could not be decoded');
      return;
    }
    let checked: { body: string; pairs: Record<string, string[]> } | string;
    if (auditPath === AUDIT_PATH) {
      const map = checkAuditBody(text);
      checked = typeof map === 'string' ? map : { body: JSON.stringify(map), pairs: map };
    } else {
      checked = checkLegacyAuditBody(text);
    }
    if (typeof checked === 'string') {
      sendJson(res, 400, checked);
      return;
    }
    for (const [name, versions] of Object.entries(checked.pairs)) {
      const owner = routeRegistry(reg, name);
      if (owner?.id !== defaultRegistry.id) {
        sendJson(
          res,
          403,
          `auto-swe: ${name} is served by another registry, so an audit that names it would disclose it to the default registry; audit this repository outside the workspace`
        );
        return;
      }
      const allowlist = reg.allowlists?.get(owner.id);
      if (allowlist) {
        const allowed = allowlist.get(name);
        const denied = allowed ? versions.find((v) => !allowed.has(v)) : versions[0];
        if (denied !== undefined || !allowed) {
          reg.onDenied({ name, reason: 'not-in-lockfile', registryId: owner.id, version: denied });
          sendJson(res, 403, denyMessage(name, denied));
          return;
        }
      }
    }
    const slot = await reg.buffered.acquire();
    if (slot === null) {
      res.setHeader('retry-after', '5');
      sendJson(res, 503, 'the registry proxy is busy; retry shortly');
      return;
    }
    // The client may have hung up while it waited.
    if (res.destroyed) {
      slot();
      return;
    }
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), deadlineMs);
    const hangUp = () => abort.abort();
    res.on('close', hangUp);
    let status = 0;
    let failure: string | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const upstream = await upstreamFetchFor(defaultRegistry)(
        `${defaultRegistry.upstreamUrl}${auditPath}`,
        {
          body: checked.body,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(defaultRegistry.token
              ? {
                  authorization:
                    defaultRegistry.authKind === 'basic'
                      ? `Basic ${Buffer.from(defaultRegistry.token).toString('base64')}`
                      : `Bearer ${defaultRegistry.token}`,
                }
              : {}),
          },
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
        }
      );
      status = upstream.status;
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > MAX_AUDIT_BODY_BYTES) {
            failure = 'the upstream audit answer is too large to proxy';
            break;
          }
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch {
      failure = 'the upstream registry could not be reached';
    } finally {
      clearTimeout(deadline);
      res.off('close', hangUp);
      slot();
    }
    if (failure !== undefined) {
      if (!res.destroyed) {
        sendJson(res, 502, failure);
      }
      return;
    }
    res.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    });
    res.end(Buffer.concat(chunks));
  }

  /**
   * One Go proxy request, already parsed. Lockfile mode answers `list` from the allowlist and
   * refuses `latest` and anything `go.sum` does not name before any upstream call. Everything
   * else is a streamed relay: the upstream URL is built from the validated path, the registry
   * credential is added here, redirects are refused, a 404/410 is relayed as such (the Go tool
   * treats both as "not found"), and any other upstream outcome is a fixed-message 502 — the
   * upstream's body and error text never reach the client.
   */
  async function serveGo(
    reg: Registration,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    registry: ResolvedRegistry,
    p: GoProxyPath
  ): Promise<void> {
    const stored = reg.allowlists?.get(registry.id);
    // `null` opens the registry; a registry the map does not name has an empty lockfile.
    const allowlist = stored === null ? null : (stored ?? new Map<string, Set<string>>());
    if (allowlist !== null) {
      if (p.kind === 'list') {
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': GO_CONTENT_TYPES.list,
        });
        res.end(req.method === 'HEAD' ? undefined : goListBody(allowlist, p.module));
        return;
      }
      if (!goAllowed(allowlist, p)) {
        reg.onDenied({
          name: p.module,
          reason: 'not-in-lockfile',
          registryId: registry.id,
          version: p.version,
        });
        // `@latest` asks for whatever is newest, which no lockfile states.
        sendJson(res, 403, denyMessage(p.module, p.version));
        return;
      }
    }

    const upstreamPath = `${registry.upstreamUrl}${goUpstreamPath(p)}`;
    const isZip = p.kind === 'zip';
    if (isZip && req.method === 'GET' && options.cache) {
      const hit = await options.cache.get(registry.id, upstreamPath).catch(() => null);
      if (hit) {
        res.writeHead(200, { 'content-type': GO_CONTENT_TYPES.zip });
        const stream = hit.createStream();
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
    }

    const headers: Record<string, string> = {
      accept: GO_CONTENT_TYPES[p.kind],
      'accept-encoding': 'identity',
    };
    if (registry.token) {
      headers.authorization =
        registry.authKind === 'basic'
          ? `Basic ${Buffer.from(registry.token).toString('base64')}`
          : `Bearer ${registry.token}`;
    }
    const maxBytes = isZip ? (options.maxGoZipBytes ?? MAX_GO_ZIP_BYTES) : MAX_PACKUMENT_BYTES;

    const abort = new AbortController();
    const hangUp = () => abort.abort();
    res.on('close', hangUp);
    // Zips stream for as long as they take; the small answers run under the upstream deadline.
    const deadline = isZip
      ? undefined
      : setTimeout(() => abort.abort(), options.upstreamDeadlineMs ?? DEFAULT_UPSTREAM_DEADLINE_MS);
    let cacheStream: Awaited<ReturnType<TarballCache['startWrite']>> | null = null;
    try {
      let upstream: Response;
      try {
        upstream = await upstreamFetchFor(registry)(upstreamPath, {
          headers,
          method: req.method ?? 'GET',
          redirect: 'error',
          signal: abort.signal,
        });
      } catch {
        sendJson(res, 502, 'the upstream Go module proxy could not be reached');
        return;
      }
      if (upstream.status === 404 || upstream.status === 410) {
        await upstream.body?.cancel().catch(() => {});
        sendJson(res, upstream.status, 'the upstream Go module proxy does not have this module');
        return;
      }
      const declared = Number(upstream.headers.get('content-length'));
      if (upstream.status !== 200 || (Number.isFinite(declared) && declared > maxBytes)) {
        await upstream.body?.cancel().catch(() => {});
        sendJson(
          res,
          502,
          upstream.status === 200
            ? 'the upstream Go module is too large to proxy'
            : 'the upstream Go module proxy answered with an error'
        );
        return;
      }
      res.writeHead(200, {
        'content-type': GO_CONTENT_TYPES[p.kind],
        ...(isZip && Number.isFinite(declared) && upstream.headers.get('content-length')
          ? { 'content-length': String(declared) }
          : {}),
      });
      if (!upstream.body) {
        res.end();
        return;
      }
      cacheStream =
        isZip && req.method === 'GET' && options.cache
          ? await options.cache.startWrite(registry.id, upstreamPath).catch(() => null)
          : null;
      let size = 0;
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        // A client that hung up never drains again; throwing leaves the loop, which cancels the
        // upstream body, and the catch below aborts the cache write.
        if (res.destroyed || res.writableEnded) {
          throw new Error('client closed');
        }
        size += chunk.length;
        if (size > maxBytes) {
          // Cut the client and the upstream now rather than after the iterator's cleanup.
          res.destroy();
          abort.abort();
          throw new Error('too large');
        }
        const wrote = cacheStream ? await cacheStream.write(chunk) : Promise.resolve();
        const flushed = res.write(chunk);
        await wrote;
        if (!flushed && !res.destroyed) {
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
    } catch {
      // Mid-stream (or past the size cap): the status line is gone, so cutting the connection
      // is the only way left to make the Go tool fail the download.
      abort.abort();
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, 502, 'the upstream Go module proxy could not be reached');
      }
      await cacheStream?.abort().catch(() => {});
    } finally {
      if (deadline) {
        clearTimeout(deadline);
      }
      res.off('close', hangUp);
    }
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
    // Only the Go route accepts Basic; decided from the raw target so the token check stays first.
    const token = presentedToken(req.headers.authorization, (req.url ?? '').startsWith('/go/'));
    const reg = token ? registrations.get(digest(token)) : undefined;
    if (!reg) {
      sendJson(res, 401, 'unknown or expired token');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://proxy');
    const goMatch = /^\/go\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (goMatch) {
      handleGo(reg, req, res, goMatch[1] ?? '', goMatch[2] ?? '');
      return;
    }
    const m = /^\/npm\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) {
      sendJson(res, 404, 'only /npm/<registry>/… and /go/<registry>/… paths exist here');
      return;
    }
    // The URL's <id> only proves membership — the caller may legitimately
    // address a scoped tarball through the default registry's id (npm's
    // replace-registry-host keeps the default registry origin for every
    // resolved URL, scope or not). The upstream is picked by package name.
    const urlRegistry = reg.registries.get(m[1] ?? '');
    if (!urlRegistry || urlRegistry.ecosystem === 'go') {
      sendJson(res, 404, 'unknown registry');
      return;
    }
    const isAudit = req.method === 'POST' && isAuditPath(m[2]);
    if (!isAudit && req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, 'read-only: GET and HEAD only (and the bulk advisory query)');
      return;
    }
    if (!reg.allowlists) {
      sendJson(res, 503, 'the registry allowlist is not ready yet');
      return;
    }
    if (isAudit) {
      const audit = serveAudit(reg, req, res, m[2] as string).catch(() => {
        sendJson(res, 502, 'the upstream registry could not be reached');
      });
      reg.inFlight.add(audit);
      void audit.finally(() => reg.inFlight.delete(audit));
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
    const call = (async () => {
      await serve(reg, req, res, registry, parsed.name, parsed.tarball, parsed.version);
    })().catch(() => {
      sendJson(res, 502, 'the upstream registry could not be reached');
    });
    reg.inFlight.add(call);
    void call.finally(() => reg.inFlight.delete(call));
  }
  /** `/go/<registryId><rest>`: the token is already verified. */
  function handleGo(
    reg: Registration,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    registryId: string,
    rest: string
  ): void {
    const registry = reg.registries.get(registryId);
    if (registry?.ecosystem !== 'go') {
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
    const parsed = parseGoProxyPath(rest);
    if (!parsed) {
      sendJson(res, 404, 'unrecognized Go module path');
      return;
    }
    const call = serveGo(reg, req, res, registry, parsed).catch(() => {
      sendJson(res, 502, 'the upstream Go module proxy could not be reached');
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
        buffered: new Semaphore(
          options.maxBufferedFetches ?? DEFAULT_MAX_BUFFERED_FETCHES,
          options.maxQueuedFetches ?? DEFAULT_MAX_QUEUED_FETCHES,
          options.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS
        ),
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
            // Requests still waiting for a slot are turned away rather than awaited.
            reg.buffered.close();
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
