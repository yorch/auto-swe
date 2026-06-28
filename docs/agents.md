# Agents, Tools & Skills — Reference

> Comprehensive reference for the agent layer: role definitions, tools, skill system, observability pattern, and admin API. See [architecture.md](./architecture.md) for the broader system context.

---

## 1. Agent Roles

Agent identity is a **free-form string** since the platform pivot — the `AgentRole` Postgres enum and the `SkillOnlyRole` union were removed (P0/P1); the DB columns are plain `TEXT` and `AnySkillRole = string`. The seeded SWE agent keys fall into two groups by convention. (The channel assistant adds one model-backed key, `channelAssistant` — see Group 1. The evals feature seeds one more model-backed agent, `evalJudge` — an LLM-as-judge on a distinct, cheaper model to avoid self-preference bias; it is eval infrastructure, not a SWE workflow role, and is not in `MODEL_BACKED_AGENT_KEYS`, so it does not gate worker boot. See `docs/evals.md`.)

### Group 1 — model-backed roles (7)

These keys each have a **GLOBAL `Agent` row with a `modelSpec`** (created by the seed with the defaults below). The worker refuses to start (`assertConfigReady()`) until all seven SWE + channel roles resolve a model + credential. Model, prompt, skills, and tools are edited — and overridden at CHANNEL / TEAM / WORKFLOW_TEMPLATE scope — via the Agent library (`/admin/agents/library`).

| Role | Key | Activity | Default model |
|---|---|---|---|
| Implementer | `implementer` | `executeImplementation` | `anthropic/claude-opus-4-8` |
| Reviewer | `reviewer` | `runReviewNetwork` | `anthropic/claude-opus-4-8` |
| Planner | `planner` | `planDecomposition` | `anthropic/claude-sonnet-4-6` |
| Security Review | `securityReview` | _(legacy — see note)_ | `anthropic/claude-sonnet-4-6` |
| Validate Context | `validateContext` | `validateContext` | `anthropic/claude-sonnet-4-6` |
| Commit to Memory | `commitToMemory` | `commitToMemory` | `anthropic/claude-opus-4-8` |
| Channel Assistant | `channelAssistant` | `runChannelAgentTurn` (mention/ambient/reactive) | `anthropic/claude-opus-4-8` |

> **`securityReview` role note:** This role was the original single-agent security path. The current canonical path is the three-agent **review network** (`runReviewNetwork`), which uses the `reviewer` model for all three sub-agents. The `securityReview` GLOBAL `Agent` row is still required at worker boot for forward compatibility. Do not route new agent code through `securityReview` — use the review network instead.

### Group 2 — sub-role personas (4)

**Sub-agent personas** used within a parent activity. Their `Agent` row has **no** `modelSpec` — it carries `inheritsModelFrom`, so `resolveAgent` binds the parent's model. They exist so skills and tools can be assigned at per-sub-agent granularity.

| Role | Key | Inherits model from | Used by |
|---|---|---|---|
| Security Reviewer | `securityReviewer` | `reviewer` | `runReviewNetwork` |
| Domain Logic Reviewer | `domainLogicReviewer` | `reviewer` | `runReviewNetwork` |
| Performance Reviewer | `performanceReviewer` | `reviewer` | `runReviewNetwork` |
| Decomposer | `decomposer` | `planner` | `planDecomposition` |

**Type definitions:** `packages/worker/src/lib/config/types.ts` (`AnySkillRole = string`; re-exports `ModelBackedAgentKey` (the 7-key model-backed set including `channelAssistant`) from `@auto-swe/shared/agentKeys`, shared with the web dashboard).

### First-class `Agent` entity (P1) + `agent` node (P2)

The **`Agent`** table is the versioned, governed, **single source of truth** for an agent's model/prompt/skills/tools — the legacy `ModelRoleConfig` / `AgentSkillAssignment` / `AgentToolConfig` tables were removed in P1.5. `resolveAgent(key, ctx)` (`lib/config/agentResolver.ts`) takes the most-specific active Agent version (cascade `WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL`; the CHANNEL tier fires only when `ctx.channelId` is set; the ORGANIZATION tier — P5 — fires only when the run's team has an org; the version is pinned per run via the `WorkflowRun.agentVersions` snapshot or an explicit `key@version` ref): model from `modelSpec` (chasing `inheritsModelFrom`) + credential, skills from `skillRefs`, tools from `toolKeys`. `getModel`/`getModelSpec`/`loadAgentSkills`/`loadAgentToolConfig` are thin shims over it.

- **Resolution → execution:** `resolveAgentSpec` (`lib/config/agentSpec.ts`) composes the resolved model + skills + tools + prompt into an `AgentSpec`; the generic `runAgent` activity (`activities/runAgent.ts`) runs it.
- **Governance:** editing an Agent's system prompt runs the injection/exfil scan and resets `isVerified`; versions are immutable (a base edit cuts a new version); RBAC GLOBAL=ADMIN, TEAM=team OWNER. Seeded built-ins are `origin='swe-starter'`.
- **API + UI:** `/api/v1/admin/agent-library` (+ `/api/v1/teams/:id/agent-library`) and `/admin/agents/library`.
- **Declarative `agent` node (P2):** a workflow node with `agentRef` (`<key>` / `<key>@<version>`) + optional `userMessage`/`systemPrompt` that the interpreter dispatches to the `runAgentNode` activity (resolve → `runAgent`).

---

## 2. Model Configuration & Resolution

Model config is **fully DB-driven** — no model-related env vars. At activity-call time, `resolveAgent(key, ctx)` cascades through five scopes:

