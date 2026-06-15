/**
 * Parsed form of an `agentRef`: a stable Agent `key`, optionally pinned to an
 * exact `version`.
 */
export interface ParsedAgentRef {
  key: string;
  /** Pinned version, or undefined to float to the latest active version. */
  version?: number;
}

/**
 * Parse an `agentRef`:
 *   - `"<key>"`            → float (resolve the latest active version)
 *   - `"<key>@<version>"`  → pin the exact version
 *
 * The version must be a positive integer. Throws on a malformed pin. (Consumed
 * by the P2 `agent` node; the WS3 run-start snapshot pins via `ResolveCtx`.)
 */
export function parseAgentRef(ref: string): ParsedAgentRef {
  const at = ref.lastIndexOf('@');
  if (at === -1) {
    if (!ref) {
      throw new Error("Invalid agentRef '': expected '<key>' or '<key>@<version>'");
    }
    return { key: ref };
  }
  const key = ref.slice(0, at);
  const versionStr = ref.slice(at + 1);
  const version = Number(versionStr);
  if (!key || !/^\d+$/.test(versionStr) || !Number.isInteger(version) || version < 1) {
    throw new Error(
      `Invalid agentRef '${ref}': expected '<key>' or '<key>@<version>' (version must be an integer >= 1)`
    );
  }
  return { key, version };
}

/** Format a {@link ParsedAgentRef} back into its string form. */
export function formatAgentRef(parsed: ParsedAgentRef): string {
  return parsed.version === undefined ? parsed.key : `${parsed.key}@${parsed.version}`;
}
