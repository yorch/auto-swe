# Workflow nodes

> How to write a workflow spec by hand: what each node type does, what it reads and writes, how it
> fails, and a complete example of each that you can paste into the editor's JSON view.

A workflow template version is a `WorkflowSpec`: a JSON graph of nodes that the interpreter walks on
Temporal, one node at a time, from the entry node until a `terminate` node ends the run. The spec
supports 15 node types. This page is the reference for all of them; for how the engine is put
together see [architecture.md](./architecture.md#4-workflow-engine), and for the vocabulary see
[concepts.md](./concepts.md). [workflow-inventory.md](./workflow-inventory.md) is the generated
catalog beside it: every node type and registered step, and which built-in templates use each.

Every example below is a complete spec. A unit test
(`packages/shared/src/workflow/nodeReference.docs.test.ts`) parses each one with the same schema a
save uses and runs `validateSpec` over it, and fails on any error or warning, so the examples cannot
drift from what the editor accepts.

---

## 1. Anatomy of a spec

```json
{
  "schemaVersion": 1,
  "name": "hello",
  "description": "The smallest useful spec: write a value, then end the run with it.",
  "entry": "greet",
  "nodes": {
    "greet": {
      "type": "set",
      "values": { "context.greeting": { "literal": "hello" } },
      "next": "done"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "greeting": { "from": "context.greeting" } }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Always `1`. A save with any other value is refused. |
| `name` | 1–120 characters. |
| `description` | Up to 2000 characters; defaults to empty. |
| `entry` | The id of the first node. It must be a key of `nodes`. |
| `nodes` | A map of node id → node. An id is 1–64 characters. |

Edges are node fields that name another node id (`next`, `onTrue`, `onTimeout`, …). The schema
refuses a spec whose edge names a node that is not in `nodes`, so a typo fails the save rather than
the run. Loops are allowed: a `cond` may point back at an earlier node, and the run is bounded by a
transition cap instead (§4).

Beyond the schema, `validateSpec` (`packages/shared/src/workflow/validateSpec.ts`) reports findings
before a run. Its **errors** are an unparseable expression (`EXPR_SYNTAX`), no reachable `terminate`
(`NO_TERMINAL`), a write path through `__proto__`, `prototype` or `constructor`
(`RESERVED_PATH_SEGMENT`) and an internal step (`INTERNAL_STEP`). Its **warnings** are an
unreachable node (`UNREACHABLE`), a node with no path to a `terminate` (`NODE_CANT_TERMINATE`), a
`from` binding under a node id that does not exist (`UNKNOWN_NODE_REF`), an unknown step
(`UNKNOWN_STEP`) or missing required step config (`MISSING_CONFIG`), a step spelling of a typed node
(`STEP_HAS_TYPED_NODE`), a field the interpreter never reads (`IGNORED_FIELD`), a fan-out branch that
can reach its own join (`FANOUT_LEAK`), a `signal` reachable inside a fan-out whose branches run
concurrently (`SIGNAL_SHARED_ACROSS_BRANCHES`), a `terminate` reachable only inside a fan-out branch
(`TERMINAL_IN_SUBGRAPH_ONLY`), and a `group` whose nodes are not connected
(`GROUP_NOT_CONTIGUOUS`).

How a save treats them:

- A spec that fails the schema, or that names an internal step, is refused (`400 INVALID_SPEC`).
- Every other finding, errors included, is reported with the saved version and does not block the
  save, so a work-in-progress draft is never lost.
- A version with any `validateSpec` error cannot be promoted to active, used as an experiment arm,
  or made live by setting its template back to `ACTIVE`: each answers `409 SPEC_HAS_ERRORS`. A
  version that saves with an `EXPR_SYNTAX` error is therefore kept but cannot be put in front of
  runs that way. The one exception is a new template's first version, which is active from
  creation, so fix errors before creating a template.

`POST /api/v1/workflow-templates/validate` answers with exactly what a save would report.

## 2. The run context

Every binding and expression reads from one object, the run context. A run starts with four roots:

| Root | Holds |
|---|---|
| `request` | The launch request: `payload` (the run's input, validated against the template's input schema when it declares one), `description`, `externalTicketId`, `repoId` and the rest of the request the run was started with. |
| `context` | Scratch space for the spec. It starts as `{ "workspace": { "connectionId": …, "provider": … } }`, the run's target connection and workspace provider; `set`, `storeAs` and some steps write here. |
| `nodes` | Starts empty. A node that produces output writes it at `nodes.<id>.output`, and a thrown error kept under `onFail: "warn"` or `onError: "continue"` writes `nodes.<id>.error` (§4). |
| `workflow` | `{ "id": … }`, the Temporal workflow id, read as `workflow.id`. |

Writes are visible to every node that runs after them. `nodes.<id>` is keyed by the node's id in the
spec, so a node that runs twice in a loop overwrites its own output.

**Inside a fan-out branch** the context is a sealed copy. The branch sees `request`, `workflow` and a
deep copy of `context`; `nodes` starts empty again; and three roots are added: the item at
`<itemKey>` (default `subtask`), its zero-based position at `<itemKey>Index`, and
`fanOut` = `{ "index": …, "itemKey": … }`. Nothing a branch writes reaches the parent except what the
`fanOut` node collects (§6, `fanOut`).

The value a `terminate` node returns is the run's result. It is not readable by other nodes: the run
has ended when it is produced.

## 3. Bindings and expressions

A **binding** is an object in one of three forms — `from` (optionally with a `default`), `literal`
or `expr`:

| Form | Value |
|---|---|
| `{ "from": "<path>" }` | The value at that path in the context. |
| `{ "from": "<path>", "default": … }` | The same, or `default` when the path resolves to `undefined` (a missing key, not `null`). |
| `{ "literal": … }` | The literal JSON value, unevaluated. |
| `{ "expr": "<expression>" }` | The value of an expression (below), up to 2000 characters. |

Bindings are accepted in `inputs` (on `step`, `agent`, `mcp`, `shell` and `containerStep`),
`set.values`, `terminate.result`, `fanOut.over`, `eval.target`, `eval.candidateRef` and
`humanApproval.approverCount`. An `eval` node's `inputs` is accepted by the schema but ignored, and
`validateSpec` reports it as `IGNORED_FIELD`.

A **path** is dot-separated keys with optional brackets: `nodes.draft.output.text`,
`context.items[0]`, `nodes.split.output.results[1].exports['context.summary']`. A key that is missing,
or a step through `null` or a non-object, resolves to `undefined` rather than failing.

Some fields take a **plain path**, not a binding:

| Field | Read or write | Notes |
|---|---|---|
| `contextFrom` (`humanApproval`, `humanDecision`) | read | Shown to the person answering. |
| `contentFrom` (`humanReview`) | read | The content under review. |
| `storeAs` (`signal`, `humanDecision`, `humanInput`, `humanReview`) | write | Where the payload is also stored. |
| keys of `set.values` | write | One path per key. |
| `fanOut.exports` | read, in the branch | Each entry is read from the branch's context. |
| `fanOut.pluck` | read, per result entry | Relative to one entry of `results`. |

Write paths are split on `.` only, so a bracket in a write path is part of a key, not an index.

An **expression** (a `cond` node's `expr`, an `expr` binding, an `eval` node's `assert` scorer) is a
small, side-effect-free language defined in `packages/shared/src/workflow/expr.ts`:

- **paths**, as above, starting with a letter, `_` or `$`;
- **literals**: numbers (`3`, `-1`, `0.5`), strings in single or double quotes (`\n`, `\t` and
  `\<char>` escapes), `true`, `false`, `null`;
- **arithmetic** `+ - * /`, on numbers only — `+` does not join strings;
- **comparison** `== != < <= > >=`. `==` and `!=` are strict (no coercion); the ordering operators
  require numbers on both sides;
- **logic** `&& || !`, which short-circuit and yield `true` or `false`;
- **nullish default** `a ?? b`, which yields `a` unless it is `null` or `undefined`;
- **parentheses** for grouping.

There are no function or method calls, no assignment and no `===`. A syntax error is a
`validateSpec` error (`EXPR_SYNTAX`) wherever the expression sits: a `cond`, an `expr` binding, an
`assert` scorer or `approverCount`. A type error — `<` with `undefined` on one side, `+` on a string
— is raised only when the expression is evaluated, and fails the node that evaluated it, so guard
optional values: `(context.attempts ?? 0) < 3`, not `context.attempts < 3`. The `assert` scorer is
the exception: an expression it cannot evaluate, whether a type error or a syntax error in a version
saved anyway, makes the assert fail rather than the node.

## 4. Failure handling

**Dispatch nodes** (`step`, `agent`, `mcp`, `shell`, `containerStep`, `eval`) call an activity. One
fails in either of two ways: the activity throws, or it returns an output whose `passed` is `false`
(a *gate failure* — `shell` and `eval` report their verdict this way). Either is handled by the
node's `onFail`. The two differ in what they leave behind: a gate failure's output is written to
`nodes.<id>.output` and nothing is written to `nodes.<id>.error`, while a thrown error leaves no
output and, when the run continues past it, writes `nodes.<id>.error`.

| `onFail` | After the failure |
|---|---|
| `"block"` (default) | The run fails. A gate failure's output is still written to `nodes.<id>.output` first. |
| `"warn"` | The step is recorded FAILED and the run continues at `next`. `nodes.<id>.output` holds the gate failure's output, or `null` after a throw, and only a throw writes `nodes.<id>.error`. |
| `{ "retry": N }` | The node runs again, up to N more times (N is 1–10). If the last attempt fails too, the run fails as under `block`. An error the activity marks non-retryable is not retried. |

`onError: "continue"` is the older spelling for "keep going": when the activity **throws**, the step
is recorded SKIPPED, `nodes.<id>.output` is `null`, `nodes.<id>.error` is set, and the run continues
at `next`. It takes precedence over `onFail` for a throw — so it also short-circuits
`onFail: { "retry": N }`: the first throw continues instead of retrying — and does not apply to a
gate failure.

`nodes.<id>.error` is the thrown error converted to a string. What reaches the workflow is usually
Temporal's wrapper around the activity's error (`ActivityFailure: Activity task failed`), not the
activity's own message, so treat it as a marker that the node failed, test it with
`nodes.<id>.error != null`, and read the cause in the run viewer, which records each attempt's
error on its step.

Activity-level retry and timeouts are not per node: the worker runs each kind of step under a fixed
retry and timeout policy, so `retry`, `startToCloseTimeout` and `heartbeatTimeout` on a node have no
effect and `validateSpec` reports them as `IGNORED_FIELD`. Use `onFail: { "retry": N }` for a
workflow-level retry.

Three failures bypass `onFail` and `onError` altogether:

- **A binding that cannot be evaluated** (an `expr` that raises a type error) fails the node before
  its first attempt.
- **A cancellation** of the run, or of a fan-out branch by its fan-out, ends the work it interrupts.
- **The transition cap.** Every node visit counts, across every fan-out branch, and a run that
  exceeds `workflow.maxTransitions` (default 500, pinned when the run starts) fails as a likely
  infinite loop.

The other nodes have no failure policy. A `cond` whose expression raises, a `set` whose binding
raises, and a `fanOut` whose `over` is not an array each fail the run — or, inside a fan-out branch,
the branch, which the fan-out then handles by its `onBranchFail`. A wait that times out is not a
failure: it takes the node's `onTimeout` edge.

A run that fails ends with status `FAILED`. A run that reaches a `terminate` node ends with that
node's `status`, which may itself be `FAILED`.

## 5. Common fields

These fields mean the same on every node type that has them; the per-type tables in §6 list the rest.

| Field | On | Meaning |
|---|---|---|
| `group` | every node | Presentation only: a phase label (up to 40 characters) that groups nodes on the canvas and in the outline. See [architecture.md](./architecture.md#presentation-fields-group-and-title). |
| `title` | every node | Presentation only on the non-human nodes: a name (up to 80 characters) shown in place of the id. On the four human nodes it is required and is the approver's heading (up to 200 characters). |
| `next` | `step`, `agent`, `mcp`, `shell`, `containerStep`, `eval`, `set` | The node to run afterwards. A node with no `next` ends the run with status `SUCCESS` and an empty result; `validateSpec` warns `NODE_CANT_TERMINATE` so it is visible. Prefer an explicit `terminate`. |
| `onFail` | dispatch nodes | `"block"`, `"warn"` or `{ "retry": N }` (§4). |
| `onError` | dispatch nodes | `"fail"` (default) or `"continue"` (§4). |
| `retry`, `startToCloseTimeout` | dispatch nodes | Accepted so stored specs parse; never read (§4). |
| `heartbeatTimeout` | `step`, `agent`, `mcp`, `eval` | Accepted so stored specs parse; never read (§4). |

## 6. Node reference

### `step`

**Purpose.** Run one registered activity from the step catalog: open a pull request, run the quality
gates, implement a change, write a status. The catalog is the registry in
`packages/shared/src/workflow/stepRegistry.ts`, served at `GET /api/v1/workflow-steps/registry` and
shown in the editor palette; [workflow-inventory.md](./workflow-inventory.md#registered-steps) lists
every registered step with its description and config fields.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `step` | yes | The registered step's name. An unknown name is a `UNKNOWN_STEP` warning and fails at run time. |
| `config` | no | Static settings for the step. Each step declares its own config fields; a missing required one is a `MISSING_CONFIG` warning. |
| `inputs` | no | Bindings resolved when the node runs. A step reads its own named inputs; several accept a required config field from `inputs` instead. |

`next`, `onFail`, `onError`, `group`, `title` and the ignored `retry`, `startToCloseTimeout`,
`heartbeatTimeout` are as in §5.

**Edges.** `next`.

**Output.** Whatever the step's activity returns, at `nodes.<id>.output`. Each step documents its
own shape; `updateDomainState` returns `{ "status": … }`, so the example's value is at
`nodes.mark.output.status`.

**Failure.** `onFail` and `onError` as in §4. Steps that run a quality gate return
`{ "passed": false, … }` on a failing check, which is a gate failure.

**Built-in examples.** `ticket-to-merge`, `hotfix`, `code-and-ci`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "step-example",
  "description": "Write a status label, then end the run with it.",
  "entry": "mark",
  "nodes": {
    "mark": {
      "type": "step",
      "step": "updateDomainState",
      "config": { "status": "drafting" },
      "next": "done"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "status": { "from": "nodes.mark.output.status" } }
    }
  }
}
```

**Pitfalls.**

- Four steps are the executors behind typed nodes (`runAgentNode`, `mcpCallTool`, `runEvalNode`,
  `runContainerStep`). Naming one in a `step` works but loses the typed node's checked fields and
  form, and `validateSpec` warns `STEP_HAS_TYPED_NODE`. A `step` naming `runContainerStep` is gated
  exactly like a `containerStep` node: the same authoring permission, image allowlist and audit.
- Steps flagged internal belong to a platform template; naming one is an `INTERNAL_STEP` error.
- Many steps act on the run's repository and fail when the run was started without a connection.

**See also.** [architecture.md](./architecture.md#node-types) for the engine, and the step catalog
in the editor palette.

### `agent`

**Purpose.** Run a library Agent by reference and keep its answer. The Agent supplies the model, the
system prompt, the skills and the tools; the node supplies the message.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `agentRef` | yes | `<key>` (the most specific active version) or `<key>@<version>` (that version). |
| `userMessage` | no | The literal message sent to the agent. |
| `inputs` | no | Bindings. Without `userMessage`, a single string input is sent as the message itself, and anything else is sent as the inputs' JSON. |
| `systemPrompt` | no | Replaces the Agent's own system prompt for this node. |
| `workspace` | no | `true` runs the agent in a throwaway checkout of the run's repository, at the run's branch (the base branch before the run has pushed one), with the workspace tools its Agent grants. Nothing it changes is kept. |
| `spanName` | no | The trace and cost-attribution name (default `llm.agent_node`). |

**Edges.** `next`.

**Output.** `nodes.<id>.output.text` holds the agent's final text. `nodes.<id>.output.object` is set
only when the run produced structured output; the node supplies no output schema, so read `text`.

**Failure.** A model, tool or budget error throws and is handled by `onFail` (§4). With
`workspace: true`, a run that has no repository fails the node with a non-retryable error.

**Built-in examples.** `create-issue-from-brief`, `product-prd-draft`, `zendesk-ticket-reply`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "agent-example",
  "description": "Ask a writing agent for a short update and return its text.",
  "entry": "draft",
  "nodes": {
    "draft": {
      "type": "agent",
      "agentRef": "contentWriter",
      "inputs": {
        "brief": {
          "from": "request.payload.brief",
          "default": "Write a two-line product update."
        }
      },
      "next": "done"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "text": { "from": "nodes.draft.output.text" } }
    }
  }
}
```

**Pitfalls.**

- `agentRef` is checked against the Agent library when the spec is saved, as a warning; a missing
  Agent fails the node, not the save.
- Steering sent to a channel task reaches the next `agent` node to start, never one already running.
- Without `workspace: true` the agent has no repository access, and an Agent set to run on a harness
  runs on the Mastra loop instead (see [agents.md](./agents.md)).

**See also.** [agents.md](./agents.md) for Agents, versions, runtimes and tools.

### `mcp`

**Purpose.** Call one tool on an MCP server as a workflow step, with the node's inputs as the tool's
arguments.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `connectionRef` | yes | The id of an active `mcp` Connection (its URL is the server). |
| `tool` | yes | The tool's name as the server lists it. |
| `inputs` | no | Bindings; the resolved object is the tool's argument object. |
| `spanName` | no | Accepted but ignored (`IGNORED_FIELD`). |

**Edges.** `next`.

**Output.** `nodes.<id>.output.result` holds what the tool returned.

**Failure.** A connection that is not an active `mcp` Connection, one the run's team may not use, a
tool the server does not list, and an error from the tool all throw, under `onFail` (§4). A tool the
server does not mark read-only is treated as a write: it is refused while the run's latest autonomy
decision requires an approval that has not been recorded, and a retry returns the first call's recorded result
instead of calling the tool again.

**Built-in examples.** None of the built-in templates uses this node.

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "mcp-example",
  "description": "Call one search tool on an MCP server and return what it found.",
  "entry": "checkPolicy",
  "nodes": {
    "checkPolicy": {
      "type": "step",
      "step": "publishOutcome",
      "config": { "action": "internal_read" },
      "inputs": { "description": { "literal": "search the MCP server" } },
      "next": "lookup"
    },
    "lookup": {
      "type": "mcp",
      "connectionRef": "00000000-0000-4000-8000-000000000000",
      "tool": "search",
      "inputs": {
        "query": { "from": "request.payload.query", "default": "release notes" }
      },
      "next": "done"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "found": { "from": "nodes.lookup.output.result" } }
    }
  }
}
```

