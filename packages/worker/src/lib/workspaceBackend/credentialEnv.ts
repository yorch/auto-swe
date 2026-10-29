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
 * The name rule is the invariant's, copied from `CREDENTIAL_NAME` and
 * `NOT_A_CREDENTIAL` in `scripts/check-invariants.mjs`. Keep the two in step.
 *
 * A value is refused when it carries URL userinfo (`user:password@host`, or a bare
 * `token@host` on http, https and ftp) or has the shape of a well-known credential
 * (`CREDENTIAL_VALUE_SHAPES`). A credential in any other form, or under an innocuous
 * name, is not seen.
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
 * Userinfo ends at whitespace, a quote, a slash, a query or fragment marker, a bracket or a
 * backslash, so compact JSON, query strings and IPv6 hosts do not match. The username stops at
 * the first `:` (only the first colon separates user from password), while the password may
 * contain colons, since a curl or WHATWG-accepted password can. The `@` ends either part. The
 * lookbehind keeps the scan linear: without it, a long value without `://` is rescanned from
 * every letter.
 */
const USERNAME_CHARS = String.raw`[^\s"/?#@:\[\]\\]`;
const PASSWORD_CHARS = String.raw`[^\s"/?#@\[\]\\]`;
const URL_USERINFO = new RegExp(
  `(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\\/\\/${USERNAME_CHARS}*:${PASSWORD_CHARS}*@`,
  'i'
);

/**
 * Username-only userinfo (`https://ghp_x@host`) on the schemes where a bare user is a token.
 * `ssh://git@host` and scp-style `git@host:path` are not matched: `git@` is a convention.
 * The user part excludes `:` (the user:password check owns that), `/`, `?` and `#`, so a
 * path, query or fragment holding an `@` does not match. Same scheme lookbehind as above,
 * so a repeated `https://` is scanned linearly.
 */
const URL_USERNAME_ONLY = new RegExp(
  `(?<![a-z0-9+.-])(?:https?|ftp):\\/\\/${USERNAME_CHARS}+@`,
  'i'
);

/**
 * Well-known credential shapes in a value. Each is anchored on a distinctive prefix and a
 * minimum length so ordinary data (hashes, UUIDs, prose, `sk-learn`) cannot match; each is a
 * literal prefix followed by one bounded class, so matching is linear. The `Bearer`/`Basic`
 * scheme word is case-sensitive on purpose: a case-insensitive `basic` would match prose
 * such as `basic authentication-service`. One line per shape; the label is the only text an
 * error carries.
 */
const CREDENTIAL_VALUE_SHAPES: readonly { kind: string; re: RegExp }[] = [
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { kind: 'GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'API key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'HTTP authorization', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/ },
  // base64 of `x-access-token:`, the start of the git `http.extraheader` Basic value
  { kind: 'git auth header', re: /eC1hY2Nlc3MtdG9rZW46/ },
];

/** The label of the credential shape a value has, or null. */
function credentialValueKind(value: string): string | null {
  for (const shape of CREDENTIAL_VALUE_SHAPES) {
    if (shape.re.test(value)) {
      return shape.kind;
    }
  }
  return null;
}

/**
 * Throws when any `NAME=value` pair names a credential, or its value carries URL userinfo
 * or has a well-known credential shape. The error names the variable and the call site
 * only; it never includes any part of the value.
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
    if (eq === -1) {
      continue;
    }
    const value = pair.slice(eq + 1);
    if (URL_USERINFO.test(value) || URL_USERNAME_ONLY.test(value)) {
      throw new Error(
        `refusing to pass environment variable ${name} as a plain env pair in ${where}: ` +
          'value carries URL credentials; pass it as secretEnv.'
      );
    }
    const kind = credentialValueKind(value);
    if (kind !== null) {
      throw new Error(
        `refusing to pass environment variable ${name} as a plain env pair in ${where}: ` +
          `value looks like a credential (${kind}); pass it as secretEnv.`
      );
    }
  }
}
