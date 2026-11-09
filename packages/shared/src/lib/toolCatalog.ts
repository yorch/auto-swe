import { z } from 'zod';

/**
 * The tool catalog: pinned, checksummed downloads a workspace may install on demand. The catalog
 * is the allowlist, so a request (a repository's `.auto-swe/tools.yml`, an admin list, an agent)
 * can only name a `{ key, version? }` that resolves to a row here. Pure and I/O-free: the gateway
 * validates writes with it, the worker resolves requests with it.
 */

export type ToolArch = 'amd64' | 'arm64';
export type ToolLibc = 'musl' | 'glibc' | 'any';
export type ToolStatus = 'ACTIVE' | 'DEPRECATED' | 'REVOKED';

export interface ToolDownload {
  url: string;
  sha256: string;
}

export interface ToolCatalogEntry {
  key: string;
  version: string;
  /** One verified download per architecture; an arch with no entry fails the install. */
  archs: Partial<Record<ToolArch, ToolDownload>>;
  /** Path of the executable inside the `.tar.gz`. */
  member: string;
  /** The C library the binary needs; `any` is a static build. */
  libc: ToolLibc;
  status: ToolStatus;
  description?: string | null;
}

export interface ToolRequest {
  key: string;
  version?: string;
}

/**
 * A tool could not be resolved or installed. `retryable` is true only for failures a retry can
 * fix (the network); a policy or integrity failure is not retried, so the run fails at once with
 * a message naming the tool.
 */
export class ToolInstallError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'ToolInstallError';
    this.retryable = options.retryable ?? false;
  }
}

export const TOOL_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const TOOL_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Every segment starts with a word character: no leading `-` (an option to tar), no `.` or `..`.
const MEMBER_SEGMENT = '[A-Za-z0-9_][A-Za-z0-9._-]*';
const MEMBER_RE = new RegExp(`^${MEMBER_SEGMENT}(/${MEMBER_SEGMENT})*$`);

/**
 * Names of programs the platform itself runs inside a workspace. A tool is installed under its
 * key on the workspace's PATH, so a catalog row with one of these keys would shadow it.
 */
export const RESERVED_TOOL_KEYS: ReadonlySet<string> = new Set([
  'ash',
  'awk',
  'base64',
  'bash',
  'cat',
  'chmod',
  'cp',
  'curl',
  'dash',
  'docker',
  'echo',
  'env',
  'find',
  'git',
  'grep',
  'head',
  'kill',
  'kubectl',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'printf',
  'ps',
  'rm',
  'sed',
  'sh',
  'sha256sum',
  'sleep',
  'tar',
  'tee',
  'test',
  'timeout',
  'uname',
  'wget',
  'xargs',
]);

export const ToolKeySchema = z.string().max(64).regex(TOOL_KEY_RE, 'invalid tool key');

/** The key of a catalog row: a valid key that does not shadow a platform program. */
export const ToolCatalogKeySchema = ToolKeySchema.refine(
  (k) => !RESERVED_TOOL_KEYS.has(k),
  'tool key is reserved for a program the platform runs'
);

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Free text shown to every signed-in user: no control characters (newlines, escapes). */
export const hasNoControlChars = (s: string): boolean => !CONTROL_CHARS_RE.test(s);

/**
 * A download URL is inlined into a shell script and readable by every signed-in user, so it is
 * plain `https://host[:port]/path`: no credentials, query or fragment, and only printable ASCII
 * with none of the characters a shell would interpret inside quotes.
 */