Replace the `connectionRef` with the id of one of your team's `mcp` Connections. The
`publishOutcome` step declares what this call is judged as — `internal_read` for a lookup — because
the spec cannot know what a tool does: an unannotated tool is treated as a write at run time, and
`validateSpec` warns (`WRITE_WITHOUT_POLICY`) when an `mcp` node is not reached through that step.

**Pitfalls.**

- `connectionRef` is a literal id. It is checked when the spec is saved (a warning when it does not
  resolve or the template's team cannot reach it) and again when the node runs.
- An Agent can also use MCP tools while it reasons; that is the Agent's `mcp` tool key, not this node.

**See also.** [agents.md](./agents.md) for MCP on Agents; [mcp-server.md](./mcp-server.md) is the
platform's own MCP endpoint, which is a different thing.

### `shell`

**Purpose.** Run a command you write in a locked-down, throwaway container, against a checkout of the
run's branch, and push any changes it makes.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `image` | yes | The image to run in. It must be on the team's effective allowlist: the built-in images (for example `node:24-alpine`, `python:3.13-alpine`, `eclipse-temurin:21-jdk-alpine`, `golang:1.26-alpine`, `alpine:latest`) plus the team's additions. |
| `command` | yes | The shell command, up to 8000 characters. |
| `inputs` | no | Bindings. Only three are read: `inputs.command` and `inputs.image` replace the node's own when they resolve to strings, and `inputs.branch` names the branch to check out and to push changes to (default the run's work branch). |
| `network` | no | `"none"` (default) or `"egress"` for outbound traffic, filtered by the team's egress allowlist (see Pitfalls for what that filter does). |
| `memory` | no | A Docker memory limit such as `"512m"` (the default) or `"1g"`. |
| `cpus` | no | A CPU limit from 0.1 to 8 (default 1). |
| `timeoutMs` | no | The command's wall clock, 1000–3600000 ms (default 600000), capped at 50 minutes when it runs. |
| `config` | no | Accepted for the editor's form; not passed to the container. |

