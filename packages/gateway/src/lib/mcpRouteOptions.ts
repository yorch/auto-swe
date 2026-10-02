import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
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
