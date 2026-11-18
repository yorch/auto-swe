# `@auto-swe/cli`

`auto-swe` — a thin command-line client over the gateway REST API for submitting
work requests and managing workflow templates, runs, personal access tokens,
bundles, and eval datasets, plus OAuth credential helpers for MCP clients. ESM, Node 26+.

## Install / build

```bash
yarn workspace @auto-swe/cli build   # emits dist/index.js (the `auto-swe` bin)
```

The package exposes an `auto-swe` bin (`dist/index.js`). Run it via
`yarn workspace @auto-swe/cli exec auto-swe <command>`, or link/install the
built package so `auto-swe` is on your `PATH`.

## Authentication

REST command credentials are resolved per process (never cached to disk):

`AUTO_SWE_TOKEN` — an `ats_*` personal access token (a short-lived JWT from
the session-token bridge also works). PATs are the intended path: mint one in
the dashboard at **Settings → API tokens**, or with
`auto-swe tokens create <name>`.

| Variable             | Default                 | Purpose                                  |
| -------------------- | ----------------------- | ---------------------------------------- |
| `AUTO_SWE_API_URL`   | `http://localhost:8080` | Base URL of the gateway                  |
| `AUTO_SWE_TOKEN`     | —                       | Bearer token (`ats_*` PAT or JWT)        |
| `AUTO_SWE_WEB_URL`   | `http://localhost:3000` | Dashboard base URL for the links `orchestrate` prints |

### MCP device authorization

`mcp` commands use separate OAuth credentials, not `AUTO_SWE_TOKEN`, and do not require a PAT.
The deployment administrator enables `mcp.enabled` and `mcp.deviceFlowEnabled`; write login also
requires `mcp.writeToolsEnabled`.

```sh
auto-swe mcp login --url https://auto-swe.example.com          # read and offline access
auto-swe mcp login --url https://auto-swe.example.com --write  # also request write access
auto-swe mcp token --url https://auto-swe.example.com          # token only, stdout
auto-swe mcp header --url https://auto-swe.example.com         # Authorization JSON, stdout
auto-swe mcp logout --url https://auto-swe.example.com
```

The base defaults to `AUTO_SWE_API_URL`, then `http://localhost:8080`. It is the gateway origin,
not the MCP endpoint; HTTPS is required except on loopback. The CLI discovers the OAuth endpoints,
registers a public device/refresh client once per deployment, and reuses it on subsequent logins.
The provider requires an unused loopback redirect URI even for device-only clients; the CLI supplies
it without opening a callback listener. Login prints the complete verification URL and user code to
stderr. Open it in a trusted browser and approve only a code you started. Device codes expire in ten
minutes; polling respects the returned interval and `slow_down`. Approval grants all requested scopes:
deny a write request and log in again without `--write` if you only want reads.

Successful login stores issuer, client id, resource, scopes, access token, access expiry (epoch
milliseconds), and refresh token in `$XDG_CONFIG_HOME/auto-swe/mcp-credentials.json` (fallback
`~/.config/auto-swe/mcp-credentials.json`), keyed by gateway origin. The directory is mode `0700`,
the file `0600`, and replacements are atomic. Local credential operations are serialized to protect
rotating refresh tokens. Do not share the file, put it in a repository, or log its contents.
`token` and `header` refresh when less than sixty seconds remain and save the rotated refresh token
before printing. `invalid_grant` requires another login. Logout revokes the refresh token before
deleting the local entry; a failed revocation preserves it so logout can be retried. Use dashboard
Connected apps to disconnect the grant itself. Already-issued access tokens expire after ten minutes.