**Edges.** `next`.

**Output.** `nodes.<id>.output.passed` is `true` when the command exited 0 and any changes it made
were committed and pushed to the branch. `nodes.<id>.output.exitCode` and `nodes.<id>.output.summary` describe the
command, `nodes.<id>.output.artifactId` names the stored log when there is one, and the output also
carries `persisted`, `filesChanged` and, when it committed, `committedSha`.

**Failure.** Almost everything that goes wrong is a gate failure — `passed: false`, under `onFail`
(§4), with the reason in `summary` and no `nodes.<id>.error`:

- a non-zero exit, a kill, or a timeout of the command (`exitCode` `124`);
- a container that could not start (Docker's own non-zero exit, such as `125` for an image it
  cannot pull);
- an image that is not on the team's allowlist when the node runs (`exitCode` `126`);
- a command that passed but whose changes could not be committed and pushed (`persisted` is
  `false`).

The activity throws only when the run has no repository connection, the clone fails, or the
workspace volume cannot be created.

**Built-in examples.** `db-migration-dry-run`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "shell-example",
  "description": "Check that package.json declares a license, and branch on the result.",
  "entry": "test",
  "nodes": {
    "test": {
      "type": "shell",
      "image": "node:24-alpine",
      "command": "node -e 'const p = require(\"./package.json\"); if (!p.license) { console.error(\"package.json has no license field\"); process.exit(1); }'",
      "onFail": "warn",
      "next": "check"
    },
    "check": {
      "type": "cond",
      "expr": "nodes.test.output.passed == true",
      "onTrue": "done",
      "onFalse": "failed"
    },
    "done": { "type": "terminate", "status": "SUCCESS" },
    "failed": {
      "type": "terminate",
      "status": "FAILED",
      "result": { "summary": { "from": "nodes.test.output.summary" } }
    }
  }
}
```

**Pitfalls.**

- Saving a spec with a `shell` node needs the team-admin role on the template's team (platform admin
  for a global template), the image must be allowed when the spec is saved, and every save is
  audited. An image supplied through `inputs.image` is checked only when the node runs.
- The run must be scoped to a repository connection.
- The command runs in `/workspace/repo`, the checkout. The root filesystem is read-only, with no
  Docker socket and no network unless `"egress"` is set; only `/workspace` (a volume) and `/tmp` (a
  64 MB tmpfs) are writable. A command that installs dependencies needs `"egress"` and a home and
  cache outside the checkout, such as `HOME=/workspace/.home`: anything left inside
  `/workspace/repo` is committed and pushed, and `/tmp` is too small for most package caches. The
  example above reads a file and writes nothing, so it runs with the defaults.
- The egress allowlist filters by name, not by address. With entries, the container's DNS answers
  only for the listed hosts; a connection to a literal IP address is not blocked. With an empty
  allowlist, `"egress"` is unrestricted outbound access.
- `inputs.branch` is also where changes are pushed. When the branch does not exist yet, the run's
  base branch is checked out and any changes are pushed as the new branch.

**See also.** `containerStep` for a structured JSON contract instead of a command.

### `containerStep`

**Purpose.** Run an image as a coded capability with a JSON contract: the node's inputs go in as
JSON, and the container answers with JSON. Untrusted code runs in the same locked-down container as
`shell`, never in the worker.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `image` | yes | As for `shell`: on the team's effective allowlist. |
| `command` | no | A `sh -c` command; without one the image's own entrypoint runs. |
| `inputs` | no | Bindings. The resolved object is passed as JSON in the `CONTAINER_STEP_INPUT` environment variable (and as the request body for `sidecar`). |
| `transport` | no | How the result comes back: `"stdout"` (default, one JSON value printed), `"ndjson"` (a stream of JSON lines; the result is the last `{ "type": "result", "result": … }` event, else the last JSON line) or `"sidecar"` (the image serves HTTP and the worker POSTs to it). |
| `sidecar` | for `sidecar` | `port` (required), `requestPath` (default `/`), `readinessPath` (polled before the request; default the request path) and `readyTimeoutMs` (default 30000). |
| `network` | no | `"none"` (default) or `"egress"`. A `sidecar` always runs on bridge networking, under the egress allowlist. |
| `memory`, `cpus` | no | As for `shell`. |
| `timeoutMs` | no | The command's wall clock (default 600000 ms), capped at 50 minutes. For `sidecar` it bounds the HTTP request; waiting for readiness is bounded separately by `readyTimeoutMs`. |

**Edges.** `next`.

**Output.** `nodes.<id>.output.result` holds the parsed JSON result. With `"ndjson"`,
`nodes.<id>.output.events` holds every line received, a line that is not JSON kept as
`{ "type": "log", "log": … }`.

**Failure.** A non-zero exit, output that is not valid JSON, a sidecar that is never ready or
answers with an error status, and an image that is not allowed all throw, under `onFail` (§4).

**Built-in examples.** None of the built-in templates uses this node.

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "container-step-example",
  "description": "Pass text into a container and read back the JSON it prints.",
  "entry": "measure",
  "nodes": {
    "measure": {
      "type": "containerStep",
      "image": "node:24-alpine",
      "command": "node -e 'const i = JSON.parse(process.env.CONTAINER_STEP_INPUT); console.log(JSON.stringify({ length: i.text.length }))'",
      "inputs": {
        "text": { "from": "request.payload.text", "default": "hello world" }
      },
      "next": "done"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "length": { "from": "nodes.measure.output.result.length" } }
    }
  }
}
```

