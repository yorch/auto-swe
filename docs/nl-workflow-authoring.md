# Natural-Language Workflow Authoring

> Describe an automation in plain language; an AI agent assembles a valid
> `WorkflowSpec` and saves it as a **DRAFT** template for a human to review,
> edit on the canvas, and activate.

Entry points: web canvas, gateway API + CLI, and the Slack
channel assistant. Generated drafts can then be **refined conversationally** —
describe a change and it's applied as a new version (web chat panel + Slack
thread follow-ups).

---

## 1. What it does

A workflow in auto-swe is a JSON DAG (`WorkflowSpec`) validated by a single Zod
schema (`packages/shared/src/workflow/spec.ts`). This feature lets a user produce
one from a sentence instead of hand-building it node by node:

1. The user describes the workflow ("when a ticket comes in, run the implementer,
   then the review network, open a PR, and pause for approval before merge").
2. A model-backed **`workflowAuthor`** agent generates a `WorkflowSpec`, picking
   only from the building blocks that actually exist in the user's workspace.
3. The result is validated and **persisted as a `DRAFT` template** — never
   auto-activated. The human reviews/edits it on the canvas, then activates it.

The trust model is deliberate: a generated workflow can run agents in Docker, run
shell nodes, and open PRs, so a human gate sits between generation and execution.
Shell / `containerStep` nodes inherit the same authoring RBAC + image-allowlist +
audit as the hand-authored path, and the author agent is told not to emit them
unless the requester may author shell and the intent requires it.

---

## 2. How it works

```
   intent ──▶ gateway POST /workflow-templates/generate
                  │  (RBAC: same as create; allowShell hint from role)
                  ▼
          temporal: WorkflowAuthorWorkflow  ── start + await ──┐
                  │                                            │
                  ▼                                            │
          activity: generateWorkflowSpec (worker)             │
            1. build catalog (steps + agents + mcp in scope)  │
            2. resolve `workflowAuthor` agent spec            │
            3. loop (≤3): model → JSON.parse → parseWorkflowSpec
                 └─ on error, feed errors back & retry        │
                  ▼                                            │
          validated WorkflowSpec ◀───────────────────────────┘
                  │
                  ▼
          persist DRAFT WorkflowTemplate v1  ──▶  canvas review ──▶ activate
```

Generation runs in the **worker** because that is where models bind
(`getModel`/`resolveAgent`); the gateway never calls an LLM directly. The gateway
starts `WorkflowAuthorWorkflow` and awaits its result (request/response, not a
long-running run).

### The generate → validate → repair loop

`generateWorkflowSpec` (`packages/worker/src/activities/generateWorkflowSpec.ts`)
is the heart of the feature. The author agent returns the spec as a **JSON
string** (a 15-way discriminated union round-trips poorly through structured-output
JSON-schema conversion). Each round:

- `JSON.parse` the returned `specJson`;
- run `parseWorkflowSpec` (the canonical Zod gate);
- on a JSON or schema error, feed the **concrete errors** back to the model and
  retry (bounded at 3 attempts).

This repair loop is what makes generation reliable: the validator, not the model,
is the source of truth, and the model gets a precise diff to fix.

### The catalog

So the model can only reference real building blocks, the activity renders a
catalog into the prompt (`packages/shared/src/workflow/authoring.ts`):

- **Registered steps** — from the in-process step registry (`listSteps()`).
- **Library agents** — every `Agent` at GLOBAL or the requester's team scope.
- **MCP connections** — the team's active `mcp` `Connection`s (team-scoped only).
- A shell-allowed/denied note.

The static format reference (the `WorkflowSpec` shape, all node types, binding
syntax, rules) lives in the seeded `WORKFLOW_AUTHOR_PROMPT` system prompt; the
dynamic catalog + the user's intent go in the user message.

---

## 3. Entry points

| Surface | How |
|---|---|
| **Web** | Workflow library (`/templates`) → **"Generate with AI"** → describe → routes to the canvas editor for the new DRAFT. |
| **API (sync)** | `POST /api/v1/workflow-templates/generate` `{ prompt, teamId?, name? }` → `{ data: template, spec, summary, attempts, warnings? }`. Errors are distinguished: `422 GENERATION_FAILED` when the model can't produce a valid spec (rephrase) vs `503 GENERATION_UNAVAILABLE` for an infra failure. Shell-capable (audited) authoring path. |
| **API (async)** | `POST /api/v1/workflow-templates/generate/jobs` → `202 { jobId }`; poll `GET /api/v1/workflow-templates/generate/jobs/:jobId` → `{ status: running\|done\|failed, phase \| result \| code }`. Non-blocking (no proxy idle-timeout); persists the DRAFT worker-side; refuses shell nodes. |
| **Explain** | `POST /api/v1/workflow-templates/:id/explain` → `{ data: { explanation } }` (Markdown), CLI `auto-swe workflows explain <name>`, web "Explain" button. The inverse of authoring. |
| **Refine (web)** | Template page (`/templates/[id]`) → **"Refine with AI"** → a chat panel where each plain-language change calls `POST /api/v1/workflow-templates/:id/refine` `{ prompt }` → `{ data: version, spec, summary, attempts, warnings? }`. Each turn saves a **new DRAFT version** off the latest and updates the canvas. Gated on ADMIN/LEAD. |
| **Refine (Slack)** | A follow-up in the same thread ("also add a security review step") → the channel assistant's `refineWorkflow` tool → applies the change to the draft that thread generated (linked via `ChannelThreadSession.lastGeneratedTemplateId`) and saves a new version. Budget-gated; refuses shell nodes; replies with the new version (or "nothing to refine yet"). |
| **CLI** | `auto-swe workflows generate "<description>" [--name=NAME] [--team=<slug>]` |
| **Slack** | The channel assistant's `generateWorkflow` tool: ask it to "create a workflow that…" and it drafts one (scoped to the channel's team, `allowShell: false`) and replies in-thread with the draft name + a pointer to the Workflow library. The draft is **budget-gated** like a delegated task, and the channel path is never shell-authorized — a generated spec containing `shell`/`containerStep` nodes is refused (those require canvas authoring with the proper RBAC + audit). |

