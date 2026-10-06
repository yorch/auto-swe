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

// Shapes a credential takes in a shell command line. Each pattern keeps the
// part that says WHAT was there (`NPM_TOKEN=`, `--password `, `https://`) and
// replaces only the value, so the masked text still reads as the command it
// was. Heuristic by design: it is for text that is persisted and later shown to
// a model or an operator, where an unknown token cannot be passed in by name.
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // URL userinfo: https://user:pass@host → https://***@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  // Authorization headers: `Bearer xyz`, `Basic xyz`, `token xyz`
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***'],
  // NAME=value / NAME: value where NAME names a credential
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2***',
  ],
  // --token value / --password=value / -p value is too ambiguous; long flags only
  [
    /(--[A-Za-z0-9-]*(?:token|secret|password|passwd|api-?key|access-?key|private-?key)[A-Za-z0-9-]*)([=\s]+)("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2***',
  ],
  // Well-known token prefixes that need no surrounding context
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g,
    '***',
  ],
];

/**
 * Mask anything in `s` shaped like a credential — URL userinfo, auth headers,
 * `*_TOKEN=` style assignments, `--password` style flags, and well-known token
 * prefixes. Use it on free text (a shell step's command line) that is about to
 * be persisted where a model or an operator will read it, in ADDITION to
 * {@link redactSecrets} for the secrets known by value. A heuristic: it lowers
 * the odds of a stored secret, it does not prove there is none.
 */
export function maskCredentialShapes(s: string): string {
  let out = s;
  for (const [pattern, replacement] of CREDENTIAL_SHAPES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
