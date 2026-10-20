/**
 * Pure renderers for the container side of registry wiring: the npmrc, the
 * Berry rc, and the `docker run` env. Kept dependency-free so tests and the
 * workspace activity can use them without Prisma.
 */

/** npmrc lines for every registry + scope, written to `NPM_CONFIG_USERCONFIG`. */
export function renderNpmrc(
  registries: { id: string; isDefault?: boolean; scopes: string[] }[],
  baseUrl: string,
  token: string
): string {
  const url = new URL(baseUrl);
  const hostport = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const lines: string[] = [];
  for (const r of registries) {
    lines.push(`//${hostport}/npm/${r.id}/:_authToken=${token}`);
    for (const scope of r.scopes) {
      lines.push(`${scope}:registry=${baseUrl}/npm/${r.id}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Berry `.yarnrc.yml` content: npmScopes for each scoped registry. */
export function renderYarnrc(
  registries: { id: string; isDefault?: boolean; scopes: string[] }[],
  baseUrl: string
): string | null {
  const scoped = registries.filter((r) => r.scopes.length > 0);
  if (scoped.length === 0) {
    return null;
  }
  const lines = ['npmScopes:'];
  for (const r of scoped) {
    for (const scope of r.scopes) {
      const key = scope.startsWith('@') ? scope.slice(1) : scope;
      lines.push(
        `  ${JSON.stringify(key)}:`,
        `    npmRegistryServer: ${JSON.stringify(`${baseUrl}/npm/${r.id}`)}`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The `NAME=value` env pairs a workspace carries for registry access. */
export function registryWorkspaceEnv(
  registries: { id: string; isDefault?: boolean; scopes: string[] }[],
  baseUrl: string,
  token: string
): string[] {
  const env = [
    'NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc',
    'NPM_CONFIG_REPLACE_REGISTRY_HOST=always',
    'NPM_CONFIG_AUDIT=false',
    'NPM_CONFIG_FUND=false',
    'NPM_CONFIG_UPDATE_NOTIFIER=false',
  ];
  const def = registries.find((r) => r.isDefault);
  if (def) {
    env.push(`NPM_CONFIG_REGISTRY=${baseUrl}/npm/${def.id}`);
    env.push(`YARN_NPM_REGISTRY_SERVER=${baseUrl}/npm/${def.id}`);
  }
  env.push(`YARN_NPM_AUTH_TOKEN=${token}`, 'YARN_NPM_ALWAYS_AUTH=true');
  return env;
}
