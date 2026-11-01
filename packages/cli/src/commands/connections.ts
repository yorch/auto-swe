import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { FLAG_PRESENT, missingValue, parseFlags } from '../lib/flags.js';
import { pad } from '../lib/format.js';

/**
 * `auto-swe connections` — check that the platform's stored connections work.
 *
 * `test` asks the gateway to run every configured connection's own check (the same ones the
 * dashboard's "Test connection" buttons run) and prints one line each. It exits 1 when any
 * connection fails, so a deploy step or a cron job can gate on it; exit 2 stays for the gateway
 * refusing the request (the caller must be a platform admin).
 */

const SUB_HELP = `auto-swe connections — check that stored connections work

  connections test [--ticket=<id>] [--json]
        Check every configured connection: GitHub, Slack, the issue tracker, the knowledge base,
        Figma, per-host GitHub credentials, the approver App, package registries and
        model-provider keys. One line each: failing first, then working, then skipped (not
        configured). Exits 1 when any connection fails. The issue tracker is only checked when
        --ticket names a real ticket to fetch. --json prints the gateway's answer as is.
        Needs a platform admin token. A repository's access is checked with
        \`repos test-access <org/name>\`.
`;

interface HealthEntry {
  id: string;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
}

const ORDER = { failed: 0, ok: 1, skipped: 2 } as const;

export async function runConnectionsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'test') {
      return await cmdTest(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: connections ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdTest(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const unknown = Object.keys(flags).find((f) => f !== 'ticket' && f !== 'json');
  if (unknown || positional.length > 0) {
    process.stderr.write(
      `${unknown ? `Unknown flag: --${unknown}` : `Unexpected argument: ${positional[0]}`}\n${SUB_HELP}`
    );
    return 1;
  }
  if (missingValue(flags, 'ticket')) {
    process.stderr.write(`--ticket needs a ticket id\n`);
    return 1;
  }
  const entries = await apiRequest<HealthEntry[]>(
    env,
    'POST',
    '/api/v1/platform/connections/test',
    flags.ticket ? { trackerTicketId: flags.ticket } : {}
  );
  const failing = entries.filter((e) => e.status === 'failed').length;
  if (flags.json === FLAG_PRESENT) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return failing > 0 ? 1 : 0;
  }
  const sorted = [...entries].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const width = Math.max(0, ...sorted.map((e) => e.label.length)) + 2;
  for (const e of sorted) {
    process.stdout.write(`${pad(e.status, 9)}${pad(e.label, width)}${e.detail}\n`);
  }
  const working = entries.filter((e) => e.status === 'ok').length;
  process.stdout.write(
    failing > 0
      ? `\n${failing} of ${failing + working} configured connections failing.\n`
      : `\n${working === 0 ? 'Nothing is configured to test yet.' : `All ${working} configured connections work.`}\n`
  );
  return failing > 0 ? 1 : 0;
}
