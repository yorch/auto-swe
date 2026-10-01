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
  nodes. The full list is in [architecture.md](./architecture.md#node-types).

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
