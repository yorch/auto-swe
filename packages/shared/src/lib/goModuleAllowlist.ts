/**
 * The Go module allowlist: the module@version pairs a repository's committed `go.sum` names.
 *
 * `go.sum` has two kinds of line per module version. `<module> <version> h1:…` hashes the
 * module's source zip, so the build needs that source. `<module> <version>/go.mod h1:…` hashes
 * only its `go.mod`, which the module graph reads even for a module whose source is never built.
 * Keeping the two apart is what lets the proxy serve a `go.mod` without serving the code.
 *
 * Pure and I/O-free: the content is attacker-influenced (a repository's own file), so nothing
 * here throws on it and every module path and version is validated before it can reach a URL.
 */

export const GO_SUM_NAME = 'go.sum';
/** A `go.work` workspace keeps checksums that appear in no module's `go.sum` here; same format. */
export const GO_WORK_SUM_NAME = 'go.work.sum';

/** A hostile file contributes at most this many lines. */
const MAX_GO_SUM_LINES = 200_000;
const MAX_MODULE_PATH_CHARS = 300;
const MAX_VERSION_CHARS = 128;

const MODULE_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const VERSION_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+incompatible)?$/;
const HASH_RE = /^h1:[A-Za-z0-9+/]+=*$/;
const GO_MOD_SUFFIX = '/go.mod';

export interface GoSumEntry {
  module: string;
  /** Without any `/go.mod` suffix. */
  version: string;
  /** `zip`: the module's source is needed. `mod`: only its `go.mod` is. */
  kind: 'zip' | 'mod';
}

/** A module path in its unescaped form (`github.com/Azure/go-autorest`). */
export function isValidGoModulePath(p: string): boolean {
  if (p.length === 0 || p.length > MAX_MODULE_PATH_CHARS) {
    return false;
  }
  return p
    .split('/')
    .every(
      (seg) => seg !== '.' && seg !== '..' && !seg.startsWith('-') && MODULE_SEGMENT_RE.test(seg)
    );
}

export function isValidGoVersion(v: string): boolean {
  return v.length <= MAX_VERSION_CHARS && VERSION_RE.test(v);
}

/** The entries of a `go.sum`; a malformed or hostile line is skipped, never an error. */
export function parseGoSum(content: string): GoSumEntry[] {
  const out: GoSumEntry[] = [];
  let start = 0;
  for (let n = 0; n < MAX_GO_SUM_LINES && start <= content.length; n += 1) {
    let end = content.indexOf('\n', start);
    if (end < 0) {
      end = content.length;
    }
    const line = content.slice(start, end).replace(/\r$/, '');
    start = end + 1;
    const fields = line.split(' ');
    if (fields.length !== 3) {
      continue;
    }
    const [module, versionField, hash] = fields as [string, string, string];
    if (!HASH_RE.test(hash)) {
      continue;
    }
    const kind = versionField.endsWith(GO_MOD_SUFFIX) ? 'mod' : 'zip';
    const version = kind === 'mod' ? versionField.slice(0, -GO_MOD_SUFFIX.length) : versionField;
    if (isValidGoModulePath(module) && isValidGoVersion(version)) {
      out.push({ kind, module, version });
    }
  }
  return out;
}

/**
 * Module → the strings the proxy may serve: `v1.2.3` for a source zip, `v1.2.3/go.mod` for a
 * `go.mod` only. The same `Map<string, Set<string>>` shape the npm allowlist uses.
 */
export function buildGoAllowlist(entries: GoSumEntry[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { kind, module, version } of entries) {
    const set = out.get(module) ?? new Set<string>();
    set.add(kind === 'mod' ? `${version}${GO_MOD_SUFFIX}` : version);
    out.set(module, set);
  }
  return out;
}