---

## 4. Key files

| Concern | File |
|---|---|
| Author agent prompt | `packages/shared/src/lib/agentPrompts.ts` → `WORKFLOW_AUTHOR_PROMPT` |
| Catalog + output schema + message builders | `packages/shared/src/workflow/authoring.ts` |
| Seeded `workflowAuthor` Agent | `packages/shared/src/lib/syncBuiltins.ts` |
| Generation activity (loop) | `packages/worker/src/activities/generateWorkflowSpec.ts` |
| Author workflow | `packages/worker/src/workflows/workflowAuthor.ts` |
| Gateway endpoint | `packages/gateway/src/routes/workflowTemplates.ts` (`POST /generate`) |
| Temporal client bridge | `packages/gateway/src/plugins/temporal.ts` (`generateWorkflowSpec`) |
| CLI command | `packages/cli/src/commands/workflows.ts` (`generate`) |
| Web modal + hook | `packages/web/src/app/workflows/library/page.tsx`, `packages/web/src/hooks/useTemplates.ts` |
| Slack tool + draft activity | `packages/worker/src/activities/channelAssistant.ts`, `packages/worker/src/activities/channelWorkflowDraft.ts` |
| Refine message builder | `packages/shared/src/workflow/authoring.ts` → `buildRefineRequestMessage` |
| Refine endpoint + version helper | `packages/gateway/src/routes/workflowTemplates.ts` (`POST /:id/refine`, `createTemplateVersion`) |
| Web refine chat panel + hook | `packages/web/src/components/workflow/RefineChatPanel.tsx`, `useRefineWorkflowTemplate` in `packages/web/src/hooks/useTemplates.ts` |
| Slack refine activity + thread link | `packages/worker/src/activities/channelWorkflowRefine.ts`, `ChannelThreadSession.lastGeneratedTemplateId` |

---

## 5. Design notes

- **DRAFT, never auto-activate.** The canvas review step reuses all existing
  editor + RBAC machinery; activation is an explicit human action.
