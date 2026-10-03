/**
 * The keys of `bound` (an agent's final tool map) whose tool is the very object
 * one of `sources` supplied — for `RunAgentOptions.selfRecordingTools`, where
 * the sources are the tool sets that record their own calls (MCP, workspace).
 * Matching by identity rather than by key means a self-recording tool displaced
 * on a key collision is not named, so the tool that won the key still gets its
 * rows.
 */
export function boundToolKeys(
  bound: object | undefined,
  ...sources: Array<object | undefined>
): Set<string> {
  const supplied = new Set(sources.flatMap((s) => Object.values(s ?? {})));
  return new Set(
    Object.entries(bound ?? {})
      .filter(([, tool]) => supplied.has(tool))
      .map(([key]) => key)
  );
}
