#!/usr/bin/env node
import { runBundleCommand } from './commands/bundle.js';
import { runBundlesCommand } from './commands/bundles.js';
import { runRunsCommand } from './commands/runs.js';
import { runTokensCommand } from './commands/tokens.js';
import { runWorkflowsCommand } from './commands/workflows.js';
import { runWorkRequestsCommand } from './commands/workRequests.js';
import { type CliEnv, loadCliEnv } from './lib/env.js';

const HELP = `auto-swe — CLI for the auto-swe agentic SWE platform

USAGE
  auto-swe <command> [subcommand] [args]

COMMANDS
  run --ticket=<id> --description=<text> (--repo=<org/name>|--repo-id=<uuid>) [--workflow=<name>]
                                       Submit a work request and start a run

  workflows list                       List workflow templates visible to you
  workflows show <name>                Print one template's active spec (JSON)
  workflows export <name> [-o <path>]  Write the active spec to a file (or stdout)
  workflows import <path> [--name=N] [--team=<slug>]
                                       Create a template (or new version if --name matches an existing template)

  runs list [--status=S] [--template-id=ID] [--limit=N]
                                       List recent workflow runs
  runs show <runId>                    Print one run (with steps) as JSON
  runs tail <runId> [--interval=SEC]   Poll until terminal status

  tokens list                          List your personal access tokens
  tokens create <name>                 Issue a long-lived API token (printed once)
  tokens revoke <id>                   Revoke a token

  bundle init [dir]                    Scaffold a bundle authoring project (local, no token)
  bundle validate <path>               Validate a bundle manifest (schema + content hash)
  bundle sign <path> --key=<pem>       Attach a detached ed25519 signature
  bundles list                         List installed bundles (admin token)
  bundles export <name> <version>      Export GLOBAL content to a bundle file
  bundles install <path>               Install a bundle from a file
  bundles install-from-url <url>       Install a bundle from a URL

  help                                 Show this message

ENVIRONMENT
  AUTO_SWE_API_URL   Base URL of the gateway (default: http://localhost:8080)
  AUTO_SWE_TOKEN     Bearer token: JWT or phase-8 \`ats_*\` personal access token
                     Mint one at Settings → API tokens in the dashboard

EXIT CODES
  0  success
  1  user error (missing arg, no token, etc.)
  2  remote error (HTTP non-2xx from the gateway)
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
  let env: CliEnv;
  try {
    env = await loadCliEnv();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (cmd === 'run') {
    return await runWorkRequestsCommand(rest, env);
  }
  if (cmd === 'workflows') {
    return await runWorkflowsCommand(rest, env);
  }
  if (cmd === 'runs') {
    return await runRunsCommand(rest, env);
  }
  if (cmd === 'tokens') {
    return await runTokensCommand(rest, env);
  }
  if (cmd === 'bundles') {
    return await runBundlesCommand(rest, env);
  }
  process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
  return 1;
}

// Hoisted for testability: tests import `main` directly. The CLI entry point
// only runs `main(process.argv.slice(2))` when invoked as a script.
export { main };

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    }
  );
}
