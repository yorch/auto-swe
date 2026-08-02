# Agents, Tools & Skills — Reference

> Comprehensive reference for the agent layer: role definitions, tools, skill system, observability pattern, and admin API. See [architecture.md](./architecture.md) for the broader system context.

---

## 1. Agents

Agent identity is a **free-form string** — there is no enum, the DB columns are plain `TEXT`, and
`AnySkillRole = string`. New agents are added as data, not code.

`syncBuiltins` seeds 21 built-in agents, tagged `origin='swe-starter'`. The tag is the point: these
are seed content for the flagship software-engineering use case, not a fixed roster. An agent a team
adds resolves through exactly the same cascade as `implementer`. The one asymmetry is at boot —
`assertConfigReady` hard-fails on the agents the *step catalog* declares, so those rows must exist
even in a deployment that never runs an SWE workflow (see [§11](#11-limitations)).

They split by how they bind a model: an agent carries either its own `modelSpec`, or an
`inheritsModelFrom` pointer that `resolveAgent` chases to a parent.

### Model-backed agents (10)

Each has a GLOBAL `Agent` row with its own `modelSpec`. Model, prompt, skills, and tools are edited
— and overridden at CHANNEL / TEAM / ORGANIZATION / WORKFLOW_TEMPLATE scope — through the Agent
library at `/admin/agents/library`.

| Key | Used by | Default model |
|---|---|---|
| `implementer` | `executeImplementation` | `anthropic/claude-opus-4-8` |
| `reviewer` | `runReviewNetwork` (all three sub-agents) | `anthropic/claude-opus-4-8` |
| `planner` | `planDecomposition`, epic planning | `anthropic/claude-sonnet-4-6` |
| `securityReview` | _(legacy — see note)_ | `anthropic/claude-sonnet-4-6` |
| `validateContext` | `validateContext` | `anthropic/claude-sonnet-4-6` |
| `commitToMemory` | `commitToMemory` | `anthropic/claude-opus-4-8` |
| `channelAssistant` | Channel turns, ambient and reactive modes, `planChannelTask` / `runChannelSubtasks` | `anthropic/claude-opus-4-8` |
| `evalJudge` | `runEvalNode` judge scorer | `anthropic/claude-haiku-4-5-20251001` |
| `workflowAuthor` | NL workflow generation | `anthropic/claude-opus-4-8` |
| `workflowExplainer` | NL workflow explanation | `anthropic/claude-sonnet-4-6` |

`assertConfigReady()` gates worker boot on the agents the **step catalog** declares
(`STEP_REQUIRED_AGENTS`), not on what any particular template references — the worker holds no
template at boot and any template may be launched against it. So the set is derived rather than
hand-maintained, but it is the catalog's union, and it is wider than a given deployment needs (§11).
Agents reached only through a template's `agentRef` are checked non-fatally at template save and
resolved per node at run time, so a bad reference fails that node, never boot. `evalJudge`
deliberately runs on a cheaper, different model from the agents it scores, to avoid self-preference
bias.

> **`securityReview` is legacy.** It was the original single-agent security path. The canonical path
> is the three-agent review network, which binds the `reviewer` model for all three sub-agents. The
> row is kept for forward compatibility — **do not route new code through it.**

### Sub-role personas (11)

No `modelSpec`; each carries `inheritsModelFrom` so it runs on its parent's model. They exist so
skills and tools can be assigned at per-sub-agent granularity.

| Key | Inherits from | Used by |
|---|---|---|
| `securityReviewer` | `reviewer` | `runReviewNetwork` |
| `domainLogicReviewer` | `reviewer` | `runReviewNetwork` |
| `performanceReviewer` | `reviewer` | `runReviewNetwork` |
| `decomposer` | `planner` | `planDecomposition` |
| `prdAnalyst` | `planner` | PRD analysis |
| `prdDecomposer` | `planner` | PRD decomposition |
| `ciFixer` | `implementer` | `executeCIFixImplementation` |
| `reviewFixer` | `implementer` | `executeReviewFixImplementation` |
| `gateFixer` | `implementer` | `executeGateFixImplementation` |
| `mergeConflictResolver` | `implementer` | `resolveMergeConflict` |
| `lessonConsolidator` | `commitToMemory` | `consolidateLessons` |

`MODEL_BACKED_AGENT_KEYS` in `@auto-swe/shared/agentKeys` is a narrow convenience set used for cost
pricing and model-config UI labels — it is **not** the agent universe, and it does not include every
model-backed agent above.

### The `Agent` entity

`Agent` is the versioned, governed, single source of truth for an agent's model, prompt, skills, and
tools. `resolveAgent(key, ctx)` (`lib/config/agentResolver.ts`) resolves the most-specific active
version through the cascade, pinned per run by the `WorkflowRun.agentVersions` snapshot or an
explicit `key@version` ref, then binds the model (chasing `inheritsModelFrom`) plus credential,
skills from `skillRefs`, and tools from `toolKeys`. `getModel` / `getModelSpec` / `loadAgentSkills`
/ `loadAgentToolConfig` are thin shims over it.

- **Resolution → execution:** `resolveAgentSpec` composes the result into an `AgentSpec`, which the
  generic `runAgent` activity executes.
- **Governance:** editing a system prompt runs the injection/exfiltration scan and resets
  `isVerified`. Versions are immutable — editing a base cuts a new version. RBAC is ADMIN for
  GLOBAL, team OWNER for TEAM.
- **API + UI:** `/api/v1/admin/agent-library` (plus `/api/v1/teams/:id/agent-library`) and
  `/admin/agents/library`.
- **The `agent` node** carries an `agentRef` (`<key>` or `<key>@<version>`) plus optional
  `userMessage` / `systemPrompt`; the interpreter dispatches it to `runAgentNode`, which resolves
  and calls `runAgent`.

---

## 2. Model Configuration & Resolution

Model config is **fully DB-driven** — no model-related env vars. At activity-call time, `resolveAgent(key, ctx)` cascades through five scopes:

```
WORKFLOW_TEMPLATE scope  →  (if templateId set and row exists)
CHANNEL scope            →  (if channelId set — channel-resident runs only)
TEAM scope               →  (if teamId set and row exists)
ORGANIZATION scope       →  (if the team belongs to an org)
GLOBAL scope             →  (required — every referenced agent must resolve here)
```

**`systemPrompt` cascades independently from `modelSpec`.** A higher-scope row may supply the model spec but leave `systemPrompt = null`, allowing the cascade to continue looking for a system prompt at lower scopes. This means a team override can change the model without losing the global default system prompt (and vice versa).

Resolution throws `ConfigMissingError` when no `Agent` (or its credential) is found at any scope. Missing rows surface as a clear error message; credentials are managed at `/admin/model-config`, per-agent model specs at `/admin/agents/library`.

**Credentials** are stored AES-256-GCM encrypted in `ProviderCredential.apiKeyCiphertext`. Decryption failure also surfaces as `ConfigMissingError`. Credential resolution cascades TEAM → ORGANIZATION → GLOBAL (an Agent pins an existing credential via `Agent.credentialId`).

**Files:** `packages/worker/src/lib/config/agentResolver.ts` — `resolveAgent` (the sole model/prompt/skills/tools resolver; `getModel`/`getModelSpec` are shims over it); `packages/worker/src/lib/config/resolver.ts` — `resolveProviderCredential`, `resolveEmbeddingConfig`, `ConfigMissingError`.

**Cache:** Model config is cached in-process with a short TTL (configurable via `configCacheTtlMs()`). Cache is invalidated on pattern mutations via `invalidate()`. Mid-run config changes take effect on the next LLM call.

---

## 3. The Implementer Agent

**File:** `packages/worker/src/agents/implementer.ts`

**Factory:** `createImplementerAgent(workspace, tracer?, tools?, skills?, options?)`

Returns `{ agent: Agent, mastra: Mastra, promptSuffix: string, closeMcp?: () => Promise<void> }`. `options.mcpServerRef` opts in to MCP tool loading (see 3.5); `closeMcp` is present whenever an MCP server was contacted (including a connect that returned zero tools) and **must** be called in a `finally` block.

Activities don't call the factory directly — they use the **`buildImplementerForActivity(workspace, tracer, ctx)`** helper (same file), which loads `toolKeys` + skills at the current scope, resolves the Agent's optional MCP server via `resolveAgentMcpUrl`, and builds the agent in one call (returning `{ agent, promptSuffix, closeMcp, skills, toolKeys }`). `executeImplementation` and `implementerSession` both go through it, so the load + MCP-binding lifecycle lives in one place.

### 3.1 Workspace Tools (4, configurable)

These tools translate agent calls to `docker exec` commands inside the workspace container. All four are listed in `IMPLEMENTER_TOOL_IDS` and are controlled by `Agent.toolKeys`.

| Tool ID | Description | Security layer |
|---|---|---|
| `readFile` | Read a file from the workspace | Path traversal check (`safePath`) |
| `writeFile` | Create or overwrite a file | Sensitive file scanner (hard-block) + pre-write content scanner (soft-block) |
| `listDirectory` | List directory contents (`ls -la`) | Path traversal check |
| `bash` | Execute a shell command in the workspace | Shell command scanner (soft-block; returns error string to agent) |

`Agent.toolKeys` is a nullable Json string array of tool IDs to allow. `null` means all 4 tools are enabled.

### 3.2 `loadSkill` Tool (5th tool, always present when skills exist)

When `skills` is non-empty, a fifth tool — `loadSkill` — is automatically added alongside the four workspace tools. It is **not** listed in `IMPLEMENTER_TOOL_IDS` and is **not** part of `Agent.toolKeys` (it is auto-added).

```
loadSkill({ name: string }) → { promptText: string }
```

This enables **progressive skill disclosure**: the agent receives a compact L1 menu (skill name + description) in its system prompt and calls `loadSkill` to fetch the full `promptText` on demand. Only the skills the agent actively engages are counted against the context window.

The `promptSuffix` returned by `createImplementerAgent` is the L1 menu string injected into the system prompt:

```
## Available Skills
Use the `loadSkill` tool to load the full guidance for any skill before applying it.

- **test-first**: Write tests before implementation...
- **security-aware-implementation**: ...
```

### 3.3 Path Safety

`safePath(relPath)` normalises the path and rejects anything that is absolute, starts with `..`, contains null bytes, backslashes, or single quotes. This prevents path-traversal attacks in `readFile`, `writeFile`, and `listDirectory`.

### 3.4 Write Tool Security Chain

`writeFile` runs through two sequential checks before writing:

1. **Sensitive file scanner** (`checkSensitiveFilePath`) — hard-block. Rejects `.env`, PEM/key files, SSH private keys, credential JSON files. Returns the block message to the agent and records a trace with `error: 'blocked by sensitive file scanner'`.
2. **Pre-write content scanner** (`wrapWriteToolWithSecurityCheck`) — soft-block. Regex-based check for secrets/tokens in file content. Returns a prefixed error string starting with `SECURITY_CHECK_FAILED_PREFIX` or `SECURITY_WARNINGS_PREFIX`. The trace `error` field is set to `'blocked by content security check'` or `'content security warning'` so the gateway query in `/admin/security-events` can classify the event without raw SQL.

### 3.5 MCP Tools (first-class `mcp` Connection, opt-in)

**File:** `packages/worker/src/agents/mcpTools.ts` (`loadMcpTools`, `isMcpToolEnabled`, `MCP_TOOL_KEY`, `parseMcpServerRef`)

MCP servers are modelled as a first-class **`mcp`-type `Connection`** (`type='mcp'`,
`config.url`). An Agent opts in by
(a) referencing an `mcp` Connection via `Agent.mcpConnectionId` and (b) including `'mcp'` in its
`toolKeys`; at run time the tools served by that MCP server are bound **in addition to** the agent's
built-in workspace tools, via `@mastra/mcp` (`MCPClient`).

**Semantics of the `mcp` Connection `config.url`:**

- Interpreted as an **http(s) URL** of a streamable-HTTP (or legacy SSE) MCP server, e.g. `https://mcp.example.com/mcp`.
- Anything that is not `http://` or `https://` is rejected (`mcp.invalid_ref` activity event). **stdio MCP servers are deliberately unsupported** — the worker must never exec arbitrary commands sourced from a DB column.

**Activation requires all three:**

1. The resolved Agent has an `mcpConnectionId` pointing at an active `mcp` Connection.
2. The effective `Agent.toolKeys` allows the `mcp` pseudo-tool key (`isMcpToolEnabled`): `null`/empty = all tools enabled (MCP included, mirrors the built-in gating); a non-empty `toolKeys` must explicitly contain `'mcp'` — now accepted by the gateway tool-key validation.
3. The MCP server is reachable: connection/listing failure logs + records an `mcp.connect_failed` activity event and the agent continues with built-in tools only — it never fails the implementation.

**Security and observability:**

- Loaded tools are keyed `mcp_<toolName>` in the agent tool record (sanitized to provider-safe names); built-in tool keys always win on collision.
- Every MCP tool call is audit-logged (`[mcp:audit] server=… tool=… args=…`, like the `bash` tool) and recorded on the `AgentTracer` with `toolName: 'mcp:<toolName>'`.
- Successful loads record an `mcp.tools_loaded` activity event with the tool list.
- Tool listing (default 15 s) and each tool call (default 60 s) are capped by timeouts, overridable per connection via optional `listTimeoutMs`/`callTimeoutMs` on the `mcp` `Connection.config` (resolved by `mcpUrlForConnection`/`resolveAgentMcpUrl` into `loadMcpTools`; edited at `/admin/mcp-connections`).

**How the pieces fit:**
- **Tool key:** the gateway `toolKeys` validation accepts `'mcp'` (via `AGENT_TOOL_KEYS`).
- **Binding:** all three implementer activities (`executeImplementation`, `implementerSession`, and
  the `decomposition` merge-conflict resolver) bind MCP uniformly through the shared
  `buildImplementerForActivity` helper, which resolves the Agent's `mcpConnectionId` via
  `resolveAgentMcpUrl` → `mcpUrlForConnection` → `loadMcpTools(config.url)` and closes the client in
  `finally`. The generic `runAgentNode` path (declarative `agent` node) binds MCP the same way, so any
  agent — not just the implementer — can use MCP.
- **Write-path:** admins manage `mcp` Connections at `/admin/mcp-connections` (gateway CRUD
  `/api/v1/admin/mcp-connections` — `POST` create, `PATCH :id` edit url/name/timeouts,
  `DELETE :id` soft-delete; `PATCH` rebuilds `config` from the body so a blank timeout clears the
  override) and attach one to an Agent via the `mcpConnectionId` field on the
  agent-library form. `validateMcpConnectionRef` enforces that the reference is an active `mcp`
  Connection, and TEAM-scoped agents may only reference their own team's connection (tenancy).
- **Guarding:** non-git connections are filtered out of the repo read/submit paths (GET
  `/repositories`, Slack picker, epics, scheduled requests) and rejected by the shared
  `isGitRepoConnection` guard (`@auto-swe/shared/lib/connectionGuards`) on the submit paths.

---

## 4. The Review Network

**File:** `packages/worker/src/agents/reviewNetwork.ts`

**Entry point:** `runReviewNetwork(codeResult, successCriteria?, tracer?, systemPromptOverride?, securitySkillSuffix?, domainSkillSuffix?, performanceSkillSuffix?)`

Runs three Mastra `Agent` instances in parallel via `Promise.allSettled`. All three use the `reviewer` model (resolved via `getModel('reviewer')`). Each reviewer receives its own skill suffix appended to its system prompt.

| Reviewer | Persona | Skill role |
|---|---|---|
| `SECURITY` | `SECURITY_AUDITOR_PROMPT` | `securityReviewer` |
| `DOMAIN_LOGIC` | `DOMAIN_LOGIC_REVIEWER_PROMPT` + success criteria | `domainLogicReviewer` |
| `PERFORMANCE` | `PERFORMANCE_REVIEWER_PROMPT` | `performanceReviewer` |

If a reviewer crashes, it returns a synthetic `REVIEWER_CRASH` finding at `CRITICAL` severity rather than failing the whole network. The overall `approved` flag requires all three verdicts to be `approved: true`.

Each reviewer produces a structured `ReviewVerdict`:
```typescript
{
  approved: boolean;
  reviewer: 'SECURITY' | 'DOMAIN_LOGIC' | 'PERFORMANCE';
  severity: 'PASS' | 'INFO' | 'WARNING' | 'CRITICAL';
  findings: Array<{ category, description, file, line?, suggestedFix }>;
}
```

The code security scanner findings (`codeResult.codeSecurityFindings`) are formatted and appended to the security reviewer's prompt via `formatCodeSecurityFindings`.

---

## 5. Planner & Decomposer Agents

**Planner:** `packages/worker/src/agents/plannerAgent.ts` — decomposes a multi-repo epic brief into per-repo `Subtask[]`. No tools; structured output (Zod schema). Uses `planner` model.

**Decomposer:** `packages/worker/src/agents/decomposer.ts` — sub-agent that refines per-repo work into feature-level subtasks. No tools; structured output. Inherits `planner` model. Caps at 8 subtasks; subtask IDs must match `^[a-z][a-z0-9-]{0,39}$`. Falls back to a singleton plan if the LLM returns unstructured output.

---

## 6. Skills

### 6.1 What is a Skill?

A **skill** is a named prompt fragment (`promptText`) injected into an agent's system message. Skills control *how* an agent reasons — they do not grant new capabilities. Each skill has:

Skills are an intentionally **global, ADMIN-curated library** — the `Skill` table carries no `teamId`/`orgId`/tenant column, and creation (`POST /api/v1/admin/skills`) and edits are ADMIN-only routes. Tenant isolation is enforced one layer up: which Agents (themselves tenant-scoped) reference a skill via `skillRefs`, not by row ownership on `Skill` itself.

| Field | Purpose |
|---|---|
| `name` | Kebab-case identifier (e.g. `test-first`) |
| `description` | One-line summary shown in the L1 menu |
| `promptText` | Full reasoning guidance (max 50 KB) |
| `isBuiltIn` | `true` for seeds from `packages/shared/src/skills/` |
| `isVerified` | `true` for built-ins; reset to `false` whenever `promptText` is updated |
| `isActive` | Toggle to enable/disable without deleting |

**Table:** `skills` in `packages/shared/src/prisma/schema.prisma`

### 6.2 Built-in Skills (28 total)

**File:** `packages/shared/src/skills/index.ts`

| Category | Skill name | Assigned role |
|---|---|---|
| Implementer | `scope-conservatism` | `implementer` |
| | `follow-existing-patterns` | `implementer` |
| | `test-first` | `implementer` |
| | `incremental-commits` | `implementer` |
| | `no-new-dependencies` | `implementer` |
| | `shell-command-safety` | `implementer` |
| | `security-aware-implementation` | `implementer` |
| | `error-path-coverage` | `implementer` |
| | `acceptance-criteria-first` | `implementer` |
| | `idempotency` | `implementer` |
| | `graceful-degradation` | `implementer` |
| | `async-safety` | `implementer` |
| | `observability-first` | `implementer` |
| | `minimal-surface-area` | `implementer` |
| | `configuration-over-hardcoding` | `implementer` |
| | `rollback-first-planning` | `implementer` |
| | `design-fidelity` | `implementer` |
| Reviewer | `review-focus-security` | `reviewer` |
| | `migration-safety-review` | `reviewer` |
| | `api-contract-stability` | `reviewer` |
| Sub-reviewer | `security-review-depth` | `securityReviewer` |
| | `domain-logic-integrity` | `domainLogicReviewer` |
| | `performance-impact-assessment` | `performanceReviewer` |
| Planner/Decomposer | `pr-description-quality` | `planner` |
| | `subtask-decomposition` | `decomposer` |
| Validate Context | `success-criteria-extraction` | `validateContext` |
| | `context-ambiguity-resolution` | `validateContext` |
| Commit to Memory | `actionable-lessons` | `commitToMemory` |

### 6.3 Skill Assignment & Scope Cascade

Skill assignments live on the resolved `Agent` as `skillRefs` → `AgentSkillRef` rows (each joins to a `Skill` with a `sortOrder`). The resolver picks the most-specific active Agent version per scope:

```
WORKFLOW_TEMPLATE  →  (if templateId set and an Agent override exists for the key)
CHANNEL            →  (if channelId set — channel-resident runs only)
TEAM               →  (if teamId set and an Agent override exists for the key)
ORGANIZATION       →  (if the team belongs to an org)
GLOBAL             →  (always falls back to this; may carry no skill refs)
```

**Loaded per-activity-invocation** — admin edits to an Agent's skill refs take effect on the next LLM call within an already-running workflow.

`loadAgentSkills(role, ctx)` in `packages/worker/src/lib/config/agentSkills.ts` (a thin shim over `resolveAgent`):
- Returns `ResolvedSkill[]` sorted by `sortOrder` ascending.
- The most-specific Agent version's `skillRefs` win — an empty list means no skills injected for that role.
- Only `isActive: true` skills are included.

`skillsToPromptSuffix(skills)` joins prompt texts with double-newline; returns `undefined` for an empty array. Used by reviewer and planner sub-agents (which receive skill fragments directly in the system prompt rather than via the L1 menu).

### 6.4 Custom Skill Security Scanning

Custom skills' `promptText` is scanned by `scanSkillContent(text)` in `packages/shared/src/lib/skillScanner.ts`:
- Loads INJECTION and EXFILTRATION patterns from the `ScannerPattern` DB table (60 s TTL cache).
- Returns `{ safe: boolean, warnings: string[] }`.
- **Non-blocking advisory** — warnings are returned but never prevent saving or execution. Scan failures are caught so a DB outage cannot abort a run.

The scan runs:
1. At skill save time (gateway `POST /api/v1/admin/skills`).
2. After each TDD iteration in `executeImplementation` (scans LLM output for prompt injection attempts).

---

## 7. Tool Access Control (`Agent.toolKeys`)

`Agent.toolKeys` controls which of the four workspace tools are available to an agent role. It is a nullable Json string array on the resolved `Agent`.

| Field | Purpose |
|---|---|
| `key` | Which agent key (e.g. `implementer`) |
| `scope` | `GLOBAL` \| `TEAM` \| `WORKFLOW_TEMPLATE` |
| `toolKeys` | nullable Json `string[]` of allowed tool IDs (`null` = all four enabled) |
| `teamId` / `workflowTemplateId` | Scope keys (partial unique index) |

**Cascade:** `loadAgentToolConfig(role, ctx)` in `packages/worker/src/lib/config/agentSkills.ts` (a thin shim over `resolveAgent`) follows the same WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL order. Returns `null` when the resolved Agent has no `toolKeys`, which means all tools are enabled.

**`mcp` pseudo-tool key:** in addition to the four workspace tool IDs, the worker honours an `'mcp'` entry in `toolKeys` to gate MCP tool loading (see section 3.5). It is not part of `IMPLEMENTER_TOOL_IDS` but is included in the canonical `AGENT_TOOL_KEYS` set (`packages/shared/src/workflow/stepRegistry.ts`), so the gateway tool-key validation accepts it. A non-empty `toolKeys` must explicitly list `'mcp'` to enable MCP; absence disables it, mirroring the built-in gating.

Note: `Agent` (like `ProviderCredential`) uses partial unique indexes per scope (Prisma cannot express `WHERE IS NULL` in `upsert`). Code uses `findFirst + conditional create` for GLOBAL-scope rows instead of `upsert`.

---

## 8. Agent Observability (AgentTracer)

**File:** `packages/worker/src/lib/agentTracer.ts`

Every LLM-calling activity **must** use `AgentTracer` to record tool calls, LLM responses, and activity events. These are persisted as `AgentTrace` rows (linked to the `WorkflowRun`) and power the `/runs/[id]` viewer.

### 8.1 Pattern

```typescript
// 1. Instantiate at activity start
const tracer = new AgentTracer();

// 2. Record tool calls (inside tool execute functions)
tracer.addToolCall({
  toolName: 'readFile',
  inputJson: { path },
  outputJson: result,
  durationMs: Date.now() - start,
  error?: 'blocked by sensitive file scanner',  // optional
});

// 3. Record LLM responses — always include inputJson with the prompt sent to the model
tracer.addLlmResponse({
  role: 'SECURITY',           // reviewer type or agent role
  inputJson: { systemPrompt, userMessage },   // capture what was sent
  outputJson: verdictObject,
  durationMs: Date.now() - start,
  error?: err.message,
});

// 4. Record non-LLM activity events (git ops, test runs, PR creation, etc.)
tracer.addActivityEvent({
  name: 'git.clone',
  inputJson: { repo, branch },
  outputJson: { sha },
  durationMs: Date.now() - start,
  error?: 'clone failed',
});

// 5. Persist at exit — best-effort, failures are swallowed
await persistActivityTrace(tracer, 'implementer');
```

**`persistActivityTrace(tracer, role)`** in `packages/worker/src/lib/activityContext.ts` auto-resolves `runId` and `attempt` from Temporal context and calls `tracer.persist(runId, nodeId, role, attempt)`. **Never omit this call** in new LLM-calling activities — the run viewer depends on it.

**`inputJson` convention for `addLlmResponse`:** always pass `{ systemPrompt, userMessage }` so the `/runs/[id]` viewer can show exactly what was sent to the model. Declare prompt variables as `let` before the `try` block (not `const` inside it) so the error `catch` path can reference them too — otherwise failed LLM calls produce traces with no request context.

### 8.2 Trace Record Shape

```typescript
interface TraceRecord {
  seq: number;                                      // insertion order within the activity
  type: 'tool_call' | 'llm_response' | 'activity_event';
  toolName?: string;                                // tool ID, agent role, or event name
  inputJson?: unknown;                              // truncated to 4 000 chars per string value
  outputJson?: unknown;
  durationMs: number;
  error?: string;                                   // set for blocked/failed calls
}
```

String values are truncated to 4 000 characters per field. The `writeFile` tool records only the file `path` in `inputJson` (not the full content) to keep trace sizes manageable.

### 8.3 AgentTrace Table

**Table:** `agent_traces` in `packages/shared/src/prisma/schema.prisma`

| Column | Purpose |
|---|---|
| `runId` | FK to `workflow_runs` |
| `nodeId` | Activity type (e.g. `executeImplementation`) |
| `agentKey` | Which agent key (identity) produced this trace |
| `attempt` | Temporal activity attempt number (for retries) |
| `seq` | Insertion order within the activity attempt |
| `type` | `tool_call` \| `llm_response` \| `activity_event` |
| `toolName` | Tool ID, reviewer type, or event name |
| `inputJson` / `outputJson` / `error` | Full (truncated) details |
| `durationMs` | Wall-clock duration of the call |

---

## 9. Skill & Agent-Library API

Skill *definitions* live in `packages/gateway/src/routes/skills.ts`; per-agent
model / prompt / skills / tools live on the first-class `Agent` and are managed
via the **agent-library** API in `packages/gateway/src/routes/agentLibrary.ts`.
(the per-role `/api/v1/admin/agents/:role/skills` + `:role/tools`
assignment endpoints — that config is now fields on the `Agent`.)

### 9.1 Skills CRUD

| Method | Path | Min role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/admin/skills` | `ADMIN` | List all skills (built-in + custom) |
| `POST` | `/api/v1/admin/skills` | `ADMIN` | Create a custom skill |
| `GET` | `/api/v1/admin/skills/:id` | `ADMIN` | Get skill detail |
| `PUT` | `/api/v1/admin/skills/:id` | `ADMIN` | Update name / description / promptText / isActive |
| `DELETE` | `/api/v1/admin/skills/:id` | `ADMIN` | Delete (built-in skills are rejected with 400) |

Updating `promptText` automatically resets `isVerified` to `false` and triggers a security scan (the scan result is returned in the response but does not block the save).

### 9.2 Agent library (model / prompt / skills / tools)

The single governed surface for per-key config. An Agent payload carries
`modelSpec` / `inheritsModelFrom`, `systemPrompt`, `credentialId`, ordered
`skillRefs`, and `toolKeys` (`null` = all four workspace tools; values from
`IMPLEMENTER_TOOL_IDS = ['readFile', 'writeFile', 'listDirectory', 'bash']`).
Writes cut a new immutable `version`.

| Method | Path | Min role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/admin/agent-library` | `ADMIN` | List Agents (GLOBAL + overrides) with resolved fields |
| `GET` | `/api/v1/admin/agent-library/:id` | `ADMIN` | Agent detail + version history |
| `POST` | `/api/v1/admin/agent-library` | `ADMIN` | Create an Agent (or cut a new version) |
| `PUT` | `/api/v1/admin/agent-library/:id` | `ADMIN` | Update an Agent → bumps `version` |
| `DELETE` | `/api/v1/admin/agent-library/:id` | `ADMIN` | Delete / deactivate an Agent override |
| `GET` | `/api/v1/teams/:id/agent-library` | Team `ADMIN` | List TEAM-scope Agent overrides |
| `POST` | `/api/v1/teams/:id/agent-library` | Team `ADMIN` | Create a TEAM-scope Agent override |
| `PUT` | `/api/v1/teams/:id/agent-library/:agentId` | Team `ADMIN` | Update a TEAM-scope Agent override |

---

## 10. Data Model Summary

| Model | Table | Purpose |
|---|---|---|
| `Skill` | `skills` | Skill definitions (name, promptText, isBuiltIn, isVerified, isActive) |
| `Agent` | `agents` | Single source of truth per key/scope: model spec, system prompt, credential pin, tool keys, skill refs (versioned) |
| `AgentSkillRef` | `agent_skill_refs` | Join from an `Agent` to a `Skill` with `sortOrder` |
| `ProviderCredential` | `provider_credentials` | AES-256-GCM encrypted API keys per provider per scope |
| `EmbeddingConfig` | `embedding_configs` | Singleton embedding model + credential |
| `AgentTrace` | `agent_traces` | Per-activity tool-call / LLM-response / event rows |
| `MemoryItem` | `memory_items` | pgvector semantic memory (1536-dim HNSW); `skillsActive` column records which skills were active during the run. Steps without their own LLM call — the merge-conflict resolver and shell steps — write lessons through `recordLessonBackground`, which does not block the activity |
| `ScannerPattern` | `scanner_patterns` | Regex rules for INJECTION, EXFILTRATION, SHELL_COMMAND, CODE_SECURITY, SENSITIVE_FILE scanners |

**Schema file:** `packages/shared/src/prisma/schema.prisma`

---

## 11. Limitations

- **Worker boot requires the SWE-starter agents.** `requiredAgentKeys()` is the union of
  `STEP_REQUIRED_AGENTS` over *every registered step*, not the steps a given template uses, so
  `assertConfigReady` demands a resolvable `implementer`, `securityReview`, `reviewer`, `planner`,
  `validateContext`, `commitToMemory`, and `channelAssistant` — with credentials — before the poller
  starts. A deployment running only non-SWE workflows still has to configure all of them. The
  trade-off is deliberate (fail at boot, not mid-run), but it is scoped to the catalog rather than
  to what a deployment actually runs.
- **`securityReview` is a legacy key.** Kept for forward compatibility; the canonical security path
  is the review network. Do not route new code through it.
- **Skill scoping is enforced on reads, not by the database.** `Skill` now carries
  `scope`/`teamId`/`orgId` with a CHECK constraint, and the team-scoped list filters to GLOBAL plus
  the caller's own tenant. There is no row-level security, so a query that forgets the filter still
  sees everything — the same application-layer posture as the rest of the system.
- **Shell content scanning only sees *literal* content.** `scanShellCommand` runs the pre-write
  content rules over `echo`/`printf` redirects and here-docs, where the text being written is
  present in the command. A write fed from a pipe, a variable, or another process carries no
  inspectable content and is not scanned.
- **Shell write-target extraction is a heuristic.** It reads command text for redirects, `tee`,
  `dd of=`, and `cp`/`mv` destinations. An agent determined to evade it can (`eval`, a path built in
  a variable, `printf` into a here-doc). It raises the floor; it is not a containment boundary.
- **Soft-block scanners are advisory.** A soft block returns an error string for the model to
  self-correct against; a model that ignores it is not stopped. Only the sensitive-file scanner —
  now on both the `writeFile` and `bash` paths — and CRITICAL pre-write findings hard-block.
