/**
 * Parses the three npm-ecosystem lockfile formats into the flat
 * `name@version` allowlist the workspace registry proxy enforces in
 * `lockfile` access mode.
 *
 * Everything here is pure. `parseLockfile` throws {@link LockfileParseError}
 * on malformed input; callers fail closed — a lockfile that cannot be read
 * contributes nothing.
 */
import { parse as parseYaml } from 'yaml';

export interface LockedPackage {
  name: string;
  version: string;
}

export class LockfileParseError extends Error {
  constructor(
    /** Which lockfile failed — a repo path, for the caller's log. */
    readonly lockfilePath: string,
    message: string
  ) {
    super(`${lockfilePath}: ${message}`);
    this.name = 'LockfileParseError';
  }
}

/** Basenames {@link parseLockfile} understands; anything else throws. */
export const LOCKFILE_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

/** Flattened entries → `name → {versions}` for O(1) proxy checks. */
export function buildAllowlist(entries: LockedPackage[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const { name, version } of entries) {
    let versions = map.get(name);
    if (!versions) {
      versions = new Set();
      map.set(name, versions);
    }
    versions.add(version);
  }
  return map;
}

/**
 * Parse `content` (the committed bytes of the lockfile at `path`) into locked
 * package entries. Dispatch is on the basename: `package-lock.json`,
 * `yarn.lock` (classic header or Berry `__metadata`), `pnpm-lock.yaml`.
 */
export function parseLockfile(path: string, content: string): LockedPackage[] {
  const base = path.split('/').pop() ?? '';
  switch (base) {
    case 'package-lock.json':
      return parsePackageLock(path, content);
    case 'yarn.lock':
      return parseYarnLock(path, content);
    case 'pnpm-lock.yaml':
      return parsePnpmLock(path, content);
    default:
      throw new LockfileParseError(path, `not a recognized lockfile (${base})`);
  }
}

// ─── package-lock.json ──────────────────────────────────────────────

function parsePackageLock(path: string, content: string): LockedPackage[] {
  let doc: { lockfileVersion?: number; packages?: Record<string, unknown>; dependencies?: unknown };
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new LockfileParseError(path, `invalid JSON: ${(err as Error).message}`);
  }
  const out: LockedPackage[] = [];
  if (doc.packages) {
    // v2/v3: `packages` keyed by install path; the "" root and `link:` entries
    // are not upstream-resolved packages.
    for (const [installPath, entry] of Object.entries(doc.packages)) {
      if (installPath === '' || !entry || typeof entry !== 'object') {
        continue;
      }
      const e = entry as { link?: boolean; name?: string; resolved?: string; version?: string };
      if (e.link === true || typeof e.version !== 'string') {
        continue;
      }
      const name =
        e.name ??
        (installPath.includes('node_modules/')
          ? installPath.slice(installPath.lastIndexOf('node_modules/') + 'node_modules/'.length)
          : undefined);
      if (name) {
        out.push({ name, version: e.version });
      }
    }
  } else if (doc.dependencies) {
    // v1: a `dependencies` tree; every node carries name-by-key + version.
    walkV1(doc.dependencies as Record<string, { version?: string; dependencies?: unknown }>, out);
  } else {
    throw new LockfileParseError(path, 'no packages or dependencies object');
  }
  return out;
}

function walkV1(
  deps: Record<string, { version?: string; dependencies?: unknown }>,
  out: LockedPackage[]
): void {
  for (const [name, entry] of Object.entries(deps)) {
    if (!entry || typeof entry !== 'object' || typeof entry.version !== 'string') {
      continue;
    }
    out.push({ name, version: entry.version });
    if (entry.dependencies && typeof entry.dependencies === 'object') {
      walkV1(entry.dependencies as Record<string, never>, out);
    }
  }
}

// ─── yarn.lock ──────────────────────────────────────────────────────

