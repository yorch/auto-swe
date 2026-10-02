import { resolveSettings } from '@auto-swe/shared/config';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { fromNodeHeaders } from 'better-auth/node';
import { getAuth, MCP_RESOURCE } from './betterAuth.js';
import type { McpOAuthGateOptions } from './mcpOAuthGate.js';

/** The production wiring: settings from the registry, sessions and metadata from better-auth. */
export function mcpOAuthGateOptions(): McpOAuthGateOptions {
  return {
    authServerMetadata: (request) => oauthProviderAuthServerMetadata(getAuth())(request),
    getSessionUser: async (request) => {
      const session = await getAuth().api.getSession({ headers: fromNodeHeaders(request.headers) });
      return session ? { isActive: Boolean(session.user.isActive) } : null;
    },
    getSettings: async () => {
      const settings = await resolveSettings(['mcp.enabled', 'mcp.writeToolsEnabled']);
      return {
        enabled: settings['mcp.enabled'],
        writeToolsEnabled: settings['mcp.writeToolsEnabled'],
      };
    },
    resource: MCP_RESOURCE,
  };
}
