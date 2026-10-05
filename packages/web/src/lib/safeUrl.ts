/**
 * A link target from untrusted data, or null. Only http(s) is linkable: a
 * tracker or host can hand back `javascript:` or `data:` text, and an anchor
 * would run it.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}
