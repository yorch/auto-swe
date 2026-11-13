/**
 * Test support for fakes of `Workspace.exec` that answer the pinned git reads (`execPinned` in
 * `allowedPaths.ts`). Such a read ends with a nonce line the command itself prints; a fake that
 * returns canned output must echo it, exactly as a real shell would, or the read fails closed as
 * truncated. Pure, and imported only from tests.
 */
const SENTINEL_PRINTF = /printf '\\n%s\\n' ([0-9a-f]{32}); exit/;

/** `out` as the shell would have printed it for `command`: the end marker appended when asked for. */
export function withEndMarker(command: string, out: string): string {
  const nonce = SENTINEL_PRINTF.exec(command)?.[1];
  return nonce ? `${out}\n${nonce}\n` : out;
}
