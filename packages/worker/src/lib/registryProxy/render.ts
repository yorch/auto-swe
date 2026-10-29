/**
 * Pure renderers for the container side of registry wiring: the npmrc, the
 * Berry rc, and the `docker run` env. Kept dependency-free so tests and the
 * workspace activity can use them without Prisma.
 */

/** A registry as the renderers see it; an absent `ecosystem` is npm. */
interface RenderedRegistry {
  ecosystem?: 'npm' | 'go';
  id: string;
  isDefault?: boolean;
  scopes: string[];
}

/** The npm entries of a mixed list: a go registry's id must never appear as an npm registry. */
const npmOnly = (registries: RenderedRegistry[]): RenderedRegistry[] =>
  registries.filter((r) => r.ecosystem !== 'go');

/** npmrc lines for every registry + scope, written to `NPM_CONFIG_USERCONFIG`. */
export function renderNpmrc(
  registries: RenderedRegistry[],
  baseUrl: string,
  token: string
): string {
  const url = new URL(baseUrl);
  const hostport = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  // Yarn classic nerf-darts auth by host only and skips auth headers
  // entirely without always-auth — both lines exist for it.
  const lines: string[] = [`//${hostport}/:_authToken=${token}`, 'always-auth=true'];
  for (const r of npmOnly(registries)) {
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
 * `npmScopes` for each scoped registry. Null only when there are no npm registries.
 */
export function renderYarnrc(registries: RenderedRegistry[], baseUrl: string): string | null {
  const npm = npmOnly(registries);
  if (npm.length === 0) {
    return null;
  }
  const host = new URL(baseUrl).hostname;
  const lines = ['unsafeHttpWhitelist:', `  - ${JSON.stringify(host)}`];
  const scoped = npm.filter((r) => r.scopes.length > 0);
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
  registries: RenderedRegistry[],
  baseUrl: string,
  token: string
): string[] {
  const npm = npmOnly(registries);
  const goRegistry = registries.find((r) => r.ecosystem === 'go');
  const env: string[] = [];
  // A Go-only workspace gets no npm, Corepack or Yarn env at all. An empty list is not
  // "go-only": it keeps the npm block, as it always has.
  if (npm.length > 0 || !goRegistry) {
    env.push(
      'NPM_CONFIG_USERCONFIG=/workspace/.auto-swe/npmrc',
      'NPM_CONFIG_REPLACE_REGISTRY_HOST=always',
      'NPM_CONFIG_AUDIT=false',
      'NPM_CONFIG_FUND=false',
      'NPM_CONFIG_UPDATE_NOTIFIER=false'
    );
    const def = npm.find((r) => r.isDefault);
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
  }
  if (goRegistry) {
    const url = new URL(baseUrl);
    const hostport = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    // `GOPROXY` names only the proxy — no `,direct`, no second entry. Go falls through to the
    // next entry on a 404/410 and, with `direct`, would then fetch the module from its VCS,
    // past the allowlist. With the proxy alone, a module it refuses is not fetched at all.
    // The token rides as the URL's userinfo, so the whole value is a secret (see below).
    env.push(`GOPROXY=${url.protocol}//proxy:${token}@${hostport}/go/${goRegistry.id}`);
    // The toolchain downloader would fetch `golang.org/toolchain@…` through the proxy, which a
    // lockfile allowlist denies. With `local`, a repository that needs a newer Go than the
    // image has fails with Go's own clear message instead.
    env.push('GOTOOLCHAIN=local');
  }
  return env;
}

/** Registry env entries whose value is, or contains, the proxy token. */
const TOKEN_ENV_NAMES = new Set(['COREPACK_NPM_TOKEN', 'GOPROXY', 'YARN_NPM_AUTH_TOKEN']);

/**
 * {@link registryWorkspaceEnv} divided into what is safe on any object that
 * describes the workspace and the token-bearing entries, which belong in
 * `WorkspaceContainerSpec.secretEnv`. Corepack and Yarn Berry read the token
 * from the environment only (the npmrc written into the workspace serves npm,
 * pnpm and Yarn classic), and they run in the agent's own commands, so it has
 * to be in the container's environment, not injected per exec.
 */
export function splitRegistryWorkspaceEnv(env: string[]): {
  env: string[];
  secretEnv: Record<string, string>;
} {
  const plain: string[] = [];
  const secretEnv: Record<string, string> = {};
  for (const pair of env) {
    const eq = pair.indexOf('=');
    const name = eq > 0 ? pair.slice(0, eq) : '';
    if (TOKEN_ENV_NAMES.has(name)) {
      secretEnv[name] = pair.slice(eq + 1);
    } else {
      plain.push(pair);
    }
  }
  return { env: plain, secretEnv };
}
