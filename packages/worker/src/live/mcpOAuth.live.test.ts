import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * What a Codex client does before a person is asked to sign in, against a real deployment
 * (docs/local-agents.md, "Codex"): read the protected-resource metadata, follow it to the
 * authorization server, register a public client dynamically, and be answered `401` with a
 * pointer to that metadata when it calls the MCP endpoint without a token.
 *
 * The browser sign-in and consent that follow cannot be scripted, so this establishes the
 * discovery and registration half of the flow and stops there. When the `codex` binary is on the
 * path the suite also asks it to list the configured servers, which confirms the client parses a
 * config that points at the deployment. Opt in with `LIVE_MCP_OAUTH=1`; the deployment needs
 * `mcp.enabled` (and `mcp.deviceFlowEnabled` for the device grant).
 */
const gate = liveGate('mcp oauth', 'LIVE_MCP_OAUTH', process.env.LIVE_MCP_OAUTH === '1', [
  'LIVE_E2E_API_URL',
]);

const execFileAsync = promisify(execFile);

async function getJson(url: string): Promise<{ body: Record<string, unknown>; status: number }> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error' });
  const text = await res.text();
  return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, status: res.status };
}

describe.skipIf(!gate.enabled)(
  liveTitle('live MCP OAuth discovery (Codex client path)', gate),
  () => {
    const base = () => liveEnv('LIVE_E2E_API_URL').replace(/\/+$/, '');
    const mcpUrl = () => `${base()}/api/v1/mcp`;

    it('answers an unauthenticated call with 401 and the resource metadata pointer', async () => {
      const res = await fetch(mcpUrl(), {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate') ?? '').toMatch(/resource_metadata=/);
    });

    it('serves protected-resource metadata that names an authorization server', async () => {
      const { body, status } = await getJson(`${base()}/.well-known/oauth-protected-resource`);
      expect(status).toBe(200);
      expect(Array.isArray(body.authorization_servers)).toBe(true);
      expect((body.authorization_servers as string[]).length).toBeGreaterThan(0);
    });

    it('registers a public client at the advertised registration endpoint', async () => {
      const resource = await getJson(`${base()}/.well-known/oauth-protected-resource`);
      const issuer = (resource.body.authorization_servers as string[])[0] as string;
      const issuerUrl = new URL(issuer);
      // RFC 8414 inserts the well-known segment between the host and the issuer's path.
      const metadataUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/+$/, '')}`;
      const meta = await getJson(metadataUrl);
      expect(meta.status).toBe(200);
      const registration = meta.body.registration_endpoint;
      expect(typeof registration).toBe('string');

      const res = await fetch(registration as string, {
        body: JSON.stringify({
          client_name: 'auto-swe live discovery check',
          grant_types: ['authorization_code', 'refresh_token'],
          redirect_uris: ['http://127.0.0.1:8765/callback'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error',
      });
      const text = await res.text();
      expect([200, 201], text.slice(0, 300)).toContain(res.status);
      expect(JSON.parse(text).client_id).toBeTruthy();
    });

    it('runs `codex mcp list` against the configured home, when codex is installed', async (ctx) => {
      let version: string;
      try {
        version = (await execFileAsync('codex', ['--version'])).stdout.trim();
      } catch {
        ctx.skip();
        return;
      }
      expect(version).not.toBe('');
      const { stdout } = await execFileAsync('codex', ['mcp', 'list'], {
        env: { ...process.env, CODEX_HOME: process.env.LIVE_CODEX_HOME ?? process.env.CODEX_HOME },
        timeout: 60_000,
      });
      expect(stdout).toBeTypeOf('string');
    });
  }
);
