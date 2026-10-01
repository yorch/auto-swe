# Quickstart

> Run auto-swe on your own machine and start a first workflow, from a clean checkout to a run you
> can watch in the dashboard.

This is the local-development path. For a production install, follow
[deployment.md](./deployment.md) instead.

## What you need

- **Node.js 26 or later** and **Docker** with Docker Compose.
- **An Anthropic API key and an OpenAI API key.** The seeded agents use Anthropic models, and
  semantic memory embeds with OpenAI. Both are added in the dashboard, not in `.env` — see
  [model-configuration.md](./model-configuration.md) to use other providers instead.
- **A GitHub token** with access to a repository you are happy to receive a pull request on, for
  the engineering workflow. Workflows that do not touch a repository do not need one.

## 1. Install

```bash
npm install -g corepack && corepack enable
yarn install
```

Node 26 no longer bundles Corepack, which is why it is installed from npm first.

## 2. Configure the environment

```bash
cp .env.example .env
```

Two values are required:

| Variable | How to set it |
|---|---|
| `CONFIG_ENCRYPTION_KEY` | `openssl rand -base64 32`. Encrypts every stored credential; the gateway and worker refuse to start without it |
| `SEED_ADMIN_PASSWORD` | A password for the seeded admin account, `admin@auto-swe.local` |

Model keys, GitHub, Slack, and every other integration are stored encrypted in the database and
managed from the dashboard. `GITHUB_TOKEN` in `.env` still works as a bootstrap fallback.

## 3. Start the infrastructure

```bash
yarn docker:infra:up
```

This starts PostgreSQL (with pgvector), a second PostgreSQL for Temporal, and the Temporal server
and its web UI — plus the Garage object store, because `.env.example` enables its `objectstore`
profile.

## 4. Create the database

```bash
yarn db:migrate && yarn db:generate && yarn db:seed
```

The seed creates the admin account, a default team, the built-in workflow templates, skills,
scanner patterns, and agents.

## 5. Start the gateway and the dashboard

In two terminals:

```bash
yarn dev:gateway   # http://localhost:8080
yarn dev:web       # http://localhost:3000
```

Not the worker yet: it checks at boot that every agent can reach a model, and refuses to start
until the credentials below exist.

## 6. Add model credentials

Sign in at `http://localhost:3000` as `admin@auto-swe.local`, then open **Studio → Models**
(`/studio/models`) and add a credential for `anthropic` and one for `openai` on the Credentials
tab.

## 7. Connect GitHub and a repository

- **Studio → Integrations → GitHub** (`/studio/integrations`): enter the token and save. Skip this
  if `GITHUB_TOKEN` is set in `.env`.
- **Connections** (`/connections`): add the repository as a **Git repo** connection, or import it
  from GitHub.

## 8. Start the worker

```bash
yarn dev:worker
```

If anything is still missing, it exits with one error listing every missing piece and where in
the dashboard to add it.

## 9. Start a run

In the dashboard, choose **+ New request**, pick the `default-engineering` template, choose the
repository, and describe a small change — "add a `GET /health` endpoint that returns
`{ status: 'ok' }`" is a good first one.

Then watch it:

| Where | Shows |
|---|---|
| **Runs** (`/runs`) | Every run, and per run its steps, agent transcripts, tool calls, and cost |
| **Govern → Approvals** (`/govern/approvals`) | Steps waiting for a person, in workflows that have them |
| Temporal UI, `http://localhost:8233` | The durable workflow underneath: its event history and signals |

The run ends with a pull request on your repository and then waits for a person to merge it.
auto-swe never merges.

## Next

- [concepts.md](./concepts.md) — the vocabulary: runs, templates, nodes, gates, agents, skills, scopes.
- [architecture.md](./architecture.md) — how a run moves through the system.
- The CLI (`packages/cli/README.md`) and the REST API start the same runs headlessly, with a personal
  access token from **Settings → API tokens**.
