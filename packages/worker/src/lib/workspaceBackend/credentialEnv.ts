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
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|CREDENTIAL|NPMRC|YARNRC/i;

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
 * Throws when any `NAME=value` pair names a credential. Only the name (text
 * before the first `=`) is examined, and only the name appears in the error.
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
  }
}