**Pitfalls.**

- Authoring is gated exactly like `shell`: the same role, the same image allowlist at save and at
  run time, and the same audit.
- The run must be scoped to a repository connection, whose team's allowlists apply. The container
  gets an empty `/workspace`, not a checkout.
- Print exactly one JSON value on stdout with the `"stdout"` transport; log to stderr.

**See also.** [bundles.md](./bundles.md), which ships container steps as signed, coded
capabilities.

### `eval`

**Purpose.** Score a value already in the context with a list of scorers and decide whether it
passes, either to stop the run or to branch on.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `target` | yes | A binding to the value under evaluation. |
| `scorers` | yes | At least one scorer, each with a `kind` (below). |
| `judgeAdvisory` | no | `true` (default): a judge only informs. `false`: a judge below the configured threshold, or one that could not score, blocks. |
| `candidateRef` | no | A binding to the branch a `gate` scorer checks out; default the run's work branch. |
| `inputs` | no | Accepted but ignored by the scorers (`IGNORED_FIELD`). The bindings are still resolved and recorded on the step, so one that raises still fails the node. |
| `spanName` | no | Accepted but ignored (`IGNORED_FIELD`). |

Scorer kinds: `gate` (with `gate`, a quality gate such as `runTests`, and optional `command`) runs a
real check against the candidate branch, and needs a run started from a work request with a ticket
id and a repository connection even when `candidateRef` names the branch; `assert` (with `expr`) evaluates an expression against the
target, whose paths start with `$.`; `policy` (with `riskClass`) passes when the run's autonomy policy
lets that risk class act alone; `pii` passes when no active PII scanner pattern matches;
`trajectory` scores the run's recorded tool calls; `judge` (with `rubricRef`) asks the `evalJudge`
agent to score the target against a rubric. `gate`, `assert`, `policy` and `pii` are the floor;
`trajectory` and `judge` are soft, and a judge does not run when the floor fails. A `judge` scorer's
`baselineFrom` and a `trajectory` scorer's `from` are accepted but ignored (`IGNORED_FIELD`).

**Edges.** `next`.

**Output.** `nodes.<id>.output.passed` is `true` unless the decision blocked.
`nodes.<id>.output.decision` is `{ "blocked": …, "reason": … }`, so
`nodes.<id>.output.decision.blocked` is the verdict and `decision.reason` says why;
`nodes.<id>.output.summary` is the same reason as the step's message (`eval blocked: …` when it
blocked). `nodes.<id>.output.floorPassed` says whether every floor scorer passed,
`nodes.<id>.output.score` is 0 when the floor failed and otherwise the mean of the soft scores that
scored (1 when there are none), and `nodes.<id>.output.perAxis` maps each scorer that scored to its
value. A scorer that could not score (a judge with a missing rubric or a failed call) is left out of
`perAxis` and `score` and named in `nodes.<id>.output.errors`, with the reason. One `EvalResult` row
is recorded per scorer that ran; a judge skipped because the floor failed has none.

