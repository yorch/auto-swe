# Agents, Tools & Skills — Reference

> Comprehensive reference for the agent layer: role definitions, tools, skill system, observability pattern, and admin API. See [architecture.md](./architecture.md) for the broader system context.

---

## 1. Agent Roles

Agent identity is a **free-form string** since the platform pivot — the `AgentRole` Postgres enum and the `SkillOnlyRole` union were removed (P0/P1); the DB columns are plain `TEXT` and `AnySkillRole = string`. The 10 seeded SWE agent keys still fall into two groups by convention.

### Group 1 — model-backed roles (6)

These keys each **require a GLOBAL `ModelRoleConfig` row** in the database. The worker refuses to start (`assertConfigReady()`) until all six rows exist. Model selection, system prompt, and credential can be overridden at TEAM or WORKFLOW_TEMPLATE scope via the admin UI.

| Role | Key | Activity | Default model |
|---|---|---|---|
| Implementer | `implementer` | `executeImplementation` | `anthropic/claude-opus-4-7` |
| Reviewer | `reviewer` | `runReviewNetwork` | `anthropic/claude-opus-4-7` |
| Planner | `planner` | `planDecomposition` | `anthropic/claude-sonnet-4-6` |
| Security Review | `securityReview` | _(legacy — see note)_ | `anthropic/claude-sonnet-4-6` |
| Validate Context | `validateContext` | `validateContext` | `anthropic/claude-sonnet-4-6` |
| Commit to Memory | `commitToMemory` | `commitToMemory` | `anthropic/claude-opus-4-7` |

> **`securityReview` role note:** This role was the original single-agent security path. The current canonical path is the three-agent **review network** (`runReviewNetwork`), which uses the `reviewer` model for all three sub-agents. The `securityReview` `ModelRoleConfig` row is still required at worker boot for forward compatibility. Do not route new agent code through `securityReview` — use the review network instead.

### Group 2 — sub-role personas (4)

**Sub-agent personas** used within a parent activity. They have **no** `ModelRoleConfig` row — their seeded `Agent` row carries `inheritsModelFrom`, so `resolveAgent` binds the parent's model. They exist so skills and tools can be assigned at per-sub-agent granularity.

| Role | Key | Inherits model from | Used by |
|---|---|---|---|
| Security Reviewer | `securityReviewer` | `reviewer` | `runReviewNetwork` |
| Domain Logic Reviewer | `domainLogicReviewer` | `reviewer` | `runReviewNetwork` |
| Performance Reviewer | `performanceReviewer` | `reviewer` | `runReviewNetwork` |
| Decomposer | `decomposer` | `planner` | `planDecomposition` |

**Type definitions:** `packages/worker/src/lib/config/types.ts` (`AnySkillRole = string`; `AgentRole` is the 6-key model-backed union).

### First-class `Agent` entity (P1) + `agent` node (P2)

The **`Agent`** table is the versioned, governed library object that consolidates an agent's model/prompt/skills/tools. It **overlays** the three legacy config tables (`ModelRoleConfig` / `AgentSkillAssignment` / `AgentToolConfig`): `resolveAgent(key, ctx)` (`lib/config/agentResolver.ts`) takes the most-specific active Agent version (cascade `WORKFLOW_TEMPLATE → TEAM → GLOBAL`; the version is pinned per run via the `WorkflowRun.agentVersions` snapshot or an explicit `key@version` ref), and any null override field falls through to the legacy cascade — so seeded SWE agents resolve byte-identically to pre-P1.

- **Resolution → execution:** `resolveAgentSpec` (`lib/config/agentSpec.ts`) composes the resolved model + skills + tools + prompt into an `AgentSpec`; the generic `runAgent` activity (`activities/runAgent.ts`) runs it.
- **Governance:** editing an Agent's system prompt runs the injection/exfil scan and resets `isVerified`; versions are immutable (a base edit cuts a new version); RBAC GLOBAL=ADMIN, TEAM=team OWNER. Seeded built-ins are `origin='swe-starter'`.
- **API + UI:** `/api/v1/admin/agent-library` (+ `/api/v1/teams/:id/agent-library`) and `/admin/agents/library`.
- **Declarative `agent` node (P2):** a workflow node with `agentRef` (`<key>` / `<key>@<version>`) + optional `userMessage`/`systemPrompt` that the interpreter dispatches to the `runAgentNode` activity (resolve → `runAgent`).

