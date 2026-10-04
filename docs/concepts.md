# Concepts

> The vocabulary of auto-swe in one place: what a run, a template, a node, a gate, an agent, a
> skill, and a scope are, and how they fit together. Each term links to the doc that owns it.

## The shape of it

A **work request** starts a **run** of a **workflow template**. The template's current version is a
graph of **nodes**; the run walks it on Temporal. Some nodes call **agents**, which reason with
**skills** and act through **tools** inside an isolated **workspace**. Some nodes are **gates**,
where the run stops until a person acts. Which model, prompt, and tools an agent gets is resolved
through the **scope cascade**, so one platform can behave differently per team.

## Running work

- **Work request** — A request to do something — a ticket to implement, a PRD to decompose, a
  support ticket to answer. It names a template and carries the inputs that template's `inputSchema`
  asks for. Submitted from the dashboard, Slack, the CLI, the REST API, or a per-template webhook.

- **Run** — One execution of one template version, as a durable Temporal workflow. It survives
  restarts and deploys, can wait days for a person or for CI, and records every step, agent
  transcript, and token it spent. Runs are listed at `/runs`.

- **Agent run** — One library agent, one prompt, one repository, launched on demand instead of
  through a workflow you author. It works in a throwaway workspace and can optionally publish what it
  wrote as a branch or a draft pull request, after deterministic checks and the security gate. See
  [agent-runs.md](./agent-runs.md).

- **Epic** — A brief that spans several repositories. A planner agent splits it into per-repository
  runs and starts them in dependency order. See
  [repo-dependency-graph.md](./repo-dependency-graph.md).

- **Budget tier** — The token ceiling a run is held to — `STANDARD`, `LARGE`, or `EPIC`. A run that
  exceeds it is stopped with `BUDGET_EXCEEDED`.

## Workflows

- **Workflow template** — A named, versioned workflow — `default-engineering`, `four-eyes`,
  `zendesk-ticket-reply`. The built-in ones are seeded; teams clone and edit them, or author their
  own on the canvas or in plain language ([nl-workflow-authoring.md](./nl-workflow-authoring.md)).

- **Version** — Every save of a template is a new, immutable version. A run is pinned to the version
  it started with, and two versions can be A/B tested against each other.

- **Spec** — A version's content: a JSON graph of nodes, an entry node, and the edges between them,
  validated before it can be saved. See [architecture.md](./architecture.md#4-workflow-engine).

- **Node** — One step of a spec. Node types include `step` (a built-in activity), `agent` (a library
  agent), `cond` (a branch), `signal` (wait for an outside event), `fanOut` (parallel branches),
  `shell` and `containerStep` (a sandboxed command), `eval` (score a result), and the four human
  nodes. The full list is in [architecture.md](./architecture.md#node-types). A node may also carry
  a short `title` and a `group` label, which only change how the graph is drawn and listed: the
  canvas shows the title in place of the id and can fold a group into one card, and the outline lists
  the steps in order under their groups. See
  [architecture.md](./architecture.md#presentation-fields-group-and-title).

- **Gate** — A place a run stops for a person. The human nodes — `humanApproval`, `humanDecision`,
  `humanInput`, and `humanReview` — park the run until someone answers in the approvals inbox or in
  Slack, or until a timeout routes it elsewhere. Merging a pull request is the gate no template
  automates. See [hitl-workflows.md](./hitl-workflows.md).

- **Autonomy policy** — The rule that decides whether an action may happen without a person —
  posting a public reply, filing an issue — per risk class, team, and template. It fails closed. See
  [autonomy-policies.md](./autonomy-policies.md).

## Agents

- **Agent** — A versioned, named configuration — `implementer`, `reviewer`, `supportResponder` — of
  a model, a system prompt, a set of skills, and the tools it may use. Agents are data, not code: a
  new one is a row, not a deploy. See [agents.md](./agents.md).

- **Skill** — A named fragment of instructions added to an agent's prompt: how to reason, not what
  it may do. Built-in skills ship verified; custom ones are scanned for injection and start
  unverified.

- **Tool** — Something an agent can execute — read or write a file, run a shell command, call an MCP
  server. Which tools an agent may use is part of its configuration.

- **Review network** — Three reviewer agents — security, domain logic, and performance — that
  inspect a change in parallel. All three must approve.

- **Workspace** — The isolated Docker container an agent works in. The repository is cloned into it,
  and every command and file write is scanned before it runs.

- **Lesson** — What a finished run learned, embedded with pgvector and retrieved as context for
  later runs on the same repository.

## Configuration

- **Scope cascade** — How a setting resolves when several levels set it, most specific first:
  workflow template, channel, team, organization, global. An agent, a model choice, or a policy knob
  can differ per team without a separate deployment. See [configuration.md](./configuration.md) and
  [architecture.md](./architecture.md#configuration-cascade).

- **Connection** — A configured link to an outside system — a git repository, an issue tracker,
  Notion, Zendesk, Slack, an MCP server. Templates name the kind of connection they need, and a run
  is given one.

- **Bundle** — A signed package of agents, skills, scanner patterns, and templates, for moving them
  between deployments. See [bundles.md](./bundles.md).

- **Eval** — A measurement of output quality — scored inside a run by an `eval` node, or offline
  against a frozen dataset to catch regressions. See [evals.md](./evals.md).

## Dashboard workspace

**Home** presents the signed-in engineer's requests that need attention, work in progress, and
recent successful results. The engineer can switch to team work; the team selector narrows the
view. A successful execution is an output to review, not an acceptance of that output.

**Requests** (`/workflows`) groups execution attempts by their work request. It defaults to the
requester's own work, with team scope, task/ticket search, and status filters. Status filters apply
to the latest visible attempt before pagination, so an earlier failure does not resurface after a
successful retry. Pending human steps, failed or timed-out attempts, and engineering workflows
waiting for a human merge appear under **Needs attention**. Search, filters, pagination, and the
open request are encoded in the URL.

Multi-repository requests summarize the latest visible execution for each repository; one
completed child does not make a request with another running child appear finished. Their panel
labels history as repository executions and does not offer a whole-request retry.

Selecting a request opens a side panel with the current result or blocker, progress, and paginated
attempt history. The panel fills narrow screens and offers the full run page for deeper inspection.
Technical logs and the diagram are behind a disclosure; trace payloads are fetched when opened.
The engineer can retry eligible finished attempts with optional additional instructions. Each
attempt preserves the request identity, while an agent attempt allocates a fresh delivery branch.

**Start work** (`/start`) offers **Run a workflow** and **Run an agent**. Both paths collect inputs,
show a review screen, and open the launched request. Workflow input drafts remain available when
switching templates or paths within the page. **Approvals**, the **Workflow library**, and
**Connections** remain directly available in the main navigation. `/runs` remains a linkable
execution-history screen for diagnostics.

### Workspace limitations

- Requests without a recorded execution attempt do not appear in the request list yet. After a
  launch, the side panel polls for the first attempt and explains that execution has not appeared.
- Request status is derived from the latest visible execution. The list reads execution identities
  across the matching history before filtering and paginating, so large histories increase the
  cost of the list query.
- Additional retry instructions change the attempt's request description, and a payload's
  `description` field when it has one. A custom workflow reading a different input field must
  explicitly consume the description to use these instructions.
- Launch drafts are kept within the mounted page; leaving or reloading the page discards them.