**Failure.** A blocked decision is a gate failure (`passed: false`), so `onFail` applies (§4): the
default `"block"` fails the run, `"warn"` records the step as failed and continues at `next` with the
output in place and no `nodes.<id>.error`, and `{ "retry": N }` scores again. A scorer that cannot
score fails or is reported in `errors` rather than throwing. When the activity does throw (a
database error, say), `"warn"` leaves `nodes.<id>.output` as `null` and sets `nodes.<id>.error`. To branch on
the verdict instead of failing, set `onFail: "warn"` and follow the node with a `cond` on
`nodes.<id>.output.passed == true` (see Pitfalls for why not `decision.blocked`).

**Built-in examples.** None of the built-in templates uses this node.

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "eval-example",
  "description": "Draft an update, refuse it if it leaks personal data, and branch on the verdict.",
  "entry": "draft",
  "nodes": {
    "draft": {
      "type": "agent",
      "agentRef": "contentWriter",
      "userMessage": "Write a two-line product update.",
      "next": "check"
    },
    "check": {
      "type": "eval",
      "target": { "from": "nodes.draft.output" },
      "scorers": [{ "kind": "pii" }, { "kind": "assert", "expr": "$.text != null" }],
      "onFail": "warn",
      "next": "decide"
    },
    "decide": {
      "type": "cond",
      "expr": "nodes.check.output.passed == true",
      "onTrue": "done",
      "onFalse": "held"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "text": { "from": "nodes.draft.output.text" } }
    },
    "held": {
      "type": "terminate",
      "status": "FAILED",
      "result": { "reason": { "from": "nodes.check.output.decision.reason" } }
    }
  }
}
```

**Pitfalls.**

- Under `onFail: "warn"`, an eval that **threw** leaves `nodes.<id>.output` as `null`, so
  `nodes.<id>.output.decision.blocked != true` is true for it. Test for the positive,
  `nodes.<id>.output.passed == true`, so a crashed eval does not read as a pass.
- An `assert` that cannot be evaluated counts as failed, not as an error. Its expression is run
  with the target as the entire context: every `$.` is removed from the text before it is
  evaluated — even inside a quoted string, so `$.status == '$.x'` compares with `'x'` — and every
  path then reads from the target. `context.x` or `nodes.x` in an assert reads a key of the target,
  not the run. The target must be an object for `$.field` to resolve.
- A `gate` scorer that cannot run (no work request, ticket id or repository, a clone failure) fails
  rather than passing. Name `candidateRef` whenever the code is not on the run's own branch.

**See also.** [evals.md](./evals.md#2-the-eval-node) for scorers, rubrics and the offline harness.

### `set`

**Purpose.** Write values into the context: initialise a counter, copy a field to a shorter path,
compute a value with an expression.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `values` | yes | A map of write path → binding. Entries are applied in order, so a later binding reads an earlier write. |

**Edges.** `next`.

**Output.** None: a `set` node writes only the paths it names, not `nodes.<id>.output`.

**Failure.** A binding that raises fails the run; so does a write path through a reserved segment
(which `validateSpec` reports as an error first).

**Built-in examples.** `ticket-to-merge`, `ci-triage-and-fix`, `parallel-fan-out`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "set-example",
  "description": "Initialise a counter and copy a launch field into the context.",
  "entry": "init",
  "nodes": {
    "init": {
      "type": "set",
      "values": {
        "context.attempts": { "literal": 0 },
        "context.topic": { "from": "request.payload.topic", "default": "release" },
        "context.label": { "expr": "context.attempts + 1" }
      },
      "next": "done"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": {
        "topic": { "from": "context.topic" },
        "label": { "from": "context.label" }
      }
    }
  }
}
```

**Pitfalls.**

- Write under `context.`. A write path may name any root, including `nodes` and `request`, and
  overwriting them misleads every node after it.
- Write paths split on `.` only: `context.items[0]` writes a key literally named `items[0]`.

**See also.** §3 for bindings.

### `cond`

**Purpose.** Branch on a boolean expression. A `cond` whose `onFalse` or `onTrue` points back at an
earlier node is how a spec loops.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `expr` | yes | An expression (§3); its value is read as true or false. |
| `onTrue` | yes | The node to run when it is true. |
| `onFalse` | yes | The node to run when it is false. |

**Edges.** `onTrue`, `onFalse`.

**Output.** None.

**Failure.** An expression that raises a type error fails the run; there is no `onFail`.

**Built-in examples.** `approve-before-pr`, `model-catalog-refresh`, `ci-triage-and-fix`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "cond-example",
  "description": "Route urgent requests one way and everything else another.",
  "entry": "triage",
  "nodes": {
    "triage": {
      "type": "cond",
      "expr": "(request.payload.priority ?? 0) >= 3",
      "onTrue": "urgent",
      "onFalse": "normal"
    },
    "urgent": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "route": { "literal": "urgent" } }
    },
    "normal": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "route": { "literal": "normal" } }
    }
  }
}
```

**Pitfalls.**

- Guard optional operands with `??`: a missing value compared with `<` fails the run.
- A node id read in an expression must look like an identifier. In an expression,
  `nodes.check-pii.output` reads as `nodes.check` minus `pii.output`; a `from` binding has no such
  limit.
- A loop needs an exit. `validateSpec` cannot see that a loop's condition eventually turns false,
  and the transition cap (§4) is the only bound.

**See also.** §7 for a bounded retry loop.

### `fanOut`

**Purpose.** Run a subgraph once per item of an array, in parallel up to a limit, then continue
once every branch has finished.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `over` | yes | A binding that must resolve to an array. |
| `subgraph` | yes | The first node of each branch. |
| `join` | yes | The node to run after every branch has finished. |
| `itemKey` | no | Where each branch finds its item (default `subtask`); its index is at `<itemKey>Index`. |
| `concurrency` | no | Branches run at once, 1–20. Without it the run uses `workflow.fanoutConcurrency` (default 4, pinned when the run starts). |
| `onBranchFail` | no | `"block"` (default): the first failed branch stops new branches, cancels running ones and fails the fan-out. `"continue"`: the fan-out finishes and continues at `join` whatever the branches did. |
| `exports` | no | Up to 20 paths read from each branch's context when it ends, stored under each result's `exports`, keyed by the path. |
| `pluck` | no | A path relative to one result entry (`result.text`, `exports['context.summary']`); the values are collected into `plucked`. |

**Edges.** `subgraph`, `join`.

**Output.** `nodes.<id>.output.count` is the number of items, `nodes.<id>.output.results` holds one
`{ "status", "result", "exports"?, "error"? }` entry per branch that ran, in item order,
`nodes.<id>.output.succeeded` and `nodes.<id>.output.failed` count them, and
`nodes.<id>.output.skipped` counts the items never started because a `"block"` fan-out stopped
early. With `pluck`, `nodes.<id>.output.plucked` is the plucked value of each entry, `null` where
the path is missing.

**Failure.** A branch fails when one of its nodes fails the branch or it reaches a `terminate` whose
status is not `SUCCESS`. Under `"block"` that fails the fan-out node, and so the run; under
`"continue"` it is only counted. An `over` that is not an array fails the run.

**Built-in examples.** `parallel-fan-out`, `consensus-review`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "fan-out-example",
  "description": "Summarise several topics in parallel and collect the summaries.",
  "entry": "seed",
  "nodes": {
    "seed": {
      "type": "set",
      "values": {
        "context.topics": { "literal": ["billing", "search", "onboarding"] }
      },
      "next": "split"
    },
    "split": {
      "type": "fanOut",
      "over": { "from": "context.topics" },
      "itemKey": "topic",
      "subgraph": "summarise",
      "join": "done",
      "concurrency": 3,
      "pluck": "result.text"
    },
    "summarise": {
      "type": "agent",
      "agentRef": "contentWriter",
      "inputs": {
        "brief": { "literal": "Write a two-sentence customer update about this topic." },
        "topic": { "from": "topic" }
      },
      "next": "branchDone"
    },
    "branchDone": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "text": { "from": "nodes.summarise.output.text" } }
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "summaries": { "from": "nodes.split.output.plucked" } }
    }
  }
}
```

