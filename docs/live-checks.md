# Live checks

> Suites that run the paths the unit tests mock — real Temporal, a real Docker daemon, a real
> model, real GitHub, a real Atlassian site, a real Postgres with pgvector — and the workflow that
> runs them.

The unit suite runs against mocked Docker, mocked Temporal and mocked LLM calls
([product-overview.md §8](./product-overview.md#8-maturity)), and the opt-in `*.pg.test.ts` and
`*.docker.test.ts` suites that `ci.yml` runs cover a real database and a real container but no
external service. A **live check** is a `*.live.test.ts` suite under `packages/worker/src/live/`
that exercises one path with real infrastructure and a real credential. Live checks cost money and
need secrets, so they are not part of `yarn test`, `ci.yml` or any pull-request job.

## 1. What can be checked

| Path | Suite | Flag | What it asserts |
|---|---|---|---|
| Ticket to green pull request | `endToEnd.live.test.ts` | `LIVE_E2E` | A ticket submitted through the gateway opens a pull request on the fixture repository, and that pull request's CI ends green (first push, or after the platform's CI-fix loop pushed a follow-up commit) |
| Eval harness ([evals.md §3](./evals.md#3-offline-harness)) | `evals.live.test.ts` | `LIVE_EVALS` | A one-case dataset is flake-screened, then an eval run scores the seeded `implementer` with a real model in a real workspace and ends with a verdict (`SUCCESS` or `FAILED`), not `INCONCLUSIVE` |
| Confluence connector | `confluence.live.test.ts` | `LIVE_CONFLUENCE` | Create, read and update a page, then add a footer comment and an inline comment anchored to a passage, on a real Atlassian Cloud site |
| Inline pull-request finding comments | `githubReview.live.test.ts` | `LIVE_GITHUB_REVIEW` | `createReview` puts an inline comment on a line of a changed file; the comment reads back over REST and appears in the review threads (GraphQL) |
| MCP OAuth discovery, the Codex client path ([local-agents.md](./local-agents.md#codex)) | `mcpOAuth.live.test.ts` | `LIVE_MCP_OAUTH` | An unauthenticated MCP call answers `401` with a resource-metadata pointer; the protected-resource and authorization-server metadata resolve; a public client registers dynamically. When `codex` is installed, `codex mcp list` runs |
| Knowledge vector SQL ([knowledge.md](./knowledge.md)) | `knowledgePgvector.live.test.ts` | `LIVE_KNOWLEDGE_PGVECTOR` | The `vector` extension, the `vector(1536)` column and the HNSW index exist; the indexing `UPDATE` writes a vector and respects its digest and version guard; the ranking `SELECT` orders by cosine similarity and leaves out a vector whose digest or model is stale |
| Credentialed GitHub checkout | `githubCheckout.live.test.ts` | `LIVE_GITHUB_CHECKOUT` | The workspace clones the repository with a credential resolved by the SCM provider, a second repository is cloned beside it as read-only reference material (`cloneDependencyRepos`), and neither `.git/config` keeps the token |

The knowledge suite replaces only the embedding model and the budget gate with deterministic
stand-ins; the SQL under test is the real statement (`rankKnowledgeByEmbedding` and
`indexKnowledgeCandidates` in `packages/worker/src/lib/knowledgeRuntime.ts`). The MCP suite
establishes discovery and registration; the browser sign-in and consent that follow need a person.

## 2. The workflow

`.github/workflows/live-e2e.yml` runs every suite above. It starts on a schedule (Monday and
Thursday) and by hand from the Actions tab (`workflow_dispatch`), and nothing else: never for a
pull request, a push or a caller. `yarn invariants:check` fails when a `*.live.test.ts` is not run
by a `yarn test` step of this workflow with its flag set and no `if:` or `continue-on-error:` on
the step, and when the workflow gains a `pull_request`, `pull_request_target`, `push` or
`workflow_call` trigger or loses its `schedule` or `workflow_dispatch` one.

The `preflight` job reads the secrets the end-to-end check needs. If any is missing — a fork, a
deployment that did not opt in — it writes a notice naming what is absent and the `live` job is
skipped, so the run is green and says why. The `live` job then:

1. creates `.env` (`yarn env:setup init`), starts the infrastructure (`yarn docker:infra:up`),
   migrates and seeds the database, and starts the gateway;
2. provisions the stack with `scripts/live-e2e-stack.mjs bootstrap`: signs in as the seeded admin,
   stores the Anthropic and OpenAI credentials, turns on the MCP endpoint, onboards the fixture
   repository as a connection, issues a personal access token, and seeds the fixture repository
   from `infra/live-e2e/fixture/` when its default branch has no `package.json`;
3. starts the worker, which refuses to boot until the credentials exist;
4. runs every suite in one step, so a failing suite does not hide the others, and fails the step if
   any failed; then prints the gateway and worker logs and stops the stack.

### Secrets and variables

| Name | Kind | Needed for |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | secret | The seeded agents and the embedding model. Required: without them the whole job is skipped |
| `LIVE_E2E_GITHUB_TOKEN` | secret | A token with `repo` and workflow-run access on the fixture repository: clone, push, open pull requests, read checks. Required |
| `LIVE_E2E_FIXTURE_REPO` | variable | The fixture repository as `owner/name`. Use a repository nobody else writes to. Required |
| `LIVE_EVALS_REPO_URL` | variable | A clone URL the eval workspace can read **without** a platform credential — the fixture repository when it is public. The eval suite skips without it |
| `LIVE_CONFLUENCE_API_TOKEN` (secret), `LIVE_CONFLUENCE_BASE_URL`, `LIVE_CONFLUENCE_EMAIL`, `LIVE_CONFLUENCE_SPACE_KEY` (variables) | secret and variables | The Confluence suite. It skips without them. Use a scratch space; the user needs permission to create and delete pages there |

### The fixture repository

`infra/live-e2e/fixture/` is a small Node project with one deliberate bug: `src/sum.js` subtracts,
so `test/sum.test.js` and the project's CI fail on the default branch. The end-to-end check asks
for a fix and expects a pull request whose CI is green. The default branch is never merged into —
the suite closes its pull request and deletes its branch — so the next run starts from the same
bug. `test/ok.test.js` always passes; the eval check scores it as its golden test, because a case
whose reference fails is a case the harness refuses to score.

### Cost

One run provisions the stack on a GitHub-hosted runner (the job limit is two hours) and spends
model tokens on two agent runs: the end-to-end ticket, with whatever CI-fix attempts it needs, and
the eval case, which runs the implementer against itself. Both are small edits to a few-line
project, so the spend is bounded by the `STANDARD` budget tier and the eval's runless cap
([configuration.md](./configuration.md)), and is dominated by the end-to-end run. The Confluence,
GitHub and MCP checks cost API calls only. A scheduled twice-weekly run is the intended cadence;
lower it by editing the cron expression.

## 3. Running one suite by hand

Each suite reads its flag and credentials from the environment and skips, with its reason in the
test title and a warning line when the flag is set but a credential is missing, otherwise.

```bash
# Knowledge vector SQL: any migrated Postgres with pgvector
DATABASE_URL=postgresql://… LIVE_E2E_DATABASE_URL=postgresql://… \
LIVE_KNOWLEDGE_PGVECTOR=1 yarn test packages/worker/src/live/knowledgePgvector.live.test.ts

# Confluence: a scratch space on a real site
LIVE_CONFLUENCE=1 LIVE_CONFLUENCE_BASE_URL=https://example.atlassian.net \
LIVE_CONFLUENCE_EMAIL=… LIVE_CONFLUENCE_API_TOKEN=… LIVE_CONFLUENCE_SPACE_KEY=SCRATCH \
yarn test packages/worker/src/live/confluence.live.test.ts
```

The suites that need the whole stack (`LIVE_E2E`, `LIVE_EVALS`, `LIVE_MCP_OAUTH`) expect
`LIVE_E2E_API_URL`, `LIVE_E2E_TOKEN` and `LIVE_E2E_REPO_ID`, which `live-e2e-stack.mjs bootstrap`
prints (or appends to `$GITHUB_ENV`). The GitHub suites and the knowledge suite open the database
directly and need `DATABASE_URL` and `LIVE_E2E_DATABASE_URL` to name the same migrated database.

## 4. Adding a live check

Name the file `<thing>.live.test.ts`, gate it with `liveGate()` from `packages/worker/src/live/liveGate.ts`
(the flag read as `process.env.LIVE_X === '1'` in the suite itself), add a `yarn test` line for it
and its flag to the `Live suites` step of `live-e2e.yml`, and add a row to §1. The invariant check
fails until all of that is in place.

## Limitations

- **A live check is available, not a recorded result.** Nothing in the repository records that a
  suite has passed against a live service. A path counts as verified only by a green run of the
  workflow; [product-overview.md §8](./product-overview.md#8-maturity) keeps its "mocked" wording
  for each path until then.
- **The stack provisioning is a script over the REST API.** `live-e2e-stack.mjs` and the start-up
  steps of the workflow assume the gateway's sign-in, credential, repository, token and setting
  routes and the compose services' readiness behave as documented; a change to any of them breaks
  the job before a suite runs.
- **End-to-end proves the machinery and one small change, not quality.** The fixture is a one-line
  bug. A pass says a ticket reached a pull request with green CI; it says little about larger
  tasks, other stacks, or review quality. The CI-heal assertion accepts a green first push, so
  whether the platform's CI-fix loop ran is logged, not asserted.
- **The eval check scores a case that passes by construction.** Its golden test passes at the
  pinned commit, so it establishes that screening, the TDD loop and scoring turn end to end, not
  that the model solves anything. The eval workspace clones the case's URL without a platform
  credential, so the fixture must be readable that way.
- **The MCP check stops before sign-in.** Authorization needs a person in a browser. The suite
  confirms discovery, registration and the `401` challenge, which a Codex client performs first;
  it does not exercise consent, token issue or a `tools/list` over a real Codex session.
- **The checkout suite targets the credentialed clone path.** It covers the workspace's own clone
  and the read-only dependency clone from GitHub; it does not cover a GitHub Enterprise host, a
  GitHub App installation token, or a user's own token.
- **The knowledge suite uses deterministic vectors.** It checks the SQL and the migration DDL, not
  the embedding model's quality or the scope policy `searchWorkflowKnowledge` applies before
  ranking.
- **The Confluence suite covers Atlassian Cloud with an API token** against the v2 endpoints the
  connector uses; Data Center and OAuth app credentials are not covered.
- **One stack, one run.** The workflow serialises runs on a concurrency group and shares the
  fixture repository, so concurrent runs would collide; a run cancelled mid-flight can leave a
  branch and a pull request on the fixture repository.
