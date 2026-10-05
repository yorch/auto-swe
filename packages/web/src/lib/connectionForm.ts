import {
  type ConnectionType,
  isConnectionType,
  listConnectionTypes,
} from '@auto-swe/shared/lib/connectionTypes';

export interface ConnectionTypeOption {
  label: string;
  value: ConnectionType;
}

/**
 * Connection types the create form offers: the shared registry the gateway
 * validates against, minus `mcp` — MCP servers are created on their own
 * ADMIN-only, SSRF-checked page and the repository route rejects them.
 */
export function selectableConnectionTypes(): ConnectionTypeOption[] {
  return listConnectionTypes()
    .filter((m) => m.key !== 'mcp')
    .map((m) => ({ label: m.label, value: m.key }));
}

/** A stored type the form understands, else `git_repo` (legacy rows carry none). */
export function initialConnectionType(type: unknown): ConnectionType {
  return isConnectionType(type) ? type : 'git_repo';
}

export type ConfigParse =
  | { ok: true; config: Record<string, unknown> | null }
  | { ok: false; error: string };

/**
 * Parse the config textarea. Blank means "no config" (`null`); the caller
 * decides how to send that — omit it on create (the create schema is optional,
 * not nullable) and send `null` on update to clear it.
 */
export function parseConnectionConfig(text: string): ConfigParse {
  if (!text.trim()) {
    return { config: null, ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Config JSON is invalid', ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Config must be a JSON object (e.g. {"key": "value"})', ok: false };
  }
  return { config: parsed as Record<string, unknown>, ok: true };
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|bearer|credential)/i;

/**
 * Dotted paths of config keys whose names look like credentials. Config is stored as plain JSON
 * and shown to the connection's team, so a match is worth a warning before it is saved.
 */
export function secretLikeConfigKeys(config: unknown, prefix = ''): string[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return [];
  }
  return Object.entries(config as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = secretLikeConfigKeys(value, path);
    return SECRET_KEY.test(key) && typeof value === 'string' && value !== ''
      ? [path, ...nested]
      : nested;
  });
}