function parseYarnLock(path: string, content: string): LockedPackage[] {
  if (/^__metadata:/m.test(content)) {
    return parseYarnBerryLock(path, content);
  }
  if (!/^# yarn lockfile v1/m.test(content)) {
    throw new LockfileParseError(path, 'unrecognized yarn.lock header');
  }
  // Classic yarn.lock is a custom format, not YAML — parse entry blocks:
  // a header of comma-separated descriptors, then `version "x"`.
  const out: LockedPackage[] = [];
  const entryRe = /(?:^|\n)([^\s#][^\n]*):\n((?:\s{2}[^\n]*\n?)*)/g;
  for (const m of content.matchAll(entryRe)) {
    const header = m[1] ?? '';
    const body = m[2] ?? '';
    const versionMatch = /version\s+"([^"]+)"/.exec(body);
    if (!versionMatch) {
      continue;
    }
    const firstDescriptor = stripQuotes(header.split(',')[0] ?? '');
    // A descriptor is name@range; the name runs to the last '@' (scoped
    // names start with '@' so they carry exactly one more).
    const at = firstDescriptor.lastIndexOf('@');
    if (at <= 0) {
      continue;
    }
    const name = firstDescriptor.slice(0, at);
    const range = firstDescriptor.slice(at + 1);
    if (range.startsWith('workspace:') || range.startsWith('patch:')) {
      continue;
    }
    out.push({ name, version: versionMatch[1] ?? '' });
  }
  if (out.length === 0) {
    throw new LockfileParseError(path, 'no package entries found');
  }
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

function parseYarnBerryLock(path: string, content: string): LockedPackage[] {
  let doc: Record<string, { resolution?: string } | unknown>;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new LockfileParseError(path, `invalid YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new LockfileParseError(path, 'no package entries found');
  }
  const out: LockedPackage[] = [];
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata' || !entry || typeof entry !== 'object') {
      continue;
    }
    // Only the npm protocol is upstream-fetched; workspace:, patch:, link: and
    // virtual descriptors resolve locally.
    const resolution = (entry as { resolution?: string }).resolution;
    if (typeof resolution !== 'string') {
      continue;
    }
    const at = resolution.lastIndexOf('@');
    if (at <= 0) {
      continue;
    }
    const name = resolution.slice(0, at);
    const ref = resolution.slice(at + 1);
    // A patch/virtual/workspace resolution nests the npm ref after its own
    // protocol (`dep@patch:dep@npm:1.0.0#…`); a name containing a protocol
    // separator is one of those, and only `npm:` entries resolve upstream.
    if (!ref.startsWith('npm:') || name.includes(':')) {
      continue;
    }
    const version = ref.slice('npm:'.length).split('#')[0];
    if (name && version) {
      out.push({ name, version });
    }
  }
  return out;
}

// ─── pnpm-lock.yaml ─────────────────────────────────────────────────

function parsePnpmLock(path: string, content: string): LockedPackage[] {
  let doc: { lockfileVersion?: unknown; packages?: Record<string, unknown> };
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new LockfileParseError(path, `invalid YAML: ${(err as Error).message}`);
  }
  const packages = doc?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new LockfileParseError(path, 'no packages object');
  }
  const out: LockedPackage[] = [];
  for (const key of Object.keys(packages)) {
    // v5/v6 keys look like `/name/1.2.3` or `/name@1.2.3`, v9 like `name@1.2.3`;
    // every flavour can trail `(peer@deps)` suffixes.
    const clean = key.replace(/^\//, '').replace(/\([^)]*\)$/, '');
    const parsed = splitPnpmKey(clean);
    if (parsed) {
      out.push(parsed);
    }
  }
  if (out.length === 0 && Object.keys(packages).length > 0) {
    throw new LockfileParseError(path, 'could not parse any package keys');
  }
  return out;
}

function splitPnpmKey(key: string): LockedPackage | null {
  // Slash-style (v5/v6 `name/1.2.3`, `/@scope/name/1.2.3`) splits at the last
  // '/'; the peer suffix trails the version as `_react@17.0.2`. The `@`-style
  // (v9 `name@1.2.3`, `@scope/name@1.2.3`) splits at the last '@'.
  const slash = key.lastIndexOf('/');
  // Slash-style only when the tail is a version (`name/1.2.3`); a `@` before
  // the `_` peer suffix means it is `name@ver` with a scoped name
  // (`@scope/pkg@2.0.0`) — check the version part, not the whole tail.
  const slashVersion = slash > 0 ? key.slice(slash + 1).split('_')[0] : '';
  if (slash > 0 && !slashVersion.includes('@')) {
    const name = key.slice(0, slash);
    return name && /^\d/.test(slashVersion) ? { name, version: slashVersion } : null;
  }
  const at = key.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  const name = key.slice(0, at);
  const version = key.slice(at + 1).split('_')[0];
  return name && /^\d/.test(version) ? { name, version } : null;
}
