/**
 * Run-time counterpart of the `credential-not-in-env` source invariant.
 *
 * A plain `NAME=value` env pair becomes part of a command line (`kubectl exec`
 * argv, which the apiserver audit log records; `docker run/exec -e` argv, which
 * `ps` shows) or of a Pod object. The invariant catches an `env: [ … ]` literal
 * that names a credential; it cannot see an env list built elsewhere. This guard
 * refuses such a pair where the backend renders it, so a credential travels as
 * `secretEnv` or the call fails loudly.
 *
 * The rule is the invariant's, copied from `CREDENTIAL_NAME` and
 * `NOT_A_CREDENTIAL` in `scripts/check-invariants.mjs`. Keep the two in step.
 */
const CREDENTIAL_NAME = new RegExp(
  [
    /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|CREDENTIAL|NPMRC|YARNRC/,
    /(?:PRIVATE|ACCESS|SSH|DEPLOY|SIGNING)_?KEY|BEARER|COOKIE|PASSPHRASE/,
    /(?<![A-Za-z0-9])(?:PAT|PASS|PWD)(?![A-Za-z])/,
  ]
    .map((re) => re.source)
    .join('|'),
  'i'
);

/** Names that contain a credential word without being one. */
const NOT_A_CREDENTIAL = /AUTHOR(?!IZ)|TOKENS(?![A-Za-z])/gi;

/**
 * Exact, case-sensitive names that carry no credential despite matching the pattern.
 * `YARN_NPM_ALWAYS_AUTH` is a Yarn boolean flag (`true`) whose name contains AUTH. Every
 * addition needs the same justification: the variable's value is provably not a secret.
 */
const NOT_CREDENTIALS: ReadonlySet<string> = new Set(['YARN_NPM_ALWAYS_AUTH']);

/** Whether an environment variable name looks like it carries a credential. */
export function isCredentialEnvName(name: string): boolean {
  if (NOT_CREDENTIALS.has(name)) {
    return false;
  }
  return CREDENTIAL_NAME.test(name.replace(NOT_A_CREDENTIAL, ''));
}

/**
 * URL userinfo in a value (`scheme://user:pass@host`), e.g. `HTTPS_PROXY=http://u:p@host`.
 * The user and password are limited to RFC 3986 userinfo characters, so JSON, query strings and
 * paths (`"`, `/`, `?`, `#`, `[`, whitespace) end the match. The lookbehind keeps the scan
 * linear: without it, a long value without `://` is rescanned from every letter.
 */
const USERINFO_CHARS = "[A-Za-z0-9\\-._~%!$&'()*+,;=]";
const URL_USERINFO = new RegExp(
  `(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\\/\\/${USERINFO_CHARS}*:${USERINFO_CHARS}*@`,
  'i'
);

/**
 * Throws when any `NAME=value` pair names a credential, or its value carries URL userinfo.
 * The error names the variable and the call site only; it never includes the value.
 */
export function assertNoCredentialEnvPairs(
  pairs: readonly string[] | undefined,
  where: string
): void {
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (isCredentialEnvName(name)) {
      throw new Error(
        `refusing to pass credential-named environment variable ${name} as a plain env ` +
          `pair in ${where}: plain env reaches command lines and audit logs. Pass it as secretEnv.`
      );
    }
    if (eq !== -1 && URL_USERINFO.test(pair.slice(eq + 1))) {
      throw new Error(
        `refusing to pass environment variable ${name} as a plain env pair in ${where}: ` +
          'value carries URL credentials; pass it as secretEnv.'
      );
    }
  }
}
