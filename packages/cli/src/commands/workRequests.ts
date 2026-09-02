import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';

const SUB_HELP = `auto-swe run — submit a work request

  run --ticket=<id> --description=<text> (--repo=<org/name>|--repo-id=<uuid>) [--budget=<tier>]

  FLAGS
    --ticket=<id>           External ticket ID (e.g. JIRA-123, GH-42)
    --repo=<org/name>       Target repository in "org/name" format
    --repo-id=<uuid>        Target repository UUID (bypasses name-resolution lookup)
    --description=<text>    What the agent should implement
    --budget=STANDARD|LARGE|EPIC
                            Budget tier for the run (default: STANDARD)

  The run uses the repository's team default template (or the global default).
  To start a specific template with an arbitrary payload, use \`workflows run\`.
`;

/** Shape returned by POST /api/v1/work-requests (201). */
interface WorkRequestResponse {
  workRequestId: string;
  workflowIds: string[];
}

interface ParsedRunFlags {
  ticket: string | undefined;
  description: string | undefined;
  repo: string | undefined;
  repoId: string | undefined;
  budget: string | undefined;
  /** Set when the removed `--workflow` flag is passed, so we can say why it is rejected. */
  workflow: string | undefined;
}

function parseRunFlags(args: string[]): ParsedRunFlags {
  const flags: ParsedRunFlags = {
    budget: undefined,
    description: undefined,
    repo: undefined,
    repoId: undefined,
    ticket: undefined,
    workflow: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eqIdx = arg.indexOf('=');
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
    const val = eqIdx !== -1 ? arg.slice(eqIdx + 1) : (args[i + 1] ?? '');
    if (eqIdx === -1 && !arg.startsWith('--')) {
      continue;
    }
    if (key === 'ticket') {
      flags.ticket = val;
      if (eqIdx === -1) {
        i++;
      }
    } else if (key === 'description') {
      flags.description = val;
      if (eqIdx === -1) {
        i++;
      }
    } else if (key === 'repo') {
      flags.repo = val;
      if (eqIdx === -1) {
        i++;
      }
    } else if (key === 'repo-id') {
      flags.repoId = val;
      if (eqIdx === -1) {
        i++;
      }
    } else if (key === 'workflow') {
      flags.workflow = val;
      if (eqIdx === -1) {
        i++;
      }
    } else if (key === 'budget') {
      flags.budget = val;
      if (eqIdx === -1) {
        i++;
      }
    }
  }
  return flags;
}

export async function runWorkRequestsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  // Top-level `auto-swe run` treats all args as flags (no sub-subcommand).
  const allArgs = [sub, ...rest];
  try {
    return await cmdRun(allArgs, env);
  } catch (err) {
    if (err instanceof GatewayError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function cmdRun(args: string[], env: CliEnv): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(SUB_HELP);
    return 0;
  }

  const flags = parseRunFlags(args);

  if (flags.workflow !== undefined) {
    // The work-request endpoint has no template field — it always runs the
    // repository's team default. Refuse loudly rather than silently ignoring
    // the flag; `workflows run` is the path for a specific template.
    process.stderr.write(
      '--workflow is not supported: a work request always runs the team/global default template. Use `workflows run <name>` to start a specific template.\n'
    );
    return 1;
  }
  if (!flags.ticket) {
    process.stderr.write('Missing required flag: --ticket=<id>\n');
    return 1;
  }
  if (!flags.description) {
    process.stderr.write('Missing required flag: --description=<text>\n');
    return 1;
  }
  if (!flags.repo && !flags.repoId) {
    process.stderr.write('Missing required flag: --repo=<org/name> or --repo-id=<uuid>\n');
    return 1;
  }
  if (flags.repo && flags.repoId) {
    process.stderr.write('--repo and --repo-id are mutually exclusive; provide only one.\n');
    return 1;
  }

  const validBudgets = ['STANDARD', 'LARGE', 'EPIC'];
  const budget = flags.budget?.toUpperCase() ?? 'STANDARD';
  if (!validBudgets.includes(budget)) {
    process.stderr.write(`--budget must be one of: ${validBudgets.join(', ')}\n`);
    return 1;
  }

  // Resolve the repo ID — skip the lookup when --repo-id is already a UUID.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let resolvedRepoId: string;
  if (flags.repoId) {
    if (!UUID_RE.test(flags.repoId)) {
      process.stderr.write(
        '--repo-id must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)\n'
      );
      return 1;
    }
    resolvedRepoId = flags.repoId;
  } else {
    const [org, repoName] = (flags.repo as string).split('/');
    if (!org || !repoName) {
      process.stderr.write('--repo must be in "org/name" format (e.g. acme/payments-api)\n');
      return 1;
    }
    const repos = await apiRequest<RepositorySummary[]>(env, 'GET', '/api/v1/repositories');
    const repo = repos.find(
      (r) =>
        (r.organizationName ?? '').toLowerCase() === org.toLowerCase() &&
        (r.repoName ?? '').toLowerCase() === repoName.toLowerCase()
    );
    if (!repo) {
      process.stderr.write(
        `Repository "${flags.repo}" not found. Check the /repositories page in the web UI for configured repos.\n`
      );
      return 1;
    }
    resolvedRepoId = repo.id;
  }

  const body: Record<string, unknown> = {
    budgetTier: budget,
    description: flags.description,
    externalTicketId: flags.ticket,
    repoIds: [resolvedRepoId],
  };
  const result = await apiRequest<WorkRequestResponse>(env, 'POST', '/api/v1/work-requests', body);

  process.stdout.write(`Work request submitted.\n`);
  process.stdout.write(`  Work request: ${result.workRequestId}\n`);
  process.stdout.write(`  Workflow:     ${result.workflowIds.join(', ')}\n`);
  process.stdout.write(`  Ticket:       ${flags.ticket}\n`);
  process.stdout.write(
    `\nMonitor progress:\n  auto-swe runs list --limit=5\n  auto-swe runs tail <runId>\n`
  );
  return 0;
}
