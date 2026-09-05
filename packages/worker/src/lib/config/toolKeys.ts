/**
 * Coerce the nullable JSON `Agent.toolKeys` column into `string[] | null`.
 * `null` means "no override — every candidate tool is enabled"; any non-string
 * entry is dropped rather than failing the resolve. One definition, shared by
 * the resolver and its skill/MCP shims, so the three cannot drift.
 */
export function parseToolKeys(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return null;
}
