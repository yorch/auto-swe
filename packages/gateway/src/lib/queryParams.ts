import { z } from 'zod';

/**
 * Boolean querystring parameter.
 *
 * Accepts exactly the literal strings `'true'` / `'false'` — matching the
 * `z.enum(['true', 'false'])` precedent this codebase already uses for
 * boolean query flags — and coerces to a real `boolean`, so downstream
 * consumers get `boolean`, never `'true' | 'false' | undefined`.
 *
 * Do **not** use `z.coerce.boolean()` on a querystring field: it is just
 * `Boolean(input)`, which is `true` for *any* non-empty string — including
 * the literal string `"false"` (and `"0"`) — so an explicit `?flag=false`
 * silently inverts to `true`.
 *
 * Anything other than `'true'`/`'false'` — `'1'`/`'0'`, mixed case, or a bare
 * present flag with no value (`?flag`, which Fastify parses as `''`) — fails
 * querystring validation with a 400 rather than being silently coerced one
 * way or the other. This matches the existing `z.enum(['true', 'false'])`
 * precedent and keeps the API's accepted input shape uniform across routes.
 *
 * @param defaultValue value used when the parameter is omitted entirely.
 */
export function booleanQueryParam(defaultValue = false) {
  return z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true'));
}
