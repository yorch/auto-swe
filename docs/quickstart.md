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

## The one-command path

```bash
npm install -g corepack && corepack enable
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… yarn quickstart     # or: just quickstart
```

`yarn quickstart` runs steps 1 to 6 and step 8 below in order and is safe to repeat: it creates `.env` if
there is none (and validates it if there is), installs dependencies, starts the infrastructure,
waits until Postgres is healthy and the Temporal namespace exists, applies the migrations, seeds
the database, stores the model credentials and the embedding configuration, then starts the
gateway, the worker and the dashboard in the background and prints what to do next. Service
output goes to `.quickstart/<service>.log`; `yarn quickstart down` stops the three services and the
infrastructure containers and keeps the data.

| Option | Effect |
|---|---|
| `--check` | Prints the plan, which keys were found and what the host lacks, and changes nothing |
| `--anthropic-key-env NAME`, `--openai-key-env NAME` | Read a key from a differently named environment variable. The flags take a variable name, never a key, so no key appears in `ps` |
| `--no-start` | Stop after the database and model configuration |
| `--skip-install` | Do not run `yarn install --immutable` |

The keys are stored encrypted in the database (under `CONFIG_ENCRYPTION_KEY`), as the dashboard
would store them; they are not written to `.env` or anywhere in the repository. A credential or
embedding configuration that already exists is left as it is. Without both keys the script still
brings up everything except the worker, and says so: the worker refuses to start until every agent
can reach a model (step 8).

## 1. Install

```bash
npm install -g corepack && corepack enable
yarn install
```

Node 26 no longer bundles Corepack, which is why it is installed from npm first.

## 2. Configure the environment

```bash
yarn env:setup init
```

This creates `.env` from `.env.example` and generates every required secret. It never overwrites
an existing `.env`; after pulling a change to `.env.example`, run `yarn env:setup sync` to bring
your file up to date (it keeps your values and backs the old file up first), and
`yarn env:setup check` to validate it. The values it generates:

| Variable | What it is |
|---|---|
| `CONFIG_ENCRYPTION_KEY` | Base64 of 32 random bytes. Encrypts every stored credential; the gateway and worker refuse to start without it. Never regenerated once set — rotate it with `yarn keys:rotate` |
| `SEED_ADMIN_PASSWORD` | The password for the seeded admin account, `admin@auto-swe.local` |
| `BETTER_AUTH_SECRET`, `JWT_SECRET` | Session-cookie and API-token signing keys |
| `GARAGE_RPC_SECRET` | Node auth for the bundled Garage object store (only while `COMPOSE_PROFILES` includes `objectstore`) |

The generated admin password is in `.env`; the script never prints secrets.

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
yarn db:deploy && yarn db:generate && yarn db:seed
```

The seed creates the admin account, a default team, the built-in workflow templates, skills,
scanner patterns, and agents. It does not create model credentials or the embedding configuration;
step 6 adds them.

## 5. Start the gateway and the dashboard

In two terminals:

```bash
yarn dev:gateway   # http://localhost:8080
yarn dev:web       # http://localhost:3000
```

Not the worker yet: it checks at boot that every agent can reach a model, and refuses to start
until the credentials below exist.

## 6. Add model credentials

Sign in at `http://localhost:3000` as `admin@auto-swe.local`, then open **Build → Model configuration**
(`/models`) and add a credential for `anthropic` and one for `openai` on the Credentials
tab.

## 7. Connect GitHub and a repository

- **Admin → Integrations → GitHub** (`/admin/integrations`): enter the token and save. Skip this
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

In the dashboard, choose **+ New request**, pick the `ticket-to-merge` template, choose the
repository, and describe a small change — "add a `GET /health` endpoint that returns
`{ status: 'ok' }`" is a good first one.

Then watch it:

| Where | Shows |
|---|---|
| **Runs** (`/runs`) | Every run, and per run its steps, agent transcripts, tool calls, and cost |
| **Work → Approvals** (`/approvals`) | Steps waiting for a person, in workflows that have them |
| Temporal UI, `http://localhost:8233` | The durable workflow underneath: its event history and signals |

The run ends with a pull request on your repository and then waits for a person to merge it.
By default auto-swe never merges (the opt-in `auto` mode and bot approval of [pr-evaluation.md](./pr-evaluation.md) are off).

## Limitations

- **The 15-minute target is not measured.** The one-command path removes the manual steps and the
  waits between them; the time it takes depends on the machine, the network (image pulls and
  `yarn install`) and Docker, and no timing is recorded here.
- **It needs two API keys, or the dashboard.** The seeded agents use Anthropic models and
  embeddings use OpenAI (`openai/text-embedding-3-large`). Other providers are configured at
  `/models`; the script stores only these two.
- **GitHub is not configured by the script.** The first run still needs a token entered at
  `/admin/integrations` (or `GITHUB_TOKEN` in `.env`) and a connection for the repository.
- **Services run in development mode** (`yarn dev:*`, detached, with file watching), not from built
  images. For the Docker stack use `yarn docker:app:up`; for production see
  [deployment.md](./deployment.md).
- **Ports are fixed.** Dashboard 3000, gateway 8080, Postgres 5432, and the Temporal gRPC (7233) and UI (8233) ports. A port in
  use makes the step that needs it fail; the script does not choose another.
- **`down` stops only what `up` started**, found through the pid files in `.quickstart/`. A service
  started by hand keeps running.
- **Two Postgres containers start.** Temporal keeps its own (`postgres-temporal`) beside the
  application's. Pointing Temporal at the application's server would change the Temporal server's
  configuration (`POSTGRES_SEEDS`), which this repository does not do, so there is no
  single-Postgres layout.
- **Node 26 is checked, not installed.** The script stops with the install instruction when Node,
  Yarn or Docker is missing.

## Next

- [concepts.md](./concepts.md) — the vocabulary: runs, templates, nodes, gates, agents, skills, scopes.
- [architecture.md](./architecture.md) — how a run moves through the system.
- The CLI (`packages/cli/README.md`) and the REST API start the same runs headlessly, with a personal
  access token from **Settings → API tokens**.
