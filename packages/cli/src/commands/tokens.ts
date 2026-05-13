import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { parseFlags } from './workflows.js';

/**
 * `auto-swe tokens` — issue / list / revoke personal access tokens.
 *
 * Issuing emits the plaintext token on stdout exactly once; subsequent calls
 * can only see the prefix. The CLI prints to stdout (not stderr) so a CI
 * pipeline can capture it via `auto-swe tokens create ... > token.txt`.
 */

const SUB_HELP = `auto-swe tokens — manage personal access tokens

  tokens list                                 List your tokens
  tokens create <name> [--expires-in-days=N]  Issue a token (plaintext printed once)
  tokens revoke <id>                          Revoke a token
`;

interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface IssuedToken extends TokenSummary {
  token: string;
}

export async function runTokensCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  try {
    if (sub === 'list') return await cmdList(env);
    if (sub === 'create') return await cmdCreate(rest, env);
    if (sub === 'revoke') return await cmdRevoke(rest, env);
  } catch (err) {
    if (err instanceof GatewayError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write(`Unknown subcommand: tokens ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdList(env: CliEnv): Promise<number> {
  const rows = await apiRequest<TokenSummary[]>(env, 'GET', '/api/v1/auth/tokens');
  if (rows.length === 0) {
    process.stdout.write('No tokens.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('ID', 38) + pad('NAME', 22) + pad('PREFIX', 16) + pad('LAST USED', 26)}STATUS\n`
  );
  for (const r of rows) {
    const status = r.revokedAt ? 'revoked' : isExpired(r.expiresAt) ? 'expired' : 'active';
    process.stdout.write(
      pad(r.id, 38) +
        pad(r.name, 22) +
        pad(r.prefix, 16) +
        pad(r.lastUsedAt ?? '-', 26) +
        `${status}\n`
    );
  }
  return 0;
}

async function cmdCreate(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    process.stderr.write('Usage: tokens create <name> [--expires-in-days=N]\n');
    return 1;
  }
  let expiresInDays: number | undefined;
  if (flags['expires-in-days']) {
    const raw = flags['expires-in-days'];
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || String(n) !== raw.trim()) {
      process.stderr.write('--expires-in-days must be a positive integer\n');
      return 1;
    }
    expiresInDays = n;
  }
  const body: { name: string; expiresInDays?: number } = { name };
  if (expiresInDays !== undefined) body.expiresInDays = expiresInDays;
  const issued = await apiRequest<IssuedToken>(env, 'POST', '/api/v1/auth/tokens', body);
  process.stdout.write(`${issued.token}\n`);
  process.stderr.write(
    `Created token "${issued.name}" (id ${issued.id}, prefix ${issued.prefix}).\n` +
      `This plaintext will NOT appear again — capture it now.\n`
  );
  return 0;
}

async function cmdRevoke(args: string[], env: CliEnv): Promise<number> {
  const { positional } = parseFlags(args);
  const id = positional[0];
  if (!id) {
    process.stderr.write('Usage: tokens revoke <id>\n');
    return 1;
  }
  await apiRequest<{ id: string; revokedAt: string }>(env, 'DELETE', `/api/v1/auth/tokens/${id}`);
  process.stdout.write(`Revoked ${id}\n`);
  return 0;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, w - 1)} `;
  return s + ' '.repeat(w - s.length);
}
