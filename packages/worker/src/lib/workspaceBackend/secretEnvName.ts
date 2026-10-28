const SECRET_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Refuse a secret environment name that is not a plain identifier. Every
 * backend names a secret without its value (`docker exec -e NAME`, or a
 * `NAME=value` line on stdin), so anything else would set a literal value,
 * end the line early or reach a shell string.
 */
export function assertSecretEnvName(name: string): void {
  if (!SECRET_ENV_NAME_RE.test(name)) {
    throw new Error(`invalid secret environment name: ${JSON.stringify(name)}`);
  }
}

/**
 * `-e NAME` for each name of a `secretEnv`, validated. docker resolves the
 * value from the client's own environment, so it is never on a command line.
 */
export function secretEnvFlags(secretEnv: Record<string, string> | undefined): string[] {
  const names = Object.keys(secretEnv ?? {});
  for (const name of names) {
    assertSecretEnvName(name);
  }
  return names.flatMap((name) => ['-e', name]);
}