**Pitfalls.**

- A branch ends at a `terminate`. One that can walk on into `join` (or back into the fan-out) runs
  the rest of the workflow once per branch; `validateSpec` warns `FANOUT_LEAK`.
- A `terminate` inside a branch ends that branch, not the run. A spec whose only reachable
  `terminate` nodes are inside branches gets `TERMINAL_IN_SUBGRAPH_ONLY`.
- An `exports` key is the path itself, dots included, so pluck it with brackets:
  `exports['context.summary']`.
- A human node in a branch waits on a branch-unique signal (`hitl_split[0]/approve`), so each branch
  is answered separately. A `signal` node does not: its name is shared by every branch, so one
  delivery wakes one branch. `validateSpec` warns `SIGNAL_SHARED_ACROSS_BRANCHES` when a `signal` is
  reachable inside a fan-out whose `concurrency` is unset or above 1; set `"concurrency": 1` to run
  the branches one at a time, so each wait gets its own delivery.
- Every branch's nodes count toward the run's transition cap (§4).

**See also.** §7 for collecting branch values with `exports`.

### `terminate`

**Purpose.** End the run (or, inside a fan-out branch, the branch) with a status and a result.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `status` | yes | `SUCCESS`, `FAILED`, `TIMED_OUT` or `SKIPPED`. |
| `result` | no | A map of key → binding; the resolved map is the run's result. |

**Edges.** None.

**Output.** None in the context. `result` becomes the run's result, shown on the run page and
returned to whatever started the run; inside a fan-out branch it becomes that branch's `result`.

**Failure.** A `result` binding that raises fails the run.

**Built-in examples.** `hotfix`, `ticket-to-merge`, `parallel-fan-out`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "terminate-example",
  "description": "End immediately with a fixed result.",
  "entry": "done",
  "nodes": {
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "message": { "literal": "nothing to do" } }
    }
  }
}
```

**Pitfalls.**

- A result key named `status` does not change the run's status.
- `CANCELLED` is not a terminate status; a run is cancelled from outside it.

**See also.** §4 for how a run's final status is decided.

### `signal`

**Purpose.** Wait for a named Temporal signal from outside the run, such as a CI result or a deploy
finishing, with a timeout.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The signal name to wait for. |
| `timeout` | yes | A positive duration such as `"30m"`, `"24h"` or `"7d"` (not ISO 8601). |
| `onReceive` | yes | The node to run when the signal arrives. |
| `onTimeout` | yes | The node to run when the timeout elapses first. |
| `storeAs` | no | A write path that also receives the payload. |

**Edges.** `onReceive`, `onTimeout`.

**Output.** The signal's payload, whatever it is, at `nodes.<id>.output` (and at `storeAs`). A
timeout writes nothing.

**Failure.** None: a timeout takes `onTimeout`.

**Built-in examples.** `ticket-to-merge`, `external-approval-gate`, `code-and-ci`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "signal-example",
  "description": "Wait up to two hours for a deploy to report back.",
  "entry": "wait",
  "nodes": {
    "wait": {
      "type": "signal",
      "name": "deployFinished",
      "timeout": "2h",
      "storeAs": "context.deploy",
      "onReceive": "done",
      "onTimeout": "expired"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "deploy": { "from": "nodes.wait.output" } }
    },
    "expired": { "type": "terminate", "status": "TIMED_OUT" }
  }
}
```

**Pitfalls.**

- A signal that arrives before the run reaches the node is kept and satisfies the wait, but only
  one is kept per name: a second delivery before the wait replaces the first, so two deliveries
  ahead of the wait collapse into one. Each kept payload satisfies one wait.
- The platform delivers the signals its own integrations send (the GitHub webhooks deliver
  `ciPipelineSignal` and `humanMergeSignal` to the built-in engineering templates). For any other
  name, send the signal to the run's Temporal workflow yourself, for example with the Temporal CLI
  (`temporal workflow signal --workflow-id <id> --name deployFinished --input '{"ok":true}'`) —
  there is no gateway route that sends an arbitrary signal.
- For a person, use a human node instead: it creates an inbox item, notifies Slack and records who
  answered.

**See also.** [hitl-workflows.md](./hitl-workflows.md) for the human nodes.

### `humanApproval`

**Purpose.** Pause the run until a person approves or rejects, in the approvals inbox or in Slack.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | The heading the approver sees (up to 200 characters). |
| `description` | no | Up to 2000 characters of explanation. |
| `contextFrom` | no | A path whose value is shown with the request. |
| `approverCount` | no | A binding to the number of distinct approvals needed (default 1). |
| `timeout` | yes | A positive duration, as for `signal`. |
| `onApprove` | yes | The node to run when approved. |
| `onReject` | yes | The node to run when rejected. |
| `onRequestChanges` | no | When set, the gate offers a third action — request changes — which needs a written note and routes here. |
| `onTimeout` | yes | The node to run when nobody answers in time. |

**Edges.** `onApprove`, `onReject`, `onRequestChanges` (optional), `onTimeout`.

**Output.** The response at `nodes.<id>.output`: `nodes.<id>.output.action` is `"approve"`,
`"reject"` or — on a gate with `onRequestChanges` — `"request_changes"`, and
`nodes.<id>.output.resolvedBy` is the id of the user who answered — with
`approverCount` above 1, the approver whose approval completed the count (or whoever rejected or
requested changes, either of which resolves the step at once). A `request_changes` answer also
carries `nodes.<id>.output.comment`, the required feedback; approve and reject comments stay
stored-only and never reach the workflow.
There is no `storeAs`.

**Failure.** None: a timeout takes `onTimeout` and marks the inbox item timed out.

