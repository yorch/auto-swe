import {
  JOIN_REQUEST_STATUSES,
  MAX_JOIN_REQUEST_MESSAGE_LENGTH,
  MAX_JOIN_REQUEST_NOTE_LENGTH,
} from '@auto-swe/shared/lib/teamJoinRequests';
import { TEAM_ROLES } from '@auto-swe/shared/permissions/roles';
import { apiRequest, apiRequestFull, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { FLAG_PRESENT, missingValue, parseFlags } from '../lib/flags.js';
import { clean, parseOptionalPositiveInt } from '../lib/format.js';
import {
  type JoinRequestView,
  orDash,
  printRequests,
  renderTable,
  withCooldownReason,
} from '../lib/joinRequests.js';

/**
 * `auto-swe teams` — the team directory and join requests (docs/teams.md).
 *
 * Requesting, withdrawing and the requester's own list need only a signed-in user. The reviewer
 * subcommands (`requests pending|approve|reject`) need `team.members.manage` on the team; the
 * gateway decides, and a refusal surfaces as its error code with exit 2.
 */

const SUB_HELP = `auto-swe teams — the team directory and join requests

  teams directory [--query=q] [--org=<id>] [--limit=N] [--cursor=C] [--json]
        List the teams you can see, with your relationship to each (member, requested, none)
  teams directory organizations [--query=q] [--limit=N] [--cursor=C] [--json]
        List the organizations the directory lists a team of, by name (for the --org filter)
  teams request <teamId> [--message=text] [--json]
        Ask to join a team; the team's managers decide. A team in another organization also
        needs that organization's admin to approve.
  teams requests [--json]
        List your own join requests, newest first
  teams requests withdraw <requestId> [--json]
        Withdraw one of your open requests
  teams requests pending <teamId> [--status=S] [--json]
        List a team's requests (team managers). S is one of ${JOIN_REQUEST_STATUSES.join(', ')}, ALL.
  teams requests approve <teamId> <requestId> [--role=ROLE] [--note=text] [--json]
        Approve at the team step. ROLE is ${TEAM_ROLES.join(', ')} (default MEMBER) and may not
        exceed your own role. A cross-organization request then waits for the organization step.
  teams requests reject <teamId> <requestId> [--note=text] [--json]
        Reject at the team step
`;

/** A directory row (`GET /teams/directory`). */
interface DirectoryTeam {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  orgId: string;
  orgName: string;
  memberCount: number;
  relationship: 'MEMBER' | 'REQUESTED' | 'NONE';
  requestId?: string | null;
}

interface DirectoryPage {
  teams: DirectoryTeam[];
  creatableOrgs?: { id: string; name: string }[];
  /** Every organization with a team the caller may see, sorted by name. */
  organizations?: { id: string; name: string }[];
  scope?: string;
  nextCursor?: string | null;
}

export async function runTeamsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'directory') {
      if (rest[0] === 'organizations') {
        return await cmdDirectoryOrganizations(rest.slice(1), env);
      }
      return await cmdDirectory(rest, env);
    }
    if (sub === 'request') {
      return await cmdRequest(rest, env);
    }
    if (sub === 'requests') {
      return await cmdRequests(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: teams ${sub}\n${SUB_HELP}`);
  return 1;
}

/** Returns an error line when `flags` names a flag outside `allowed`, else null. */
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

async function cmdDirectory(args: string[], env: CliEnv): Promise<number> {
  const usage =
    'Usage: teams directory [--query=q] [--org=<id>] [--limit=N] [--cursor=C] [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['query', 'org', 'limit', 'cursor', 'json']);
  if (bad || positional.length > 0) {
    return fail(bad ?? `Unexpected argument: ${positional[0]}`, usage);
  }
  for (const key of ['query', 'org', 'cursor']) {
    if (missingValue(flags, key)) {
      return fail(`--${key} needs a value`, usage);
    }
  }
  const limit = parseOptionalPositiveInt(flags.limit);
  if (limit === 'invalid') {
    return fail('--limit must be a positive integer', usage);
  }
  const params = new URLSearchParams();
  if (flags.query !== undefined) {
    params.set('q', flags.query);
  }
  if (flags.org !== undefined) {
    params.set('orgId', flags.org);
  }
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  if (flags.cursor !== undefined) {
    params.set('cursor', flags.cursor);
  }
  const qs = params.toString();
  const page = await apiRequest<DirectoryPage>(
    env,
    'GET',
    `/api/v1/teams/directory${qs ? `?${qs}` : ''}`
  );
  if (flags.json === FLAG_PRESENT) {
    printJson(page);
    return 0;
  }
  if (page.teams.length === 0) {
    process.stdout.write('No teams match.\n');
  } else {
    process.stdout.write(
      renderTable(
        ['ID', 'TEAM', 'ORGANIZATION', 'MEMBERS', 'YOU'],
        page.teams.map((t) => [
          t.id,
          t.name,
          t.orgName,
          String(t.memberCount),
          t.relationship === 'REQUESTED' && t.requestId
            ? `requested (${t.requestId})`
            : t.relationship.toLowerCase(),
        ])
      )
    );
  }
  if (page.nextCursor) {
    process.stdout.write(`More teams: add --cursor=${clean(page.nextCursor)}\n`);
  }
  return 0;
}

/** `GET /teams/directory/organizations`: the body is `{ organizations, nextCursor }`, unwrapped. */
interface DirectoryOrganizationsPage {
  organizations: { id: string; name: string }[];
  nextCursor: string | null;
}

async function cmdDirectoryOrganizations(args: string[], env: CliEnv): Promise<number> {
  const usage =
    'Usage: teams directory organizations [--query=q] [--limit=N] [--cursor=C] [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['query', 'limit', 'cursor', 'json']);
  if (bad || positional.length > 0) {
    return fail(bad ?? `Unexpected argument: ${positional[0]}`, usage);
  }
  for (const key of ['query', 'cursor']) {
    if (missingValue(flags, key)) {
      return fail(`--${key} needs a value`, usage);
    }
  }
  const limit = parseOptionalPositiveInt(flags.limit);
  if (limit === 'invalid' || (limit !== undefined && limit > 100)) {
    return fail('--limit must be a whole number from 1 to 100', usage);
  }
  const params = new URLSearchParams();
  if (flags.query !== undefined) {
    params.set('q', flags.query);
  }
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  if (flags.cursor !== undefined) {
    params.set('cursor', flags.cursor);
  }
  const qs = params.toString();
  const page = await apiRequestFull<DirectoryOrganizationsPage>(
    env,
    'GET',
    `/api/v1/teams/directory/organizations${qs ? `?${qs}` : ''}`
  );
  if (flags.json === FLAG_PRESENT) {
    printJson(page);
    return 0;
  }
  if (page.organizations.length === 0) {
    process.stdout.write('No organizations match.\n');
  } else {
    process.stdout.write(
      renderTable(
        ['ID', 'NAME'],
        page.organizations.map((o) => [o.id, o.name])
      )
    );
  }
  if (page.nextCursor) {
    process.stdout.write(`More organizations: add --cursor=${clean(page.nextCursor)}\n`);
  }
  return 0;
}

async function cmdRequest(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: teams request <teamId> [--message=text] [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['message', 'json']);
  if (bad) {
    return fail(bad, usage);
  }
  const teamId = positional[0];
  if (!teamId || positional.length > 1) {
    return fail('Usage: teams request <teamId> [--message=text]', usage);
  }
  if (missingValue(flags, 'message')) {
    return fail('--message needs a value', usage);
  }
  const message = flags.message ?? '';
  if (message.length > MAX_JOIN_REQUEST_MESSAGE_LENGTH) {
    return fail(`--message must be at most ${MAX_JOIN_REQUEST_MESSAGE_LENGTH} characters`, usage);
  }
  let created: JoinRequestView;
  try {
    created = await apiRequest<JoinRequestView>(
      env,
      'POST',
      `/api/v1/teams/${teamId}/join-requests`,
      { message }
    );
  } catch (err) {
    throw withCooldownReason(err);
  }
  if (flags.json === FLAG_PRESENT) {
    printJson(created);
    return 0;
  }
  process.stdout.write(
    `Requested to join ${teamId}: request ${created.id} is ${clean(orDash(created.status))}.\n`
  );
  return 0;
}

async function cmdRequests(args: string[], env: CliEnv): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || action.startsWith('-')) {
    return await cmdListOwn(args, env);
  }
  if (action === 'withdraw') {
    return await cmdWithdraw(rest, env);
  }
  if (action === 'pending') {
    return await cmdPending(rest, env);
  }
  if (action === 'approve' || action === 'reject') {
    return await cmdDecide(action, rest, env);
  }
  return fail(
    `Unknown subcommand: teams requests ${action}`,
    'Usage: teams requests [withdraw|pending|approve|reject] ... (see teams help)\n'
  );
}

async function cmdListOwn(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: teams requests [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['json']);
  if (bad || positional.length > 0) {
    return fail(bad ?? `Unexpected argument: ${positional[0]}`, usage);
  }
  const envelope = await apiRequestFull<{
    data?: JoinRequestView[];
    meta?: { truncated?: boolean };
  }>(env, 'GET', '/api/v1/me/join-requests');
  const rows = envelope.data ?? [];
  if (flags.json === FLAG_PRESENT) {
    printJson(rows);
    return 0;
  }
  printRequests(rows, 'own');
  if (envelope.meta?.truncated === true) {
    process.stdout.write('Only the newest requests are listed; older ones are not shown.\n');
  }
  return 0;
}

async function cmdWithdraw(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: teams requests withdraw <requestId> [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['json']);
  if (bad) {
    return fail(bad, usage);
  }
  const requestId = positional[0];
  if (!requestId || positional.length > 1) {
    return fail('Usage: teams requests withdraw <requestId>', usage);
  }
  const updated = await apiRequest<JoinRequestView>(
    env,
    'POST',
    `/api/v1/me/join-requests/${requestId}/withdraw`
  );
  if (flags.json === FLAG_PRESENT) {
    printJson(updated);
    return 0;
  }
  process.stdout.write(`Withdrew request ${requestId}: ${clean(orDash(updated.status))}.\n`);
  return 0;
}

async function cmdPending(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: teams requests pending <teamId> [--status=S] [--json]\n';
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, ['status', 'json']);
  if (bad) {
    return fail(bad, usage);
  }
  const teamId = positional[0];
  if (!teamId || positional.length > 1) {
    return fail('Usage: teams requests pending <teamId> [--status=S]', usage);
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
    `/api/v1/teams/${teamId}/join-requests${qs}`
  );
  if (flags.json === FLAG_PRESENT) {
    printJson(rows);
    return 0;
  }
  printRequests(rows, 'review');
  return 0;
}

async function cmdDecide(
  action: 'approve' | 'reject',
  args: string[],
  env: CliEnv
): Promise<number> {
  const usage =
    action === 'approve'
      ? 'Usage: teams requests approve <teamId> <requestId> [--role=ROLE] [--note=text] [--json]\n'
      : 'Usage: teams requests reject <teamId> <requestId> [--note=text] [--json]\n';
  const allowed = action === 'approve' ? ['role', 'note', 'json'] : ['note', 'json'];
  const { positional, flags } = parseFlags(args);
  const bad = unknownFlag(flags, allowed);
  if (bad) {
    return fail(bad, usage);
  }
  const [teamId, requestId] = positional;
  if (!teamId || !requestId || positional.length > 2) {
    return fail(`Usage: teams requests ${action} <teamId> <requestId>`, usage);
  }
  for (const key of allowed.filter((k) => k !== 'json')) {
    if (missingValue(flags, key)) {
      return fail(`--${key} needs a value`, usage);
    }
  }
  if (flags.note !== undefined && flags.note.length > MAX_JOIN_REQUEST_NOTE_LENGTH) {
    return fail(`--note must be at most ${MAX_JOIN_REQUEST_NOTE_LENGTH} characters`, usage);
  }
  const body: { role?: string; note?: string } = {};
  if (action === 'approve' && flags.role !== undefined) {
    if (!(TEAM_ROLES as readonly string[]).includes(flags.role)) {
      return fail(`--role must be one of ${TEAM_ROLES.join(', ')}`, usage);
    }
    body.role = flags.role;
  }
  if (flags.note !== undefined) {
    body.note = flags.note;
  }
  const decided = await apiRequest<JoinRequestView>(
    env,
    'POST',
    `/api/v1/teams/${teamId}/join-requests/${requestId}/${action}`,
    body
  );
  if (flags.json === FLAG_PRESENT) {
    printJson(decided);
    return 0;
  }
  process.stdout.write(
    `${action === 'approve' ? 'Approved' : 'Rejected'} request ${requestId}: ${clean(orDash(decided.status))}.\n`
  );
  return 0;
}