---

## 2. Model Configuration & Resolution

Model config is **fully DB-driven** — no model-related env vars. At activity-call time, `resolveModelConfig(role, ctx)` cascades through three scopes:

```
WORKFLOW_TEMPLATE scope  →  (if templateId set and row exists)
TEAM scope               →  (if teamId set and row exists)
GLOBAL scope             →  (required — 6 AgentRoles only)
```

**`systemPrompt` cascades independently from `modelSpec`.** A higher-scope row may supply the model spec but leave `systemPrompt = null`, allowing the cascade to continue looking for a system prompt at lower scopes. This means a team override can change the model without losing the global default system prompt (and vice versa).

`resolveModelConfig` throws `ConfigMissingError` when no row is found at any scope. Missing rows surface as a clear error message pointing to `/admin/model-config`.

**Credentials** are stored AES-256-GCM encrypted in `ProviderCredential.apiKeyCiphertext`. Decryption failure also surfaces as `ConfigMissingError`. Credential resolution cascades TEAM → GLOBAL (templates reference an existing credential via `ModelRoleConfig.credentialId`).

**File:** `packages/worker/src/lib/config/resolver.ts` — exports `resolveModelConfig`, `resolveProviderCredential`, `resolveEmbeddingConfig`, `ConfigMissingError`.

**Cache:** Model config is cached in-process with a short TTL (configurable via `configCacheTtlMs()`). Cache is invalidated on pattern mutations via `invalidate()`. Mid-run config changes take effect on the next LLM call.

---

## 3. The Implementer Agent

**File:** `packages/worker/src/agents/implementer.ts`

**Factory:** `createImplementerAgent(workspace, tracer?, tools?, skills?, options?)`

Returns `{ agent: Agent, mastra: Mastra, promptSuffix: string, closeMcp?: () => Promise<void> }`. `options.mcpServerRef` opts in to MCP tool loading (see 3.5); `closeMcp` is present only when MCP tools were loaded and should be called in a `finally` block.

### 3.1 Workspace Tools (4, configurable)

These tools translate agent calls to `docker exec` commands inside the workspace container. All four are listed in `IMPLEMENTER_TOOL_IDS` and are controlled by `AgentToolConfig`.

| Tool ID | Description | Security layer |
|---|---|---|
| `readFile` | Read a file from the workspace | Path traversal check (`safePath`) |
| `writeFile` | Create or overwrite a file | Sensitive file scanner (hard-block) + pre-write content scanner (soft-block) |
| `listDirectory` | List directory contents (`ls -la`) | Path traversal check |
| `bash` | Execute a shell command in the workspace | Shell command scanner (soft-block; returns error string to agent) |

`AgentToolConfig.enabledTools` is a `String[]` of tool IDs to allow. `null` (no row) means all 4 tools are enabled.

### 3.2 `loadSkill` Tool (5th tool, always present when skills exist)

When `skills` is non-empty, a fifth tool — `loadSkill` — is automatically added alongside the four workspace tools. It is **not** listed in `IMPLEMENTER_TOOL_IDS` and is **not** controlled by `AgentToolConfig`.

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

### 3.5 MCP Tools (`Repository.mcpServerRef`, opt-in)

**File:** `packages/worker/src/agents/mcpTools.ts` (`loadMcpTools`, `isMcpToolEnabled`, `MCP_TOOL_KEY`, `parseMcpServerRef`)

When a repository has `mcpServerRef` set, the implementer agent can be given the tools served by that MCP server **in addition to** its built-in workspace tools. Implemented via `@mastra/mcp` (`MCPClient`).

**Semantics of `mcpServerRef`:**

- Interpreted as an **http(s) URL** of a streamable-HTTP (or legacy SSE) MCP server, e.g. `https://mcp.example.com/mcp`.
- Anything that is not `http://` or `https://` is rejected (`mcp.invalid_ref` activity event). **stdio MCP servers are deliberately unsupported** — the worker must never exec arbitrary commands sourced from a DB column.

**Activation requires all three:**

