import {
  BUILTIN_TOOLS,
  resolveToolRequests,
  type ToolCatalogEntry,
  ToolInstallError,
  type ToolRequest,
} from '@auto-swe/shared/lib/toolCatalog';
import { shellQuote } from './shellQuote.js';

export type { ToolCatalogEntry, ToolRequest };
export { resolveToolRequests, ToolInstallError };

/** Where on-demand tools land: outside the clone, so `git add -A` never sweeps them in. */
export const TOOLS_DIR = '/workspace/.tools';
export const TOOLS_BIN_DIR = `${TOOLS_DIR}/bin`;

/**
 * The `PATH=` pair for an exec once tools are installed. The tools directory goes LAST: the agent
 * can write there, so a planted `git` or `sh` must never shadow the image's own binary (the
 * platform's guards and credentialed commands run through `PATH`). A catalog tool can only add
 * names the image lacks.
 */
export function toolsPathEnv(basePath: string): string {
  const usable = basePath.split(':').every((element) => element.startsWith('/'));
  return `PATH=${usable ? basePath : FALLBACK_BASE_PATH}:${TOOLS_BIN_DIR}`;
}

/**
 * Used when the container's own `PATH` is empty or has an empty or relative element. An empty
 * element means the current directory, and execs run in the agent-writable clone, so passing it
 * through would let a planted binary there shadow the image's. This is the standard Linux path.
 */
const FALLBACK_BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Kept for callers that still import the built-in list from here. */
export const BUILTIN_TOOL_CATALOG = BUILTIN_TOOLS;

/** `sh` exit code for a failure a retry can fix (sysexits EX_TEMPFAIL): the download. */
export const TOOL_INSTALL_RETRYABLE_EXIT = 75;

/**
 * Turn a failed install script into a {@link ToolInstallError}. Only the retryable exit code (a
 * network failure) is marked retryable; a checksum, libc, arch or archive failure never is.
 */
export function classifyToolInstallFailure(
  exitCode: number | null,
  message: string,
  tool?: string
): ToolInstallError {
  const text = tool && !message.includes(tool) ? `${tool}: ${message}` : message;
  return new ToolInstallError(text, { retryable: exitCode === TOOL_INSTALL_RETRYABLE_EXIT });
}

/**
 * `sh` script that installs the entries into `<dir>/bin` as the container's own user (no root, no
 * package manager). It picks the download for the container's architecture, refuses a binary built
 * for the other C library, checks its SHA-256 before extracting, and exits non-zero with a message
 * naming the tool (and only the download's host) on any failure: 75 for a network failure, a
 * timeout or an HTTP 408/429/5xx (retryable), 1 for everything else.
 */
export function toolInstallScript(
  entries: readonly ToolCatalogEntry[],
  dir: string = TOOLS_DIR
): string {
  const q = shellQuote;
  const lines = [
    'set -eu',
    // Every proxy variable is cleared. This is safe because a creation-time install runs before
    // `lockEgress` (a late install is refused under blocked/restricted egress), and the downloads
    // come from catalog URLs an admin vetted. Left set, the team's allowlisting proxy would 403 a
    // release download's redirect to another host (curl exit 56) and burn the activity's retries.
    // With the proxy out of the path, exit 56 is a genuine network failure and stays retryable.
    'unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy',
    'fail() { echo "auto-swe tool install: $1" >&2; exit "${2:-1}"; }',
    'case "$(uname -m)" in',
    '  x86_64|amd64) arch=amd64 ;;',
    '  aarch64|arm64) arch=arm64 ;;',
    '  *) fail "unsupported architecture $(uname -m)" ;;',
    'esac',
    'libc=glibc',
    'for f in /lib/ld-musl-* /usr/lib/ld-musl-*; do if [ -e "$f" ]; then libc=musl; fi; done',
    'if [ "$libc" = glibc ] && ldd --version 2>&1 | grep -qi musl; then libc=musl; fi',
    // `fetch URL OUT NAME`: the message names only the HOST (the catalog schema guarantees an
    // https URL without userinfo or query, but a URL is never echoed whole). A transport failure
    // and HTTP 408/429/5xx are retryable (75); any other HTTP status is permanent.
    'fetch() {',
    '  host=${1#*://}; host=${host%%[/?#]*}; host=${host##*@}',
    '  rc=0',
    '  if command -v curl >/dev/null 2>&1; then',
    '    code=$(curl -sSL --globoff --retry 2 --connect-timeout 20 --max-time 240 --proto "=https" --proto-redir "=https" -o "$2" -w "%{http_code}" "$1" 2>/dev/null) || rc=$?',
    '    if [ "$rc" -ne 0 ]; then',
    '      case "$rc" in 1|2|3) fail "$3: download failed from $host (curl exit $rc)" 1 ;; esac',
    '      fail "$3: download failed from $host" 75',
    '    fi',
    '    case "$code" in',
    '      2??) return 0 ;;',
    '      408|429|5??) fail "$3: HTTP $code from $host" 75 ;;',
    '      *) fail "$3: HTTP $code from $host" 1 ;;',
    '    esac',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    # wget cannot be restricted to https redirects; integrity is the SHA-256, not the transport.',
    '    # busybox wget reports no HTTP status: its exit 8 covers every 4xx and 5xx alike, so it',
    '    # cannot tell a missing file from an outage. Every wget failure is treated as retryable.',
    '    wget -q -T 60 -O "$2" "$1" >/dev/null 2>&1 || rc=$?',
    '    if [ "$rc" -ne 0 ]; then fail "$3: download failed from $host" 75; fi',
    '  else fail "neither curl nor wget is available"; fi',
    '}',
    `mkdir -p ${q(`${dir}/bin`)}`,
    `tmp=$(mktemp -d ${q(`${dir}/tmp.XXXXXX`)})`,
    'trap \'rm -rf "$tmp"\' EXIT',
  ];
  for (const entry of entries) {
    const name = `${entry.key}@${entry.version}`;
    lines.push(
      `case ${q(entry.libc)} in any) ;; "$libc") ;; *) fail ${q(`${name}: needs a ${entry.libc} container, but this one is `)}"$libc" ;; esac`,
      'case "$arch" in'
    );
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
      `fetch "$url" "$tmp/archive" ${q(name)}`,
      `echo "$sha  $tmp/archive" | sha256sum -c - >/dev/null 2>&1 || fail ${q(`${name}: checksum mismatch`)}`,
      `tar -xzf "$tmp/archive" -C "$tmp" -- ${q(entry.member)} || fail ${q(`${name}: archive has no ${entry.member}`)}`,
      `mv -- "$tmp"/${q(entry.member)} ${q(`${dir}/bin/${entry.key}`)}`,
      `chmod -- 755 ${q(`${dir}/bin/${entry.key}`)}`
    );
  }
  return lines.join('\n');
}
