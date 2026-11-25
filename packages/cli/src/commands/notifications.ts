import { JOIN_REQUEST_NOTIFICATION_STATUSES } from '@auto-swe/shared/lib/teamJoinRequests';
import { apiRequest, apiRequestFull, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { FLAG_PRESENT, missingValue, parseFlags } from '../lib/flags.js';
import { clean, parseOptionalPositiveInt } from '../lib/format.js';
import { orDash, renderTable } from '../lib/joinRequests.js';

/**
 * `auto-swe notifications` — the join-request notification outbox, for platform admins.
 *
 * Each row is one email or Slack message about a join request. The gateway never returns a
 * recipient address, a message body or a credential, and this command prints only what it returns.
 * A `FAILED` row is re-queued with `retry`; the gateway refuses any other status (409).
 */

const SUB_HELP = `auto-swe notifications — the join-request notification outbox (platform admin)

  notifications list [--status=S] [--limit=N] [--cursor=C] [--json]
        List notifications, newest first. S is one of ${JOIN_REQUEST_NOTIFICATION_STATUSES.join(', ')}
  notifications retry <id> [--json]
        Re-queue a FAILED notification to send now
`;

/** One notification row as the gateway's admin view returns it. */
interface NotificationView {
  id: string;
  status: string;
  attempts: number;
  event: string;
  audience: string;
  channel?: string;
  teamId?: string;
  teamName?: string | null;
  requestId?: string;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt?: string;
  deliveredAt?: string | null;
  updatedAt?: string;
}

export async function runNotificationsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'list') {
      return await cmdList(rest, env);
    }
    if (sub === 'retry') {
      return await cmdRetry(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: notifications ${sub}\n${SUB_HELP}`);
  return 1;
}

function unknownFlag(flags: Record<string, string>, allowed: readonly string[]): string | null {
  const unknown = Object.keys(flags).find((f) => !allowed.includes(f));
  return unknown ? `Unknown flag: --${unknown}` : null;
}

function fail(message: string, usage: string): number {
  process.stderr.write(`${message}\n${usage}`);
  return 1;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function cmdList(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: notifications list [--status=S] [--limit=N] [--cursor=C] [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['status', 'limit', 'cursor', 'json']);
  if (bad || positional.length > 0) {
    return fail(bad ?? `Unexpected argument: ${positional[0]}`, usage);
  }
  for (const key of ['status', 'cursor']) {
    if (missingValue(flags, key)) {
      return fail(`--${key} needs a value`, usage);
    }
  }
  if (
    flags.status !== undefined &&
    !(JOIN_REQUEST_NOTIFICATION_STATUSES as readonly string[]).includes(flags.status)
  ) {
    return fail(`--status must be one of ${JOIN_REQUEST_NOTIFICATION_STATUSES.join(', ')}`, usage);
  }
  const limit = parseOptionalPositiveInt(flags.limit);
  if (limit === 'invalid' || (limit !== undefined && limit > 100)) {
    return fail('--limit must be a whole number from 1 to 100', usage);
  }
  const params = new URLSearchParams();
  if (flags.status !== undefined) {
    params.set('status', flags.status);
  }
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  if (flags.cursor !== undefined) {
    params.set('cursor', flags.cursor);
  }
  const qs = params.toString();
  const envelope = await apiRequestFull<{
    data?: NotificationView[];
    meta?: { nextCursor?: string | null };
  }>(env, 'GET', `/api/v1/platform/join-request-notifications${qs ? `?${qs}` : ''}`);
  if (flags.json === FLAG_PRESENT) {
    printJson(envelope);
    return 0;
  }
  const rows = envelope.data ?? [];
  if (rows.length === 0) {
    process.stdout.write('No notifications match.\n');
  } else {
    process.stdout.write(
      renderTable(
        ['ID', 'STATUS', 'ATTEMPTS', 'EVENT', 'AUDIENCE', 'TEAM', 'NEXT ATTEMPT', 'ERROR'],
        rows.map((n) => [
          n.id,
          n.status,
          String(n.attempts),
          n.event,
          n.audience,
          orDash(n.teamName),
          orDash(n.nextAttemptAt),
          orDash(n.lastError),
        ])
      )
    );
  }
  const nextCursor = envelope.meta?.nextCursor;
  if (nextCursor) {
    process.stdout.write(`More notifications: add --cursor=${clean(nextCursor)}\n`);
  }
  return 0;
}

async function cmdRetry(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: notifications retry <id> [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['json']);
  if (bad) {
    return fail(bad, usage);
  }
  const id = positional[0];
  if (!id || positional.length > 1) {
    return fail('Usage: notifications retry <id>', usage);
  }
  const requeued = await apiRequest<NotificationView>(
    env,
    'POST',
    `/api/v1/platform/join-request-notifications/${id}/retry`
  );
  if (flags.json === FLAG_PRESENT) {
    printJson(requeued);
    return 0;
  }
  process.stdout.write(`Re-queued notification ${clean(id)}: ${clean(orDash(requeued.status))}.\n`);
  return 0;
}