function isSafeDownloadUrl(raw: string): boolean {
  // `{}[]` are curl glob syntax (one URL would fetch several) and how an IPv6 literal is written.
  if (!/^[\x21-\x7e]+$/.test(raw) || /[`$"'\\?#{}[\]]/.test(raw)) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // The container, not the platform, fetches this, so there is no DNS-time guard to lean on:
  // refuse what only names an internal target. A real DNS name is two or more labels, none
  // empty, and the last is not numeric (which is how `0x7f.1` and `2130706433` normalise to
  // an IPv4 address).
  const labels = url.hostname.split('.');
  const topLabel = labels[labels.length - 1] ?? '';
  if (
    labels.length < 2 ||
    labels.some((l) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)) ||
    /^\d+$/.test(topLabel) ||
    ['internal', 'local', 'localdomain', 'localhost'].includes(topLabel) ||
    url.port === '0'
  ) {
    return false;
  }
  return (
    raw.startsWith('https://') &&
    raw[8] !== '/' &&
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}
export const ToolVersionSchema = z.string().max(64).regex(TOOL_VERSION_RE, 'invalid tool version');

export const ToolDownloadSchema = z.strictObject({
  sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 lowercase hex digits'),
  url: z
    .string()
    .max(2000)
    .refine(isSafeDownloadUrl, 'url must be a plain https URL (no credentials, query or fragment)'),
});

export const ToolArchsSchema = z
  .strictObject({ amd64: ToolDownloadSchema.optional(), arm64: ToolDownloadSchema.optional() })
  .refine((a) => a.amd64 !== undefined || a.arm64 !== undefined, 'at least one architecture');

export const ToolMemberSchema = z.string().max(200).regex(MEMBER_RE, 'unsafe archive member');

export const ToolLibcSchema = z.enum(['musl', 'glibc', 'any']);
export const ToolStatusSchema = z.enum(['ACTIVE', 'DEPRECATED', 'REVOKED']);

/** A catalog entry as the API accepts it and as a database row must read back. */
export const ToolCatalogEntrySchema = z.object({
  archs: ToolArchsSchema,
  description: z
    .string()
    .trim()
    .max(500)
    .refine(hasNoControlChars, 'must not contain control characters')
    .nullable()
    .optional(),
  key: ToolCatalogKeySchema,
  libc: ToolLibcSchema,
  member: ToolMemberSchema,
  status: ToolStatusSchema,
  version: ToolVersionSchema,
});

/** Check one entry's shape; a catalog row is trusted code, so a malformed one fails loudly. */
export function assertValidEntry(entry: ToolCatalogEntry): void {
  const parsed = ToolCatalogEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new ToolInstallError(
      `tool catalog entry ${entry.key}@${entry.version} is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`)
        .join('; ')}`
    );
  }
}

/** The row shape `toToolCatalogEntry` reads (a Prisma `ToolCatalogEntry`, structurally). */
export interface ToolCatalogRow {
  key: string;
  version: string;
  archs: unknown;
  member: string;
  libc: string;
  status: string;
  description?: string | null;
}

