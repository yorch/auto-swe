import {
  JOIN_REQUEST_STATUSES,
  MAX_JOIN_REQUEST_NOTE_LENGTH,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { FLAG_PRESENT, missingValue, parseFlags } from '../lib/flags.js';
import { clean } from '../lib/format.js';
import { type JoinRequestView, orDash, printRequests } from '../lib/joinRequests.js';

/**
 * `auto-swe orgs` — the organization step of cross-organization join requests (docs/teams.md).
 *
 * A request to a team in another organization is approved by the team's managers first; then an
 * admin of that organization (`org.members.manage`) decides here. Approval creates the
 * organization membership and the team membership together.
 */

const SUB_HELP = `auto-swe orgs — organization membership decisions

  orgs requests <orgId> [--status=S] [--json]
        List join requests waiting for this organization's decision (S is one of
        ${JOIN_REQUEST_STATUSES.join(', ')}, ALL)
  orgs requests approve <orgId> <requestId> [--note=text] [--json]
        Approve the organization step: the requester becomes an organization member and joins
        the team
  orgs requests reject <orgId> <requestId> [--note=text] [--json]
        Reject the organization step
`;

export async function runOrgsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'requests') {
      return await cmdRequests(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: orgs ${sub}\n${SUB_HELP}`);
  return 1;
}

function fail(message: string, usage: string): number {
  process.stderr.write(`${message}\n${usage}`);
  return 1;
}

async function cmdRequests(args: string[], env: CliEnv): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'approve' || action === 'reject') {
    return await cmdDecide(action, rest, env);
  }
  return await cmdList(args, env);
}

async function cmdList(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: orgs requests <orgId> [--status=S] [--json]\n';
  const { positional, flags } = parseFlags(args);
  const unknown = Object.keys(flags).find((f) => f !== 'status' && f !== 'json');
  if (unknown) {
    return fail(`Unknown flag: --${unknown}`, usage);
  }
  const orgId = positional[0];
  if (!orgId || positional.length > 1) {
    return fail('Usage: orgs requests <orgId> [--status=S]', usage);
  }
  if (missingValue(flags, 'status')) {
    return fail('--status needs a value', usage);
  }
  if (
    flags.status !== undefined &&
    !([...JOIN_REQUEST_STATUSES, 'ALL'] as readonly string[]).includes(flags.status)
  ) {
    return fail(`--status must be one of ${JOIN_REQUEST_STATUSES.join(', ')}, ALL`, usage);
  }
  const qs = flags.status ? `?status=${encodeURIComponent(flags.status)}` : '';
  const rows = await apiRequest<JoinRequestView[]>(
    env,
    'GET',
    `/api/v1/platform/organizations/${orgId}/join-requests${qs}`
  );
  if (flags.json === FLAG_PRESENT) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  printRequests(rows, 'org');
  return 0;
}

async function cmdDecide(
  action: 'approve' | 'reject',
  args: string[],
  env: CliEnv
): Promise<number> {
  const usage = `Usage: orgs requests ${action} <orgId> <requestId> [--note=text] [--json]\n`;
  const { positional, flags } = parseFlags(args);
  const unknown = Object.keys(flags).find((f) => f !== 'note' && f !== 'json');
  if (unknown) {
    return fail(`Unknown flag: --${unknown}`, usage);
  }
  const [orgId, requestId] = positional;
  if (!orgId || !requestId || positional.length > 2) {
    return fail(`Usage: orgs requests ${action} <orgId> <requestId>`, usage);
  }
  if (missingValue(flags, 'note')) {
    return fail('--note needs a value', usage);
  }
  if (flags.note !== undefined && flags.note.length > MAX_JOIN_REQUEST_NOTE_LENGTH) {
    return fail(`--note must be at most ${MAX_JOIN_REQUEST_NOTE_LENGTH} characters`, usage);
  }
  const body = flags.note === undefined ? {} : { note: flags.note };
  const decided = await apiRequest<JoinRequestView>(
    env,
    'POST',
    `/api/v1/platform/organizations/${orgId}/join-requests/${requestId}/${action}`,
    body
  );
  if (flags.json === FLAG_PRESENT) {
    process.stdout.write(`${JSON.stringify(decided, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${action === 'approve' ? 'Approved' : 'Rejected'} organization step for ${requestId}: ${clean(orDash(decided.status))}.\n`
  );
  return 0;
}
