#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runAgentCommand } from './commands/agent.js';
import { runBundleCommand } from './commands/bundle.js';
import { runBundlesCommand } from './commands/bundles.js';
import { runConnectionsCommand } from './commands/connections.js';
import { runEvalsCommand } from './commands/evals.js';
import { runMcpCommand } from './commands/mcp.js';
import { runNotificationsCommand } from './commands/notifications.js';
import { runOrchestrateCommand } from './commands/orchestrate.js';
import { runOrgsCommand } from './commands/orgs.js';
import { hasDescribeFlag, runDescribeAlias, runPlanCommand } from './commands/plan.js';
import { runPrPolicyCommand } from './commands/prPolicy.js';
import { runReposCommand, runReposSetupInit } from './commands/repos.js';
import { runRunsCommand } from './commands/runs.js';
import { runSkillsCommand } from './commands/skills.js';
import { runTeamsCommand } from './commands/teams.js';
import { runTokensCommand } from './commands/tokens.js';
import { runTranscriptsCommand } from './commands/transcripts.js';
import { runWorkflowsCommand } from './commands/workflows.js';
import { runWorkRequestsCommand } from './commands/workRequests.js';
import { type CliEnv, loadCliEnv } from './lib/env.js';

const HELP = `auto-swe — CLI for the auto-swe agentic SWE platform

USAGE
  auto-swe <command> [subcommand] [args]

COMMANDS
  mcp login [--url <base>] [--write]  Authorize this headless client in a browser (no PAT needed)
  mcp token|header [--url <base>]     Print an MCP token or Authorization JSON; refresh when needed
  mcp logout [--url <base>]          Revoke the refresh token and remove saved MCP credentials

  run --ticket=<id> [--description=<text>] (--repo=<org/name>|--repo-id=<uuid>) [--budget=<tier>]
                                       Submit a work request and start a run on the default template;
                                       --description is optional when the ticket can be read from the
                                       issue tracker (the server builds the brief from it)

  agent run <key[@version]> "<prompt>" --repo=<org/name> [--deliver=none|branch|draft_pr]
            [--base=<branch>] [--max-steps=N] [--timeout=SECONDS] [--wait]
                                       Run a library agent on a repository in a throwaway workspace;
                                       --deliver=branch|draft_pr publishes it after the platform's checks
  agent rerun <workRequestId> [--wait] Run an earlier agent run again as a new run

  orchestrate start "<task>" --agent=<key> [--repo=<org/name> | --team=<slug>] [--wait]
                                       Start a conversation that starts and steers agent runs
  orchestrate list|show|messages|say|steer|cancel-agent|cancel|end
                                       Follow and steer an orchestration (see orchestrate help)
  orchestrate attach|decline|approve|deny
                                       Human decisions: the launcher attaches a repository or
                                       decides an MCP write
  plan route "<goal>" --repo=<org/name>
                                       Rank the templates you may launch for a goal
  plan create "<goal>" --repo=<org/name> [--agent=<key>] [--wait] [--timeout=SECONDS]
                                       Generate a plan for a goal (exit 2 with the error code if
                                       generation fails); nothing runs until it is approved
  plan wait <jobId>                    Poll a generation job to its plan id
  plan show <planId> [--json]          Print the plan outline (the spec only with --json)
  plan list [--status=S] [--limit=N]   List your plans
  plan approve <planId> [--budget-tier=T] [--idempotency-key=KEY] [--yes]
                                       Approve the stored plan and start its run; asks first on
                                       a terminal, refuses non-interactively without --yes; the
                                       key makes a retried approval find its run
  plan reject <planId>                 Reject a pending plan
  plan save <planId> [--name=NAME]     Save the plan as a DRAFT workflow template in its team
                                       (team lead); another person must review the draft
  plan run "<goal>" --repo=<org/name> [--agent=<key>] [--idempotency-key=KEY] --yes
                                       Create, wait, show and approve in one step (without --yes
                                       it stops after printing the plan)
  run --describe "<goal>" --repo=<org/name> [--agent=<key>] --yes
                                       The same as plan run

  workflows list                       List workflow templates visible to you
  workflows show <name> [--version=N]  Print one template's active (or given) spec (JSON)
  workflows export <name> [-o <path>]  Write the active spec to a file (or stdout)
  workflows import <path> [--name=N] [--team=<slug>]
                                       Create a template (or new version if --name matches an existing template)
  workflows run <name> --payload=<json> [--label=<text>]
                                       Start a run with a generic JSON payload
  workflows generate "<description>" [--name=N] [--team=<slug>]
                                       Generate a DRAFT template from plain language (AI)
  workflows explain <name>             Explain a template's active version in plain language (AI)
                                       show / export / import / run / explain take --team=<slug> or
                                       --global: names are unique per team, and a name found in more
                                       than one scope is an error until one is picked

  repos gate-commands <org/name> [--lint=CMD] [--typecheck=CMD] [--tests=CMD] [--build=CMD]
        [--vuln-scan=CMD] [--perf-bench=CMD] [--clear]
                                       Print a repository's gate commands, or set them (an empty
                                       value removes one); setting needs team admin
  repos setup init [dir] [--force]     Write a starter .auto-swe/setup.yml into a local checkout
                                       from its detected stack (local, no token)
  repos test-access <org/name> [--json]
                                       Check what a run on the repository could do with its
                                       credentials (exit 1 on a failing step); needs team lead

  connections test [--ticket=<id>] [--json]
                                       Check every configured connection (GitHub, Slack, tracker,
                                       registries, model keys, …); exit 1 if any fails; needs admin

  runs list [--status=S] [--template-id=ID] [--work-request-id=ID] [--limit=N]
                                       List recent workflow runs
  runs show <runId>                    Print one run (with steps) as JSON
  runs tail <runId> [--interval=SEC] [--max=N]
  transcripts list <runId> / get <id> / export --from --to   Agent transcript inspection and export
                                       Poll until terminal status (exit 2 if the run did not succeed)

  teams directory [--query=q] [--org=<id>] [--limit=N]
                                       List the teams you can see and your relationship to each
  teams directory organizations [--query=q] [--limit=N] [--cursor=C]
                                       List the organizations the directory lists a team of
  teams request <teamId> [--message=text]
                                       Ask to join a team
  teams requests [withdraw <requestId>]
                                       List your join requests, or withdraw one
  teams requests pending <teamId> [--status=S]
                                       List a team's join requests (team managers)
  teams requests approve|reject <teamId> <requestId> [--role=ROLE] [--note=text]
                                       Decide a join request at the team step
  orgs requests <orgId> [--status=S]   List join requests awaiting an organization's decision
  orgs requests approve|reject <orgId> <requestId> [--note=text]
                                       Decide the organization step of a cross-organization request
  orgs deactivate|reactivate <orgId>   Deactivate or reactivate an organization (platform admin)

  notifications list [--status=S] [--limit=N] [--cursor=C]
                                       List join-request notifications (platform admin); S is
                                       PENDING, DELIVERED, SKIPPED or FAILED
  notifications retry <id>             Re-queue a FAILED notification to send now

  tokens list                          List your personal access tokens
  tokens create <name> [--expires-in-days=N]
                                       Issue a personal access token (printed once)
  tokens revoke <id>                   Revoke a token

  bundle init [dir] [--name=N] [--version=V]
                                       Scaffold a bundle authoring project (local, no token)
  bundle validate <path>               Validate a bundle manifest (schema + content hash)
  bundle sign <path> --key=<pem>       Attach a detached ed25519 signature
  bundles list                         List installed bundles (admin token)
  bundles export <name> <version> [--origin=TAG] [-o <path>]
                                       Export GLOBAL content to a bundle file
  bundles install <path> [--overwrite-protected] [--acknowledge-warnings]
                                       Install a bundle from a file; a bundle agent that would
                                       replace a built-in or admin-authored one is refused unless
                                       --overwrite-protected is passed; plugin warnings need
                                       --acknowledge-warnings
  bundles install-from-url <url> [--overwrite-protected] [--acknowledge-warnings]
                                       Install a bundle from a URL

  pr-policy init [--dir <path>] [--force]
                                       Write .auto-swe/pr-policy.yml (local, no token); pre-fills
                                       sensitivePaths from the sensitive directories present
  pr-policy validate [file]            Validate a PR policy file (local, no token)
  pr-policy status <repoId>            Show a repository's PR evaluation mode, last evaluation
                                       and auto-merge evidence
  pr-policy mode <repoId> <off|advisory|enforce|auto|inherit>
                                       Set a repository's PR evaluation mode

  skills sources list                  List tracked external skill sources (admin token)
  skills sources add <owner/repo> --ref=<branch|tag> [--host=H] [--path=DIR]
            [--script-mode=text-only|reject] [--skills=a,b] [--yes]
                                       Preview a GitHub repository's skills, then import them
                                       (unverified, pinned to the previewed commit)

  evals list                           List eval datasets (admin token)
  evals show <id>                      Print a dataset's cases
  evals results [--source=…] [--run=…] Query captured eval signals
  evals run <slug> --candidate=<ref> --against=<ref>
                                       Run the regression gate (exit 1 on a regression,
                                       2 when the eval run fails without a verdict)

  help                                 Show this message

ENVIRONMENT
  AUTO_SWE_API_URL   Base URL of the gateway (default: http://localhost:8080)
  AUTO_SWE_TOKEN     Bearer token: an \`ats_*\` personal access token or a JWT
                     Mint one at Settings → API tokens in the dashboard

EXIT CODES
  0  success
  1  user error (missing arg, no token, etc.) — or, for evals run, a regression
  2  remote error (HTTP non-2xx from the gateway) — or, for runs tail, a run that
     ended in a non-success status; for evals run, an eval run that failed
     without reaching a verdict
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }
  // `bundle` (singular) is local authoring — no gateway, no token. Dispatch it
  // before resolving credentials so it works offline.
  if (cmd === 'bundle') {
    return await runBundleCommand(rest);
  }
  if (cmd === 'mcp') {
    return await runMcpCommand(rest);
  }
  // `pr-policy` init/validate are local too; status/mode load credentials themselves.
  if (cmd === 'pr-policy') {
    return await runPrPolicyCommand(rest, loadCliEnv);
  }
  // `repos setup init` writes a file into a local checkout and needs no gateway.
  if (cmd === 'repos' && rest[0] === 'setup' && rest[1] === 'init') {
    return await runReposSetupInit(rest.slice(2));
  }
  let env: CliEnv;
  try {
    env = await loadCliEnv();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (cmd === 'run') {
    // `run --describe "<goal>"` is `plan run`; without it `run` submits a ticket as before.
    if (hasDescribeFlag(rest)) {
      return await runDescribeAlias(rest, env);
    }
    return await runWorkRequestsCommand(rest, env);
  }
  if (cmd === 'agent') {
    return await runAgentCommand(rest, env);
  }
  if (cmd === 'orchestrate') {
    return await runOrchestrateCommand(rest, env);
  }
  if (cmd === 'plan') {
    return await runPlanCommand(rest, env);
  }
  if (cmd === 'workflows') {
    return await runWorkflowsCommand(rest, env);
  }
  if (cmd === 'runs') {
    return await runRunsCommand(rest, env);
  }
  if (cmd === 'transcripts') {
    return await runTranscriptsCommand(rest, env);
  }
  if (cmd === 'tokens') {
    return await runTokensCommand(rest, env);
  }
  if (cmd === 'bundles') {
    return await runBundlesCommand(rest, env);
  }
  if (cmd === 'skills') {
    return await runSkillsCommand(rest, env);
  }
  if (cmd === 'evals') {
    return await runEvalsCommand(rest, env);
  }
  if (cmd === 'repos') {
    return await runReposCommand(rest, env);
  }
  if (cmd === 'connections') {
    return await runConnectionsCommand(rest, env);
  }
  if (cmd === 'teams') {
    return await runTeamsCommand(rest, env);
  }
  if (cmd === 'orgs') {
    return await runOrgsCommand(rest, env);
  }
  if (cmd === 'notifications') {
    return await runNotificationsCommand(rest, env);
  }
  process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
  return 1;
}

// Hoisted for testability: tests import `main` directly. The CLI entry point
// only runs `main(process.argv.slice(2))` when invoked as a script.
export { main };

/**
 * True when this module is the script Node was asked to run (as opposed to
 * being imported by a test). `import.meta.url` is the *resolved* path of this
 * file, while `process.argv[1]` is whatever the user typed — the
 * `node_modules/.bin/auto-swe` symlink, a relative path, or a path with spaces
 * — so compare after realpath + URL encoding, or the CLI silently does nothing
 * when installed as a bin.
 */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    }
  );
}