**Built-in examples.** `approve-before-pr`, `four-eyes`, `db-migration-dry-run`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "approval-example",
  "description": "Ask two people to approve before continuing.",
  "entry": "approve",
  "nodes": {
    "approve": {
      "type": "humanApproval",
      "title": "Ship this change?",
      "description": "Two approvals are needed.",
      "contextFrom": "request.payload.summary",
      "approverCount": { "literal": 2 },
      "timeout": "24h",
      "onApprove": "shipped",
      "onReject": "rejected",
      "onTimeout": "expired"
    },
    "shipped": { "type": "terminate", "status": "SUCCESS" },
    "rejected": { "type": "terminate", "status": "FAILED" },
    "expired": { "type": "terminate", "status": "TIMED_OUT" }
  }
}
```

**Pitfalls.**

- A rejection or change request requires a written reason. A rejection's reason is shown to the requester but is not part of
  the output; a change request's note is — the workflow reads it at `nodes.<id>.output.comment`.
- With `approverCount` above 1, a single rejection still rejects, and a single change request resolves the step the same way.

**See also.** [hitl-workflows.md](./hitl-workflows.md).

### `humanDecision`

**Purpose.** Pause the run until a person picks one of 2–10 options, each leading somewhere
different.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | The heading (up to 200 characters). |
| `description` | no | Up to 2000 characters. |
| `contextFrom` | no | A path whose value is shown with the question. |
| `options` | yes | 2–10 of `{ "label", "value", "next" }`: what the person sees, what is recorded, and where the run goes. |
| `storeAs` | no | A write path that also receives the response. |
| `timeout` | yes | A positive duration. |
| `onTimeout` | yes | The node to run when nobody answers in time. |

**Edges.** `onTimeout`, and each option's `next` (`options[i].next`).

**Output.** The response at `nodes.<id>.output`, with the chosen option's value at
`nodes.<id>.output.value` (and the whole response at `storeAs`, so read `<storeAs>.value`).

**Failure.** None. A response whose value matches no option is recorded as a failed step and takes
`onTimeout`.

**Built-in examples.** `security-triage`, `tiered-escalation`, `human-code-review`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "decision-example",
  "description": "Let a person choose whether to send now or hold.",
  "entry": "choose",
  "nodes": {
    "choose": {
      "type": "humanDecision",
      "title": "Send the update now?",
      "options": [
        { "label": "Send now", "value": "send", "next": "sent" },
        { "label": "Hold", "value": "hold", "next": "held" }
      ],
      "storeAs": "context.choice",
      "timeout": "1h",
      "onTimeout": "expired"
    },
    "sent": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "choice": { "from": "context.choice.value" } }
    },
    "held": { "type": "terminate", "status": "SKIPPED" },
    "expired": { "type": "terminate", "status": "TIMED_OUT" }
  }
}
```

**Pitfalls.**

- Route on the option's `next`, not on a `cond` over the stored value; the edges are what the canvas
  draws and what `validateSpec` checks.

**See also.** [hitl-workflows.md](./hitl-workflows.md).

### `humanInput`

**Purpose.** Pause the run until a person fills in a short typed form, then use the answers.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | The heading (up to 200 characters). |
| `description` | no | Up to 2000 characters. |
| `fields` | yes | 1–20 of `{ "key", "label", "type", "required"?, "options"? }`; `type` is `text`, `number`, `boolean` or `select`, and `options` lists a `select`'s choices. |
| `storeAs` | no | A write path that also receives the response. |
| `timeout` | yes | A positive duration. |
| `onSubmit` | yes | The node to run once the form is submitted. |
| `onTimeout` | yes | The node to run when nobody answers in time. |

**Edges.** `onSubmit`, `onTimeout`.

**Output.** The response at `nodes.<id>.output`, with the answers keyed by field `key` at
`nodes.<id>.output.value` (and the whole response at `storeAs`, so read
`<storeAs>.value.<key>`).

**Failure.** None: the form is validated against `fields` before the run is resumed, and a timeout
takes `onTimeout`.

