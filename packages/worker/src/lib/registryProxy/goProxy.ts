/**
 * The GOPROXY protocol, as far as a read-only proxy needs it. Pure: no I/O, no state.
 *
 * Five request shapes exist, all GET: `/<module>/@v/list`, `/<module>/@latest`, and
 * `/<module>/@v/<version>.info|.mod|.zip`. Module paths and versions are case-encoded on the
 * wire (an uppercase letter is `!` plus its lowercase) because a registry may sit on a
 * case-insensitive filesystem; the encoding is a bijection, so a decoder that accepts nothing
 * else cannot be handed two spellings of one module.
 *
 * Nothing the caller wrote reaches the upstream: the path is parsed, the module and version are
 * decoded and validated against the same shapes `go.sum` entries are held to, and the upstream
 * path is built from those validated values alone (`goUpstreamPath`).
 */
import { isValidGoModulePath, isValidGoVersion } from '@auto-swe/shared/lib/goModuleAllowlist';

export type GoProxyKind = 'list' | 'latest' | 'info' | 'mod' | 'zip';

export interface GoProxyPath {
  kind: GoProxyKind;
  /** Unescaped (`github.com/Azure/go-autorest`). */
  module: string;
  /** Unescaped; set for `info`, `mod` and `zip`. */
  version?: string;
}

/** `Azure` → `!azure`. */
export function escapeGoPath(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

/**
 * The inverse of `escapeGoPath`, or null. `!` is accepted only before a lowercase ASCII letter,
 * and a raw uppercase letter is refused: an escaped path never carries one.
 */
export function unescapeGoPath(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i);
    if (c === '!') {
      const next = s.charAt(i + 1);
      if (next < 'a' || next > 'z') {
        return null;
      }
      out += next.toUpperCase();
      i += 1;
    } else if (c >= 'A' && c <= 'Z') {
      return null;
    } else {
      out += c;
    }
  }
  return out;
}

/** Anything here is refused before the path is looked at: it has no place in a Go proxy path. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what is being refused
const FORBIDDEN_RE = /[%\\?#\s\u0000]/;
const VERSION_FILE_RE = /^(.+)\.(info|mod|zip)$/;

/** `rest` is the path after `/go/<registryId>`: a leading `/`, no query. */
export function parseGoProxyPath(rest: string): GoProxyPath | null {
  if (!rest.startsWith('/') || FORBIDDEN_RE.test(rest)) {
    return null;
  }
  const segments = rest.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return null;
  }
  let moduleEsc: string;
  let tail: string | null;
  if (rest.endsWith('/@latest')) {
    moduleEsc = rest.slice(1, -'/@latest'.length);
    tail = null;
  } else {
    const at = rest.indexOf('/@v/');
    if (at < 1) {
      return null;
    }
    moduleEsc = rest.slice(1, at);
    tail = rest.slice(at + '/@v/'.length);
    if (tail === '' || tail.includes('/')) {
      return null;
    }
  }
  if (moduleEsc.includes('@')) {
    return null;
  }
  const module = unescapeGoPath(moduleEsc);
  if (module === null || !isValidGoModulePath(module)) {
    return null;
  }
  if (tail === null) {
    return { kind: 'latest', module };
  }
  if (tail === 'list') {
    return { kind: 'list', module };
  }
  const file = VERSION_FILE_RE.exec(tail);
  if (!file) {
    return null;
  }
  const version = unescapeGoPath(file[1] as string);
  if (version === null || !isValidGoVersion(version)) {
    return null;
  }
  return { kind: file[2] as 'info' | 'mod' | 'zip', module, version };
}

/**
 * Whether lockfile mode lets `p` through; `null` is open mode. `info` and `mod` are served for a
 * module whose go.sum has either line, because the module graph reads a `go.mod` even for source
 * that is never built. A `zip` needs the plain line: a `/go.mod`-only module's source is not part
 * of the build, so it must not be served. `list` and `latest` ask about versions the lockfile
 * does not state; `list` is answered locally (`goListBody`) and `latest` is refused.
 */
export function goAllowed(allowlist: Map<string, Set<string>> | null, p: GoProxyPath): boolean {
  if (allowlist === null) {
    return true;
  }
  if (p.kind === 'list' || p.kind === 'latest' || p.version === undefined) {
    return false;
  }
  const set = allowlist.get(p.module);
  if (!set) {
    return false;
  }
  if (p.kind === 'zip') {
    return set.has(p.version);
  }
  return set.has(p.version) || set.has(`${p.version}/go.mod`);
}

/** The lockfile-mode `list` answer: the module's source-bearing versions, sorted, one per line. */
export function goListBody(allowlist: Map<string, Set<string>>, module: string): string {
  const versions = [...(allowlist.get(module) ?? [])].filter((v) => !v.endsWith('/go.mod')).sort();
  return versions.length === 0 ? '' : `${versions.join('\n')}\n`;
}

/** The upstream path, built only from the validated and re-escaped module and version. */
export function goUpstreamPath(p: GoProxyPath): string {
  const base = `/${escapeGoPath(p.module)}`;
  switch (p.kind) {
    case 'latest':
      return `${base}/@latest`;
    case 'list':
      return `${base}/@v/list`;
    default:
      return `${base}/@v/${escapeGoPath(p.version ?? '')}.${p.kind}`;
  }
}
