# Agents, Tools & Skills — Reference

> Comprehensive reference for the agent layer: role definitions, tools, skill system, observability pattern, and admin API. See [architecture.md](./architecture.md) for the broader system context.

---

## 1. Agents

Agent identity is a **free-form string** — there is no enum, the DB columns are plain `TEXT`, and
`AnySkillRole = string`. New agents are added as data, not code.

`syncBuiltins` seeds 28 built-in agents, tagged `origin='swe-starter'`. The tag is the point: these
are seed content for the flagship software-engineering use case, not a fixed roster. An agent a team
adds resolves through exactly the same cascade as `implementer`, and nothing in the engine privileges
the seeded set — `assertConfigReady` gates boot on what the deployment has *installed*, not on the
catalog (§2).

They split by how they bind a model: an agent carries either its own `modelSpec`, or an
`inheritsModelFrom` pointer that `resolveAgent` chases to a parent.

### Model-backed agents (17)

Each has a GLOBAL `Agent` row with its own `modelSpec`. Model, prompt, skills, and tools are edited
— and overridden at CHANNEL / TEAM / ORGANIZATION / WORKFLOW_TEMPLATE scope — through the Agent
library at `/studio/agents/library`.

| Key | Used by | Default model |
|---|---|---|
| `implementer` | `executeImplementation` | `anthropic/claude-opus-4-8` |
| `reviewer` | `runReviewNetwork` (all three sub-agents) | `anthropic/claude-opus-4-8` |
| `planner` | `planDecomposition`, epic planning | `anthropic/claude-sonnet-4-6` |
| `securityReview` | `scanDiffForSecurityIssues` — the post-diff gate on `executeImplementation` + the three fix paths | `anthropic/claude-sonnet-4-6` |
| `validateContext` | `validateContext` | `anthropic/claude-sonnet-4-6` |
| `commitToMemory` | `commitToMemory` | `anthropic/claude-opus-4-8` |
| `channelAssistant` | Channel turns, ambient and reactive modes, `planChannelTask` / `runChannelSubtasks` | `anthropic/claude-opus-4-8` |
| `evalJudge` | `runEvalNode` judge scorer | `anthropic/claude-haiku-4-5-20251001` |
| `workflowAuthor` | NL workflow generation | `anthropic/claude-opus-4-8` |
| `workflowExplainer` | NL workflow explanation | `anthropic/claude-sonnet-4-6` |
| `repoDependencyInferrer` | `inferRepoDependencies` — proposes repo dependency edges for human confirmation | `anthropic/claude-haiku-4-5-20251001` |
| `contentWriter` | Generic document-workflow drafting (e.g. Notion) | `anthropic/claude-sonnet-4-6` |
| `brandReviewer` | Content/Comms pack — brand-voice and clarity review | `anthropic/claude-sonnet-4-6` |
| `supportResponder` | Support/Ops ticket replies | `anthropic/claude-sonnet-4-6` |
| `productAnalyst` | Product pack — problem analysis | `anthropic/claude-sonnet-4-6` |
| `prdWriter` | Product pack — PRD drafting | `anthropic/claude-sonnet-4-6` |
| `issueDrafter` | Product pack — drafts issue descriptions from a brief | `anthropic/claude-sonnet-4-6` |

`assertConfigReady()` gates worker boot on the agents the **installed templates** can reach:
`requiredAgentKeysForDeployment()` walks the active (and experiment) version of every `ACTIVE`
template, maps each `step` node through `STEP_REQUIRED_AGENTS`, and adds `channelAssistant` when the
deployment has any `SlackChannel` — channel turns call `runAgent` directly rather than through a
step node, so no spec walk can see that requirement. A deployment that runs no SWE workflow does not
have to configure `implementer` and friends. With nothing runnable installed the gate is empty and
boot proceeds; a template activated *after* boot is not retroactively gated, so an unconfigured
agent fails that node at run time. Agents reached only through a template's `agentRef` are likewise
checked non-fatally at template save and resolved per node at run time. `evalJudge` deliberately
runs on a cheaper, different model from the agents it scores, to avoid self-preference bias.

> **`securityReview` is live, not legacy.** It used to be documented as a compatibility shim, which
> was wrong and unsafe advice — deleting the row breaks every implementation run. It backs
> `scanDiffForSecurityIssues`, which `executeImplementation` and all three fix paths call on the
> committed diff, and which throws a non-retryable `SECURITY_GATE_FAILURE` when any finding is
> CRITICAL (the processor forces `passed: false` in that case regardless of what the model returned).
> It complements the review network rather than being replaced by it: the network gives three
> personas an opinion and routes on their verdicts, this one fails the activity outright.

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
version through the cascade, then binds the model (chasing `inheritsModelFrom`) plus credential,
skills from `skillRefs`, and tools from `toolKeys`. The per-run `WorkflowRun.agentVersions`
snapshot pins the GLOBAL row only: it is taken from the GLOBAL lineage at run start, so a run that
falls through to GLOBAL is frozen against later library edits, while a TEAM / ORGANIZATION /
CHANNEL / WORKFLOW_TEMPLATE override still wins and resolves its latest active version. An explicit
`key@version` ref on an agent node feeds the same pin, so it too names a GLOBAL version. `getModel` / `getModelSpec` / `loadAgentSkills`
/ `loadAgentToolConfig` are thin shims over it.