**Built-in examples.** `scope-clarification`, `fully-supervised`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "input-example",
  "description": "Ask who an update is for before writing it.",
  "entry": "form",
  "nodes": {
    "form": {
      "type": "humanInput",
      "title": "Who is this update for?",
      "fields": [
        {
          "key": "audience",
          "label": "Audience",
          "type": "select",
          "options": ["internal", "external"],
          "required": true
        },
        { "key": "notes", "label": "Notes", "type": "text" }
      ],
      "storeAs": "context.form",
      "timeout": "1h",
      "onSubmit": "done",
      "onTimeout": "expired"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "audience": { "from": "context.form.value.audience" } }
    },
    "expired": { "type": "terminate", "status": "TIMED_OUT" }
  }
}
```

**Pitfalls.**

- An optional field left empty may be missing, `null` or an empty string in the answers, so read
  it with a `default` and treat an empty string as no answer.

**See also.** [hitl-workflows.md](./hitl-workflows.md).

### `humanReview`

**Purpose.** Show a person some content — a draft, a diff, a plan — and continue once they have
read it, with any note they leave.

**Fields.**

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | The heading (up to 200 characters). |
| `description` | no | Up to 2000 characters. |
| `contentFrom` | yes | A path to the content shown for review. |
| `storeAs` | no | A write path that also receives the response. |
| `timeout` | yes | A positive duration. |
| `onSubmit` | yes | The node to run once the review is submitted. |
| `onTimeout` | yes | The node to run when nobody answers in time. |

**Edges.** `onSubmit`, `onTimeout`.

**Output.** The response at `nodes.<id>.output`, with the reviewer's note (a string of up to 2000
characters, absent when they left none) at `nodes.<id>.output.value` (and the whole response at
`storeAs`, so read `<storeAs>.value`).

**Failure.** None: a timeout takes `onTimeout`.

**Built-in examples.** `human-code-review`, `prd-decomposition`, `fully-supervised`

**Example.**

```json
{
  "schemaVersion": 1,
  "name": "review-example",
  "description": "Have a person read a draft before it is returned.",
  "entry": "draft",
  "nodes": {
    "draft": {
      "type": "agent",
      "agentRef": "contentWriter",
      "userMessage": "Write a two-line product update.",
      "next": "review"
    },
    "review": {
      "type": "humanReview",
      "title": "Read the draft",
      "contentFrom": "nodes.draft.output.text",
      "storeAs": "context.review",
      "timeout": "24h",
      "onSubmit": "done",
      "onTimeout": "expired"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": {
        "text": { "from": "nodes.draft.output.text" },
        "notes": { "from": "context.review.value", "default": "" }
      }
    },
    "expired": { "type": "terminate", "status": "TIMED_OUT" }
  }
}
```

**Pitfalls.**

- A review does not change the content: the reviewer's note is all that comes back. To act on it,
  pass it to a later node.
- A review cannot refuse. Follow it with a `humanApproval` when the person must be able to stop the
  run.

**See also.** [hitl-workflows.md](./hitl-workflows.md).

## 7. Patterns

### Bounded retry loop

Draft, check, and try again up to three times. The counter is set before each attempt, the `eval`
uses `onFail: "warn"` so a failed check routes instead of failing the run, and the second `cond` is
the loop's exit.

```json
{
  "schemaVersion": 1,
  "name": "draft-check-retry",
  "description": "Draft an update, check it, and retry up to three times.",
  "entry": "count",
  "nodes": {
    "count": {
      "type": "set",
      "values": { "context.attempts": { "expr": "(context.attempts ?? 0) + 1" } },
      "next": "draft"
    },
    "draft": {
      "type": "agent",
      "agentRef": "contentWriter",
      "inputs": {
        "brief": {
          "from": "request.payload.brief",
          "default": "Write a two-line product update."
        }
      },
      "next": "check"
    },
    "check": {
      "type": "eval",
      "target": { "from": "nodes.draft.output.text" },
      "scorers": [{ "kind": "pii" }],
      "onFail": "warn",
      "next": "decide"
    },
    "decide": {
      "type": "cond",
      "expr": "nodes.check.output.passed == true",
      "onTrue": "done",
      "onFalse": "retry"
    },
    "retry": {
      "type": "cond",
      "expr": "context.attempts < 3",
      "onTrue": "count",
      "onFalse": "failed"
    },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": { "text": { "from": "nodes.draft.output.text" } }
    },
    "failed": {
      "type": "terminate",
      "status": "FAILED",
      "result": { "attempts": { "from": "context.attempts" } }
    }
  }
}
```

Each pass overwrites `nodes.draft.output` and `nodes.check.output`, so the `cond` always reads the
latest attempt.

### Fan-out and collect

Each branch writes its own value into its context and `exports` lifts it out; `pluck` flattens the
exports into one array for the next node. The agent gets two inputs, so they are sent as their JSON
and the instruction travels with each branch's item.

```json
{
  "schemaVersion": 1,
  "name": "fan-out-and-collect",
  "description": "Assess several product areas in parallel and collect one note from each.",
  "entry": "seed",
  "nodes": {
    "seed": {
      "type": "set",
      "values": { "context.areas": { "literal": ["onboarding", "billing"] } },
      "next": "split"
    },
    "split": {
      "type": "fanOut",
      "over": { "from": "context.areas" },
      "itemKey": "area",
      "subgraph": "review",
      "join": "done",
      "onBranchFail": "continue",
      "exports": ["context.note"],
      "pluck": "exports['context.note']"
    },
    "review": {
      "type": "agent",
      "agentRef": "productAnalyst",
      "inputs": {
        "task": { "literal": "In two sentences, name the biggest risk in this product area." },
        "area": { "from": "area" }
      },
      "next": "keep"
    },
    "keep": {
      "type": "set",
      "values": { "context.note": { "from": "nodes.review.output.text" } },
      "next": "branchDone"
    },
    "branchDone": { "type": "terminate", "status": "SUCCESS" },
    "done": {
      "type": "terminate",
      "status": "SUCCESS",
      "result": {
        "notes": { "from": "nodes.split.output.plucked" },
        "failed": { "from": "nodes.split.output.failed" }
      }
    }
  }
}
```

With `onBranchFail: "continue"`, a branch that failed contributes `null` to `plucked` and is counted
in `failed`, and the run still reaches `done`.

### Wait for Qodo's review of the pull request

The `awaitQodoReview` step waits for and reads Qodo's review of the pull request the run just
opened. It reads the review Qodo's own PR bot produces; it cannot start one, so it works only where
that bot is installed. Details, the result's fields and the credential rules are in
[qodo.md §6](./qodo.md#6-waiting-for-qodos-review-in-a-workflow).

| Part | Contract |
|---|---|
| `inputs.prUrl`, `inputs.headSha` | The pull request's URL and the head commit the review must cover; bind them from the node that opened it |
| `config.waitSeconds` | Optional, 0 to 600; default the `qodo.reviewWaitSeconds` setting |
| `config.minActionLevel` | Optional; open findings below this level are ignored |
| output | `status` (`reviewed`, `pending`, `stale`, `unavailable`, `disabled`), `reviewedHeadSha`, `headMatches`, `counts`, `worst`, `blocking`, `findings` (at most 25), `truncated`, `withheldFields`; never a `passed` field |

The node names no connection: the team, and so the Qodo credential, is the run's repository's.
The step never fails the run, so it blocks only if the template routes on it. Qodo's finding text
is untrusted; never bind `findings` into an agent prompt unfenced. A template carrying this step
spends up to `qodo.reviewWaitSeconds` (default 180) and repeated MCP reads on every run of a
repository without the Qodo PR bot; a wait of 0 makes it a single read. The `qodoReview()` authoring
helper emits the two nodes below.

```json
{
  "schemaVersion": 1,
  "name": "qodo-review-example",
  "description": "Open a pull request, wait for Qodo's review, and ask a person when it blocks.",
  "entry": "openPR",
  "nodes": {
    "openPR": {
      "type": "step",
      "step": "createOrUpdatePullRequest",
      "inputs": { "codeResult": { "from": "context.currentCodeResult" } },
      "next": "savePrInfo"
    },
    "savePrInfo": {
      "type": "set",
      "values": {
        "context.prNumber": { "from": "nodes.openPR.output.prNumber" },
        "context.prUrl": { "from": "nodes.openPR.output.prUrl" }
      },
      "next": "qodoReview"
    },
    "qodoReview": {
      "type": "step",
      "step": "awaitQodoReview",
      "config": { "waitSeconds": 240 },
      "inputs": {
        "prUrl": { "from": "context.prUrl" },
        "headSha": { "from": "context.currentCodeResult.headSha" }
      },
      "onFail": "warn",
      "next": "qodoGate"
    },
    "qodoGate": {
      "type": "cond",
      "expr": "nodes.qodoReview.output.blocking == true",
      "onTrue": "qodoDecision",
      "onFalse": "done"
    },
    "qodoDecision": {
      "type": "humanDecision",
      "title": "Qodo found a blocking issue. Continue anyway?",
      "options": [
        { "label": "Continue", "value": "continue", "next": "done" },
        { "label": "Stop", "value": "stop", "next": "stopped" }
      ],
      "storeAs": "context.qodoChoice",
      "timeout": "24h",
      "onTimeout": "stopped"
    },
    "done": { "type": "terminate", "status": "SUCCESS" },
    "stopped": { "type": "terminate", "status": "FAILED" }
  }
}
```

`qodoReview` follows the node that records `context.prUrl`, and `qodoDecision` offers to continue or
stop. To fail closed when Qodo did not finish, pass `failClosed: true` to `qodoReview()`, which
gates on
`nodes.qodoReview.output.status != 'reviewed' || nodes.qodoReview.output.blocking == true`.
The built-in `ticket-to-merge-qodo` template places this pattern between green CI and the merge
wait (see [qodo.md §6](./qodo.md#6-waiting-for-qodos-review-in-a-workflow)).

## Limitations

- **No per-node activity timeouts or retry policy.** The worker fixes them per kind of step; the node
  fields that look like they set them are ignored (§4).
- **The expression language is deliberately small.** No function calls, no string building, and a
  type error surfaces only when the expression is evaluated, failing the run. `validateSpec` checks
  syntax, and checks that a `from` binding under `nodes.` names a real node, but not the paths inside
  an expression.
- **A `signal` name is shared across fan-out branches**, so a signal inside a concurrent branch wakes
  only one of them; `"concurrency": 1` is the workaround. Human nodes do not have this problem.
- **A `signal` keeps one undelivered payload per name**, so deliveries that arrive before the wait
  collapse into the last one.
- **No gateway route sends an arbitrary named signal.** A spec's own signals are delivered through
  Temporal by whatever owns the event.
- **`shell` and `containerStep` need a run scoped to a repository connection**, whose team supplies
  the image and egress allowlists.
- **An `agent` node has no output schema**, so its answer is text; structured data must be parsed
  out by a later node.
- **A loop's termination is not proven.** `validateSpec` checks that a path to a `terminate`
  exists, not that a loop takes it; the transition cap is the backstop.
- **Write paths do not understand brackets**, unlike read paths.
