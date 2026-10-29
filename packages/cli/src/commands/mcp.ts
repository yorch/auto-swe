import { setTimeout as delay } from 'node:timers/promises';
import { parseFlags } from '../lib/flags.js';
import { type McpCredentials, withMcpCredentials } from '../lib/mcpCredentials.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const HELP = `auto-swe mcp — OAuth credentials for MCP clients (not the REST API)

  mcp login [--url <base>] [--write]  Print a device approval URL and wait for browser consent
  mcp token [--url <base>]           Print a valid access token to stdout, refreshing if needed
  mcp header [--url <base>]          Print an Authorization JSON object for headersHelper
  mcp logout [--url <base>]          Revoke the refresh token and remove local credentials

Base defaults to AUTO_SWE_API_URL or http://localhost:8080. Login requires the deployment's
mcp.enabled and mcp.deviceFlowEnabled settings; --write also requires mcp.writeToolsEnabled.
Credentials are private to this user in $XDG_CONFIG_HOME/auto-swe/mcp-credentials.json
(default ~/.config). Never share this file or the output of token/header.
`;

type Json = Record<string, unknown>;
interface Metadata {
  issuer: string;
  registration: string;
  device: string;
  token: string;
  revocation: string;
}

function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid MCP OAuth response.');
  }
  return value as Json;
}

function text(row: Json, key: string): string {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    !value ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error('Invalid MCP OAuth response.');
  }
  return value;
}

function seconds(row: Json, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 86_400) {
    throw new Error('Invalid MCP OAuth lifetime or polling interval.');
  }
  return value;
}

function baseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('MCP --url must be an HTTPS gateway origin (HTTP is allowed on loopback).');
  }
  return url.origin;
}

function endpoint(raw: string, base: string): string {
  const url = new URL(raw);
  if (url.origin !== base || url.username || url.password || url.hash) {
    throw new Error('MCP OAuth endpoints must belong to the configured gateway origin.');
  }
  return url.href;
}

async function request(url: string, form?: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...(form
        ? {
            body: new URLSearchParams(form),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            method: 'POST',
          }
        : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('MCP OAuth request failed. Check the deployment URL and connection.');
  }
  let body: Json;
  try {
    const raw = await response.text();
    body = raw ? record(JSON.parse(raw)) : {};
  } catch {
    throw new Error('Invalid MCP OAuth response.');
  }
  return { body, response };
}

function requireSuccess(response: Response, body: Json) {
  if (response.ok && !body.error) {
    return;
  }
  if (body.error === 'invalid_grant') {
    throw new Error('MCP credentials expired or were revoked. Run auto-swe mcp login again.');
  }
  if (body.error === 'access_denied') {
    throw new Error('Device authorization denied. No MCP access was granted.');
  }
  if (body.error === 'expired_token') {
    throw new Error('Device code expired. Run auto-swe mcp login again.');
  }
  if (response.status === 404) {
    throw new Error('MCP device authorization is unavailable. Ask an administrator to enable it.');
  }
  throw new Error('MCP OAuth request was refused. Check client registration and requested access.');
}

async function metadata(base: string): Promise<Metadata> {
  const { body, response } = await request(
    `${base}/.well-known/oauth-authorization-server/api/auth`
  );
  requireSuccess(response, body);
  const issuer = text(body, 'issuer');
  if (issuer !== `${base}/api/auth`) {
    throw new Error('MCP OAuth issuer does not match the configured deployment.');
  }
  return {
    device:
      typeof body.device_authorization_endpoint === 'string'
        ? endpoint(text(body, 'device_authorization_endpoint'), base)
        : '',
    issuer,
    registration: endpoint(text(body, 'registration_endpoint'), base),
    revocation: endpoint(text(body, 'revocation_endpoint'), base),
    token: endpoint(text(body, 'token_endpoint'), base),
  };
}

function applyTokens(entry: McpCredentials, body: Json): McpCredentials {
  if (text(body, 'token_type').toLowerCase() !== 'bearer') {
    throw new Error('Invalid MCP OAuth token type.');
  }
  return {
    ...entry,
    accessToken: text(body, 'access_token'),
    accessTokenExpiresAt: Date.now() + seconds(body, 'expires_in') * 1000,
    refreshToken: text(body, 'refresh_token'),
    scopes: typeof body.scope === 'string' ? text(body, 'scope').split(/\s+/) : entry.scopes,
  };
}

async function login(base: string, write: boolean) {
  const server = await metadata(base);
  if (!server.device) {
    throw new Error('MCP device authorization is unavailable. Ask an administrator to enable it.');
  }
  const resource = `${base}/api/v1/mcp`;
  const scopes = ['mcp:read', ...(write ? ['mcp:write'] : []), 'offline_access'];
  const clientId = await withMcpCredentials(async (entries) => {
    const prior = entries[base];
    if (prior && prior.issuer === server.issuer && prior.resource === resource) {
      return prior.clientId;
    }
    let response: Response;
    try {
      response = await fetch(server.registration, {
        body: JSON.stringify({
          client_name: 'auto-swe CLI',
          grant_types: [DEVICE_GRANT, 'refresh_token'],
          redirect_uris: ['http://127.0.0.1/auto-swe-mcp'],
          response_types: [],
          scope: 'mcp:read mcp:write offline_access',
          token_endpoint_auth_method: 'none',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('MCP client registration failed. Check the deployment connection.');
    }
    let body: Json;
    try {
      body = record(await response.json());
    } catch {
      throw new Error('Invalid MCP registration response.');
    }
    requireSuccess(response, body);
    const id = text(body, 'client_id');
    entries[base] = { clientId: id, issuer: server.issuer, resource, scopes: [] };
    return id;
  });
  const code = await request(server.device, {
    client_id: clientId,
    resource,
    scope: scopes.join(' '),
  });
  requireSuccess(code.response, code.body);
  const deviceCode = text(code.body, 'device_code');
  const userCode = text(code.body, 'user_code');
  const verification = new URL(text(code.body, 'verification_uri_complete'));
  if (
    verification.protocol !== 'https:' &&
    !(
      verification.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(verification.hostname)
    )
  ) {
    throw new Error('Invalid MCP device verification URL.');
  }
  const deadline = Date.now() + seconds(code.body, 'expires_in') * 1000;
  let interval = seconds(code.body, 'interval') * 1000;
  process.stderr.write(
    `Open ${verification.href}\nUser code: ${userCode}\nApprove only the code you started yourself. Waiting for approval…\n`
  );
  while (Date.now() + interval < deadline) {
    await delay(interval);
    const poll = await request(server.token, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
      resource,
    });
    if (poll.body.error === 'authorization_pending') {
      continue;
    }
    if (poll.body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    requireSuccess(poll.response, poll.body);
    const entry = applyTokens({ clientId, issuer: server.issuer, resource, scopes }, poll.body);
    await withMcpCredentials(async (entries) => {
      entries[base] = entry;
    });
    process.stderr.write('MCP login complete. Credentials saved privately.\n');
    return;
  }
  throw new Error('Device code expired. Run auto-swe mcp login again.');
}

async function token(base: string): Promise<string> {
  return withMcpCredentials(async (entries) => {
    let entry = entries[base];
    if (!entry?.refreshToken || !entry.accessToken || !entry.accessTokenExpiresAt) {
      throw new Error('No MCP credentials for this deployment. Run auto-swe mcp login.');
    }
    if (entry.issuer !== `${base}/api/auth` || entry.resource !== `${base}/api/v1/mcp`) {
      throw new Error('MCP credentials do not match this deployment. Log in again.');
    }
    if (entry.accessTokenExpiresAt - Date.now() < 60_000) {
      const server = await metadata(base);
      if (entry.issuer !== server.issuer || entry.resource !== `${base}/api/v1/mcp`) {
        throw new Error('MCP credentials do not match this deployment. Log in again.');
      }
      const refreshed = await request(server.token, {
        client_id: entry.clientId,
        grant_type: 'refresh_token',
        refresh_token: entry.refreshToken,
        resource: entry.resource,
      });
      requireSuccess(refreshed.response, refreshed.body);
      entry = applyTokens(entry, refreshed.body);
      entries[base] = entry;
    }
    return entry.accessToken as string;
  });
}

async function logout(base: string) {
  await withMcpCredentials(async (entries) => {
    const entry = entries[base];
    if (entry?.refreshToken) {
      const server = await metadata(base);
      if (entry.issuer !== server.issuer) {
        throw new Error('MCP credentials do not match this deployment.');
      }
      const revoked = await request(server.revocation, {
        client_id: entry.clientId,
        token: entry.refreshToken,
        token_type_hint: 'refresh_token',
      });
      requireSuccess(revoked.response, revoked.body);
    }
    delete entries[base];
  });
  process.stderr.write('MCP credentials removed.\n');
}

export async function runMcpCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || ['help', '-h', '--help'].includes(sub)) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const { flags, positional } = parseFlags(rest);
    if (
      !['login', 'token', 'header', 'logout'].includes(sub) ||
      positional.length ||
      Object.keys(flags).some((key) => key !== 'url' && !(sub === 'login' && key === 'write')) ||
      flags.url === 'true' ||
      flags.url === '' ||
      (flags.write !== undefined && flags.write !== 'true')
    ) {
      throw new Error(
        'Usage: auto-swe mcp login|token|header|logout [--url <base>] (login: [--write]).'
      );
    }
    const base = baseUrl(flags.url ?? process.env.AUTO_SWE_API_URL ?? 'http://localhost:8080');
    if (sub === 'login') {
      await login(base, flags.write === 'true');
    } else if (sub === 'logout') {
      await logout(base);
    } else {
      const accessToken = await token(base);
      process.stdout.write(
        `${sub === 'header' ? JSON.stringify({ Authorization: `Bearer ${accessToken}` }) : accessToken}\n`
      );
    }
    return 0;
  } catch (error) {
    // All provider errors are reduced to fixed messages before they reach this boundary.
    process.stderr.write(
      `${error instanceof Error ? error.message : 'MCP authentication failed.'}\n`
    );
    return 1;
  }
}
