import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { JSONWebKeySet } from 'jose';
import { loadTokenUser } from '../plugins/auth.js';
import type { McpRouteOptions } from '../routes/mcp.js';
import { getAuth, MCP_ISSUER, MCP_RESOURCE } from './betterAuth.js';
import { getCorsOrigins, getDefaultClientOrigin } from './env.js';
import { createMcpTokenVerifier } from './mcpTokenVerifier.js';

/** What a client sees as the server's version in `initialize`; bump when the tool surface changes. */
const MCP_SERVER_VERSION = '1.0.0';

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

const GITHUB_HOSTS_TTL_MS = 60_000;

/**
 * Every GitHub web host the platform is configured for: the instance's own, and each distinct
 * override a connection carries (GitHub Enterprise). A pull request link in a run's result is
 * trusted only on one of these. Cached briefly, since it is read on every `get_run`.
 */
function githubHostsReader() {
  let cached: { hosts: string[]; at: number } | null = null;
  return async (): Promise<string[]> => {
    if (cached && Date.now() - cached.at < GITHUB_HOSTS_TTL_MS) {
      return cached.hosts;
    }
    const [config, rows] = await Promise.all([
      resolveGitHubConfig(),
      runUnscoped('the set of GitHub hosts is platform-wide, not a tenant', ['Connection'], () =>
        prisma.connection.findMany({
          distinct: ['githubUrl'],
          select: { githubUrl: true },
          where: { githubUrl: { not: null } },
        })
      ),
    ]);
    const hosts = new Set<string>();
    for (const url of [config.baseUrl, ...rows.map((r) => r.githubUrl)]) {
      try {
        hosts.add(new URL(url as string).host.toLowerCase());
      } catch {
        // An unparseable override is not a host anyone could link to.
      }
    }
    cached = { at: Date.now(), hosts: [...hosts] };
    return cached.hosts;
  };
}

/** The production wiring: keys and consent from the authorization server's own tables, settings from the registry. */
export function mcpRouteOptions(): McpRouteOptions {
  const getSettings = async () => {
    const settings = await resolveSettings(['mcp.enabled', 'mcp.writeToolsEnabled']);
    return {
      enabled: settings['mcp.enabled'],
      writeToolsEnabled: settings['mcp.writeToolsEnabled'],
    };
  };
  return {
    allowedOriginHostnames: [...getCorsOrigins(), MCP_RESOURCE]
      .map(hostnameOf)
      .filter((host): host is string => host !== null),
    dashboardOrigin: getDefaultClientOrigin(),
    getGitHubHosts: githubHostsReader(),
    getSettings,
    issuer: MCP_ISSUER,
    resource: MCP_RESOURCE,
    serverVersion: MCP_SERVER_VERSION,
    verifier: createMcpTokenVerifier({
      fetchJwks: async () => (await getAuth().api.getJwks()) as JSONWebKeySet,
      getWriteToolsEnabled: async () => (await getSettings()).writeToolsEnabled,
      issuer: MCP_ISSUER,
      loadGrant: async (userId, clientId) => {
        const [consent, client] = await Promise.all([
          prisma.oauthConsent.findFirst({
            orderBy: { updatedAt: 'desc' },
            select: { id: true, scopes: true, updatedAt: true },
            where: { clientId, userId },
          }),
          prisma.oauthClient.findUnique({ select: { disabled: true }, where: { clientId } }),
        ]);
        return consent
          ? {
              clientActive: client !== null && client.disabled !== true,
              consentId: consent.id,
              consentScopes: consent.scopes,
              consentUpdatedAt: consent.updatedAt,
            }
          : null;
      },
      loadUser: (userId) => loadTokenUser(prisma, userId),
      resource: MCP_RESOURCE,
    }),
  };
}