- **`workflowAuthor` is model-backed but not in `MODEL_BACKED_AGENT_KEYS`** —
  like `evalJudge`, it is seeded with a default model (`anthropic/claude-opus-4-8`)
  and resolved on demand, so it never gates worker boot (`assertConfigReady`).
- **Cost + tracing** flow through the same `runAgent` path as every other LLM
  activity (OTel span `llm.workflow_author`, `recordLlmUsage`, `AgentTrace`).
- **One persist path.** Both `POST /` (ACTIVE) and `POST /generate` (DRAFT) go
  through the shared `createTemplateWithInitialVersion` helper, so the
  template + v1 + shell-audit transaction can't drift between the two routes.
- **Coded / container steps.** When shell authoring is permitted, the catalog
  lists the team's effective image allowlist (built-in + additions) and the
  `containerStep` contract, so generated workflows can use bundle-shipped coded
  capabilities. The async/channel paths refuse shell nodes (no audit there).
- **Async generation.** The web uses a non-blocking job (`/generate/jobs` →
  poll) so a long generation never holds the HTTP request open (proxy-safe); the
  job persists the DRAFT worker-side, so re-polling is idempotent.
- **Explain.** `workflowExplainer` reads a spec and returns a Markdown
  walkthrough — the inverse of authoring.
- **Conversational refinement.** `generateWorkflowSpec` takes an optional
  `baseSpec`; when set it runs the same generate→validate→repair loop in *refine*
  mode (seeded with the current spec via `buildRefineRequestMessage`, asked to
  return the full updated spec, not a diff). Refinements save a **new version**
  of the same template (never a new template), so history is preserved and the
  human still activates. The gateway `POST /:id/refine` refines the latest
  version and pins the spec name to the template; the Slack path anchors the
  thread to its draft via `ChannelThreadSession.lastGeneratedTemplateId` (a
  plain UUID — a deleted template reads as "nothing to refine"). Both save
  paths reuse the shared `createTemplateVersion` (concurrency-safe append +
  shell audit); the channel path additionally refuses shell nodes.
- **Expression language.** `cond.expr` / `{ expr }` bindings use the
  interpreter's restricted **safe** expression language (`==` not `===`, no
  method calls), documented in `WORKFLOW_AUTHOR_PROMPT`. An integration test
  executes a generated spec through the real interpreter to keep this honest.
- **Pre-execution validation.** `validateSpec` (`packages/shared/src/workflow/validateSpec.ts`)
  is a pure analyzer that runs *beyond* the schema: it lints every `cond`/binding
  expression for **syntax** (catches the `===`/method-call class via the
  parse-only `checkExprSyntax`, without false-positiving on valid relational/
  arithmetic exprs like `count >= 3`), checks reachability + that a `terminate`
  is reachable, validates `nodes.<id>` binding provenance, and flags unknown
  steps / missing required config. It returns structured `{ errors, warnings }`.
  Wiring: the **generation repair loop** hard-gates on `errors` (the author
  self-corrects unrunnable graphs); the **gateway save** is *advisory* — findings
  are returned as non-blocking `warnings` (mirroring `validateSpecRefs`, so a
  work-in-progress draft is never rejected) and it's ready to back a **canvas
  live-lint** panel. Graph-edge enumeration lives once in `nodeEdges` (`spec.ts`),
  shared by the schema's ref check and `validateSpec`.

---

## 6. Limitations

- **Shell nodes are refused on the async and channel paths.** Shell authoring requires an audit
  trail, and neither the background generation job nor the Slack path has one. Only the synchronous
  web/API path can generate a spec containing `shell` nodes, and only when the team's allowlist
  permits.
- **Generated specs are DRAFT, never active.** By design — activation is an explicit human action
  through the canvas. A generated workflow cannot run until a person promotes it.
- **Refinement replaces the whole spec.** Refine mode asks the model to return the full updated
  spec rather than a diff, so a refinement is only as good as the model's fidelity to the parts it
  was not asked to change. Every refinement saves a new version, so the previous one is recoverable.
