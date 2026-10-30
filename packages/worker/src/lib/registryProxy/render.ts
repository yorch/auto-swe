/**
 * Pure renderers for the container side of registry wiring: the npmrc, the
 * Berry rc, and the `docker run` env. Kept dependency-free so tests and the
 * workspace activity can use them without Prisma.
 */

/** A registry as the renderers see it; an absent `ecosystem` is npm. */
interface RenderedRegistry {
  ecosystem?: 'npm' | 'go' | 'pypi' | 'maven';
  id: string;
  isDefault?: boolean;
  scopes: string[];
}

/** The npm entries of a mixed list: a go, pypi or maven registry's id must never appear as an npm registry. */
const npmOnly = (registries: RenderedRegistry[]): RenderedRegistry[] =>
  registries.filter((r) => r.ecosystem === undefined || r.ecosystem === 'npm');

/** Where the workspace and the shell step keep the Maven `settings.xml`; `MAVEN_ARGS` names it. */
export const MAVEN_SETTINGS_PATH = '/workspace/.auto-swe/maven-settings.xml';

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Maven `settings.xml` for the first maven registry, or null when there is none. One mirror of
 * everything (`mirrorOf *`), so every repository a POM or plugin names is fetched through the
 * proxy, and one server entry carrying the proxy token as the Basic password. The file is the
 * secret: the token is in no URL.
 */
export function renderMavenSettings(
  registries: RenderedRegistry[],
  baseUrl: string,
  token: string
): string | null {
  const maven = registries.find((r) => r.ecosystem === 'maven');
  if (!maven) {
    return null;
  }
  const root = baseUrl.replace(/\/+$/, '');
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<settings>',
    '  <mirrors>',
    '    <mirror>',
    '      <id>auto-swe-proxy</id>',
    '      <mirrorOf>*</mirrorOf>',
    `      <url>${xmlEscape(`${root}/maven/${maven.id}/`)}</url>`,
    '    </mirror>',
    '  </mirrors>',
    '  <servers>',
    '    <server>',
    '      <id>auto-swe-proxy</id>',
    '      <username>token</username>',
    `      <password>${xmlEscape(token)}</password>`,
    '    </server>',
    '  </servers>',
    '</settings>',
  ].join('\n')}\n`;
}

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
  const pypiRegistry = registries.find((r) => r.ecosystem === 'pypi');
  const mavenRegistry = registries.find((r) => r.ecosystem === 'maven');
  const env: string[] = [];
  // A workspace wired only to go, pypi and/or maven gets no npm, Corepack or Yarn env at all. An
  // empty list is not that: it keeps the npm block, as it always has.
  if (npm.length > 0 || registries.length === 0) {
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
    // `GOPROXY` names only the proxy — no `,direct`, no second entry. Go falls through to the
    // next entry on a 404/410 and, with `direct`, would then fetch the module from its VCS,
    // past the allowlist. With the proxy alone, a module it refuses is not fetched at all.
    // The token is a path segment, not userinfo: Go refuses to send credentials from a `GOPROXY`
    // URL over plain http, and the proxy is plain http. The whole value is a secret (see below).
    env.push(`GOPROXY=${baseUrl}/go/${token}/${goRegistry.id}`);
    // The toolchain downloader would fetch `golang.org/toolchain@…` through the proxy, which a
    // lockfile allowlist denies. With `local`, a repository that needs a newer Go than the
    // image has fails with Go's own clear message instead.
    env.push('GOTOOLCHAIN=local');
  }
  if (pypiRegistry) {
    // The token is the password of URL userinfo, unlike Go's path segment. pip and uv both send
    // userinfo over plain http (Go refuses to), and both redact it in the files and error text
    // they write; a token in the path would land in `uv.lock` and `pyproject.toml`. The user name
    // is a placeholder the proxy ignores. The whole URL is a secret. `UV_INDEX_URL` is the older
    // uv spelling of `UV_DEFAULT_INDEX`.
    const url = new URL(baseUrl);
    const indexUrl = new URL(url);
    indexUrl.username = 'token';
    indexUrl.password = token;
    indexUrl.pathname = `${url.pathname.replace(/\/+$/, '')}/pypi/${pypiRegistry.id}/simple/`;
    indexUrl.search = '';
    indexUrl.hash = '';
    const index = indexUrl.href;
    env.push(
      `PIP_INDEX_URL=${index}`,
      `UV_DEFAULT_INDEX=${index}`,
      `UV_INDEX_URL=${index}`,
      // pip refuses an http index unless its host is trusted; its format is `host[:port]`.
      `PIP_TRUSTED_HOST=${url.port ? `${url.hostname}:${url.port}` : url.hostname}`,
      'PIP_DISABLE_PIP_VERSION_CHECK=1',
      // Empty, so an extra index cannot be added through the environment.
      'PIP_EXTRA_INDEX_URL=',
      'UV_EXTRA_INDEX_URL='
    );
  }
  if (mavenRegistry) {
    // Maven 3.9+ reads `MAVEN_ARGS`. The path holds no secret: the token is in the settings file.
    env.push(`MAVEN_ARGS=-s ${MAVEN_SETTINGS_PATH}`);
  }
  return env;
}

/** Registry env entries whose value is, or contains, the proxy token. */
const TOKEN_ENV_NAMES = new Set([
  'COREPACK_NPM_TOKEN',
  'GOPROXY',
  'PIP_INDEX_URL',
  'UV_DEFAULT_INDEX',
  'UV_INDEX_URL',
  'YARN_NPM_AUTH_TOKEN',
]);

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