See [headless client setup](../../docs/local-agents.md#headless-ssh-and-ci-clients) for Claude Code
`headersHelper` and Codex `bearer_token_env_var` examples. Never send token/header output to logs.

## Commands

```
mcp login [--url <base>] [--write]  Approve a device code in a browser; no REST token needed
mcp token|header [--url <base>]     Print an MCP token or Authorization JSON, refreshing if needed
mcp logout [--url <base>]          Revoke the refresh token and delete local MCP credentials

run --ticket=<id> [--description=<text>] (--repo=<org/name>|--repo-id=<uuid>) [--budget=<tier>]
    [--idempotency-key=<key>] [--acknowledge-unchanged]
    [--egress-policy=open|restricted|blocked]
                                     Submit a work request and start a run on the default template;
                                     with --idempotency-key a retried submission returns the run it
                                     already started instead of a second one; a request identical to
                                     one that stopped as not actionable in the last 24 hours is
                                     refused unless --acknowledge-unchanged is passed.
                                     --description is optional when the ticket can be read from the
                                     issue tracker; otherwise the server refuses with
                                     DESCRIPTION_REQUIRED.

agent run <key[@version]> "<prompt>" --repo=<org/name> [--deliver=none|branch|draft_pr]
          [--base=<branch>] [--max-steps=N] [--timeout=SECONDS] [--wait]
          [--egress-policy=open|restricted|blocked]
                                     Run a library agent on a repository in a throwaway workspace;
                                     --deliver=branch|draft_pr publishes it after the platform's
                                     checks pass (see docs/agent-runs.md)
agent rerun <workRequestId> [--wait] Run an earlier agent run again as a new run

orchestrate start "<task>" --agent=<key> [--agent=<key> ...] [--repo=<org/name> | --team=<slug>]
          [--connection=<id> ...] [--budget-tier=STANDARD|LARGE|EPIC]
          [--deliver=none|branch|draft_pr] [--idempotency-key=KEY] [--wait] [--json]
                                     Start an orchestration: a conversation with an orchestrator
                                     that starts, steers and collects agent runs
orchestrate list [--team=<slug>] [--status=S] [--json]
orchestrate show <id> [--json]       Print an orchestration's status, children, pending requests
orchestrate messages <id> [--follow] [--json]
                                     Print the transcript; --follow keeps polling until it finishes
orchestrate say <id> "<message>"     Message the orchestrator
orchestrate steer <id> <childId> "<message>"
                                     Steer one running agent
orchestrate cancel-agent <id> <childId>
orchestrate cancel <id>              Cancel the orchestration and its running agents
orchestrate end <id>                 End the orchestration
orchestrate attach <id> --repo=<org/name>
orchestrate decline <id>             Human acts: answer the orchestrator's repository request
orchestrate approve <id> <approvalId>
orchestrate deny <id> <approvalId>   Human acts: decide one held MCP write
plan route "<goal>" --repo=<org/name>
                                     Rank the templates you may launch for a goal
plan create "<goal>" --repo=<org/name> [--agent=<key>] [--wait] [--timeout=SECONDS]
                                     Generate a plan for a goal; --wait polls to the plan id
plan wait <jobId> [--timeout=SECONDS]  Poll a generation job to its plan id
plan show <planId> [--json]          Print the plan outline (the spec only with --json)
plan list [--status=S] [--limit=N] [--json]
                                     List your plans
plan approve <planId> [--budget-tier=T] [--yes]
                                     Approve the stored plan and start its run
plan reject <planId>                 Reject a pending plan
plan run "<goal>" --repo=<org/name> [--agent=<key>] [--budget-tier=T] --yes
                                     Create, wait, show and approve in one step

workflows list                       List workflow templates visible to you
workflows show <name> [--version=N]  Print one template's active (or given) spec (JSON)
workflows export <name> [-o <path>]  Write the active spec to a file (or stdout)
workflows import <path> [--name=N] [--team=<slug>]
                                     Create a template (or a new version if --name matches)
workflows run <name> --payload=<json> [--label=<text>] [--acknowledge-unchanged]
              [--egress-policy=open|restricted|blocked]
                                     Start a run with a generic JSON payload
workflows generate "<description>" [--name=N] [--team=<slug>]
                                     Generate a DRAFT template from plain language (AI)
workflows explain <name>             Explain a template's active version in plain language (AI)
                                     show / export / import / run / explain take --team=<slug> or
                                     --global: names are unique per team, and a name found in more
                                     than one scope is an error until one is picked

repos gate-commands <org/name> [--lint=CMD] [--typecheck=CMD] [--tests=CMD] [--build=CMD]
      [--vuln-scan=CMD] [--perf-bench=CMD] [--clear]
                                     Print a repository's gate commands, or set them: an empty
                                     value (--lint=) removes one, --clear removes all first.
                                     Setting needs a platform admin or the team's admin
                                     (see docs/repositories.md)

repos setup init [dir] [--force]
                                     Write a starter .auto-swe/setup.yml into a local checkout
                                     (default: the current directory), with the install for the
                                     stack its tracked files show. Local, no token; refuses to
                                     replace an existing file without --force

repos setup <org/name> [--file=PATH | --clear]
                                     Print a repository's workspace setup, set it from a YAML or
                                     JSON file (the .auto-swe/setup.yml schema), or remove it so
                                     workspaces read the repository's own file. Setting needs a
                                     platform admin or the team's admin (see docs/repositories.md)

repos test-access <org/name> [--json]
                                     Check what a run on the repository could do with its
                                     credentials: token, repository, push, default branch. Exits
                                     1 on a failing step. Needs a platform admin or a lead of the
                                     team (see docs/repositories.md)

connections test [--ticket=<id>] [--json]
                                     Check every configured connection (GitHub, Slack, issue
                                     tracker, knowledge base, Figma, per-host credentials,
                                     package registries, model keys). Exits 1 when any fails.
                                     The tracker is checked only with --ticket. Needs a platform
                                     admin (see docs/configuration.md)

runs list [--status=S] [--template-id=ID] [--work-request-id=ID] [--limit=N]
                                     List recent workflow runs
runs show <runId>                    Print one run (with steps) as JSON
runs tail <runId> [--interval=SEC] [--max=N]
                                     Poll until terminal status (exit 2 if the run did not succeed)

tokens list                          List your personal access tokens
tokens create <name> [--expires-in-days=N]
                                     Issue a personal access token (printed once)
tokens revoke <id>                   Revoke a token

bundle init [dir] [--name=N] [--version=V]
                                     Scaffold a bundle authoring project (local, no token)
bundle validate <path>               Validate a bundle manifest (schema + content hash)
bundle sign <path> --key=<pem> [--signed-by=ID] [-o <path>]
                                     Attach a detached ed25519 signature

bundles list                         List installed bundles (admin token)
bundles export <name> <version> [--origin=TAG] [-o <path>]
                                     Export GLOBAL content to a bundle file
bundles install <path> [--overwrite-protected]
                                     Install a bundle from a file; a bundle agent that would
                                     replace a built-in or admin-authored one is refused unless
                                     --overwrite-protected is passed
bundles install-from-url <url> [--overwrite-protected]
                                     Install a bundle from a URL

pr-policy init [--dir <path>] [--force]
                                     Write .auto-swe/pr-policy.yml (local, no token), pre-filling
                                     sensitivePaths from the sensitive directories present;
                                     refuses to overwrite without --force
pr-policy validate [file]            Check a policy file offline (default .auto-swe/pr-policy.yml);
                                     errors exit 1, warnings print and exit 0
pr-policy status <repoId>            Show a repository's PR evaluation mode, the last evaluation
                                     and the auto-merge evidence
pr-policy mode <repoId> <off|advisory|enforce|auto|inherit>
                                     Set a repository's PR evaluation mode; inherit restores the
                                     deployment default. enforce holds the status pending until
                                     enough approvals exist and never arms auto-merge; warnings
                                     print when the status is not a required check. auto is
                                     platform-admin only and is refused with the reasons it is
                                     not ready (exit 1)
pr-policy bot-approval <repoId> <on|off>
                                     Let the approver App approve a repository's LOW pull
                                     requests, so they merge with no human approval (auto mode
                                     only). on is platform-admin only and is refused with every
                                     unmet reason (exit 1); off needs a team lead or platform
                                     admin and withdraws the approvals

evals list                           List eval datasets (admin token)
evals show <id>                      Print a dataset's cases
evals rescreen <id> [--case=<case-id>]
                                     Reset a dataset's cases (or one) to unscreened and
                                     start its flake screen
evals results [--run=<id>] [--source=GATE|REVIEW|MERGE] [--scorer=<s>] [--limit=N]
                                     Query captured eval signals
evals run <dataset-slug> --candidate=<ref> --against=<ref>
          [--candidate-runtime=mastra|claude-code] [--against-runtime=mastra|claude-code]
                                     Run the regression gate; exits 1 on a regression,
                                     2 when the eval run fails without a verdict, is
                                     INCONCLUSIVE (no case flake-screened yet), or the
                                     budget stopped it before every case ran. A runtime
                                     flag runs that side on the named implementer runtime

help                                 Show usage
```

`pr-policy init` and `pr-policy validate` are token-free and offline; `pr-policy status`,
`pr-policy mode` and `pr-policy bot-approval` call the gateway (see [`docs/pr-evaluation.md`](../../docs/pr-evaluation.md)).

`bundle` (singular) is token-free local authoring over `@auto-swe/sdk`; `bundles`
(plural) hits `/api/v1/platform/bundles` and needs an admin token. `evals` also needs an
admin token; `evals run` is the regression gate a nightly CI job polls to completion
(see [`docs/evals.md`](../../docs/evals.md)).

## `auto-swe orchestrate`

An orchestration is a conversation with an `orchestrator` agent. The orchestrator turns your task
into child agent runs, each a library agent with one role: a **reader** delivers nothing, and a
**writer** delivers a branch or draft pull request under its declared path scopes. The orchestrator
never touches a workspace itself. The platform must have `orchestration.enabled` switched on, and
every child is started through the same launch path as `agent run`.

```bash
# Repository-bound: writers and delivery are available once the repository is attached.
auto-swe orchestrate start "Find why retries double-charge" --repo=acme/payments \
  --agent=contentWriter --agent=reviewer --budget-tier=LARGE --wait

# Repo-less: read-only (readers only, no workspace). --team names the team that owns it.
auto-swe orchestrate start "Summarise last week's incidents" --team=payments --agent=contentWriter

auto-swe orchestrate show <id>                  # status, children, pending requests and approvals
auto-swe orchestrate messages <id> --follow     # the transcript, polled every 3 seconds
auto-swe orchestrate steer <id> <childId> "Skip the cache layer"
```

**Start.** `--agent` names an agent on the allowlist and repeats; at least one is required. A
version can be pinned with `key@3`. `--repo` takes `org/name` (or a repository UUID); without it,
`--team` is required and the orchestration is read-only. `--connection` takes an MCP connection UUID
and repeats; the set is fixed at launch, and omitting it gives children no MCP connection. Each
invocation sends an `Idempotency-Key`: a new one by default, or the value of `--idempotency-key`, so
a retried launch with the same key returns the orchestration it already made. `--budget-tier` and
`--deliver` set the defaults; `--deliver` applies to writers once a repository is attached. The
command prints the orchestration id and a dashboard link built from `AUTO_SWE_WEB_URL`.

**Following.** `--wait` on `start` and `--follow` on `messages` print the transcript as
`role: body` lines (roles are lowercase: `user`, `orchestrator`, `system`), with `(child <id>)` after
the role for a message addressed to one child. Status changes go to stderr as `[STATUS]`. `--wait`
stops when the orchestration is `WAITING` for a person, `COMPLETED`, `CANCELLED` or `FAILED`;
`--follow` keeps going through `WAITING` and stops only when it is finished. A request that needs a
person is printed once, with the exact command that answers it, and only the launcher is shown
those commands.

**Output.** `list`, `show` and `start` print tables or key-value lines. `--json` prints the API's
data instead: one document for `list`, `show` and `start`, and one JSON object per line for
`messages`. `start` cannot combine `--json` with `--wait`.

**Human acts.** `attach`, `decline`, `approve` and `deny` are decisions only the person who
launched the orchestration can make. They are recorded under the token's account, and the gateway
refuses them to anyone else, to the in-app assistant and to service principals. Each prints a
one-line reminder to stderr. `attach` takes the repository the orchestrator asked for; `decline`
keeps the orchestration repo-less; `approve` and `deny` decide one MCP write, which runs once if
approved and returns an error to the agent if denied or expired.

**Steering.** `say` messages the orchestrator, and `steer` queues a message for one running child.
A child on a harness runtime (Claude Code or Pi) cannot take a message mid-run: the message stays
queued and undelivered, and `show` counts it as such. `cancel-agent` stops
one child, `cancel` stops the whole orchestration with its running children, and `end` completes it.
Pushed branches stay in place when either is cancelled.

**Refusals.** A refusal prints `CODE: <plain sentence>` to stderr and exits 2. Every code in the
orchestration contract has a sentence, and so do the common gateway refusals, for example
`ORCHESTRATION_DISABLED`, `TEAM_REPO_MISMATCH`, `NOT_LAUNCHER` and `APPROVAL_NOT_PENDING`. An
unrecognised code prints the gateway's own message.

## Exit codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| `0`  | Success                                   |
| `1`  | User error (missing arg, no token, etc.); `evals run` also exits 1 on a regression, and `connections test` and `repos test-access` when a connection or step fails |
| `2`  | Remote error (HTTP non-2xx from gateway); `runs tail`, `agent run --wait` and `orchestrate start --wait` also exit 2 when the run or orchestration ends in a non-success status (`orchestrate` cancelled or failed), and `evals run` when the eval run fails without reaching a verdict, ends `INCONCLUSIVE` (no case had passed its flake screen, so none was scored), or passes over only the cases its budget reached (`summary.partial`; a partial run that regressed exits 1); `plan create --wait` and `plan run` exit 2 when generation fails. `plan approve` exits 1 when it is not confirmed, and `plan create --wait` exits 1 when generation outlasts `--timeout` |


### `auto-swe plan`

`plan` describes a goal and runs the workflow the platform generates for it. `plan route` ranks the
templates you may already launch; `plan create` starts a generation job, and `--wait` polls it with a
growing delay (default limit 600 seconds, `--timeout`) until it prints the plan id. A failed job exits `2`
with its stable error code on stderr (`PLAN_GENERATION_FAILED`, `PLAN_AGENTS_UNAVAILABLE`, and so on); a
timeout exits `1` and names `plan wait <jobId>` to resume.

`plan show` prints an outline: mode, each step marked `core`, `injected`, `mandatory` or `free`, the
estimated cost with the steps it could not price, warnings, pinned agent versions, expiry and status.
The generated spec is printed only by `plan show --json`. Plans are private to the person who
created them, and nothing runs until that person approves exactly the stored plan.

`plan approve` sends a fresh `Idempotency-Key`. Without `--yes` it prints the outline and asks for
confirmation on a terminal; in a non-interactive session it refuses (exit `1`) unless `--yes` is given.
If the repository, agent catalog, settings or the plan itself changed since generation, the gateway
refuses with `409` and the CLI says to generate a new plan. `plan run` does create, wait, show and approve;
it requires `--yes` and otherwise stops after printing the plan and the approve command. Plans can be
generated and approved only by the user who owns them; a service token cannot.

## Examples

```bash
export AUTO_SWE_TOKEN=ats_...                 # PAT from Settings → API tokens
auto-swe workflows list
auto-swe run --ticket=JIRA-1 --description="Add GET /health" --repo=acme/payments-api
auto-swe runs tail <runId> --interval=5
auto-swe agent run contentWriter "Fix the typos in the README" --repo=acme/docs --deliver=draft_pr --wait
auto-swe plan create "Add a /health endpoint" --repo=acme/payments-api --wait
auto-swe plan show <planId>
auto-swe plan approve <planId>
```

## `auto-swe transcripts`

Inspect and export agent transcripts (the model calls each activity attempt made).

- `auto-swe transcripts list <runId>` — a run's transcripts with status, runtime, call count and size.
- `auto-swe transcripts get <transcriptId> [--format=raw|normalized] [--scrub-pii] [-o file]` — metadata plus the NDJSON content stream.
- `auto-swe transcripts export --from=ISO --to=ISO [--agent=KEY] [--activity-type=TYPE] [--format=raw|normalized] [--scrub-pii] [-o file]` — admin export of `{transcript, record}` lines over a ≤31-day range, across all tenants.

## Limitations

- MCP login still requires a signed-in active user to approve a code in a browser; it is not unattended
  account sign-in. Device OAuth tokens work only at the MCP endpoint, not at the REST API.
- File permission modes require a filesystem with POSIX permission support. A crash can leave
  `.mcp-credentials.lock` in the private config directory: remove that empty lock directory only after
  confirming no MCP credential command is running. Back up credentials privately, never in Git.
- The CLI does not refresh another process's environment. A Codex bearer-token wrapper suits short
  sessions only; restart it when the ten-minute token expires. Vendor interoperability is not tested
  against a live deployment.
