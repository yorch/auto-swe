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
  exceeds it is stopped with `BUDGET_EXCEEDED`. The input cap counts dollar-equivalent tokens, so
  prompt-cache reads count at the model's cache rate rather than in full.

## Workflows

- **Workflow template** — A named, versioned workflow — `ticket-to-merge`, `four-eyes`,
  `zendesk-ticket-reply`. The built-in ones are seeded; teams clone and edit them, or author their
  own on the canvas or in plain language ([nl-workflow-authoring.md](./nl-workflow-authoring.md)).

- **Version** — Every save of a template is a new, immutable version. A run is pinned to the version
  it started with, and two versions can be A/B tested against each other.

- **Spec** — A version's content: a JSON graph of nodes, an entry node, and the edges between them,
  validated before it can be saved. See [architecture.md](./architecture.md#4-workflow-engine).

- **Node** — One step of a spec. Node types include `step` (a built-in activity), `agent` (a library
  agent), `cond` (a branch), `signal` (wait for an outside event), `fanOut` (parallel branches),
  `shell` and `containerStep` (a sandboxed command), `eval` (score a result), and the four human
  nodes. Every node type, with its fields, output and a complete example, is in
  [workflow-nodes.md](./workflow-nodes.md). A node may also carry
  a short `title` and a `group` label, which only change how the graph is drawn and listed: the
  canvas shows the title in place of the id and can fold a group into one card, and the outline lists
  the steps in order under their groups. See
  [architecture.md](./architecture.md#presentation-fields-group-and-title).

- **Gate** — A place a run stops for a person. The human nodes — `humanApproval`, `humanDecision`,
  `humanInput`, and `humanReview` — park the run until someone answers in the approvals inbox or in
  Slack, or until a timeout routes it elsewhere. By default merging a pull request is the gate no template
  automates; the one opt-in exception is a repository's `auto` mode ([pr-evaluation.md](./pr-evaluation.md)). See [hitl-workflows.md](./hitl-workflows.md).

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
  later runs on the same repository. This legacy repository memory is separate from governed
  knowledge items.

- **Governed knowledge** — A versioned, evidence-backed summary with an owner, origin, visibility,
  review state, and publication history. Agent capture starts local and unreviewed; humans control
  approval and any wider summary publication. Retrieval returns untrusted evidence, not policy. See
  [knowledge.md](./knowledge.md).

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

The sidebar groups the dashboard into **Work** (Home, Approvals, Requests, Epics, All runs, Pull
requests and Tickets), **Teams** (member team spaces), **Build** (Workflow library, Agents, Skills
and Review presets), **Connect** (Connections, Model configuration, MCP connections and Bundles),
**Knowledge** and **Admin**. Each role sees only the destinations it may open. The single Knowledge
destination has role-filtered **Knowledge**, **Knowledge bases** and **Lessons** tabs at `/knowledge`,
`/knowledge-bases` and `/lessons`. Admin opens `/admin` with its own role-gated sub-navigation;
its **Platform review presets** label distinguishes it from Build's **Review presets**.
Settings and Docs are in the sidebar's user menu; Docs is also reachable from Help and the command
palette. Pages that moved keep their old addresses as permanent redirects, so a
bookmark to `/workflows`, `/govern/…` or `/studio/…` still opens the page.

On desktop, the sidebar toggles between expanded navigation and a complete icon rail, including
team initials, Start work and the user menu, with accessible labels and hover/focus tooltips.
The preference persists in local storage. Focused workflow-editor, run-detail and diff routes start
collapsed; expanding one applies only to that visit and does not change the saved preference.
Mobile uses an off-canvas drawer with focus trapping and Escape dismissal.

**Home** is the personal desk described in [teams.md](./teams.md): the signed-in engineer's teams and what is waiting on them across all of them.
Beneath it, Home lists the signed-in engineer's own requests in flight and their recent successful
results. These lists are always the viewer's own work across every team: no team is selected on
Home, and the team switcher only moves between team spaces. A successful execution is an output to review, not an acceptance of that output.

**Requests** (`/requests`) groups execution attempts by their work request. It defaults to the
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
Retrying a request that ran a workflow template applies the checks a fresh launch applies: the
template must be `ACTIVE` and visible to the caller through team membership, and a recorded run
input is validated against the template's input schema. This holds whether the request targeted a
repository or no repository; access to the repository or connection and the organization budget are
re-checked as well. The attempt still runs the template version the request recorded; the status and input
schema are read from the template as it is now. A refused retry answers `TEMPLATE_NOT_FOUND` (404)
or `INVALID_INPUT` (400), as a launch does.

**Start work** (`/start`) offers four modes: **Run a workflow**, **Run an agent**, **Run a
multi-repo epic** (a planner splits one brief into a child run per repository; team leads and
administrators only, enforced by the server as team LEAD or ADMIN on the team that owns each
repository) and **Run from a PRD** (the same gating; the form takes a title, the PRD text, an
optional tracker project and one or more repositories, and starts `POST /api/v1/prd-runs`). Every
mode collects inputs and shows a review screen; the workflow, agent and epic modes open the
launched request, and the PRD mode shows a link to the run (the request, until the workflow has
recorded its run). Workflow input drafts remain available when
switching templates or paths within the page. **Approvals**, the **Workflow library**, and
**Connections** remain directly available in the main navigation. **All runs** (`/runs`) is the
linkable execution-history screen for diagnostics.

The workflow picker and the library's Run links offer only hand-launchable templates.
System-managed templates run through the platform; review templates start from a finished
run's Reviews panel. Templates with `kind: "automation"`, including CI triage, PR feedback
and Channel Task, start through an automation or integration. This kind hides hand-launch
actions without preventing API or CLI launches.

The picker groups built-in workflows by outcome and shows readable titles, descriptions,
default markers and team badges. Search matches titles and template names, not descriptions.
Up to three recently run workflows appear first, without repeating in their categories.
Without a workflow deep link, the selected team's default takes precedence over the global
default. The process summary appears immediately after selection, before task details.
The side rail uses its declared phases, outputs and human steps: it mentions a pull request
only when the workflow declares one, and describes non-git work as updating a record or document.
Schema labels and enum choices use readable names while payload keys and values remain unchanged.
Required schema fields precede optional fields, preserving declared order within each group.
The outer sections carry the step numbers; Details and Review identify the form's current state.
Setup warnings and mode guidance expand from compact disclosures without losing their details.

A git-repository workflow without an input schema collects a required Repository, a Task name,
a multi-line Description and a Ticket ID. Only the Repository is required; the other three follow
these rules:

- **Task name** is display only. The run list shows it. The title shown for a request is its stored
  title (the `RunInput.title` column); when that is blank it is the label in the request's stored
  payload. When neither is set the title falls back to the first line of the Description, then to
  the Ticket ID. It never determines the Ticket ID.
- **Ticket ID** names the run's branch and workflow ID and, when an issue tracker is configured,
  selects the ticket the run reads. An absent or empty Ticket ID makes the run synthetic: it reads
  no tracker context and posts no ticket comments. A Task name that looks like a ticket ID is not
  used as one.
- **Description** is the agent's brief. It may be left empty when a Ticket ID is given and the
  ticket can be read. The server then builds the brief from the ticket after the launch is
  authorized: its first line is `Ticket <id>`, and the title and body sit inside a `<ticket>` fence
  as data, with every angle bracket in them neutralised. The ticket-derived brief applies on
  `POST /work-requests`, the Slack run modal and `auto-swe run` (where `--description` is optional)
  for any template. On the template-run route it applies only to a template whose input schema
  declares a string `description`. A request with no Task name and no Description is titled with
  that first line. If the ticket cannot be read, the tracker is unreachable, the ticket is outside
  `github.trackerAllowedProjectKeys`, or the brief does not satisfy the schema's rules for
  `description`, the launch is refused with `DESCRIPTION_REQUIRED` (the Slack modal asks for a typed
  description instead). Text typed in Description wins over the ticket. An `Idempotency-Key` replay
  compares the typed description, so a blank description matches a blank one. The agent also
  receives the ticket as fenced context, and on a conflict it follows the Description and records
  the conflict in its implementation notes. The allowed-projects setting is described in
  [`configuration.md` §9](./configuration.md#jira-and-linear-project-allowlist).
- **Description scan** is an advisory prompt-injection check on text a person typed. It runs on
  the template-run route, `POST /work-requests` and the Slack run modal, and it never sees a brief
  built from a ticket. It matches only the INJECTION patterns and never blocks a launch. The audit
  row for the launch records which patterns matched (their labels, never the text) as
  `descriptionScan`. On the template-run route and `POST /work-requests`, a non-empty match adds
  `warnings: [{ code: 'DESCRIPTION_INJECTION_SUSPECTED', message }]` to the `201` response; the
  CLI prints the message to stderr, and Slack records the audit only.
- **Fetch title** beside the Ticket ID calls `GET /api/v1/tickets/preview` with the ticket ID and
  the connection ID. It shows the ticket's title, status and URL, and nothing else from the ticket.
  It answers `503 TRACKER_UNAVAILABLE` when the tracker could not be read.

Other workspace providers keep their own inputs. Free-text schema fields
named description, brief, instructions, message or prdContent use multi-line inputs unless
they declare fixed choices.

### In-app help

Terms in this vocabulary are defined once, in the dashboard's glossary, and surfaced where they
appear. A **help tip** is a small question-mark button beside a label; hovering, focusing, or
clicking it opens a popover with the plain-language definition and a link to the doc that owns the
term, named for it ("Learn more about <term>", for example "Learn more about gate"). It closes on Escape, an outside click, or when focus
leaves. The popover is positioned against the button, so a table or scrolling panel does not clip it; inside a modal dialog it is placed within that dialog, and Escape there
closes only the tip, leaving the dialog open. The **?** button in the top bar opens the page's
**Help** panel: a dialog holding whatever explanation the current page declares, such as a link to
the doc that explains the page or the **How auto-swe works** overview of the request, run, gate,
pull request, and merge lifecycle, which states that no built-in step or template merges a pull
request. A page that declares none shows a note and a link to the documentation, and the panel
closes when the route changes. Definitions in the glossary agree with this document, and a test checks that every doc
and heading they link to exists.

Guided paths build on those pieces:

- **Home** shows an administrator the setup card until the platform is ready, then a dismissible
  guide to the governance pages in the order an administrator meets them. An engineer or team lead
  sees a dismissible "Your first run" list. Its four steps tick from real data (a visible
  repository, a started request, a gate the viewer has answered, a merged pull request from the
  viewer's own requests), and the list hides itself once all four are done. A viewer whose runs
  never reach a gate keeps the list until they dismiss it. A gate answered on a run the viewer can
  no longer see does not count, so the step can untick after a team change. Dismissal is
  remembered in the viewer's browser only, and a "Show it again" line at the foot of Home brings
  the hidden guide back. The setup card stays out of the way until the readiness check has
  answered, so a fully set-up administrator never sees a placeholder.
- **The product tour** is short and optional, and nothing starts it automatically. Take the tour on
  Home's header starts it, and so does Take the product tour in the Help panel (the ? in the top
  bar), which every page has. The tour is a card that walks through the sidebar pages the viewer's
  role can open, from Start work, Approvals and Requests to the Workflow library, the Admin entry
  and Docs; the Admin step names more for leads and more again for administrators, who also see the
  Agents step. Next and Back move between steps, Skip tour, Done or Escape ends it, and Take the
  tour again replays it. The tour never blocks the page, and ending it returns focus to the button
  that started it.
- **Page tours** cover the workflow editor and the run page. Their Help panel also offers Tour this
  page, a card that points at the palette, canvas, node inspector, Check workflow and status bar of
  the editor, or at the verdict, layout switch and trace of a run. A page tour ends, without
  counting as the product tour, when the viewer leaves the page.
- **Start work** carries a collapsible "Need help choosing?" guide that recommends a mode, and a "Try a sample task"
  button on each form that only fills the fields, never launches, and leaves the review screen in
  place. The agent sample asks for a read-only explanation; the epic and workflow samples ask for a
  small README change, which a launched run can turn into a real pull request. The epic sample gets
  a new placeholder ticket id on every fill, and the workflow sample is offered only when the
  workflow has a free-text field to fill. The epic mode is offered to team leads and administrators only.
- **Policies**, **Platform settings**, and **Workflow defaults** open with a warning that states
  the blast radius of a change there.
- **The workflow editor** explains each node type in the inspector and the palette, and its
  **Check workflow** button reports the structural and expression-syntax check that runs as you
  edit and also asks the server for the checks a save would run, including whether the agents and
  MCP connections it names exist and, for a saved template, whether the version being edited is
  still the newest. It never runs the workflow, and when the server check cannot run
  it says so and shows the editor result only. The palette shows a node's help in one shared panel
  instead of a tab stop per node.
- **A run's page** opens with a plain-language verdict derived from the run's recorded status,
  open gates, failed step, and result, and has a collapsed guide to reading the page.
- **The scanner page** can try a pattern against several samples on the server, under the
  scanner's time limit, without saving anything. Each sample is its own field and may span lines,
  so the `m` and `s` flags can be tried.
- **The docs reader** filters titles and summaries as you type and, once you pause, asks the server
  to search the text of every served doc. A word matches another form of the same word (plurals
  and the common -ing and -ed endings, so `cases` finds `case` and `approved` finds `approve`, but
  `speed` never finds `spend` and `rate` never finds `rat`), and
  the best 20 sections are listed with a link to the section.

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
- The guided paths are per viewer: dismissing one is stored in that browser and does not follow
  the person to another browser.
- The product tour points only at the sidebar. A step whose page link is hidden, because its
  sidebar section is collapsed or the mobile menu is closed, appears as a centered card instead.
  A tour started from the Help panel keeps running when a sidebar link is followed; one started
  from Home ends there, and counts as seen. Only the workflow editor and the run page have a page
  tour, and a step whose element is hidden (the palette below the lg breakpoint) is centered.
- None of the "Your first run" steps are narrowed to a team. The merged-pull-request step ticks
  only when the webhook that records a merge is configured, and it ticks when anyone merges a pull
  request from the viewer's request. The repository step looks at the
  first 500 connections the viewer can see.
- The run verdict cannot say who a gate is waiting on, because gate records carry no assignee.
- Docs search needs a signed-in session. Matching is English-only and stem-based, so irregular
  forms and synonyms are not found, there is no typo tolerance, and every word must appear in one
  section. Queries are cut at 100 characters and 8 words. The server starts building the index when
  it starts, in the background and a document at a time so other requests are still served and
  start-up is not delayed. That takes under a second on a development machine, more on a
  small container, and a search that arrives before it finishes waits for it. If the build fails,
  it is logged and the first search tries again. The server needs the docs on disk beside it. If
  the text search fails, the reader keeps filtering by title and summary and says the text search
  is unavailable.

## Limitations

- **Jira and Linear reads are unrestricted until an operator sets `github.trackerAllowedProjectKeys`.**
  The default is empty, so any launcher who can reach a repository can read any ticket the platform's
  tracker credential can see, through **Fetch title**, the brief and the worker's ticket read. Once an
  admin lists project keys, a ticket outside them reads as not found. The list does not restrict
  Jira or Linear writes, such as comments and transitions.
- **A launch of a global template without a repository applies only the GLOBAL allowed-projects
  value, and the preview needs a reachable repository.** A launch with no git repository resolves
  the list at the launching template's team and organization, but a global template has no team, so
  a list set only at TEAM or ORGANIZATION does not reach such a launch. **Fetch title** is offered
  only once a repository is chosen.
- **The Description scan is advisory and pattern-based.** It applies only the INJECTION patterns, not
  the EXFILTRATION set, which matches ordinary prose such as URLs. The web form does not show its
  warning. A reworded instruction can pass it, so it is not a security boundary, and the typed text
  still reaches the agent as the brief in the user message, unchanged.
