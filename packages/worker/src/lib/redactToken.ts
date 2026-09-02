/**
 * Credential redaction for child-process failures.
 *
 * `git clone` / `git push` run with an SCM token — either embedded in the URL
 * or injected via `-c http.extraheader` — and `promisify(exec)` rejects with
 * the full command in `error.message`, and may also carry it in
 * `error.stdout`, `error.stderr` and `error.cmd`. Without scrubbing, a failed
 * clone leaks the token into the Temporal workflow history and every log line
 * that serialises the error. Shared by `workspace.ts` and `shellStep.ts` so the
 * two clone paths cannot drift.
 */

/** Replace every occurrence of `token` in `s` with `***`. Non-strings are stringified. */
export function redactToken(s: unknown, token?: string | null): string {
  if (typeof s !== 'string') {
    return String(s);
  }
  if (!token) {
    return s;
  }
  return s.split(token).join('***');
}

/** Redact several secrets at once (e.g. the raw token AND its base64 auth header). */
export function redactSecrets(
  s: unknown,
  secrets: ReadonlyArray<string | null | undefined>
): string {
  let out = typeof s === 'string' ? s : String(s);
  // Longest first, so a secret that contains another (a header wrapping its
  // bare base64 value) is scrubbed whole rather than leaving a fragment.
  const ordered = secrets
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    out = redactToken(out, secret);
  }
  return out;
}

/**
 * Scrub `secrets` out of every string field a child-process rejection can
 * carry — `message`, `stdout`, `stderr` and `promisify(exec)`'s own `cmd`
 * (an own enumerable property that a `log.error({ err })` would serialise
 * verbatim). Mutates `err` in place so the caller can simply rethrow it.
 */
export function redactExecError(
  err: unknown,
  secrets: ReadonlyArray<string | null | undefined>
): void {
  const live = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (live.length === 0 || err === null || typeof err !== 'object') {
    return;
  }
  if (err instanceof Error) {
    err.message = redactSecrets(err.message, live);
  }
  const e = err as { stdout?: unknown; stderr?: unknown; cmd?: unknown };
  if (typeof e.stdout === 'string') {
    e.stdout = redactSecrets(e.stdout, live);
  }
  if (typeof e.stderr === 'string') {
    e.stderr = redactSecrets(e.stderr, live);
  }
  if (typeof e.cmd === 'string') {
    e.cmd = redactSecrets(e.cmd, live);
  }
}