1. The caller passes `options.mcpServerRef` to `createImplementerAgent` — **defaults to disabled**; activities have not opted in yet (follow-up).
2. The effective `AgentToolConfig` allows the `mcp` pseudo-tool key (`isMcpToolEnabled`): `null`/empty config = all tools enabled (MCP included, mirrors the built-in gating); a non-empty `enabledTools` must explicitly contain `'mcp'`. Since the gateway tool-config enum does not accept `'mcp'` yet, **every existing tool config row disables MCP**.
3. The MCP server is reachable: connection/listing failure logs + records an `mcp.connect_failed` activity event and the agent continues with built-in tools only — it never fails the implementation.

**Security and observability:**

- Loaded tools are keyed `mcp_<toolName>` in the agent tool record (sanitized to provider-safe names); built-in tool keys always win on collision.
- Every MCP tool call is audit-logged (`[mcp:audit] server=… tool=… args=…`, like the `bash` tool) and recorded on the `AgentTracer` with `toolName: 'mcp:<toolName>'`.
- Successful loads record an `mcp.tools_loaded` activity event with the tool list.
- Tool listing (default 15 s) and each tool call (default 60 s) are capped by timeouts.

**Follow-ups:** (a) the gateway Zod enum for `AgentToolConfig.enabledTools` (`routes/skills.ts`) must accept `'mcp'` before admins can enable it on configs that restrict tools; (b) the implementer activities (`executeImplementation`, `implementerSession`, decomposition) need to pass the repo's `mcpServerRef` into `createImplementerAgent` and call `closeMcp()` in their `finally` blocks.

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

Skill assignments are stored in `AgentSkillAssignment`, which links a skill to an agent role at a scope:

```
WORKFLOW_TEMPLATE  →  (if templateId set and any assignments exist for role)
TEAM               →  (if teamId set and any assignments exist for role)
GLOBAL             →  (always falls back to this; may be empty)
```

**Loaded per-activity-invocation** — admin edits to skill assignments take effect on the next LLM call within an already-running workflow.

`loadAgentSkills(role, ctx)` in `packages/worker/src/lib/config/agentSkills.ts`:
- Returns `ResolvedSkill[]` sorted by `sortOrder` ascending.
- The first scope with **any** assignments for the role wins — returning an empty array means no skills injected for that role.
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

## 7. Tool Access Control (`AgentToolConfig`)

`AgentToolConfig` controls which of the four workspace tools are available to an agent role.

| Field | Purpose |
|---|---|
| `agentRole` | Which role (e.g. `IMPLEMENTER`) |
| `scope` | `GLOBAL` \| `TEAM` \| `WORKFLOW_TEMPLATE` |
| `enabledTools` | `String[]` of allowed tool IDs |
| `teamId` / `workflowTemplateId` | Scope keys (partial unique index) |

**Cascade:** `loadAgentToolConfig(role, ctx)` in `packages/worker/src/lib/config/agentSkills.ts` follows the same WORKFLOW_TEMPLATE → TEAM → GLOBAL order. Returns `null` when no row exists at any scope, which means all tools are enabled.

**`mcp` pseudo-tool key:** in addition to the four workspace tool IDs, the worker honours an `'mcp'` entry in `enabledTools` to gate MCP tool loading (see section 3.5). It is not part of `IMPLEMENTER_TOOL_IDS` and the gateway enum does not accept it yet — a non-empty config therefore disables MCP until that follow-up lands.

Note: `AgentToolConfig` and `AgentSkillAssignment` use partial unique indexes (Prisma cannot express `WHERE IS NULL` in `upsert`). Code uses `findFirst + conditional create` for GLOBAL-scope rows instead of `upsert`.

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
| `agentRole` | Which role produced this trace |
| `attempt` | Temporal activity attempt number (for retries) |
| `seq` | Insertion order within the activity attempt |
| `type` | `tool_call` \| `llm_response` \| `activity_event` |
| `toolName` | Tool ID, reviewer type, or event name |
| `inputJson` / `outputJson` / `error` | Full (truncated) details |
| `durationMs` | Wall-clock duration of the call |

---

## 9. Skill & Tool Assignment API

All endpoints below are in `packages/gateway/src/routes/skills.ts`.

### 9.1 Skills CRUD

