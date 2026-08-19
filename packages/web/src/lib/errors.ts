/**
 * Narrow an unknown thrown value to a message string.
 *
 * `catch` binds `unknown`, so every handler that wants to show the user what
 * went wrong has to check for `Error` first. Doing that inline once per handler
 * is how the same ternary ended up written out dozens of times; this is the one
 * place it lives, so a future change (a structured API error type, say) is a
 * single edit rather than a sweep.
 */
export function errMsg(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}