- **Resolution → execution:** `resolveAgentSpec` composes the result into an `AgentSpec`, which the
  generic `runAgent` activity executes.
- **Governance:** editing a system prompt runs the injection/exfiltration scan and resets
  `isVerified`. Versions are immutable — editing a base cuts a new version. RBAC is ADMIN for
  GLOBAL, team OWNER for TEAM.
- **API + UI:** `/api/v1/platform/agent-library` (plus `/api/v1/teams/:id/agent-library`) and
  `/studio/agents/library`.
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

Resolution throws `ConfigMissingError` when no `Agent` (or its credential) is found at any scope. Missing rows surface as a clear error message; credentials are managed at `/studio/models`, per-agent model specs at `/studio/agents/library`.

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
2. **Pre-write content scanner** (`wrapWriteToolWithSecurityCheck`) — soft-block. Regex-based check for secrets/tokens in file content. Returns a prefixed error string starting with `SECURITY_CHECK_FAILED_PREFIX` or `SECURITY_WARNINGS_PREFIX`. The trace `error` field is set to `'blocked by content security check'` or `'content security warning'` so the gateway query in `/govern/security` can classify the event without raw SQL.

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
- Tool listing (default 15 s) and each tool call (default 60 s) are capped by timeouts, overridable per connection via optional `listTimeoutMs`/`callTimeoutMs` on the `mcp` `Connection.config` (resolved by `mcpUrlForConnection`/`resolveAgentMcpUrl` into `loadMcpTools`; edited at `/studio/mcp`).

**How the pieces fit:**
- **Tool key:** the gateway `toolKeys` validation accepts `'mcp'` (via `AGENT_TOOL_KEYS`).
- **Binding:** all three implementer activities (`executeImplementation`, `implementerSession`, and
  the `decomposition` merge-conflict resolver) bind MCP uniformly through the shared
  `buildImplementerForActivity` helper, which resolves the Agent's `mcpConnectionId` via
  `resolveAgentMcpUrl` → `mcpUrlForConnection` → `loadMcpTools(config.url)` and closes the client in
  `finally`. The generic `runAgentNode` path (declarative `agent` node) binds MCP the same way, so any
  agent — not just the implementer — can use MCP.