```
WORKFLOW_TEMPLATE scope  →  (if templateId set and row exists)
CHANNEL scope            →  (if channelId set — channel-resident runs only)
TEAM scope               →  (if teamId set and row exists)
ORGANIZATION scope       →  (if team belongs to an org — P5)
GLOBAL scope             →  (required — 7 model-backed agent keys)
```

**`systemPrompt` cascades independently from `modelSpec`.** A higher-scope row may supply the model spec but leave `systemPrompt = null`, allowing the cascade to continue looking for a system prompt at lower scopes. This means a team override can change the model without losing the global default system prompt (and vice versa).

Resolution throws `ConfigMissingError` when no `Agent` (or its credential) is found at any scope. Missing rows surface as a clear error message; credentials are managed at `/admin/model-config`, per-agent model specs at `/admin/agents/library`.

**Credentials** are stored AES-256-GCM encrypted in `ProviderCredential.apiKeyCiphertext`. Decryption failure also surfaces as `ConfigMissingError`. Credential resolution cascades TEAM → ORGANIZATION → GLOBAL (P5 added the org tier; an Agent pins an existing credential via `Agent.credentialId`).

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
`config.url`) — P2/WS3 replaced the legacy `Connection.mcpServerRef` column. An Agent opts in by
(a) referencing an `mcp` Connection via `Agent.mcpConnectionId` and (b) including `'mcp'` in its
`toolKeys`; at run time the tools served by that MCP server are bound **in addition to** the agent's
built-in workspace tools, via `@mastra/mcp` (`MCPClient`).

**Semantics of the `mcp` Connection `config.url`:**

- Interpreted as an **http(s) URL** of a streamable-HTTP (or legacy SSE) MCP server, e.g. `https://mcp.example.com/mcp`.
- Anything that is not `http://` or `https://` is rejected (`mcp.invalid_ref` activity event). **stdio MCP servers are deliberately unsupported** — the worker must never exec arbitrary commands sourced from a DB column.

**Activation requires all three:**

1. The resolved Agent has an `mcpConnectionId` pointing at an active `mcp` Connection (the run-time
   binding that resolves the connection → `loadMcpTools(config.url)` is WS3-binding, landing next).
2. The effective `Agent.toolKeys` allows the `mcp` pseudo-tool key (`isMcpToolEnabled`): `null`/empty = all tools enabled (MCP included, mirrors the built-in gating); a non-empty `toolKeys` must explicitly contain `'mcp'` — now accepted by the gateway tool-key validation (WS2).
3. The MCP server is reachable: connection/listing failure logs + records an `mcp.connect_failed` activity event and the agent continues with built-in tools only — it never fails the implementation.

**Security and observability:**

- Loaded tools are keyed `mcp_<toolName>` in the agent tool record (sanitized to provider-safe names); built-in tool keys always win on collision.
- Every MCP tool call is audit-logged (`[mcp:audit] server=… tool=… args=…`, like the `bash` tool) and recorded on the `AgentTracer` with `toolName: 'mcp:<toolName>'`.
- Successful loads record an `mcp.tools_loaded` activity event with the tool list.
- Tool listing (default 15 s) and each tool call (default 60 s) are capped by timeouts.

**Status — WS3 complete:**
- **Tool key (WS2):** the gateway `toolKeys` validation accepts `'mcp'` (via `AGENT_TOOL_KEYS`).
- **Binding:** all three implementer activities (`executeImplementation`, `implementerSession`, and
  the `decomposition` merge-conflict resolver) bind MCP uniformly through the shared
  `buildImplementerForActivity` helper, which resolves the Agent's `mcpConnectionId` via
  `resolveAgentMcpUrl` → `mcpUrlForConnection` → `loadMcpTools(config.url)` and closes the client in
  `finally`. The generic `runAgentNode` path (declarative `agent` node) binds MCP the same way, so any
  agent — not just the implementer — can use MCP.
- **Write-path:** admins manage `mcp` Connections at `/admin/mcp-connections` (gateway CRUD
  `/api/v1/admin/mcp-connections`) and attach one to an Agent via the `mcpConnectionId` field on the
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

| Field | Purpose |
|---|---|
| `name` | Kebab-case identifier (e.g. `test-first`) |
| `description` | One-line summary shown in the L1 menu |
| `promptText` | Full reasoning guidance (max 50 KB) |
| `isBuiltIn` | `true` for seeds from `packages/shared/src/skills/` |
| `isVerified` | `true` for built-ins; reset to `false` whenever `promptText` is updated |
| `isActive` | Toggle to enable/disable without deleting |

**Table:** `skills` in `packages/shared/src/prisma/schema.prisma`

### 6.2 Built-in Skills (27 total)

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
ORGANIZATION       →  (if team belongs to an org — P5)
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

**`mcp` pseudo-tool key:** in addition to the four workspace tool IDs, the worker honours an `'mcp'` entry in `toolKeys` to gate MCP tool loading (see section 3.5). It is not part of `IMPLEMENTER_TOOL_IDS` but is included in the canonical `AGENT_TOOL_KEYS` set (`packages/shared/src/workflow/stepRegistry.ts`), so the gateway tool-key validation accepts it (P2/WS2). A non-empty `toolKeys` must explicitly list `'mcp'` to enable MCP; absence disables it, mirroring the built-in gating.

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
(P1.5 retired the per-role `/api/v1/admin/agents/:role/skills` + `:role/tools`
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
| `MemoryItem` | `memory_items` | pgvector semantic memory (1536-dim HNSW); `skillsActive` column records which skills were active during the run |
| `ScannerPattern` | `scanner_patterns` | Regex rules for INJECTION, EXFILTRATION, SHELL_COMMAND, CODE_SECURITY, SENSITIVE_FILE scanners |

**Schema file:** `packages/shared/src/prisma/schema.prisma`
