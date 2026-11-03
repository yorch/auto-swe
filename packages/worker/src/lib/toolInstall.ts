import { shellQuote } from './shellQuote.js';

/** Where on-demand tools land: outside the clone, so `git add -A` never sweeps them in. */
export const TOOLS_DIR = '/workspace/.tools';
export const TOOLS_BIN_DIR = `${TOOLS_DIR}/bin`;

export type ToolArch = 'amd64' | 'arm64';

export interface ToolCatalogEntry {
  key: string;
  version: string;
  /** One verified download per architecture; an arch with no entry fails the install. */
  archs: Partial<Record<ToolArch, { url: string; sha256: string }>>;
  /** Path of the executable inside the `.tar.gz`. */
  member: string;
}

export interface ToolRequest {
  key: string;
  version?: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MEMBER_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Tools a workspace can install today. Every row is trusted code: pin the version and the digest. */
export const BUILTIN_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
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
    key: 'just',
    member: 'just',
    version: '1.40.0',
  },
];

export class ToolInstallError extends Error {}

/** Check one entry's shape; a catalog row is trusted code, so a malformed one fails loudly. */
export function assertValidEntry(entry: ToolCatalogEntry): void {
  if (!KEY_RE.test(entry.key) || !VERSION_RE.test(entry.version)) {
    throw new ToolInstallError(`tool catalog entry has an invalid key or version: ${entry.key}`);
  }
  if (!MEMBER_RE.test(entry.member) || entry.member.split('/').includes('..')) {
    throw new ToolInstallError(`tool ${entry.key}: unsafe archive member '${entry.member}'`);
  }
  for (const [arch, download] of Object.entries(entry.archs)) {
    if (!download || !SHA256_RE.test(download.sha256) || !download.url.startsWith('https://')) {
      throw new ToolInstallError(`tool ${entry.key}: invalid ${arch} download`);
    }
  }
}

/** Resolve requests against a catalog; an omitted version takes the highest-listed one. */
export function resolveToolRequests(
  requests: ToolRequest[],
  catalog: readonly ToolCatalogEntry[]
): ToolCatalogEntry[] {
  return requests.map((request) => {
    const candidates = catalog.filter(
      (entry) =>
        entry.key === request.key && (!request.version || entry.version === request.version)
    );
    const entry = candidates.at(-1);
    if (!entry) {
      throw new ToolInstallError(
        `tool '${request.key}${request.version ? `@${request.version}` : ''}' is not in the tool catalog`
      );
    }
    assertValidEntry(entry);
    return entry;
  });
}

/**
 * `sh` script that installs the entries into `<dir>/bin` as the container's own user (no root, no
 * package manager). It picks the download for the container's architecture, checks its SHA-256
 * before extracting, and exits non-zero with a message naming the tool on any failure.
 */
export function toolInstallScript(entries: ToolCatalogEntry[], dir: string = TOOLS_DIR): string {
  const q = shellQuote;
  const lines = [
    'set -eu',
    'fail() { echo "auto-swe tool install: $1" >&2; exit 1; }',
    'case "$(uname -m)" in',
    '  x86_64|amd64) arch=amd64 ;;',
    '  aarch64|arm64) arch=arm64 ;;',
    '  *) fail "unsupported architecture $(uname -m)" ;;',
    'esac',
    'if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }',
    'elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1"; }',
    'else fail "neither curl nor wget is available"; fi',
    `mkdir -p ${q(`${dir}/bin`)}`,
    `tmp=$(mktemp -d ${q(`${dir}/tmp.XXXXXX`)})`,
    'trap \'rm -rf "$tmp"\' EXIT',
  ];
  for (const entry of entries) {
    const name = `${entry.key}@${entry.version}`;
    lines.push('case "$arch" in');
    for (const arch of ['amd64', 'arm64'] as const) {
      const download = entry.archs[arch];
      lines.push(
        download
          ? `  ${arch}) url=${q(download.url)}; sha=${q(download.sha256)} ;;`
          : `  ${arch}) fail ${q(`${name} has no ${arch} build`)} ;;`
      );
    }
    lines.push(
      'esac',
      `fetch "$url" "$tmp/archive" || fail ${q(`${name}: download failed from `)}"$url"`,
      `echo "$sha  $tmp/archive" | sha256sum -c - >/dev/null 2>&1 || fail ${q(`${name}: checksum mismatch`)}`,
      `tar -xzf "$tmp/archive" -C "$tmp" ${q(entry.member)} || fail ${q(`${name}: archive has no ${entry.member}`)}`,
      `mv "$tmp"/${q(entry.member)} ${q(`${dir}/bin/${entry.key}`)}`,
      `chmod 755 ${q(`${dir}/bin/${entry.key}`)}`
    );
  }
  return lines.join('\n');
}
