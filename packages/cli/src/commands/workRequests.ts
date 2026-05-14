import type { RepositorySummary, TeamSummary } from '@auto-swe/shared/types/api';
import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';

const SUB_HELP = `auto-swe run — submit a work request

  run --ticket=<id> --description=<text> --repo=<org/name> [--workflow=<template-name>]

  FLAGS
    --ticket=<id>           External ticket ID (e.g. JIRA-123, GH-42)
    --description=<text>    What the agent should implement
    --repo=<org/name>       Target repository in "org/name" format
    --workflow=<name>       Workflow template name (uses team default when omitted)
    --budget=STANDARD|LARGE|EPIC
                            Budget tier for the run (default: STANDARD)
`;

interface WorkRequestResponse {
  id: string;
  externalTicketId: string;
  description: string;
  status: string;
}

interface ParsedRunFlags {
  ticket: string | undefined;
  description: string | undefined;
  repo: string | undefined;
  workflow: string | undefined;
  budget: string | undefined;
}

function parseRunFlags(args: string[]): ParsedRunFlags {
  const flags: ParsedRunFlags = {
    budget: undefined,
    description: undefined,
    repo: undefined,
    ticket: undefined,
    workflow: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eqIdx = arg.indexOf('=');
    const key = eqIdx !== -1 ? arg.slice(2, eqIdx) : arg.slice(2);
    const val = eqIdx !== -1 ? arg.slice(eqIdx + 1) : (args[i + 1] ?? '');
    if (eqIdx === -1 && !arg.startsWith('--')) continue;
    if (key === 'ticket') {
      flags.ticket = val;
      if (eqIdx === -1) i++;
    } else if (key === 'description') {
      flags.description = val;
      if (eqIdx === -1) i++;
    } else if (key === 'repo') {
      flags.repo = val;
      if (eqIdx === -1) i++;
    } else if (key === 'workflow') {
      flags.workflow = val;
      if (eqIdx === -1) i++;
    } else if (key === 'budget') {
      flags.budget = val;
      if (eqIdx === -1) i++;
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

  if (!flags.ticket) {
    process.stderr.write('Missing required flag: --ticket=<id>\n');
    return 1;
  }
  if (!flags.description) {
    process.stderr.write('Missing required flag: --description=<text>\n');
    return 1;
  }
  if (!flags.repo) {
    process.stderr.write('Missing required flag: --repo=<org/name>\n');
    return 1;
  }

  const [org, repoName] = flags.repo.split('/');
  if (!org || !repoName) {
    process.stderr.write('--repo must be in "org/name" format (e.g. acme/payments-api)\n');
    return 1;
  }

  const validBudgets = ['STANDARD', 'LARGE', 'EPIC'];
  const budget = flags.budget?.toUpperCase() ?? 'STANDARD';
  if (!validBudgets.includes(budget)) {
    process.stderr.write(`--budget must be one of: ${validBudgets.join(', ')}\n`);
    return 1;
  }

  // Resolve the repo ID
  const repos = await apiRequest<RepositorySummary[]>(env, 'GET', '/api/v1/repositories');
  const repo = repos.find(
    (r) =>
      r.organizationName.toLowerCase() === org.toLowerCase() &&
      r.repoName.toLowerCase() === repoName.toLowerCase()
  );
  if (!repo) {
    process.stderr.write(
      `Repository "${flags.repo}" not found. Use "auto-swe workflows list" to see configured repos.\n`
    );
    return 1;
  }

  // Optionally resolve a specific workflow template ID
  let templateId: string | undefined;
  if (flags.workflow) {
    const templates = await apiRequest<Array<{ id: string; name: string }>>(
      env,
      'GET',
      '/api/v1/workflow-templates'
    );
    const tpl = templates.find((t) => t.name.toLowerCase() === flags.workflow?.toLowerCase());
    if (!tpl) {
      process.stderr.write(`Workflow template "${flags.workflow}" not found.\n`);
      return 1;
    }
    templateId = tpl.id;
  }

  // Resolve the team from the repo so the gateway can pick the right default template
  const teams = await apiRequest<TeamSummary[]>(env, 'GET', '/api/v1/teams');
  // The gateway resolves the team from the repo; we just need the repo ID.
  // Extra team resolution is only needed if the user passes --team (not yet).
  void teams; // reserved for future --team flag

  const body: Record<string, unknown> = {
    budgetTier: budget,
    description: flags.description,
    externalTicketId: flags.ticket,
    repoIds: [repo.id],
  };
  if (templateId) body.templateId = templateId;

  const result = await apiRequest<WorkRequestResponse>(env, 'POST', '/api/v1/work-requests', body);

  process.stdout.write(`Work request submitted.\n`);
  process.stdout.write(`  ID:     ${result.id}\n`);
  process.stdout.write(`  Ticket: ${result.externalTicketId}\n`);
  process.stdout.write(`  Status: ${result.status}\n`);
  process.stdout.write(
    `\nMonitor progress:\n  auto-swe runs list --limit=5\n  auto-swe runs tail <runId>\n`
  );
  return 0;
}
