import { resolveSettings } from '@auto-swe/shared/config';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { fromNodeHeaders } from 'better-auth/node';
import { getAuth, MCP_RESOURCE } from './betterAuth.js';
import type { McpConsentAuditOptions } from './mcpConsentAudit.js';
import { approveMcpDevice } from './mcpDeviceApproval.js';
import type { McpOAuthGateOptions } from './mcpOAuthGate.js';

/** The production wiring: settings from the registry, sessions and metadata from better-auth. */
export function mcpOAuthGateOptions(): McpOAuthGateOptions {
  return {
    approveDevice: approveMcpDevice,
    authServerMetadata: (request) => oauthProviderAuthServerMetadata(getAuth())(request),
    getSessionUser: async (request) => {
      const session = await getAuth().api.getSession({ headers: fromNodeHeaders(request.headers) });
      return session ? { isActive: Boolean(session.user.isActive) } : null;
    },
    getSettings: async () => {
      const settings = await resolveSettings([
        'mcp.enabled',
        'mcp.writeToolsEnabled',
        'mcp.deviceFlowEnabled',
      ]);
      return {
        deviceFlowEnabled: settings['mcp.deviceFlowEnabled'],
        enabled: settings['mcp.enabled'],
        writeToolsEnabled: settings['mcp.writeToolsEnabled'],
      };
    },
    resource: MCP_RESOURCE,
  };
}

/** The production wiring for the consent audit: who the session belongs to. */
export function mcpConsentAuditOptions(): McpConsentAuditOptions {
  return {
    getSessionUserId: async (request) => {
      const session = await getAuth().api.getSession({ headers: fromNodeHeaders(request.headers) });
      return session?.user.id ?? null;
    },
  };
}
