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
  // Yarn classic nerf-darts auth by host only and skips auth headers
  // entirely without always-auth — both lines exist for it.
  const lines: string[] = [`//${hostport}/:_authToken=${token}`, 'always-auth=true'];
  for (const r of registries) {
    lines.push(`//${hostport}/npm/${r.id}/:_authToken=${token}`);
    for (const scope of r.scopes) {
      lines.push(`${scope}:registry=${baseUrl}/npm/${r.id}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Berry `.yarnrc.yml` content: the proxy host on `unsafeHttpWhitelist` (Yarn 4
 * refuses an http:// registry not named there, and the proxy is always http on
 * the container network — the default registry reaches Berry through
 * `YARN_NPM_REGISTRY_SERVER`, so this is needed even with no scopes), plus
 * `npmScopes` for each scoped registry. Null only when there are no registries.
 */
export function renderYarnrc(
  registries: { id: string; isDefault?: boolean; scopes: string[] }[],
  baseUrl: string
): string | null {
  if (registries.length === 0) {
    return null;
  }
  const host = new URL(baseUrl).hostname;
  const lines = ['unsafeHttpWhitelist:', `  - ${JSON.stringify(host)}`];
  const scoped = registries.filter((r) => r.scopes.length > 0);
  if (scoped.length > 0) {
    lines.push('npmScopes:');
  }
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
    // Corepack downloads pinned package-manager binaries over npm; without
    // these it would reach the public registry (or fail with no egress).
    env.push(`COREPACK_NPM_REGISTRY=${baseUrl}/npm/${def.id}`);
    env.push(`COREPACK_NPM_TOKEN=${token}`);
    env.push('COREPACK_ENABLE_DOWNLOAD_PROMPT=0');
  }
  env.push(`YARN_NPM_AUTH_TOKEN=${token}`, 'YARN_NPM_ALWAYS_AUTH=true');
  return env;
}
