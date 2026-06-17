# Platform Pivot — P2 Epic: Declarative `agent` node + MCP

> Build plan for **Phase P2** of the [platform pivot](./platform-pivot.md). P2 ships the two
> no/low-code extension tiers: a first-class **`agent` workflow node** (so a template can run any
> Agent from the canvas, not just the hardcoded SWE steps), and **MCP completion** (an `mcp` tool
> kind usable by any Agent, an `mcp` Connection, and an `mcp` node that calls a single MCP tool as
> a workflow step).
>
> Parent RFC: [`platform-pivot.md`](./platform-pivot.md) §P2. Builds directly on P1
> ([`platform-pivot-p1.md`](./platform-pivot-p1.md)): the `agent` node resolves an `agentRef` (or
> inline AgentSpec) through `resolveAgentSpec`/`resolveAgent` and runs it via the P0 `runAgent`.

---

## Outcomes (definition of done)

1. **`agent` node type.** A new node in the workflow `NodeSchema` carrying either `agentRef`
   (`"<key>"` / `"<key>@<version>"`, parsed by `parseAgentRef`) or an inline AgentSpec, plus the
   user message template + optional output binding. The interpreter dispatches it to a worker
   activity that calls `resolveAgentSpec` + `runAgent`.
2. **No behavior change to SWE templates.** The seeded SWE workflow keeps its existing bespoke steps
   (implementer/review/etc.); the `agent` node is additive. The interpreter's other node types are
   untouched.
3. **MCP tool kind.** `'mcp'` is accepted wherever tool keys are configured (Agent `toolKeys`,
   `IMPLEMENTER_TOOL_IDS`/gateway tool enums) — an Agent can be granted MCP tools.
4. **`mcp` Connection.** MCP server config moves from `Repository.mcpServerRef` to a first-class
   `mcp` Connection (a thin precursor to the P3 generic `Connection`): server URL/transport + auth,
   referenced by Agents/nodes.
5. **`mcp` node.** A workflow node that invokes a single named MCP tool with mapped inputs and binds
   the result — the low-code "call one external capability" step.
6. **Canvas + inspector.** The canvas palette gains `agent` and `mcp` nodes; the node inspector
   edits their config.
7. **Tests.** Interpreter resolves an `agent` node (agentRef + inline) → `runAgent`; an `mcp` node
   calls one tool; `'mcp'` is accepted for any Agent; MCP tools load from an `mcp` Connection.

## Non-goals (deferred)

- Generic `Connection` replacing `Repository`, generic `RunInput`/triggers/`MemoryItem` → **P3**
  (the `mcp` Connection here is a narrow, forward-compatible first instance).
- Multi-tool MCP planning/agentic MCP loops beyond "Agent may call its granted MCP tools" and "the
  `mcp` node calls one tool".
- Bundle/distribution of nodes or MCP servers → P4.

## The guiding constraint

The interpreter runs in a **V8 isolate** (Temporal workflow). New node dispatch must follow the
WS2 static step-registry pattern (module-level map, `proxyActivities`, `import type` only for
external packages). All MCP I/O and agent execution happen in **activities**, never the workflow.

---

## Workstreams

### WS1 — `agent` node type + interpreter dispatch + `runAgentNode` activity
**Why:** make "run an Agent" a declarative step.

- **Spec** (`packages/shared/src/workflow/spec.ts`): extend `NodeSchema` with an `agent` node:
  `{ type: 'agent', agentRef?: string, inline?: InlineAgentSpecLite, userMessage: string (template),
  outputKey?: string, spanName?: string }`. Add a spec codemod bump if the schema version changes.
- **Interpreter** (`packages/shared/src/workflow/interpreter.ts`): dispatch the `agent` node to a
  step key (e.g. `agent.run`) — the actual run is a worker activity, so the interpreter only routes
  + records, identical to other LLM-backed nodes.
- **Worker** (`packages/worker/src/activities/runAgentNode.ts` + WS2 step registry entry): resolve
  `agentRef` via `parseAgentRef` → `resolveAgentSpec({ agentKey, version })` (or inline) → `runAgent`.
  Register in `stepRegistry.ts` + `stepRequiredAgents.ts` (the node's required agent key is dynamic —
  declared by the template, so `assertConfigReady` treats agent-node keys as template-declared, not
  core-required).
- **Acceptance:** interpreter test dispatches an `agent` node (agentRef + inline) to the activity;
  `runAgentNode` unit test resolves the ref and calls `runAgent`; the seeded SWE template is
  unaffected (parity).

### WS2 — `'mcp'` tool kind for Agents
**Why:** let any Agent use MCP tools, not just the four workspace tools.

- Add `'mcp'` to the tool-key enums (`IMPLEMENTER_TOOL_IDS` / gateway `skillAssignmentService.ts`
  tool validation) and allow it in Agent `toolKeys`. An Agent granted `'mcp'` gets its MCP tools
  bound at run time from the referenced `mcp` Connection (WS3).
- **Acceptance:** `'mcp'` accepted in Agent `toolKeys` + tool-config validation; resolveAgentSpec
  surfaces it so `runAgent` can bind MCP tools.

