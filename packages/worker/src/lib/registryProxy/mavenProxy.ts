/**
 * The Maven repository layout, as far as a read-only proxy needs it. Pure: no I/O, no state.
 *
 * A Maven client addresses a file by its coordinates as a path:
 * `<group dirs…>/<artifactId>/<version>/<artifactId>-<version>[-<classifier>].<ext>`, plus
 * `maven-metadata.xml` (and its checksums) at the artifact and, for snapshots, version level.
 * The proxy never interprets coordinates; it validates the path against a conservative shape
 * and the upstream URL is built from the validated segments alone.
 *
 * `kind` decides caching: a release file is immutable, so it may be cached; metadata and
 * snapshot files change under the same name, so they never are.
 */

export type MavenKind = 'metadata' | 'snapshot' | 'release';

export interface MavenPath {
  /** The validated repository path, no leading slash. */
  path: string;
  kind: MavenKind;
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
const MAX_SEGMENT_CHARS = 200;
const MAX_SEGMENTS = 24;
const MAX_PATH_CHARS = 1000;
/** A timestamped snapshot file: `<artifact>-<base>-YYYYMMDD.HHMMSS-<build>[-classifier].<ext>`. */
const TIMESTAMPED_SNAPSHOT_RE = /-\d{8}\.\d{6}-\d+(?:[.-]|$)/;

/**
 * `rest` is the path after `/maven/<registryId>`: a leading `/`, no query. Anything that is
 * not a file path — a directory listing, a trailing slash, a dot segment, an escape — is null.
 */
export function parseMavenPath(rest: string): MavenPath | null {
  if (!rest.startsWith('/') || rest.length > MAX_PATH_CHARS + 1) {
    return null;
  }
  const path = rest.slice(1);
  const segments = path.split('/');
  if (segments.length > MAX_SEGMENTS) {
    return null;
  }
  for (const s of segments) {
    if (s.length > MAX_SEGMENT_CHARS || !SEGMENT_RE.test(s)) {
      return null;
    }
  }
  const file = segments[segments.length - 1] as string;
  if (!file.includes('.')) {
    return null;
  }
  const lower = file.toLowerCase();
  if (lower.startsWith('maven-metadata')) {
    return { kind: 'metadata', path };
  }
  if (
    segments.some((s) => s.toUpperCase().includes('-SNAPSHOT')) ||
    TIMESTAMPED_SNAPSHOT_RE.test(file)
  ) {
    return { kind: 'snapshot', path };
  }
  return { kind: 'release', path };
}

/** Extensions of small text files: these run under the upstream deadline; everything else streams. */
const SMALL_EXTENSIONS: ReadonlySet<string> = new Set([
  'pom',
  'xml',
  'sha1',
  'md5',
  'sha256',
  'sha512',
  'asc',
  'module',
  'json',
]);

const extensionOf = (path: string): string => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

/** Whether the file is small enough to run under the upstream deadline instead of streaming. */
export const isSmallMavenFile = (path: string): boolean => SMALL_EXTENSIONS.has(extensionOf(path));

/** What the client is told a file is; fixed per extension, never the upstream's own header. */
export function mavenContentType(path: string): string {
  switch (extensionOf(path)) {
    case 'pom':
    case 'xml':
      return 'application/xml';
    case 'module':
    case 'json':
      return 'application/json';
    case 'sha1':
    case 'md5':
    case 'sha256':
    case 'sha512':
    case 'asc':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