| Method | Path | Min role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/admin/skills` | `ADMIN` | List all skills (built-in + custom) |
| `POST` | `/api/v1/admin/skills` | `ADMIN` | Create a custom skill |
| `GET` | `/api/v1/admin/skills/:id` | `ADMIN` | Get skill detail |
| `PUT` | `/api/v1/admin/skills/:id` | `ADMIN` | Update name / description / promptText / isActive |
| `DELETE` | `/api/v1/admin/skills/:id` | `ADMIN` | Delete (built-in skills are rejected with 400) |

Updating `promptText` automatically resets `isVerified` to `false` and triggers a security scan (the scan result is returned in the response but does not block the save).

### 9.2 Agent Skill Assignments

| Method | Path | Min role | Scope |
|---|---|---|---|
| `GET` | `/api/v1/admin/agents` | `ADMIN` | List all 10 roles with GLOBAL skill count and tool config |
| `GET` | `/api/v1/admin/agents/:role/skills` | `ADMIN` | Get GLOBAL skill assignments for a role |
| `PUT` | `/api/v1/admin/agents/:role/skills` | `ADMIN` | Replace GLOBAL skill assignments for a role |
| `DELETE` | `/api/v1/admin/agents/:role/skills` | `ADMIN` | Clear all GLOBAL assignments for a role |
| `GET` | `/api/v1/teams/:teamId/agents/:role/skills` | Team `ADMIN` | Get TEAM-scope assignments |
| `PUT` | `/api/v1/teams/:teamId/agents/:role/skills` | Team `ADMIN` | Replace TEAM-scope assignments |
| `DELETE` | `/api/v1/teams/:teamId/agents/:role/skills` | Team `ADMIN` | Clear TEAM-scope assignments |

The `PUT` body is `{ skillIds: string[], sortOrders?: number[] }`. `sortOrders` defaults to the array index if omitted.

### 9.3 Agent Tool Configs

| Method | Path | Min role | Scope |
|---|---|---|---|
| `GET` | `/api/v1/admin/agents/:role/tools` | `ADMIN` | Get GLOBAL tool config |
| `PUT` | `/api/v1/admin/agents/:role/tools` | `ADMIN` | Set GLOBAL tool config |
| `DELETE` | `/api/v1/admin/agents/:role/tools` | `ADMIN` | Remove GLOBAL config (reverts to "all tools") |
| `GET` | `/api/v1/teams/:teamId/agents/:role/tools` | Team `ADMIN` | Get TEAM-scope tool config |
| `PUT` | `/api/v1/teams/:teamId/agents/:role/tools` | Team `ADMIN` | Set TEAM-scope tool config |
| `DELETE` | `/api/v1/teams/:teamId/agents/:role/tools` | Team `ADMIN` | Remove TEAM-scope config |

The `PUT` body is `{ enabledTools: string[] }` where values are from `IMPLEMENTER_TOOL_IDS = ['readFile', 'writeFile', 'listDirectory', 'bash']`.

---

## 10. Data Model Summary

| Model | Table | Purpose |
|---|---|---|
| `Skill` | `skills` | Skill definitions (name, promptText, isBuiltIn, isVerified, isActive) |
| `AgentSkillAssignment` | `agent_skill_assignments` | Links skills to roles at GLOBAL/TEAM/WORKFLOW_TEMPLATE scope |
| `AgentToolConfig` | `agent_tool_configs` | Controls which workspace tools each role can use, per scope |
| `ModelRoleConfig` | `model_role_configs` | Model spec + system prompt override per role per scope |
| `ProviderCredential` | `provider_credentials` | AES-256-GCM encrypted API keys per provider per scope |
| `EmbeddingConfig` | `embedding_configs` | Singleton embedding model + credential |
| `AgentTrace` | `agent_traces` | Per-activity tool-call / LLM-response / event rows |
| `AgentLesson` | `agent_lessons` | pgvector semantic memory (1536-dim HNSW); `skillsActive` column records which skills were active during the run |
| `ScannerPattern` | `scanner_patterns` | Regex rules for INJECTION, EXFILTRATION, SHELL_COMMAND, CODE_SECURITY, SENSITIVE_FILE scanners |

**Schema file:** `packages/shared/src/prisma/schema.prisma`