### WS3 — `mcp` Connection + tool loading
**Why:** one governed place for MCP server config.

- **Schema (done, slice 1):** a first-class **`mcp`-type `Connection`** (`type='mcp'`, server URL in
  `config.url`) rather than a separate table. The git-identity columns (`organizationName`,
  `repoName`, git `url`, `defaultBranch`) are now nullable so non-git connection types need not set
  them; git uniqueness is a **partial unique index** scoped to `type='git_repo'` (Prisma can't
  express partial `@@unique`, so it lives in the custom-constraints migration). An Agent points at its
  server via the new `Agent.mcpConnectionId`. The legacy `Connection.mcpServerRef` column was
  **dropped** (no back-compat shim — there were no production rows). **http(s) only** — stdio MCP
  servers are deliberately unsupported (the worker must never exec commands sourced from a DB column).
- **Worker (done, slice 2 — implementer path):** `mcpUrlForConnection` / `resolveAgentMcpUrl`
  (`lib/config/mcpConnection.ts`) resolve the Agent's `mcpConnectionId` → `config.url`;
  `loadMcpTools` (`agents/mcpTools.ts`, `@mastra/mcp`) connects + lists + wraps each tool (audit log +
  tracer + per-call timeout) and is failure-isolated. Bound into `executeImplementation` and
  `implementerSession` via the shared `buildImplementerForActivity` helper, with `closeMcp()` in
  `finally`.
- **Remaining (slice 3):** gateway/UI write-path to create an `mcp` Connection and set
  `Agent.mcpConnectionId` (the binding is inert until this lands); MCP binding for the
  `decomposition` merge-conflict resolver and the generic `runAgentNode` path; a `type='git_repo'`
  filter on the connection-listing read paths + a tenancy check on `mcpConnectionId`.
- **Acceptance:** MCP tools load from an `mcp` Connection and are callable; auth is encrypted at rest.

### WS4 — `mcp` node (single-tool step)
**Why:** the low-code "call one external capability" step.

- **Spec/interpreter:** `{ type: 'mcp', connectionRef, tool, inputs (mapping), outputKey? }`;
  interpreter routes to an `mcpCallTool` activity.
- **Acceptance:** interpreter test invokes one MCP tool via the node and binds the result.

### WS5 — Canvas palette + inspector
**Why:** author `agent`/`mcp` nodes visually.

- **Web:** add `agent` + `mcp` to the canvas palette and node inspector (`packages/web/src/app/...`
  workflow canvas). Edit agentRef/inline + message template; connectionRef/tool/input mapping.
- **Acceptance:** nodes can be added + configured on the canvas; the saved spec round-trips.

## PR slicing

| PR | Workstream | Risk | Notes |
| --- | --- | --- | --- |
| 1 | WS1 | Med | `agent` node + interpreter dispatch + `runAgentNode`. Foundation. |
| 2 | WS2 | Low | `'mcp'` tool kind plumbing. |
| 3 | WS3 | High | `mcp` Connection + client + tool loading (network + secrets). |
| 4 | WS4 | Med | `mcp` node. |
| 5 | WS5 | Med | Canvas/inspector UX. |

## Risks & gotchas

1. **V8 isolate.** Node dispatch is a static registry entry; the run is an activity. Never import
   the agent/MCP runtime into the interpreter.
2. **`assertConfigReady` and dynamic agent keys.** An `agent` node references a template-declared
   key, which may not be one of the six core roles. Boot validation must not require every possible
   agent-node key — only that referenced GLOBAL agents resolve (degrade-don't-crash per WS4/P0).
3. **MCP secrets + network.** MCP auth uses the existing encryption envelope; all MCP calls are in
   activities with the network policy applied. No MCP I/O in the workflow isolate.
4. **Spec versioning.** Adding node types bumps the spec schema; add a codemod and keep existing
   stored specs migrating cleanly (the `migrateSpec` chain).

## Sequencing checklist

**Status: 🔄 in progress (WS1 + WS2 done; WS3 partial).**

- [x] WS1 — `agent` node + interpreter dispatch + `runAgentNode` activity (parity); spec
  `SPEC_SCHEMA_VERSION 4→5` + codemod; per-node `systemPrompt` override; canvas rendering. The
  inline-AgentSpec path is deferred to a follow-up (agentRef is the WS1 path).
- [x] WS2 — `'mcp'` tool kind accepted for Agents (`MCP_TOOL_KEY` + `AGENT_TOOL_KEYS` in
  `stepRegistry.ts`; gateway `toolKeys` validation + worker `isMcpToolEnabled` gating).
- [~] WS3 — `mcp` Connection + client + tool loading. **Done:** first-class `mcp` Connection schema +
  `Agent.mcpConnectionId` (slice 1); implementer MCP binding via `resolveAgentMcpUrl` +
  `buildImplementerForActivity` (slice 2). **Pending (slice 3):** gateway/UI write-path,
  `decomposition` + `runAgentNode` binding, read-path `git_repo` filter + tenancy check.
- [ ] WS4 — `mcp` node (single-tool step)
- [ ] WS5 — canvas palette + inspector for `agent`/`mcp`
