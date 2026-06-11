# `@auto-swe/cli`

`auto-swe` — a thin command-line client over the gateway REST API for submitting
work requests and managing workflow templates, runs, and personal access tokens.
ESM, Node 24+.

## Install / build

```bash
yarn workspace @auto-swe/cli build   # emits dist/index.js (the `auto-swe` bin)
```

The package exposes an `auto-swe` bin (`dist/index.js`). Run it via
`yarn workspace @auto-swe/cli exec auto-swe <command>`, or link/install the
built package so `auto-swe` is on your `PATH`.

## Authentication

Resolved per process (never cached to disk), in order:

`AUTO_SWE_TOKEN` — an `ats_*` personal access token (a short-lived JWT from
the session-token bridge also works). PATs are the intended path: mint one in
the dashboard at **Settings → API tokens**, or with
`auto-swe tokens create <name>`.

| Variable             | Default                 | Purpose                                  |
| -------------------- | ----------------------- | ---------------------------------------- |
| `AUTO_SWE_API_URL`   | `http://localhost:8080` | Base URL of the gateway                  |
| `AUTO_SWE_TOKEN`     | —                       | Bearer token (`ats_*` PAT or JWT)        |

## Commands

```
run --ticket=<id> --description=<text> (--repo=<org/name>|--repo-id=<uuid>) [--workflow=<name>]
                                     Submit a work request and start a run

workflows list                       List workflow templates visible to you
workflows show <name>                Print one template's active spec (JSON)
workflows export <name> [-o <path>]  Write the active spec to a file (or stdout)
workflows import <path> [--name=N] [--team=<slug>]
                                     Create a template (or a new version if --name matches)

runs list [--status=S] [--template-id=ID] [--limit=N]
                                     List recent workflow runs
runs show <runId>                    Print one run (with steps) as JSON
runs tail <runId> [--interval=SEC]   Poll until terminal status

tokens list                          List your personal access tokens
tokens create <name>                 Issue a long-lived API token (printed once)
tokens revoke <id>                   Revoke a token

help                                 Show usage
```

## Exit codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| `0`  | Success                                   |
| `1`  | User error (missing arg, no token, etc.)  |
| `2`  | Remote error (HTTP non-2xx from gateway)  |

## Examples

```bash
export AUTO_SWE_TOKEN=ats_...                 # PAT from Settings → API tokens
auto-swe workflows list
auto-swe run --ticket=JIRA-1 --description="Add GET /health" --repo=acme/payments-api
auto-swe runs tail <runId> --interval=5
```