- **Write-path:** admins manage `mcp` Connections at `/studio/mcp` (gateway CRUD
  `/api/v1/studio/mcp` — `POST` create, `PATCH :id` edit url/name/timeouts,
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

Skills are an intentionally **global, ADMIN-curated library** — the `Skill` table carries no `teamId`/`orgId`/tenant column, and creation (`POST /api/v1/platform/skills`) and edits are ADMIN-only routes. Tenant isolation is enforced one layer up: which Agents (themselves tenant-scoped) reference a skill via `skillRefs`, not by row ownership on `Skill` itself.

| Field | Purpose |
|---|---|
| `name` | Kebab-case identifier (e.g. `test-first`) |
| `description` | One-line summary shown in the L1 menu |
| `promptText` | Full reasoning guidance (max 50 KB) |
| `isBuiltIn` | `true` for seeds from `packages/shared/src/skills/` |
| `isVerified` | `true` for built-ins; reset to `false` whenever `promptText` is updated |
| `isActive` | Toggle to enable/disable without deleting |

**Table:** `skills` in `packages/shared/src/prisma/schema.prisma`

### 6.2 Built-in Skills (35 total)

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
|| Support / Ops | `support-ticket-tone` | `supportResponder` |
|| | `support-kb-retrieval` | `supportResponder` |
|| | `support-escalation-policy` | `supportResponder` |
|| | `support-response-templates` | `supportResponder` |
|| Product | `prd-readiness` | `productAnalyst` |
|| | `product-acceptance-criteria` | `productAnalyst`, `prdWriter` |
|| | `story-decomposition` | `prdWriter` |

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
1. At skill save time (gateway `POST /api/v1/platform/skills`).
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
There are no separate per-role skill/tool assignment endpoints — both are fields
on the `Agent` payload below.

### 9.1 Skills CRUD

| Method | Path | Min role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/platform/skills` | `ADMIN` | List all skills (built-in + custom) |
| `POST` | `/api/v1/platform/skills` | `ADMIN` | Create a custom skill |
| `GET` | `/api/v1/platform/skills/:id` | `ADMIN` | Get skill detail |
| `PUT` | `/api/v1/platform/skills/:id` | `ADMIN` | Update name / description / promptText / isActive |
| `DELETE` | `/api/v1/platform/skills/:id` | `ADMIN` | Delete (built-in skills are rejected with 400) |

Updating `promptText` automatically resets `isVerified` to `false` and triggers a security scan (the scan result is returned in the response but does not block the save).

### 9.2 Agent library (model / prompt / skills / tools)

The single governed surface for per-key config. An Agent payload carries
`modelSpec` / `inheritsModelFrom`, `systemPrompt`, `credentialId`, ordered
`skillRefs`, and `toolKeys` (`null` = all four workspace tools; values from
`IMPLEMENTER_TOOL_IDS = ['readFile', 'writeFile', 'listDirectory', 'bash']`).
Writes cut a new immutable `version`.

| Method | Path | Min role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/platform/agent-library` | `ADMIN` | List Agents (GLOBAL + overrides) with resolved fields |
| `GET` | `/api/v1/platform/agent-library/:id` | `ADMIN` | Agent detail + version history |
| `POST` | `/api/v1/platform/agent-library` | `ADMIN` | Create an Agent (or cut a new version) |
| `PUT` | `/api/v1/platform/agent-library/:id` | `ADMIN` | Update an Agent → bumps `version` |
| `DELETE` | `/api/v1/platform/agent-library/:id` | `ADMIN` | Delete / deactivate an Agent override |
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

- **`STEP_REQUIRED_AGENTS` drift is caught late in one direction.** A stale key — naming a step
  that no longer exists — fails `stepRequiredAgents.coverage.test.ts` in CI. A *missing* key, the
  damaging direction, cannot be inferred statically: one activity module hosts several activities,
  so walking imports for `recordLlmUsage` reports `runLint` as an LLM step because its module also
  holds the gate-fix loop. `recordLlmUsage` therefore checks it at runtime instead — it is the only
  place that knows both the executing activity and the agent key just spent on — and logs a warning
  plus an `llm.step_agent_unregistered` span attribute. That fires the first time the step runs, not
  at merge, so a new model-resolving step should be added to the map deliberately rather than
  discovered. Steps whose agent comes from the spec rather than the map — `runAgentNode`, which
  binds whatever `agentRef` a template node names — carry `null` in the map itself and skip the
  check, because no static entry could ever exist for them and the warning would be constant.
  The check only judges activities the boot gate actually walked: most LLM-spending activities are
  not step executors at all (channel turns, the memory passes, the workflow-authoring activities) and
  are covered by `assertConfigReady`'s other rules, so measuring them against a map of *steps* would
  warn on every healthy deployment. It follows that an activity outside the gate's scope gets no
  drift check here at all. The warning is also once per (step, agent) per process, so a drifted entry
  on a hot step cannot bury itself; the `llm.step_agent_unregistered` span attribute is set on every
  affected run.
- **The boot gate reflects install state at boot, not forever.** `requiredAgentKeysForDeployment()`
  reads the installed templates once, at startup. Activating a template afterwards — or adding a
  Slack channel — does not re-run the check, so a newly reachable agent with no credential fails at
  its node rather than at boot. Restarting the worker restores the fail-fast guarantee.
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
- **A catastrophic scanner pattern is bounded, then dropped for a while.** Scanner regexes execute
  in a pooled worker thread under a wall-clock budget (`shared/lib/regexExec.ts`) resolved from the
  `workspace.regexScanBudgetMs` setting (default 250 ms; ADMIN-only, platform-wide) and applied per
  scanned window, so a pattern that backtracks catastrophically is terminated instead of wedging
  the process. The scan it overran fails closed for a blocking scanner and degrades for an advisory
  one. An overrun is confirmed by re-running the isolated pattern alone on a fresh thread — one
  observation on a starved host is not evidence — and only a second overrun quarantines it, for
  `REGEX_QUARANTINE_TTL_MS` (10 min) in that process. Inside that window later scans **skip** the
  rule and the executor reports it in `quarantinedPatternKeys` without marking the scan incomplete;
  the caller decides what that means. The blocking scanners (`scanShellCommand`,
  `checkSensitiveFilePath`) block on a non-empty list — a rule they never ran cannot clear the
  input — so a quarantined shell or sensitive-file rule denies `bash` and `writeFile` until an admin
  fixes or disables the row at `/admin/scanner`, instead of costing two budgets per call. The
  advisory scanners proceed without the rule. It is logged on every skip, and quarantine is
  per-process, so gateway and worker decide independently and both forget on restart.
- **The write-time backtracking probe is sound but incomplete.** `POST /admin/scanner-patterns`
  executes a candidate against repetition-heavy input built from its own alphabet and rejects it if
  it overruns the budget. It cannot see a merely polynomial pattern (`a+a+$` is fine at 40
  characters and takes minutes at 20 k) or one whose blow-up needs input the corpus does not
  contain, and it does not run at bundle install, which is pure and synchronous. Runtime bounding
  is what covers those.