/** Parse a stored row. Throws {@link ToolInstallError}: a row that does not validate is never installed. */
export function toToolCatalogEntry(row: ToolCatalogRow): ToolCatalogEntry {
  const parsed = ToolCatalogEntrySchema.safeParse(row);
  if (!parsed.success) {
    throw new ToolInstallError(
      `tool catalog row ${row.key}@${row.version} is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || 'row'}: ${i.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

const NUMERIC_RE = /^[0-9]+$/;

function compareIdentifiers(a: string, b: string): number {
  const aNum = NUMERIC_RE.test(a);
  const bNum = NUMERIC_RE.test(b);
  if (aNum && bNum) {
    return Number(a) - Number(b);
  }
  if (aNum !== bNum) {
    return aNum ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseVersion(v: string) {
  const noBuild = (v.split('+')[0] ?? '').replace(/^v/i, '');
  const dash = noBuild.indexOf('-');
  const core = (dash === -1 ? noBuild : noBuild.slice(0, dash)).split('.');
  return {
    core,
    numeric: core.every((p) => NUMERIC_RE.test(p)),
    pre: dash === -1 ? null : noBuild.slice(dash + 1).split('.'),
  };
}

/**
 * Order two versions semver-style: a leading `v` and `+build` are ignored, the dotted core
 * compares numerically (missing parts are 0), and a `-prerelease` ranks below the same core
 * without one. A core that is not numeric sorts after every numeric one, then lexically.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x.numeric !== y.numeric) {
    return x.numeric ? -1 : 1;
  }
  if (!x.numeric) {
    const xs = x.core.join('.');
    const ys = y.core.join('.');
    return xs < ys ? -1 : xs > ys ? 1 : 0;
  }
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const diff = Number(x.core[i] ?? '0') - Number(y.core[i] ?? '0');
    if (diff !== 0) {
      return diff;
    }
  }
  if (x.pre === null || y.pre === null) {
    return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const xp = x.pre[i];
    const yp = y.pre[i];
    if (xp === undefined || yp === undefined) {
      return xp === undefined ? -1 : 1;
    }
    const diff = compareIdentifiers(xp, yp);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

const isStableVersion = (version: string): boolean => {
  const v = parseVersion(version);
  return v.numeric && v.pre === null;
};

/**
 * The highest version, preferring stable releases: an omitted version never silently takes a
 * prerelease (or a non-numeric name like `nightly`) over a stable release, however high its
 * core. Only when no stable row exists does the highest of the rest win.
 */
function highestVersion(entries: readonly ToolCatalogEntry[]): ToolCatalogEntry | undefined {
  const stable = entries.filter((e) => isStableVersion(e.version));
  return [...(stable.length > 0 ? stable : entries)].sort((a, b) =>
    compareVersions(b.version, a.version)
  )[0];
}

export interface ResolvedTool {
  entry: ToolCatalogEntry;
  /** Set when the entry is DEPRECATED: the run proceeds and records a warning. */
  warning?: string;
}

/**
 * Resolve requests against a catalog. An explicit version matches that row only, in any status
 * but REVOKED (a revoked row fails the install, whoever asks). An omitted version takes the
 * highest stable ACTIVE version (a prerelease only when no stable row exists), so a tool whose
 * every row is deprecated or revoked has to be pinned
 * on purpose. A request that names no row is a {@link ToolInstallError}.
 */
export function resolveToolRequests(
  requests: readonly ToolRequest[],
  catalog: readonly ToolCatalogEntry[]
): ResolvedTool[] {
  return requests.map((request) => {
    const named = `${request.key}${request.version ? `@${request.version}` : ''}`;
    const sameKey = catalog.filter((e) => e.key === request.key);
    const entry = request.version
      ? sameKey.find((e) => e.version === request.version)
      : highestVersion(sameKey.filter((e) => e.status === 'ACTIVE'));
    if (!entry) {
      throw new ToolInstallError(`tool '${named}' is not in the tool catalog`);
    }
    if (entry.status === 'REVOKED') {
      throw new ToolInstallError(
        `tool '${entry.key}@${entry.version}' is revoked in the tool catalog and cannot be installed`
      );
    }
    assertValidEntry(entry);
    return entry.status === 'DEPRECATED'
      ? { entry, warning: `tool '${entry.key}@${entry.version}' is deprecated in the tool catalog` }
      : { entry };
  });
}

/** Tools a deployment ships with. Every row is trusted code: pin the version and the digest. */
export const BUILTIN_TOOLS: readonly ToolCatalogEntry[] = [
  {
    archs: {
      amd64: {
        sha256: '181b91d0ceebe8a57723fb648ed2ce1a44d849438ce2e658339df4f8db5f1263',
        url: 'https://github.com/casey/just/releases/download/1.40.0/just-1.40.0-x86_64-unknown-linux-musl.tar.gz',
      },
      arm64: {
        sha256: 'd065d0df1a1f99529869fba8a5b3e0a25c1795b9007099b00dfabe29c7c1f7b6',
        url: 'https://github.com/casey/just/releases/download/1.40.0/just-1.40.0-aarch64-unknown-linux-musl.tar.gz',
      },
    },
    description: 'A command runner for project recipes (static musl build)',
    key: 'just',
    libc: 'any',
    member: 'just',
    status: 'ACTIVE',
    version: '1.40.0',
  },
];
