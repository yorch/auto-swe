# Agents, tools, and skills

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
| `implementer` | `executeImplementation` | `anthropic/claude-opus-5-5` |
| `reviewer` | `runReviewNetwork` (all three sub-agents) | `anthropic/claude-opus-5-5` |
| `planner` | `planDecomposition`, epic planning | `anthropic/claude-sonnet-5-5` |
| `securityReview` | `scanDiffForSecurityIssues` — the post-diff gate on `executeImplementation` + the three fix paths | `anthropic/claude-sonnet-5-5` |
| `validateContext` | `validateContext` | `anthropic/claude-sonnet-5-5` |
| `commitToMemory` | `commitToMemory` | `anthropic/claude-opus-5-5` |
| `channelAssistant` | Channel turns, ambient and reactive modes, `planChannelTask` / `runChannelSubtasks` | `anthropic/claude-opus-5-5` |
| `evalJudge` | `runEvalNode` judge scorer | `anthropic/claude-haiku-4-5-20251001` |
| `workflowAuthor` | NL workflow generation | `anthropic/claude-opus-5-5` |
| `workflowExplainer` | NL workflow explanation | `anthropic/claude-sonnet-5-5` |
| `repoDependencyInferrer` | `inferRepoDependencies` — proposes repo dependency edges for human confirmation | `anthropic/claude-haiku-4-5-20251001` |
| `contentWriter` | Generic document-workflow drafting (e.g. Notion) | `anthropic/claude-sonnet-5-5` |
| `brandReviewer` | Content/Comms pack — brand-voice and clarity review | `anthropic/claude-sonnet-5-5` |
| `supportResponder` | Support/Ops ticket replies | `anthropic/claude-sonnet-5-5` |
| `productAnalyst` | Product pack — problem analysis | `anthropic/claude-sonnet-5-5` |
| `prdWriter` | Product pack — PRD drafting | `anthropic/claude-sonnet-5-5` |
| `issueDrafter` | Product pack — drafts issue descriptions from a brief | `anthropic/claude-sonnet-5-5` |

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

No `modelSpec`; each carries `inheritsModelFrom` so it runs on its parent's model. The activity that
runs a persona resolves its `systemPrompt`, skills, `toolKeys`, and MCP binding from the persona's
own row, with three exceptions that keep an edit to the parent row in force:

- **Fix and merge-resolver tools are bounded by the implementer's.** A `ciFixer`, `reviewFixer`,
  `gateFixer`, or `mergeConflictResolver` session runs with the intersection of its own `toolKeys`
  and the implementer's (`null` meaning every tool on either side), so removing `bash` or `mcp` from
  the implementer removes it from every fix path. A persona can narrow the implementer's tools,
  never widen them. An intersection with no workspace tool left falls back to the implementer's
  workspace tools, because an empty list reads as "every tool".
- **A fix or merge-resolver persona with no MCP binding uses the implementer's**, subject to the same
  bound: it binds only when both rows allow `mcp`. The same goes for skills: a persona with none of
  its own is given the implementer's, since the seeded ones carry none.
- **A customised `reviewer` prompt still reaches the review personas.** See
  [the review network](#4-the-review-network) for the prompt order.

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
  `/studio/agents/library`. Each agent's History view lists its versions, shows what changed
  between a version and the one before it (prompt as a line diff; model, skills, tools,
  credential and MCP connection as field changes), and restores an older version as a new one. A
  restore leaves the prompt out of the new version when it equals the current prompt, so it keeps
  the current verification. A restore runs the same MCP connection check as an edit (400 when the
  connection is inactive or another team's), warns about skills deactivated since, and is refused
  with a 409 while the agent is deactivated, so it never switches an agent back on by itself.
- **Runtime:** an optional `runtime` (`mastra` or `claude-code`; null = no opinion) chooses the loop
  that drives the agent where it works in a workspace. It is resolved with the rest of the version
  and inherited along `inheritsModelFrom`; setting or changing it takes a platform ADMIN, in the
  agent library or by installing a bundle that carries it ([bundles.md](./bundles.md)). See
  [§3.7](#37-runtimes-mastra-and-the-claude-code-harness).
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

Activities don't call the factory directly — they use **`buildImplementerTurnRunner({ workspace, tracer, ctx, agentKey? })`** (`agents/implementerRuntimeSelect.ts`). It resolves the agent's runtime first (`resolveAgentRuntime`: a per-agent pin, else the Agent version's own `runtime`, else the run-pinned `workspace.implementerRuntime`; see [§3.7](#37-runtimes-mastra-and-the-claude-code-harness)) and builds only what that runtime uses. For the Mastra loop it calls `buildImplementerForActivity(workspace, tracer, ctx, agentKey?)` (`agents/implementer.ts`), which loads `toolKeys` + skills at the current scope (`resolveImplementerConfig`), resolves the Agent's optional MCP server via `resolveAgentMcpUrl`, and builds the agent; for a harness it takes the one the harness registry holds for that runtime ([§3.7](#37-runtimes-mastra-and-the-claude-code-harness)), loads the same `toolKeys`, skills and step budget, binds the Agent's model and credential through that harness, and never opens the MCP client or binds a Mastra model. It returns `{ kind, kindSource, runtime, promptSuffix, systemPrompt(base), maxSteps, skills, toolKeys, close }`, where `kind` is the runtime it built and `kindSource` what chose it; `close` releases the MCP client and **must** be called in a `finally` block. `agentKey` defaults to `implementer`; the fix sessions pass `ciFixer` / `reviewFixer` / `gateFixer`, `resolveMergeConflict` passes `mergeConflictResolver`, and the eval harness passes the ref's key (and steers the runtime only through pins, for a side with a runtime override — [evals.md §3](./evals.md#comparing-runtimes)), so each runs on its own row — tools bounded by the implementer's (`effectivePersonaToolKeys`) — and binds the implementer's model through `inheritsModelFrom`. `executeImplementation`, `implementerSession`, `resolveMergeConflict` and the eval harness all go through it, once per session rather than per turn, so the load + MCP-binding lifecycle lives in one place and a resumable runtime keeps its session across iterations and attempts.

**Running a turn:** activities do not call `agent.generate` themselves. `runImplementerTurn` (`agents/implementerRuntime.ts`) runs one turn through an `ImplementerRuntime` — the Mastra tool loop (`mastraRuntime(agent, maxSteps)`) or the Claude Code harness, chosen per agent ([§3.7](#37-runtimes-mastra-and-the-claude-code-harness)) — then accrues usage through `recordLlmUsage`, runs the advisory output scan, and records the LLM call on the tracer. `executeImplementation`, `implementerSession`, the eval harness, and the merge-conflict resolver all take this path, so a turn is metered and traced identically wherever it runs. The runtime only drives the loop and reports text, tool-call count, and usage; the caller still calls `assertBudgetAvailable` first and owns any failure row.

**Step budget.** One `agent.generate` call is a *turn*: the model calls tools until it answers or
runs out of steps, and every tool call counts as one step. The budget is the
`workspace.agentMaxSteps` setting (default 50, bounded 5–500, overridable per team and
organization — see [configuration.md](./configuration.md)), returned as `maxSteps` and passed on
every implementer, fixer, resolver, and eval-replay `generate`. The generic `runAgent` (agent
nodes, channel-assistant turns) passes the same budget whenever the agent carries tools — an agent
node with MCP tools, say — resolved at the caller's scope; a tool-free call is a single step and
does not read it. Mastra's own default when no budget is passed is 5 steps, which ends a turn
before the agent has read, edited, and tested anything. Like `workspace.maxToolOutputChars`, it is
read once per agent build.

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

### 3.2.1 Memory tools (`searchLessons`, `explainLesson`)

When the session works on a repository — the implementer, and every fix session (`ciFixer`,
`reviewFixer`, `gateFixer`) — two read-only tools are added beside the workspace tools, like
`loadSkill` outside `toolKeys`. Both are bound to the session's repository in code, never by an
argument the model passes:

```
searchLessons({ query: string, limit?: 1–10 }) → { lessons: [{ lessonId, summary, failureType, confidence, similarity }] }
explainLesson({ lessonId: uuid }) → { found, lesson: { outcome, evidence, mergedFrom, replaced, status, … } }
```

`searchLessons` returns what recall would for the agent's own query; `explainLesson` reads a lesson
of the same repository (any other id is not found) and withholds any field that matches an injection
pattern. Recalled lessons carry their ids, so the agent can ask about one. See
[memory.md §3](./memory.md#3-recalling-lessons).

### 3.3 Path Safety

`safePath(relPath)` normalises the path and rejects anything that is absolute, starts with `..`, contains null bytes, backslashes, or single quotes. This prevents path-traversal attacks in `readFile`, `writeFile`, and `listDirectory`.

### 3.4 Write Tool Security Chain

`writeFile` runs through two sequential checks before writing:

1. **Sensitive file scanner** (`checkSensitiveFilePath`) — hard-block. Rejects `.env`, PEM/key files, SSH private keys, credential JSON files. Returns the block message to the agent and records a trace with `error: 'blocked by sensitive file scanner'`.
2. **Pre-write content scanner** (`wrapWriteToolWithSecurityCheck`) — soft-block. Regex-based check for secrets/tokens in file content. Returns a prefixed error string starting with `SECURITY_CHECK_FAILED_PREFIX` or `SECURITY_WARNINGS_PREFIX`. The trace `error` field is set to `'blocked by content security check'` or `'content security warning'` so the gateway query in `/govern/security` can classify the event without raw SQL. Every trace tag (including the shell scanner's `'blocked by shell command scanner'`) is defined once, in `SECURITY_TRACE_ERRORS` (`@auto-swe/shared/lib/scannerCache`), which the tools write and the security-events endpoint and the eval trajectory scorer's guardrail count both read.

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

**Authentication.** A connection may carry one optional **bearer token**. It is entered at `/studio/mcp`
in a masked, write-only field and stored in the Connection's AES-256-GCM `apiKey*` envelope columns
(the same envelope as every other secret, so `yarn keys:rotate` re-encrypts it); it is never part of
`config`. Responses carry only `hasToken`; an edit that omits the token keeps it, supplying one replaces
it, and `clearBearerToken` removes it. The audit trail records whether a token is set, never its value.
Changing a connection's URL to a different origin while keeping its stored token is refused (409
`TOKEN_ORIGIN_CHANGE`): enter a new token or clear the old one first.

The worker decrypts the token in `mcpUrlForConnection` and passes it to `loadMcpTools`, which gives the
MCP client one `fetch` (`bearerFetch`) for both transports. That fetch adds `Authorization: Bearer …`
only to requests for the connection's own origin, refuses redirects, and the client is also pinned to
the connection's host with `allowedHosts`. The token is a non-enumerable property of the resolved
target, so serializing or logging the target cannot carry it, and it is scrubbed from the error text of
a failed connect. A token that no longer decrypts yields no MCP tools for the run. The Test button
sends the same header to the same origin only, trying streamable HTTP first and then the legacy SSE transport (a URL ending `/sse` goes straight to it), as the worker does.

**Custom headers.** A connection may carry up to five custom request headers (an API gateway key, a
tenant id). They are entered at `/studio/mcp` as name/value rows with masked values and sealed as one
JSON list in the Connection's `headers*` envelope columns, which `yarn keys:rotate` covers like every
other secret. They are write-only: responses carry header **names** (`headerNames`) only, the audit
trail records names only, and an edit sends the complete list, where a row without a value keeps the
stored value of that name and an empty list removes them all. Names must be RFC 7230 tokens and unique
ignoring case; hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`,
`Transfer-Encoding`, `Upgrade`), `Host`, `Content-Length`, `Content-Type`, `Accept`, `Cookie`,
`Set-Cookie` and the MCP protocol headers are refused, and so is `Authorization`: the bearer token is
the one place that credential lives. The same origin rule as the token applies: a URL edit to a
different origin that keeps stored header values is refused (409 `HEADERS_ORIGIN_CHANGE`). The worker
sends the headers through the same `bearerFetch` on both transports, only to the connection's own
origin and never over a transport's own headers, and the Test probe does the same. They are
non-enumerable on the resolved target and absent from every log and trace. Headers that no longer
decrypt yield no MCP tools for the run.

**Private networks.** An admin may tick "This server is on a private network"
(`config.allowPrivateNetwork`) for a server on an RFC 1918 or unique-local address. It waives only the
private-range refusal, with the semantics of the issue-tracker and knowledge-base connectors
(`checkProbeUrl`): loopback, link-local, unspecified and cloud-metadata addresses are refused with or
without it. Save, the Test probe and the worker's connect all apply the same check against the saved
flag, and the flag appears in the audit trail.

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
  `/api/v1/studio/mcp` — `POST` create, `PATCH :id` edit url/name/timeouts/token/headers/private-network flag,
  `DELETE :id` soft-delete; `PATCH` rebuilds `config` from the body so a blank timeout clears the
  override) and attach one to an Agent via the `mcpConnectionId` field on the
  agent-library form. `validateMcpConnectionRef` enforces that the reference is an active `mcp`
  Connection, and TEAM-scoped agents may only reference their own team's connection (tenancy).
- **Test and usage:** `POST /api/v1/platform/mcp-connections/:id/test` connects to the saved URL
  over streamable HTTP, initializes, and lists the tools within the connection's list timeout,
  answering `{ ok, toolCount, toolNames, durationMs }` or a fixed reason. The SSRF guard runs first,
  redirects are not followed, and the server's own error text is never returned. Reading stops once
  the matching answer is parsed (an event stream may be held open), the session is closed with a
  best-effort `DELETE`, and the list timeout is clamped to 60 s.
  `GET /api/v1/platform/mcp-connections` adds `usedBy`: the agents whose current version binds each
  connection. A connection is owned by a team, but a platform-wide agent may bind any connection; a
  team's own agents only their team's.
- **Guarding:** non-git connections are filtered out of the repo read/submit paths (GET
  `/repositories`, Slack picker, epics, scheduled requests) and rejected by the shared
  `isGitRepoConnection` guard (`@auto-swe/shared/lib/connectionGuards`) on the submit paths.

### 3.6 Large Tool Output Offload

`bash`, `readFile`, and `listDirectory` bound how much of a tool's output reaches the model.
`writeFile` and `loadSkill` are not covered — their return values are already small. Once a result
exceeds `workspace.maxToolOutputChars` (setting registry; default `20 000`
characters — see [configuration.md](./configuration.md)), the full output is written to a file under
`/workspace/.tool-output/` inside the workspace container, and the model instead receives a
**head + tail excerpt** bounded around that limit, the file's absolute path, and the count of elided
characters. For `bash`, offload applies on both the success and the non-zero-exit path, so a failing
command is covered the same as a passing one.

- **Head + tail, not head-only.** For test and build output the decisive information — a failure, a
  summary line — is usually at the *end*. A head-only preview would systematically hide it.
- **Outside the repo, not inside it.** `/workspace/.tool-output/` sits alongside `/workspace/target-repo`,
  not under it, because an offload file inside the repo could be swept up by `git add -A` and end up
  committed into the PR.
- **Retrieval is a `bash` round-trip.** The offload path is absolute, and `safePath()` (§3.3) rejects
  absolute paths on principle, so `readFile` cannot fetch an offloaded file back. The agent retrieves
  more of it with `bash` (`sed -n` and similar). An agent whose `toolKeys` disables `bash` never gets
  more than the excerpt — see Limitations (§11).
- **Resolved once per agent construction.** Unlike the rest of the setting-registry cascade, which
  re-resolves on every call (see [configuration.md §4](./configuration.md#4-run-pinned-settings)),
  `workspace.maxToolOutputChars` is read once when the implementer agent is built. A change to the
  setting takes effect on the next implementer build, not the next tool call within one already
  running.
- **Traced faithfully, not fully.** The `AgentTrace` row for an offloaded call records the excerpt
  the model actually saw, plus the offload path and the original character count — never the full
  blob — so a trace stays an honest record of what the model saw, and `agent_traces` does not grow
  unbounded on one noisy command.
- **Fails closed to truncation, never to the unbounded blob.** If the offload write itself fails,
  the tool falls back to a bounded truncation of the output. It never throws on a failed offload and
  never hands the model the full, unbounded result.

### 3.7 Runtimes: Mastra and the Claude Code harness

**Files:** `packages/worker/src/agents/implementerRuntimeSelect.ts`, `lib/config/agentRuntime.ts`,
`agents/harness/`, `agents/harnessRegistry.ts`, `agents/claudeCode/`

Two loops can drive an agent that works in a workspace: the platform's own Mastra tool loop, and the
Claude Code harness running inside the workspace container. Which one drives an agent is decided per
agent, by `resolveAgentRuntime(key, ctx, default)`:

1. **The run's pin.** `WorkflowRun.agentRuntimes` (`{ agentKey: runtime | null }`) is written at run
   start by `createWorkflowRun`, or by `startChannelRun` for a channel-assistant turn
   (`snapshotAgentRuntimes`): every agent the run can resolve, with the
   runtime its Agent asks for — or `null`, meaning it had no opinion and the caller's default
   decides — resolved in the scope and under the agent-version pins the run's activities use. Every
   resolution in the run — another activity, a retry, a parallel branch — reads it, so an edit to an
   agent or to a scoped override of it after the run starts cannot move the run's agents onto the
   other loop, and a `null` pin keeps a runtime added later out too. An agent with no entry (created
   after the run started) is pinned the first time the run resolves it. A caller can supply the pin instead (`ctx.agentRuntimes`, never written
   back): an eval case does, for a side whose eval run names a runtime
   ([evals.md](./evals.md#comparing-runtimes)), so the override wins over the Agent's own runtime.
2. **The Agent version's own `runtime`.** Resolved through the same cascade and agent-version pin as
   its model, and inherited along `inheritsModelFrom` like the model: a persona with no runtime of its
   own (`ciFixer`, `reviewFixer`, `gateFixer`, `mergeConflictResolver`) follows the agent it takes its
   model from, because the harness can only drive the model that chain resolves. A version that names
   its own model does not inherit a runtime.
3. **The caller's default.** For the implementer family it is the run-pinned
   `workspace.implementerRuntime` setting (`mastra` by default; `claude-code`). An agent run's default
   is `mastra`, whatever that setting says.

A first-use pin is written as a compare-and-set on the whole map, so two activities pinning
different agents at once keep both entries and two pinning the same agent agree on the first; it
never overwrites a pin, a `null` one included. An agent run skips the run-start snapshot: its one
step resolves its agent in a narrower scope (no team or template override) and pins it there,
before its clone. The agent-version pin alone could not promise this: it freezes the GLOBAL row only, so a TEAM or template
override edited mid-run would otherwise move a running agent onto the other loop. Outside a run (eval
replays) nothing is pinned and the value resolves live. Each session records an `agent.runtime`
activity event naming the runtime and where it came from (`run`, `agent`, `default`), and the run
viewer's header shows the runtime pinned for each agent that has one of its own (`agentRuntimes` on
the run detail).

Where the runtime applies:

| Path | Runtime |
|---|---|
| `executeImplementation`, `implementerSession` (CI / review / gate fixers), `resolveMergeConflict`, eval replays | resolved as above, default `workspace.implementerRuntime` |
| `runAgentTask` (agent runs) | resolved as above, default `mastra` |
| `runAgentNode` (generic `agent` nodes), `runAgent` callers | always Mastra: there is no workspace for the harness to run in. An Agent that asks for the harness gets an `agent.runtime_not_applicable` event on the trace |

Both the setting and the `runtime` column are ADMIN-only because they decide what runs inside the
trust boundary and which credential enters the workspace. A team admin's edit of a TEAM agent keeps
the runtime an ADMIN chose and is refused (`403`) if it would change it. Saving `claude-code` on a
version whose own model is not `anthropic/…` is refused (`400 RUNTIME_MODEL_MISMATCH`); a version that
inherits its model is checked when a run resolves it (`HARNESS_UNSUPPORTED_MODEL`). The column carries
a CHECK constraint, and the worker reads an unknown value as no opinion, with a warning.

**Agent runs on the harness.** An agent run whose agent asks for `claude-code` runs one harness turn in
its own container in place of the Mastra loop. The run's step ceiling is the harness's turn cap and its
wall-clock deadline stops the turn as it stops the Mastra loop: the run ends with
`stoppedReason: 'wall_clock'` and is still gated and published. The harness is granted exactly the
harness tools that stand in for the workspace tools the agent-run rule grants (`null` → `Read`, `Glob`,
`Grep`; a list → only what it names; `[]` and `["mcp"]` → no tools), never the implementer's "no
opinion means everything". It binds no MCP server; an agent with one gets an
`agent.runtime_mcp_skipped` event. The budget is checked before the turn, and each model call is
debited as soon as the harness has finished it (`perCallAccounting`, through the runtime's
`onCallSpent`), with the budget re-checked after every debit, as the Mastra loop debits every step: an
exhausted budget aborts the turn and the run fails `BUDGET_EXCEEDED` after the call in flight. When
the turn ends, only what was not debited call by call is accrued. Delivery is unchanged: the diff is still judged and pushed from a fresh container the agent
never ran in ([agent-runs.md §4](./agent-runs.md#4-delivery-and-the-trust-boundary)).

Both runtimes sit behind the same `ImplementerRuntime` interface: it drives one turn and reports
text, tool-call count and usage. Usage accounting, the advisory output scan and the trace row stay
in `runImplementerTurn`, so a turn is metered and traced identically whichever loop ran it. Our own
outer loop — TDD iterations, the test run, commit, push, the diff scans — is unchanged.

**The harness seam.** A harness is a `HarnessAdapter` (`harness/adapter.ts`) run by the shared
`harnessRuntime` (`harness/runtime.ts`). The split is what every harness needs and none may get
wrong, against what is one harness's own:

| Shared — `harnessRuntime` | Per harness — `HarnessAdapter` |
|---|---|
| The platform probe; installing the binary and checking its SHA-256 before every turn | `provisioning`: the binary for a platform, its hash, its path in the container, any one-off container setup |
| The `docker exec -i` spawn: exec tag, secrets named without a value, stderr drained | `runTurn`: driving one turn over the harness's own protocol, and reporting a deadline as a stop |
| Killing the turn's tag when it ends, however it ends | `decide`: mapping a native tool call onto the canonical vocabulary |
| Cancellation and a caller's deadline, wired to one abort controller; a cancelled turn reports the cancellation | `usage`: a normaliser from what the harness reports to per-model usage |
| Each decision bounded by the 60 s deadline, a throw turned into a deny, a refusal traced with its tag | `capabilities`: whether it can enforce the per-call policy |
| Tool results bounded to 20 000 characters in the trace; a failed turn's usage accrued | `close`: anything held beyond a turn (optional) |
| Per-call metering for every turn (`onCallSpent` on the turn's input): each call debited once the next begins, a throw aborting the turn, the turn's report reconciled against what was debited | Reporting each model call's usage as it streams (`turn.callUsage`) |

The canonical vocabulary (`harness/policy.ts`) is the four capabilities of the Mastra workspace
tools, and `decideCanonicalCall` applies their scanners to it: `shell` gets the audit line and
`scanShellCommand`; `write` gets confinement to the checkout, the protected-configuration check,
`checkSensitiveFilePath` and the pre-write content check; `read` and `search` get confinement to the
checkout and the harness's own read roots. An adapter maps its native tools onto those four (a
`ToolVocabulary`), and tool keys grant capabilities, not native names: `readFile` and
`listDirectory` grant `read` and `search`, `writeFile` grants `write`, `bash` grants `shell`. The
implementer family reads the Agent's `toolKeys` (no opinion grants all four); an agent run passes an
exact grant (`exactToolKeys`), where nothing named is nothing granted.

Both `buildImplementerTurnRunner` and `runAgentTask` pick a harness only through the registry
(`harnessRegistry.ts`, built with `createHarnessRegistry`), keyed by the runtime `resolveAgentRuntime`
returned. Selecting binds the Agent's resolved model into the access the harness's client needs, and
refuses a model it cannot speak to before anything is built — an agent run binds it before its
container is cloned. A harness declares `enforcesPerCallPolicyInWorker` only when it asks the worker
before **every** tool call, over a channel the worker owns, waits for the answer, and cannot run a
refused call — and no file in the repository or the container can grant a call without that answer.
The registry refuses a harness without it when it is registered (at worker start-up) and again when
it is selected, and `harnessRuntime` refuses such an adapter too, all with the non-retryable
`HARNESS_POLICY_UNENFORCEABLE`. A runtime value no harness serves fails with `HARNESS_UNAVAILABLE`.

**How the harness runs.** The Claude Agent SDK runs in the worker. The `claude` binary runs in the
workspace container, started through `docker exec -i` with the SDK's `spawnClaudeCodeProcess`. The
SDK's `PreToolUse` hook runs in the worker, so every tool call is decided there, by `decideToolCall`
(`claudeCode/policy.ts`), before the harness executes it. It maps Claude Code's tools onto the
canonical vocabulary (`Bash` → `shell`; `Write`, `Edit` → `write`; `Read` → `read`; `Glob`, `Grep` →
`search`) and decides them with `decideCanonicalCall`:

| Tool | Worker-side policy |
|---|---|
| `Bash` | audit line with secrets redacted, then `scanShellCommand` (soft block) |
| `Write`, `Edit` | an absolute path inside the checkout; the harness's own configuration refused while the run loads it (see *Repository configuration*); `checkSensitiveFilePath` (hard block), then the pre-write content check on the inserted text (CRITICAL blocks; lower severities allow with a warning returned to the model) |
| `Read`, `Glob`, `Grep` | an absolute path inside the checkout or the harness's own `.claude` directory; a search with no path runs from the harness's current directory, which must be inside the checkout; a glob may not be absolute or contain `..` |
| anything else | refused |

Paths must be absolute because the harness resolves a relative one against its own current
directory, which a `cd` in an earlier `Bash` call moves: `cd .git` followed by a `Write` of
`hooks/pre-push` would otherwise be checked as one file and written as another.

The tools are the same capability as the four Mastra workspace tools under Claude Code's names, and
the Agent's `toolKeys` gate them the same way: `readFile` and `listDirectory` grant `Read`, `Glob`
and `Grep`, `writeFile` grants `Write` and `Edit`, `bash` grants `Bash`, and `null`, `[]` or a list
naming no workspace tool grants all six. A tool the keys do not grant is left out of the harness's
tool list and refused by the policy as well. `loadSkill` and the `mcp` binding do not apply. A scanner
that cannot complete throws and the call is refused, and so is a call the policy has not decided
within 60 s. Decisions are granted explicitly (`permissionMode: 'default'` with a hook `allow`);
`bypassPermissions` is not used, and the harness refuses it as root anyway. Refusals and warnings
carry the same `AgentTrace.error` tags (`SECURITY_TRACE_ERRORS`) as the Mastra tools, so the
security-events view counts them.

**When the hook fails.** A `PreToolUse` hook the harness gives up on (its timeout is 120 s, past the
worker's own 60 s deadline) falls back to Claude Code's ordinary permission evaluation. That fallback
is pinned to refuse: the SDK's policy settings tier sets `allowManagedPermissionRulesOnly`, so allow
rules from any other source — a repository's `.claude/settings.json` included — are ignored, and the
call reaches the runtime's `canUseTool`, which denies everything. The flag settings layer also pins
`permissions.defaultMode: 'default'` and disables bypass mode.

**Model access.** The harness runs on the model and decrypted credential the Mastra runtime would
have used for the same Agent, and only for `anthropic/<model>` specs — Claude Code speaks the
Anthropic Messages API. A credential's `apiBase` is how a deployment sends the harness through its
own gateway (for example Kong); a trailing `/v1`, which the AI SDK spelling includes, is stripped
because the harness appends it.

With the worker's **model proxy** on (`HARNESS_MODEL_PROXY_PORT`, [configuration.md](./configuration.md)),
the credential never enters the container. Each turn registers with the proxy
(`agents/claudeCode/modelProxy.ts`) and the harness gets a random token in place of the key and the
proxy's address in place of the provider's. The proxy accepts only `POST /v1/messages` and
`/v1/messages/count_tokens`, only with a token whose turn is still running, sends the call on to the
credential's host with the real key, and streams the answer back unchanged. A token read out of the
container is good for that turn's model calls, at the proxy, until the turn ends, and spends against
the run's budget like any other call. A workspace reaches the proxy at `HARNESS_MODEL_PROXY_URL`: by
default `host.docker.internal`, which `createWorkspace` maps to the Docker host gateway, or a worker
that shares `WORKSPACE_NETWORK` with its workspaces, as the shipped compose files run it.

Without the proxy the credential reaches the container as `ANTHROPIC_API_KEY`, named on the
`docker exec` command line without a value so it never appears in `ps`. Either way the base URL is
pinned through the SDK's highest-priority settings layer, so a repository's own
`.claude/settings.json` cannot redirect the harness, and the key or token it sends, to another host.

**Repository configuration.** The repository's `CLAUDE.md` and `.claude` settings apply
(`settingSources: ['project']`), so a flow ported from a developer machine behaves as it did there.
Because the harness reads them again when the next turn starts, `Write` and `Edit` may not change
them: anything under a `.claude` directory, `CLAUDE.md` and `CLAUDE.local.md` at any depth, and the
root `.mcp.json` are refused.

**Skills.** The Mastra loop discloses skills through a `loadSkill` tool; the harness has none, so it
receives each skill's text inline in the system prompt. A prompt over 100 000 characters is staged as
a file in the container, because it travels on a command line capped at 128 KiB per argument. The file
is `/workspace/.harness/home/.claude/system-prompt.md`, inside the one directory outside the checkout
the policy lets `Read` reach.

**Usage.** Every turn is metered per call: `runImplementerTurn` hands the runtime the turn's
`onCallSpent` (`perCallAccounting`), each model call is debited and the budget re-checked as the call
ends, and an exhausted budget aborts the turn with `BUDGET_EXCEEDED`. Through the model proxy the calls
are exact: the proxy reads each response's usage as it streams past and reports the call when its
response ends (`turn.callSpent`) — the small-model side calls the harness makes without streaming a
message included — and once the turn is aborted its in-flight calls are cut off and new ones refused.
Without the proxy the adapter reports the usage each streamed assistant message carries
(`turn.callUsage`), and a call is debited once the next one begins. The harness itself reports usage
per model as running totals (a resumed session starts from its saved totals, so a turn records the
change since the last); a turn that ends without a result — a deadline stopped it, or the process
died — falls back to its streamed messages. Whichever report the turn ends with is reconciled against
what was debited call by call (`subtractSpent`), so nothing is charged twice.
Each model is priced at its own spec
(a harness may delegate small tasks to a cheaper model). Cache reads and writes count as input
tokens toward the budget and are priced at the model's cache rates. A turn that ends in an error
result has still been billed for what it spent: the runtime attaches that usage to the error
(`withSpentUsage`), and `runImplementerTurn` accrues it before rethrowing the original error.

**Sessions and cleanup.** Turns after the first resume the same session, so a TDD loop keeps its
context and prompt cache. Every process the harness starts carries the exec tag
(`AUTO_SWE_EXEC_ID`), and the tag is killed after every turn: `docker exec` does not stop what it
started when its client dies, so a cancelled or timed-out turn would otherwise leave the harness and
its children running.

**Container requirements.** The runtime copies the binary in at first use, choosing the variant for
the container's architecture and libc, and installs `bash` on Alpine (Claude Code's shell tool needs
it and busybox `sh` is not enough). The libc is what `ldd --version` reports; without a verdict from
it, a glibc loader means glibc even beside a musl loader. Before every turn the container's copy is
compared with the worker's by SHA-256 (`sha256sum` in the container) and copied again when it
differs; a copy that still differs fails the turn without retrying, so the image needs `sha256sum`
(coreutils or busybox). A preparation that fails is retried on the next turn. The harness's stderr is
read by the worker, so a full pipe cannot stall it and its tail explains a run that died. The SDK's
own environment switches (`CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*` that the SDK set or changed) are passed
into the container with their values; nothing else from the worker's environment is. The SDK ships a binary per platform as an optional dependency;
`.yarnrc.yml` sets `supportedArchitectures` so both libc variants for the build architecture are
installed and end up in the worker image. An executor image with neither `bash` nor `apk`, or on an
architecture the worker was not built for, fails the turn without retrying.

**Testing.** `runtime.docker.test.ts` runs the real runtime against a real container and a mock
Messages API, with no API key: `CLAUDE_CODE_DOCKER_TEST=1 yarn vitest run
packages/worker/src/agents/claudeCode/runtime.docker.test.ts`. It needs the Docker registry and
Alpine's package mirror; the `docker-tests` job in `ci.yml` runs it with the flag set, so it is
part of the CI gate that image publishing depends on.

**Other harnesses.** Claude Code is the only harness registered. Codex CLI, OpenCode and Gemini CLI
were each checked for what the registry requires: a callback the worker answers, synchronously,
before every tool call, that nothing inside the container can bypass. None provides it.

- **Codex CLI.** Its worker-reachable channel is the `codex app-server` JSON-RPC protocol over
  stdio, whose `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
  requests do block until the client answers. They are sent only when the approval policy escalates
  a call, though: `on-request` asks only for commands that leave Codex's own sandbox, `granular`
  only allows or auto-rejects categories of prompt, `never` asks for nothing, and `untrusted` is no
  longer accepted. Commands Codex already trusts, and every command that runs inside its sandbox,
  run without a request — and Codex reads files through its shell, so a read of a file outside the
  checkout reaches no scanner. Its `PreToolUse` hooks are commands Codex spawns, so they run inside
  the container the agent controls.
- **OpenCode.** Setting every permission key to `ask` makes each tool call wait for a permission
  reply, which the worker could give over `opencode acp` (ACP `session/request_permission`) or the
  `opencode serve` API. But OpenCode loads plugins from the repository (`.opencode/plugins/` and the
  `plugin` list in a project `opencode.json`) into the harness process at start-up, with no switch to
  turn that off, and a plugin's `permission.ask` hook can set a call to `allow` without the client
  being asked. A repository could therefore grant calls the worker never sees.
- **Gemini CLI.** In ACP mode a call that needs confirmation blocks on `session/request_permission`,
  and an admin-tier policy rule for `*` with `ask_user` routes read-only tools there too. The request
  carries no tool arguments, only a display title, a diff for edits, and file locations, so the
  worker would be scanning a rendering of a shell command rather than the command. The rule that
  makes every call ask, and the system settings that keep repository settings out, are files inside
  the container (for example `/etc/gemini-cli/policies/`), which the agent's own shell can rewrite;
  there is no client-supplied settings layer like the one the Claude Agent SDK passes over its pipe.

Adding a harness is an adapter in its own directory, a `defineHarness` entry in `harnessRegistry.ts`,
a new value in `IMPLEMENTER_RUNTIMES`, unit tests, and a `*.docker.test.ts` named on the
`docker-tests` job in `ci.yml` — and the adapter must honestly declare `enforcesPerCallPolicyInWorker`.

---

## 4. The Review Network

**File:** `packages/worker/src/agents/reviewNetwork.ts`

**Entry point:** `runReviewNetwork(codeResult, options?)` — `options` (`ReviewNetworkOptions`) carries the per-persona prompts and skill suffixes, success criteria, cross-repo context, a step-level prompt override and the tracer.

Runs three Mastra `Agent` instances in parallel via `Promise.allSettled`. Each reviewer runs as its own persona Agent: the `runReviewNetwork` activity resolves `securityReviewer`, `domainLogicReviewer`, and `performanceReviewer` and hands each one its own row's `systemPrompt` and skills, and each binds its model with `getModel(<persona>)` — the `reviewer` model through `inheritsModelFrom` unless the persona row overrides it. Each persona's base prompt is chosen in this order: a step-level `systemPrompt` on the review node (replacing all three); the persona row's own prompt, when an admin has customised it (it differs from that persona's built-in prompt); the parent `reviewer` row's prompt, when an admin has customised it; the persona row's seeded prompt; the built-in constant. The `reviewer` row is seeded with the domain-logic prompt, so it counts as customised only when it differs both from that constant and from the `domainLogicReviewer` row's text — the second comparison keeps a deployment seeded before a later rewording from handing the domain-logic prompt to all three. Each reviewer keeps its own skill suffix whichever prompt it runs.

| Reviewer | Agent row | Built-in prompt (when the row has none) |
|---|---|---|
| `SECURITY` | `securityReviewer` | `SECURITY_AUDITOR_PROMPT` |
| `DOMAIN_LOGIC` | `domainLogicReviewer` | `DOMAIN_LOGIC_REVIEWER_PROMPT` (+ success criteria) |
| `PERFORMANCE` | `performanceReviewer` | `PERFORMANCE_REVIEWER_PROMPT` |

Each verdict's structured output is validated against the verdict schema; an object that fails it counts as a reviewer failure. A failure is handled by kind:

- **Unrecoverable** — a non-retryable `ApplicationFailure` (`BUDGET_EXCEEDED`, `MODEL_UNPRICED`) or a `ConfigMissingError`: the network rethrows it and the activity fails. It is not a verdict on the code, so it never sends the change to a review-fix session.
- **Every reviewer failed** (a provider outage, typically): the network throws a retryable `REVIEW_NETWORK_UNAVAILABLE` failure and Temporal retries the activity under its retry policy.
- **Some, not all, reviewers failed**: each missing verdict becomes a synthetic `REVIEWER_CRASH` finding at `CRITICAL` severity, and the review stands on the others.

The overall `approved` flag requires all three verdicts to be approved. A verdict at `CRITICAL` severity is a rejection even when the model set `approved: true`. On rejection, `rejectionSummary` — the review-fix session's input — carries one line per finding of every rejecting reviewer, with the reviewer, severity, category, location, the problem (`description`) and the suggested fix; a reviewer that rejected without findings gets a `rejected without findings: <reviewer>` line.

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

**Planner:** `packages/worker/src/agents/plannerAgent.ts` — decomposes a multi-repo epic brief into per-repo `Subtask[]`. No tools; structured output (Zod schema, validated rather than cast). Uses `planner` model. The planner decides ordering, not scope (`normalizePlan`): an entry for a repository outside the epic is dropped, a repository listed twice is merged, every epic repository the planner omitted is added with no dependencies, and self-edges and dependencies outside the plan are removed. An empty plan fails non-retryably (`EPIC_PLAN_EMPTY`); `planEpic` refuses before the model call when none of the requested ids is an available git repository.

**Decomposer:** `packages/worker/src/agents/decomposer.ts` — sub-agent that refines per-repo work into feature-level subtasks. No tools; structured output. Runs as the `decomposer` Agent (its own prompt and skills) on the `planner` model it inherits. Caps at 8 subtasks; subtask IDs must match `^[a-z][a-z0-9-]{0,39}$`. Falls back to a singleton plan if the LLM returns no structured output, or output that fails the schema.

---

## 6. Skills

### 6.1 What is a Skill?

A **skill** is a named prompt fragment (`promptText`) injected into an agent's system message. Skills control *how* an agent reasons — they do not grant new capabilities. Each skill has:

Skills are an **ADMIN-curated library**: creation (`POST /api/v1/platform/skills`) and edits are ADMIN-only routes. A skill carries `scope` (`GLOBAL`, `ORGANIZATION` or `TEAM`) with `orgId`/`teamId`, mirroring `Agent`. Built-ins and admin-created skills default to `GLOBAL` and are visible everywhere; a team- or org-scoped skill is visible only within its tenant, because `promptText` is where a team is most likely to encode internal process knowledge. Which agents use a skill is decided separately, by the agent's `skillRefs`.

| Field | Purpose |
|---|---|
| `name` | Kebab-case identifier (e.g. `test-first`) |
| `description` | One-line summary shown in the L1 menu |
| `promptText` | Full reasoning guidance (max 50 KB) |
| `isBuiltIn` | `true` for seeds from `packages/shared/src/skills/` |
| `isVerified` | `true` for built-ins; set on a custom skill only by an ADMIN through `POST /api/v1/platform/skills/:id/verify`; reset to `false` by any edit that cuts a revision (a `promptText` or `description` change) — a rename or an `isActive` toggle does not reset it |
| `currentRevision` | The `SkillRevision` number that `promptText` and `description` currently mirror (§6.5) |
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
- A skill whose text was imported from an external source is prefixed with its provenance, `- **name**: [external: owner/repo@1a2b3c4] description` (§6.6). Without the source row (it was deleted) the label is `[external@1a2b3c4]`; a skill whose text an admin has since edited by hand is no longer labelled (a description-only edit keeps the label, since the text is still the imported text). The same label reaches every other path the text takes to a model (§6.6).

`skillsToPromptSuffix(skills)` joins prompt texts with double-newline; returns `undefined` for an empty array. Used by reviewer and planner sub-agents (which receive skill fragments directly in the system prompt rather than via the L1 menu).

### 6.4 Custom Skill Security Scanning

Custom skills' `promptText` is scanned by `scanSkillContent(text)` in `packages/shared/src/lib/skillScanner.ts`:
- Loads INJECTION and EXFILTRATION patterns from the `ScannerPattern` DB table (60 s TTL cache).
- Returns `{ safe: boolean, warnings: string[] }`.
- **Non-blocking advisory** — warnings are returned but never prevent saving or execution. Scan failures are caught so a DB outage cannot abort a run.

The scan runs:
1. At skill create and edit (gateway `POST`/`PUT /api/v1/platform/skills`): the description and the prompt text are scanned together over the whole text, and a scanner failure is returned as a `scan-incomplete` warning rather than an error.
2. For every skill in a bundle at install time. Findings come back in the install response's `warnings` (one entry per finding, prefixed with the skill name) and are recorded on the new revision; an install is never refused for them.
3. After each TDD iteration in `executeImplementation` (scans LLM output for prompt injection attempts).

The warnings of the save-time and install-time scans are stored on the `SkillRevision` that holds the scanned text (`scanWarnings`).

**Memory is gated, not advised.** A lesson or a channel-memory item is replayed into every later run that recalls it — a lesson into the implementer's *system prompt* — so the same scanner is used as a gate there (`packages/worker/src/lib/memoryGuard.ts`):

- Every write through `insertMemoryItem`, and every row the two consolidators insert, is scanned over the whole text (summary and rationale). A match on an `INJECTION` pattern refuses the write: `commitToMemory` records a `memory.lesson_refused` event and returns no lesson id, a consolidator leaves the cluster unconsolidated and records `memory.consolidation_refused`, and the best-effort writers skip the item.
- Every reader that puts memory in a prompt — `retrieveSimilarLessons`, `retrieveChannelMemory`, `recentChannelMemory`, `searchOrgChannelMemory` — drops a matching item, so a row written before the gate existed, or edited since, never reaches a model.
- `EXFILTRATION` hits do not gate: those patterns match a URL or a `curl`, which an engineering lesson names as a matter of course.
- The gate fails closed. A scan that throws refuses the write and recalls nothing.
- Every prompt that carries memory wraps it in a `<recalled_memory>` fence stating that it is reference data, not instructions (`fenceRecalledMemory`): recalled lessons, and channel memory in a mention turn, a reactive interjection, an ambient digest and an org-flagging check.

The shell step masks its command before storing it as a lesson: the run's token by value, then anything shaped like a credential (`maskCredentialShapes` in `packages/worker/src/lib/redactToken.ts` — URL userinfo, auth headers, `*_TOKEN=`-style assignments, `--password`-style flags, well-known token prefixes). The auto-commit message it pushes gets the same masked text.

### 6.5 Skill revisions and run pinning

`Skill.promptText` and `description` are the live copy. Every change to either also writes an immutable `SkillRevision` (`skill_revisions`, unique on `(skillId, revision)`) and sets `Skill.currentRevision` to its number, in one statement. The paths that do so are: skill create (revision 1), skill edit (when the text or the description changes — a rename or an `isActive` toggle does not), the built-in sync when shipped text changes, and bundle install when a skill's text or description changes. A revision stores the text, the description, a content hash, the scan warnings, the author, and — for content imported from a source — provenance (`sourceSha`, `sourcePath`, `referenceFiles`). Revisions are never updated.

The skill detail's History view lists the revisions (`GET /api/v1/platform/skills/:id/revisions`), compares each with the one before it, and restores an older one with `POST /api/v1/platform/skills/:id/revisions/:revision/restore`. A restore appends a revision carrying the old text and, for an imported revision, its source commit, path and reference files, clears verification like any edit, and is refused for built-in skills, whose text comes from the platform.

An edit is guarded on the revision number it read, so two concurrent edits cannot both produce revision N+1: the second gets `409 SKILL_CHANGED`. `PUT /api/v1/platform/skills/:id` also accepts `expectedRevision`, the revision the editor had on screen; when it is present and the skill has moved on, the edit is refused with the same 409 before anything is written. A guarded write that finds the skill deleted answers 404. A built-in sync that loses the race to another replica booting alongside it skips the skill, since that replica wrote the same shipped text. Startup sync gives any skill that has no revision row the row for the revision it already names.

**A run pins the skill text it started with.** `createWorkflowRun` records `WorkflowRun.skillRevisions`, a `{ skillId: currentRevision }` map, beside `agentVersions`. It covers every skill visible to the run's tenant at that moment — GLOBAL, plus its team's and organization's own — keyed by skill id, so it holds whichever agent later references the skill: an explicit `key@version` agent ref, a CHANNEL-scope agent, or a skill attached to an agent after the run began. `currentRequestContext()` returns the map on `ResolveCtx.skillRevisions`; `resolveAgent` and `loadAgentSkills` then read a pinned skill's text and description from its `SkillRevision`, so a skill edited after the run began is not read at its new text by a retry or a replay of that run. Agent-run activities carry the pin into their own context the same way they carry `agentVersions`, and the map is part of the `resolveAgent` cache key. The pin is activity-side data: nothing in the workflow isolate reads it, so replay histories are unaffected.

What is deliberately not pinned: `isActive` is read live, so disabling a harmful skill still takes effect inside a run already under way; and `isVerified` describes the current text, so a pinned revision older than the current one is never reported as verified. A pin whose revision row is missing resolves the live text, with a warning in the activity log and a `skill.pinned_revision_missing` event on the run's trace.

**Verification.** `POST /api/v1/platform/skills/:id/verify` (ADMIN, audited) takes `{ "revision": n }`, the revision the admin read, and sets `isVerified` only if that is still the skill's current revision; otherwise it answers `409 SKILL_CHANGED` and verifies nothing. A body without `revision` is a 400. It is the only place a custom skill becomes verified, and any later edit that cuts a revision — a description-only edit included — clears it; a rename or an `isActive` toggle does not.

### 6.6 External skill sources

An admin can import skills from a folder of a GitHub or GitHub Enterprise repository. The import is a **tracked source**: a `SkillSource` row (`skill_sources`) holding `host`, `owner`, `repo`, `path` (the subdirectory, empty for the repository root), `ref`, and `pinnedSha`, the commit the text was read at. Each imported `Skill` points back at it (`sourceId`, `sourcePath`), and its revision 1 carries the commit and folder (`SkillRevision.sourceSha` / `sourcePath`) plus the companion text (`referenceFiles`). Deleting the source sets `Skill.sourceId` to null in the database, so its skills stay as ordinary custom skills and keep the provenance their revisions carry.

**What a skill is.** Any folder containing a `SKILL.md`. Its YAML frontmatter must give a `name` (letters, digits, space, `.`, `_`, `-`, up to 200 characters) and a `description` (up to 1000 characters; whitespace is flattened to one line, because the description is shown in the skill menu); the body becomes `promptText` (up to 50,000 characters). A folder whose `SKILL.md` has missing or invalid frontmatter, an empty body, or an over-long field is reported as an error on that skill and does not affect the others. A skill nested inside another skill's folder is its own skill and its files do not belong to the outer one. A skill with the same name as another in the same source is an error on both.

**Field mapping.**

| Source | Stored as |
|---|---|
| frontmatter `name` | `Skill.name` |
| frontmatter `description` | `Skill.description` |
| `SKILL.md` body | `Skill.promptText` (and revision 1) |
| `.md` / `.txt` files in the folder | `SkillRevision.referenceFiles` as `{ path, content }`, path relative to the skill folder |
| commit sha, folder | `SkillRevision.sourceSha`, `SkillRevision.sourcePath`, `Skill.sourcePath` |
| source tenancy | `Skill.scope` / `teamId` / `orgId` (GLOBAL unless a team or organization is given) |

Reference files are stored, not injected: only `promptText` reaches an agent.

**Script modes** (`SkillSource.scriptMode`, set per source by an admin):

- `TEXT_ONLY` (default): `SKILL.md` becomes the prompt, `.md`/`.txt` siblings are kept as reference text, and every other file is skipped and listed (`skippedFiles`, with a reason). Skipped files are never downloaded.
- `REJECT`: a skill folder containing any file other than `.md`/`.txt` is refused, with an error naming the files.

Nothing is ever executed or stored as runnable, in either mode. Symlinks and submodules are skipped and listed, never followed. Reference files over 100 KB, past the 50th per skill, or not valid UTF-8 are skipped and listed.

**Trust model.**

- **Unverified by default.** Imported skills start `isVerified: false`; an admin verifies a revision through `POST /api/v1/platform/skills/:id/verify` (§6.5) after reading it.
- **Provenance** is visible, on every path the text takes to a model, not just the menu. A single helper (`packages/worker/src/lib/config/skillPrompt.ts`) renders a skill for a prompt: imported text is preceded by `[external: owner/repo@sha7 — third-party text]` wherever it is inlined (the Claude Code harness runtime, the review personas, the generic `runAgent`, the planner, decomposer, memory, consolidation and security-review agents), in the text `loadSkill` returns, and as a `[external: owner/repo@sha7]` prefix on the skill's menu entry. A test fails if a new site reads a skill's `promptText` without going through it. The source columns on the skill's revisions record where the text came from. A description-only edit carries the provenance forward to the new revision (the text is unchanged); an edit to the text drops it.
- **Pinned to a commit.** The source records the commit it was read at. The installed text is the text of that commit, and a run that started earlier keeps the revision it pinned (§6.5).
- **Scanner blocking.** The description and text of each chosen skill get the full advisory scan (§6.4). Because this text was written by someone else, the registry setting `skills.import.blockOnScanWarnings` (ADMIN, GLOBAL only, default on) makes any warning, an incomplete scan included, refuse that skill, with the warnings named in the response. With it off, the skill is installed and the warnings are recorded on its revision.
- **Name conflicts.** An imported skill never overwrites or sits beside a skill an agent could confuse it with. A GLOBAL import conflicts with a same-named skill at any scope; a TEAM import with GLOBAL, its organization and its own team; an ORGANIZATION import with GLOBAL, the organization and every team in it. Names compare case-insensitively with spacing and trailing punctuation folded (`tdd.` is `tdd`), and two chosen skills that fold to one name conflict too. The preview marks conflicts, and an import that includes one is refused with a 409 listing every conflict. The check and the create run in one transaction under a transaction-scoped advisory lock, so two concurrent imports cannot both take a name.
- **ADMIN only**, and every create, change and delete is written to the audit log (`SkillSource`).

**Fetching.** One shared fetcher (`packages/shared/src/lib/skillSource/`) serves the gateway. It checks the host before any request: `github.com` is always allowed; any other host must be the instance's own GitHub host or listed in `github.repositoryHosts`, and every URL must pass the SSRF guard and be HTTPS. It uses only the platform credential, resolved by `resolvePlatformCredential`: wherever the platform has a credential for the host, it is used. That includes `github.com` when the instance itself is on `github.com` (the default), where the instance's token is sent to read any public repository there; a host with no credential of its own, and `github.com` on an instance that is not, is read anonymously. The instance's token goes to the instance's host and a host's own credential to that host, never elsewhere. A user's personal token is never used. The token is sent only in the `Authorization` header and only to the host it belongs to. Redirects are followed by hand, with every hop re-checked. The ref is resolved to a commit, the repository tree is listed at that commit (a `truncated` listing is refused), and blobs are fetched by sha; no archive is downloaded. Paths with `..`, an absolute path or a backslash refuse the source. Every failure reaches the caller as one of a fixed set of messages, never as text from `fetch` or the host.

**Private-network hosts.** The SSRF guard refuses a host that is, or is spelled as, a private address (loopback, RFC 1918, link-local, `.internal`, `.local`). A self-hosted GitHub Enterprise server on such an address is allowed only per host: it must be on the approved repository hosts list **and** in the ADMIN-only setting `skills.import.privateNetworkHosts`. Either alone does nothing. The waiver applies to that exact host (and its API host) and to redirect hops on it, never to another private host. Cloud metadata addresses and names (169.254.0.0/16, `fd00:ec2::254`, 100.100.100.200, `metadata.google.internal`, the bare host `metadata`), IPv6 link-local (`fe80::/10`) and loopback/unspecified addresses are refused whatever is listed.

**Limits.** 100 skills and 2 MB of fetched text per source. The fetch also has a budget that keeps an import from draining the GitHub rate limit the platform's workflows share: at most 300 API requests (the ref, the tree, one per `SKILL.md`, one per kept reference file, redirect hops included; when that is exceeded, reference files are dropped and listed as skipped before any skill is, and a source whose skills alone do not fit is refused), a 60 s deadline for the whole fetch, and a stop as soon as the host's `x-ratelimit-remaining` falls below 200 (a fifth of the limit when the limit is small, so an anonymous 60-per-hour read can still work). A request times out after 15 s. A create reads the source again, so it spends the same budget as the preview.

Everything shown to the admin that came from the repository (folder and file names, ignored frontmatter keys) has control characters replaced, and a skill folder whose name contains one is refused; descriptions are flattened to one line with control characters turned into spaces. The preview also lists the frontmatter keys the import reads nothing from (such as `allowed-tools`).

**API** (`/api/v1/platform/skill-sources`, ADMIN):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/skill-sources/preview` | Read a source and report each skill; writes nothing. With `skill: <name>` (and the previewed `sha`, refused with 409 SHA_MOVED if the ref moved), returns that one skill's complete incoming text instead |
| `POST` | `/skill-sources` | Import the chosen skills at the previewed commit |
| `GET` | `/skill-sources` | List sources with their skill counts |
| `GET` | `/skill-sources/:id` | One source with its skills |
| `PATCH` | `/skill-sources/:id` | Change `scriptMode`, or set `status` to `DISABLED` / `OK` |
| `DELETE` | `/skill-sources/:id` | Remove the source; its skills are detached |
| `POST` | `/skill-sources/:id/check` | Ask the host now which commit the ref names (what the sweep does for each source) |
| `GET` | `/skill-sources/:id/diff` | Per-skill diff against the latest commit, or `?sha=`; with `skill=<name>&full=true`, one skill's complete incoming text; writes nothing |
| `POST` | `/skill-sources/:id/accept` | Cut new revisions from the diffed commit |
| `POST` | `/skill-sources/:id/install` | Install skills of the pinned commit that nothing installed uses |

The preview body is `{ host?, owner, repo, path?, ref, scriptMode?, scope?, teamId?, orgId? }`. For each skill it returns the name, description, text length, reference file count, scan warnings, name conflicts, skipped files, errors, and whether it is installable, plus the resolved commit `sha`. The create body is the same fields plus that `sha` and `skills`, the names to import; the request supplies names, never text — the content is read again at the commit. If the ref no longer resolves to `sha` the answer is `409 SKILL_SOURCE_SHA_MOVED` and nothing is written, so the admin previews again. The source, every skill with its revision 1, and the audit entry are written in one transaction; any failure leaves none of them. A second source for the same host, owner, repository and path in the same scope is `409 SKILL_SOURCE_EXISTS` (the reference is not part of that key). Changing `scriptMode` affects only how the source is read from then on; skills already installed are not touched.

**CLI.** `auto-swe skills sources add <owner/repo> --ref=<branch|tag> [--host=H] [--path=DIR] [--script-mode=text-only|reject] [--skills=a,b] [--yes]` previews, asks for confirmation, then creates; `auto-swe skills sources list` lists the sources. `auto-swe skills sources check <id>`, `diff <id> [--sha=<commit>] [--skill=<name> --full]` and `accept <id> [--skills=a,b] [--yes]` are the update flow below; `accept` prints the diff and asks for confirmation unless `--yes` is given.

**Updating from the source.** A source is pinned to a commit and updates are reviewed, never applied on their own.

1. **The sweep flags.** `ScheduledSkillSourceSyncWorkflow` (a system-wide Temporal Schedule the gateway registers at startup, like model discovery; cadence in [configuration.md](./configuration.md): `SKILL_SOURCE_SYNC_ENABLED`, default on, and `SKILL_SOURCE_SYNC_CRON`, default `41 5 * * *`) visits each source that is not `DISABLED`, one at a time, and resolves its ref to a commit: one API request, no tree and no blobs. A commit different from `pinnedSha` records it as `latestSha` and sets `status` to `UPDATE_AVAILABLE`; the same commit sets `OK`; a failure sets `ERROR` and `lastError` to one of the fixed fetch messages (never host or `fetch` text). `lastCheckedAt` is always set. The sweep changes no skill and no revision, honours the fetcher's rate-limit floor, and when a host reports its limit low it leaves that host's remaining sources for the next run. One source failing does not stop the others. The workflow's result and logs carry source ids, counts, statuses and the fixed messages only. A rate-limit answer from the host is not an error: it records only `lastCheckedAt`, keeps the source's status and `latestSha`, and counts the source as skipped. `POST /skill-sources/:id/check` runs the same check for one source on demand and answers `{ recorded, check, source }`; `recorded` is false when the source changed under the check (it was disabled, or a newer commit was accepted) and the answer was dropped.
2. **The diff.** `GET /skill-sources/:id/diff` reads the source at `latestSha` (or `?sha=`), by that commit and not through the ref, and compares it with what is installed. It writes nothing. Per installed skill it answers `unchanged`, `changed` (old and new description, a unified diff of the live prompt text against the incoming text, which reference files were added, changed or removed, scan warnings, whether it is `handEdited`, and `renamedTo` when upstream's frontmatter name now differs), or an error when the skill no longer parses. It also lists `added` (a `SKILL.md` folder that no installed skill uses, whether it is new upstream or was never chosen at import; each with its scan warnings) and `removed` (an installed skill whose folder is gone). A diff of the text, not both full texts, because the change is what a reviewer must judge. The diff is a bounded Myers diff: at most 600 line edits per skill (a replaced line is two), a fixed work budget of 200,000 steps per skill (so a request of 100 skills spends at most 20 million), and 60,000 characters of output per skill. A skill past any of those limits is `diffIncomplete`, and whether it is depends only on that skill's own live and incoming text, never on the other skills, (`textDiffTruncated`, or `diffTooLarge` with no text at all, since a partial diff would show something other than what an accept installs). `GET /skill-sources/:id/diff?skill=<name>&full=true` returns that skill's complete incoming text so it can be read. The diff costs one budgeted fetch of the new commit (see Limits above); the old side comes from the immutable revisions already stored, not from the host. The old text is the live text, so an accept that would overwrite a hand edit shows the edit being reverted.
3. **The accept.** `POST /skill-sources/:id/accept` takes `{ sha, skills? }`, where `skills` is a list of `{ name, revision }`: the installed revision the diff showed for each skill. A named skill whose current revision differs (someone edited it since) is `409 SKILL_CHANGED` and nothing is written, so a skill is not overwritten while its live text differs from the revision the admin reviewed. Whether a skill's diff was complete is decided by that skill's own live and incoming text alone, so the diff and the accept agree on it. `sha` must still be the source's `latestSha`, the commit the admin diffed; otherwise `409 SKILL_UPDATE_STALE_SHA` and nothing happens. The content is read at exactly that commit. Each skill that changed gets a new `SkillRevision` through the same revision-guarded write a hand edit uses, with `sourceSha`, `sourcePath` and `referenceFiles` set and `isVerified` reset to false; an edit that lands meanwhile makes the whole accept `409 SKILL_CHANGED` and rolls everything back. `skills.import.blockOnScanWarnings` applies as on create: a chosen skill with a warning refuses the accept (`422 SKILL_UPDATE_SCAN_WARNINGS`, nothing written). The revisions, the source's new `pinnedSha` and `status`, and an audit entry with the old and new commit and each skill's new revision number commit in one transaction. A workflow already running keeps the revision it pinned at start (§6.5): an accept only appends revisions. A skill whose diff was `diffIncomplete` is not updated by default: an accept that would update one without it being named is `409 SKILL_UPDATE_DIFF_INCOMPLETE` listing it. Naming it in `skills` says its full text was read. A source with no recorded commit is `409 SKILL_UPDATE_NOT_CHECKED`. The audit entry records the updated skills and their revisions, and the skills left as conflicts, not selected, unreadable or removed. An upstream rename is kept out: the installed skill keeps its name, the diff shows `renamedTo`, and the accept response lists it under `renamed`.

**Hand edits.** An imported skill whose live text or description differs from what its source last gave it (its latest pristine revision: the one an import or an accept cut) is `handEdited`, and a description-only edit counts. A skill like that is never overwritten silently. An accept without `skills` updates every changed skill that was not hand-edited and reports the others under `conflicts`; naming a hand-edited skill in `skills` is the explicit overwrite, and its previous revision, edits included, stays in history. A hand-edited skill that did not change upstream is simply left as it is.

**The pin.** `pinnedSha` moves to the accepted commit only when every skill that changed upstream was updated. If any was left out (a conflict, a subset in `skills`, or a skill that no longer parses) the pin stays, the source stays `UPDATE_AVAILABLE`, and the next diff still lists what was left, so a pin never reads as up to date while a skill sits behind. Naming a subset and leaving a hand-edited skill diverged on purpose therefore keeps the source flagged until that skill is overwritten.

**Added and removed.** An accept never installs an added skill and never deletes a removed one: added folders are listed (`added`), removed skills are flagged (`removed`) and stay installed. An added skill is installed separately, with `POST /skill-sources/:id/install` (`{ sha, skills }`, names): `sha` must be the source's `pinnedSha` (otherwise `409 SKILL_IMPORT_STALE_SHA`), and the text is read at that commit by sha, never through the ref, so the pin does not move. A folder first added upstream after the pin is therefore `400 SKILL_IMPORT_UNKNOWN_SKILLS` until an accept advances the pin. The rules are those of the first import: all-or-nothing; errors, `skills.import.blockOnScanWarnings` and name conflicts are refused as on create; the conflict check runs under the same advisory lock inside the transaction, together with a re-read of the source (a source disabled, deleted or re-pinned meanwhile is `409 SKILL_IMPORT_SOURCE_CHANGED` and nothing is written); a folder already installed from the source is `409 SKILL_IMPORT_ALREADY_INSTALLED`; a disabled source is `409 SKILL_IMPORT_DISABLED`. The install and an accept on one source are serialised by a per-source advisory lock, and an accept refuses `SOURCE_CHANGED` if the installed set changed since it planned. The new skills take the source's scope, start unverified at revision 1 with the pinned commit as their provenance, and the install is audited as an update of the source. The CLI has no install command; removed skills are never deleted by any path.

**In the dashboard.** The skills studio page (`/studio/skills`) has an *External sources* tab for admins; the server enforces ADMIN regardless. It lists each source with its location, ref, pinned and latest commit (seven characters), status, last check time, the fixed `lastError` string and script mode, with *Check now*, *Review update* (when `UPDATE_AVAILABLE`), *Disable* / *Enable*, a script-mode switch and *Delete*, whose confirmation says the skills are detached and kept. *Add source* takes the location, script mode and scope (global or one team), previews without writing, and lists each skill with its description, text length, scan warnings, name conflicts, errors, skipped files and ignored frontmatter keys. Each skill that could be installed has *Read full text*, which shows its complete text in a scrollable panel (`POST /skill-sources/preview` with `skill`, at the previewed commit; each read costs one full fetch of the repository) and has to be used before the skill can be ticked. Skills with errors or conflicts, and skills with warnings while `skills.import.blockOnScanWarnings` is on, cannot be ticked; the create sends the chosen names with the previewed commit, and a moved ref, a name conflict or a refusal is shown with its reasons. *Review update* shows each changed skill's old and new description, rename, coloured unified diff, reference-file changes and scan warnings, with *edited by hand* and *diff incomplete* badges. Skills that are hand-edited or incomplete start unselected, and selecting one needs a confirmation (*Overwrite my edit*; *I've read the full text*, which is available once *Read full incoming text* has loaded the complete text). *Accept* sends the diffed commit and each selected skill with the revision the diff showed; a 409 asks the admin to reload the diff. *Install more skills* (shown while a source is `OK` or `UPDATE_AVAILABLE`) reads the source at its pinned commit and lists the folders nothing installed uses, with their scan results, name conflicts and errors as read at that commit; *Install* is off for any that would be refused, and sends that same commit. Each candidate that could be installed has *Read full text* (`GET /diff?sha=<pinnedSha>&skill=<name>&full=true`, one full fetch each, checked against the pinned commit), and *Install* stays off until the text has been read at that commit; the reads are discarded on reload, and the modal follows the source's current pin, so a pin that moved is picked up by *Reload*. An admin therefore reads the text of every skill before it is installed, in the first import and in a later install alike. The review lists added folders at the latest commit for information only. The skills list marks an imported skill `external: owner/repo@sha7` (`GET /skills` carries `externalSource` with the commit its current text was cut from), shows its revision and verified state, and *Verify* is in the skill's detail view, beside its rendered text, and attests to the revision that view shows. The detail view also lists the scanner findings recorded on the current revision (`GET /skills` returns them as `scanWarnings`, with the keys of the active agents that use the skill as `usedBy`), and the delete and deactivate confirmations name those agents. The review is read once when it opens and never refreshed behind the admin: a focus or reconnect does not re-read it, and only *Reload diff* does, which discards every selection and confirmation (those are keyed by commit, skill and installed revision). Every string that came from a repository (names, descriptions, folders, paths, diff lines, full text) is rendered as plain text with every control, format and default-ignorable character (zero-width characters, soft hyphens, variation selectors, Unicode tag characters, bidi controls) written out as `⟨U+202E⟩`, since the stored text keeps them; the CLI and the shared display helper apply the same rule. The one exception is an emoji: a single variation selector right after an emoji-capable character and a joiner between two pictographs are left as they are so that emoji render normally; they are shown in every other position, and tag characters always.

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

**Agent runs read `toolKeys` differently.** The implementer reads `null`, `[]` and a list with no
workspace tool in it as every tool. An [agent run](./agent-runs.md) launches an arbitrary library agent
and can publish what it writes, so it grants `writeFile` and `bash` only when they are named: `null`,
`[]` or `["mcp"]` grant `readFile` and `listDirectory` only. The two rules are separate functions
(`createImplementerAgent` and `selectAgentRunTools`); MCP gating (`isMcpToolEnabled`) is the same in
both. Neither matches the column comment on `Agent.toolKeys`, which says `[]` means no tools.

Note: `Agent` (like `ProviderCredential`) uses partial unique indexes per scope (Prisma cannot express `WHERE IS NULL` in `upsert`). Code uses `findFirst + conditional create` for GLOBAL-scope rows instead of `upsert`.

---

## 8. Agent Observability (AgentTracer)

**File:** `packages/worker/src/lib/agentTracer.ts`

Every LLM-calling activity **must** use `AgentTracer` to record tool calls, LLM responses, and activity events. These are persisted as `AgentTrace` rows and power the `/runs/[id]` viewer. Every row written since the column was added carries its Temporal `workflowId`; `runId` links it to the `WorkflowRun` when one exists. Workflows that keep no run (workflow authoring and explaining, scheduled evals, lesson consolidation, repo-dependency inference, repo-access sync, epic planning) still persist their traces with a null `runId`, so their LLM spend is recorded rather than dropped.

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

**`persistActivityTrace(tracer, role)`** in `packages/worker/src/lib/activityContext.ts` auto-resolves the workflow ID, `runId`, and `attempt` from Temporal context and calls `tracer.persist({ runId, workflowId }, nodeId, role, attempt, nodeTag)` (the tag is §8.4's). It attaches the OTel span active at that moment unless the caller already attached a more specific one with `tracer.setSpanContext()` — `runAgent` does, because it persists after its LLM span has ended. **Never omit this call** in new LLM-calling activities — the run viewer depends on it.

An attempt can persist more than one tracer — its own and `runAgent`'s — and each numbers its records from 0, so `persistActivityTrace` reserves a block of `seq` values per attempt and offsets each batch into it. `seq` is therefore unique within an attempt, and batches order by when they were persisted.

**`runAgent`** records a `tool_call` row for every tool call Mastra made inside its loop, then the call's `llm_response` row. Each tool it binds is wrapped so its `execute` records the row as the call happens — real duration, input, output or the thrown error's message — which also keeps the rows of calls made before a `generate` that then throws. A call that never reached `execute` (invalid input, an unknown tool) is read afterwards from the steps of the `generate` result, matched by call id so a wrapped call is not recorded twice; Mastra keeps only successful results in a step's `toolResults`, so such a call's error comes from the tool message the loop fed back to the model, and a call with no outcome anywhere is recorded as failed, never as a success with no output. A caller whose tools record themselves passes its own tracer as `RunAgentOptions.tracer` and names those tools in `RunAgentOptions.selfRecordingTools` — `runAgentNode` (MCP tools) and `runAgentTask` (workspace and MCP tools) do. `runAgent` then records into that tracer, leaves the named tools unwrapped and unread, and leaves persisting to the caller, so every row shares one sequence and persists once. Every row lands in call order as the calls happen; only the rows read from the steps are appended after the loop returns, just before the `llm_response`. A tool is named by identity, not key, so a self-recording tool displaced on a key collision does not take the winning tool's rows with it.

**`inputJson` convention for `addLlmResponse`:** always pass `{ systemPrompt, userMessage }` so the `/runs/[id]` viewer can show exactly what was sent to the model. Declare prompt variables as `let` before the `try` block (not `const` inside it) so the error `catch` path can reference them too — otherwise failed LLM calls produce traces with no request context.

### 8.2 Trace Record Shape

```typescript
interface TraceRecord {
  seq: number;                                      // insertion order within the activity attempt
  type: 'tool_call' | 'llm_response' | 'activity_event';
  toolName?: string;                                // tool ID, agent role, or event name
  inputJson?: unknown;                              // redacted, then truncated to 32 000 chars per string value
  outputJson?: unknown;
  durationMs: number;
  error?: string;                                   // set for blocked/failed calls
}
```

String values are stored up to 32 000 characters per field. The run page polls, so
`GET /api/v1/workflow-runs/:id` and its live tail `GET /api/v1/workflow-runs/:id/traces` trim each
field to 4 000 characters (head and tail) and mark the trace `trimmed`; the page then offers
**Load full payloads**, which refetches once with `?fullTraces=true` and stops polling. The `writeFile` tool records only the file `path` in `inputJson` (not the full
content) to keep trace sizes manageable.

### 8.3 AgentTrace Table

**Table:** `agent_traces` in `packages/shared/src/prisma/schema.prisma`

| Column | Purpose |
|---|---|
| `runId` | FK to `workflow_runs`; null for workflows that keep no run |
| `workflowId` | Temporal workflow ID — set on every new row; older rows read it from their run |
| `nodeId` | Activity type (e.g. `executeImplementation`) — not a workflow node id |
| `specNodeId` / `recordingId` / `stepAttempt` | The workflow-spec node the activity ran for, its recording id (branch-prefixed inside a fan-out: `fan[0]/impl`, equal to `WorkflowStep.nodeId`), and the interpreter's attempt at it. Null when the interpreter did not dispatch the activity, and on rows older than the columns — see §8.4 |
| `agentKey` | Which agent key (identity) produced this trace |
| `attempt` | Temporal activity attempt number (for retries) |
| `seq` | Insertion order within the activity attempt |
| `type` | `tool_call` \| `llm_response` \| `activity_event` |
| `toolName` | Tool ID, reviewer type, or event name |
| `inputJson` / `outputJson` / `error` | Full (truncated) details |
| `durationMs` | Wall-clock duration of the call |
| `model` / `inputTokens` / `outputTokens` / `costUsd` | Per-call attribution on `llm_response` rows |
| `otelTraceId` / `otelSpanId` | Correlation with the matching Tempo span |
| `teamId` / `orgId` | Whose spend the row is — see §8.5. Null when no owner is derivable |

### 8.4 Node attribution

`attempt` is Temporal's retry of one activity dispatch; `stepAttempt` is the interpreter's attempt at
the node (`onFail.retry` dispatches a fresh activity each time), so a retried node reads
`stepAttempt` 1, 2, … each with `attempt` 1.

An activity learns which node it runs for from a Temporal **header**, not an argument. In
`runnable.ts` the dispatcher wraps each `dispatchStep` / `dispatchShell` in `runWithNodeTag` (an
`AsyncLocalStorage` over `{ specNodeId, recordingId, stepAttempt }`, which the interpreter now
passes on every dispatch). A workflow interceptor (`workflows/nodeTagInterceptor.ts`, registered via
`interceptors.workflowModules`) copies the store into an `x-auto-swe-node` header on `scheduleActivity`;
a worker activity interceptor (`lib/activityNodeTag.ts`) decodes it, and `persistActivityTrace` plus
the embedding usage row write it. Async-local storage rather than a variable matters: fan-out
branches run concurrently, and each awaits between choosing its node and scheduling its activity.
The interceptor adds a header only, so the command stream is unchanged and recorded histories
replay (`runnable.nodeTag.replay.test.ts` replays every fixture with it registered).

Every dispatch kind goes through the two dispatch methods — `step`, `agent`, `mcp`, `eval`,
`containerStep` through `dispatchStep`, `shell` through `dispatchShell` — so all are attributed.
Rejected: threading the id through each activity's inputs (dozens of positional signatures and
every in-flight payload), and reading the run's `RUNNING` step row (a fan-out has several at once,
so it cannot say which belongs to a given activity).

### 8.5 Spend attribution

Every row records the team and organization whose spend it is, written at persist time by
`persistActivityTrace` and the embedding usage row from `currentSpendOwner()`
(`lib/spendOwner.ts`). A run's owner is derived the way run visibility decides its team: the run's
own repository (an epic child), its ledger row's repository, its work request's connection, its
Slack channel, then its template. A workflow with no run names its owner itself with
`withSpendOwner`: authoring and explaining charge the requesting team, lesson consolidation and
dependency inference the repository's team, and the eval harness the dataset's team (or its
organization, for an ORGANIZATION-scoped dataset). Resolution never fails an activity; a lookup that
fails attributes the row to nobody.

With these columns `AgentTrace` is a tenant-scoped model for the `tenantGuard`: a mass query on it
carries a `teamId`/`orgId` predicate or declares itself with `runUnscoped`.

**Limitations.**

- **Some rows have no owner.** A GLOBAL eval dataset, an epic's planning call (its work request
  spans repositories), repository-access sync, a memory re-embed, and a run whose template,
  channel and repositories are all unowned write null `teamId`/`orgId`.
- **Rows that predate the columns are unattributed.** Nothing backfills them.

The run viewer (`web/src/lib/traceLinkage.ts`) filters on these fields: a node selects all its
branches, a fan-out selects everything inside it, a step row selects exactly its execution.

**Embeddings** are recorded too: each `generateEmbedding` call inside an activity writes one
`llm_response` row with `agentKey: 'embedding'`, its tokens, and its cost, and adds the cost (not the
tokens) to the workflow's `ActiveWorkflow` ledger. Tokens stay off the ledger because the per-tier
budgets are measured in chat tokens.

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
| `POST` | `/api/v1/platform/skills/:id/verify` | `ADMIN` | Mark the current revision human-verified (audited) |
| `DELETE` | `/api/v1/platform/skills/:id` | `ADMIN` | Delete (built-in skills are rejected with 400) |

Any edit that cuts a revision (a `promptText` or `description` change) automatically resets `isVerified` to `false`, whether or not the skill is flagged built-in (bundle-installed skills are); a rename or an `isActive` toggle leaves it. The edit triggers a security scan (the scan result is returned in the response but does not block the save). A change to `promptText` or `description` cuts a new revision (§6.5).

Importing skills from an external repository is a separate surface, documented with its trust model in §6.6.

### 9.2 Agent library (model / prompt / skills / tools)

The single governed surface for per-key config. An Agent payload carries
`modelSpec` / `inheritsModelFrom`, `systemPrompt`, `credentialId`, ordered
`skillRefs`, and `toolKeys` (`null` = all four workspace tools; values from
`IMPLEMENTER_TOOL_IDS = ['readFile', 'writeFile', 'listDirectory', 'bash']`).
Writes cut a new immutable `version`.

For admins, each row of the library table carries a "No credential" badge on its Model cell when the
provider it calls has no usable credential (and the row is not pinned to its own `credentialId`).
The status comes from the one `GET /api/v1/platform/readiness` response the page already shares with
the setup banner, and a sub-role persona takes its parent's status. Readiness describes only the
platform-wide agents, so the badge appears on platform-wide rows alone; a team, organization or
template override is never badged, because it may use a different model or credential.

| Method | Path | Min role | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/platform/agent-library` | `ADMIN` | List Agents (GLOBAL + overrides) with resolved fields |
| `GET` | `/api/v1/platform/agent-library/:id` | `ADMIN` | Agent detail + version history |
| `POST` | `/api/v1/platform/agent-library` | `ADMIN` | Create an Agent (or cut a new version) |
| `PUT` | `/api/v1/platform/agent-library/:id` | `ADMIN` | Update an Agent → bumps `version` |
| `GET` | `/api/v1/platform/agent-library/:id/versions` | `ADMIN` | Every version of the lineage `:id` belongs to, newest first, with skills and author |
| `POST` | `/api/v1/platform/agent-library/:id/restore` | `ADMIN` | Cut a new version from an older one (`{ versionId }`); never rewrites history |
| `DELETE` | `/api/v1/platform/agent-library/:id` | `ADMIN` | Delete / deactivate an Agent override |
| `GET` | `/api/v1/teams/:id/agent-library/options` | Team member | Agent keys, names and models an override may inherit from (GLOBAL plus the team's own); no prompts or tools |
| `GET` | `/api/v1/teams/:id/agent-library` | Team `ADMIN` | List TEAM-scope Agent overrides |
| `POST` | `/api/v1/teams/:id/agent-library` | Team `ADMIN` | Create a TEAM-scope Agent override |
| `PUT` | `/api/v1/teams/:id/agent-library/:agentId` | Team `ADMIN` | Update a TEAM-scope Agent override |

---

## 10. Data Model Summary

| Model | Table | Purpose |
|---|---|---|
| `Skill` | `skills` | Skill definitions (name, promptText, isBuiltIn, isVerified, isActive, scope, currentRevision) |
| `SkillRevision` | `skill_revisions` | Immutable history of a skill's text and description; what a run's `skillRevisions` pin reads |
| `SkillSource` | `skill_sources` | An external GitHub / GitHub Enterprise folder skills were imported from: location, ref, pinned commit, script mode, scope (§6.6) |
| `Agent` | `agents` | Single source of truth per key/scope: model spec, system prompt, credential pin, tool keys, skill refs (versioned) |
| `AgentSkillRef` | `agent_skill_refs` | Join from an `Agent` to a `Skill` with `sortOrder` |
| `ProviderCredential` | `provider_credentials` | AES-256-GCM encrypted API keys per provider per scope |
| `EmbeddingConfig` | `embedding_configs` | Singleton embedding model + credential |
| `AgentTrace` | `agent_traces` | Per-activity tool-call / LLM-response / event rows |
| `MemoryItem` | `memory_items` | pgvector semantic memory (1536-dim HNSW); `skillsActive` records the skills the memory agent itself ran with when it wrote the lesson (empty for lessons written without a model call and for consolidated rows) — not the skills of the run being summarised. Steps without their own LLM call — the merge-conflict resolver and shell steps — write lessons through `recordLessonBackground`, which does not block the activity |
| `ScannerPattern` | `scanner_patterns` | Regex rules for INJECTION, EXFILTRATION, SHELL_COMMAND, CODE_SECURITY, SENSITIVE_FILE scanners |

**Schema file:** `packages/shared/src/prisma/schema.prisma`

---

## 11. Limitations

- **The Claude Code harness's container-side checks are tripwires, not a boundary.** The binary's
  hash is taken with the container's own `sha256sum`, so code that controls the container (its
  `sha256sum`, or a process that outlives the turn's tag cleanup) can defeat the check; the harness's
  hooks and its reported usage are only as trustworthy as the binary. The usage a turn records is
  what the harness process inside the container reports. The fallback pin relies on the SDK's policy
  tier, which Claude Code drops when the container has an administrator-tier managed settings file
  of its own (for example one written to `/etc/claude-code/` by an earlier `Bash` call). The
  worker-side policy hook decides every call a genuine binary makes; the container's own isolation is
  what holds when the binary is not genuine.
- **Claude Code is the only harness an agent can run on.** Codex CLI, OpenCode and Gemini CLI each
  lack a worker-answered callback before every tool call that the repository or the container cannot
  bypass, so the registry would refuse them ([§3.7](#37-runtimes-mastra-and-the-claude-code-harness),
  *Other harnesses*). The verdict rests on what each CLI exposes for that callback; one that gains
  it fits the same seam.
- **The capability flag is declared, not proven.** The registry trusts what an adapter declares in
  `enforcesPerCallPolicyInWorker`; it refuses an adapter that says no, but cannot test that one which
  says yes routes every call through `turn.decide`. Each adapter's unit and Docker-backed tests are
  what show it does.
- **Under the Claude Code harness, `Bash` can still change the harness's configuration.** The
  `.claude` / `CLAUDE.md` / `.mcp.json` refusal applies to `Write` and `Edit`; a shell command is
  checked only by the shell-command scanner, whose write-target extraction is a heuristic over the
  command text and does not know the harness's current directory.

- **The memory gate and the credential masker are pattern-based.** The memory gate (§6.4) refuses
  only the phrasings the `INJECTION` patterns name; a reworded instruction is stored and recalled,
  with only the `<recalled_memory>` fence between it and the model. A refused write is visible only
  as a trace event or a worker log line — there is no review queue. `maskCredentialShapes` masks
  credential *shapes*; a secret with no recognisable name or prefix in a shell step's command is
  stored as written.

- **MCP authentication is a static bearer token plus up to five static custom headers.** OAuth flows
  and per-user tokens are not supported. The SSRF guard checks the URL's host text and then resolves the name at connection time and
  connects only to a checked address (see `docs/configuration.md` §5, outbound URL guard), so a
  public hostname that resolves to a private address is refused unless the connection opts in to a
  private network (the opt-in covers the connection's own origin only; any other origin a request or redirect names is checked strictly), and one that resolves to loopback, link-local or metadata never connects. A server that redirects (for example `/mcp` to `/mcp/`) is
  refused by the token-carrying client and by the Test probe, so the connection URL must be the final
  one. Rotating the token is an edit of the connection; runs already connected keep the token they
  started with.

- **A skill created after a run starts is not in its pin.** It resolves its current revision, which is
  also its only one. An epic's children are runs of their own and pin at their own start, so an edit
  between the epic's start and a child's start reaches that child. A run created before the
  `skillRevisions` column existed has no pin. A channel-resident run started by the channel assistant
  (`startChannelRun`) writes its own `WorkflowRun` and pins the latest active GLOBAL Agent versions,
  each agent's runtime at the channel's scope, and the skills visible to the channel's team and
  organization; a channel task run through
  `createWorkflowRun` with no repository pins GLOBAL skills plus those of the team and organization
  of the Slack channel its request came from (matched on Slack's channel id). Eval-harness cases are not runs and always read current text.
- **The token budget is a soft cap under fan-out.** The budget gate runs before a call and usage is
  accrued after it, so calls that start together all pass the same gate: the review network checks
  once before its three reviewers start, and the parallel branches a decomposition fans out to each
  check before their own turn while their siblings' usage is still unrecorded. The overshoot is bounded by the concurrency times one turn's usage,
  not by the cap.
- **A skill's `isActive` flag is not pinned.** It is read live on purpose, so a pinned run cannot keep
  using a skill an admin has disabled; the cost is that disabling and re-enabling mid-run changes
  which skills a retry sees.
- **A pinned revision whose row is missing falls back to the live text** rather than failing the run.
  Deleting a skill deletes its revisions with it, along with the agents' references to it.
- **Verification attests to text, not to a source.** `isVerified` says an admin approved the current
  revision; it carries no signature and nothing re-checks it against provenance.
- **External skill sources run no scripts.** Nothing from a source is executed, and only `.md`/`.txt`
  files are kept, as reference text no agent reads: a skill whose value is in its scripts or assets is
  imported as its instructions alone (`TEXT_ONLY`) or refused (`REJECT`).
- **External skill sources never update on their own.** The sweep only flags a moved ref; skills change
  when an admin accepts a reviewed diff. A source disabled with `PATCH` is skipped by the sweep and
  refuses an on-demand check and an accept until it is re-enabled.
- **Skills added upstream are listed by an accept, installed separately, and only at the pinned commit.**
  An accept updates and flags skills that are already installed; a new `SKILL.md` folder (or one never
  chosen at import) appears under `added`. It is installed with *Install more skills* in the dashboard
  (`POST /skill-sources/:id/install`), which reads the source at `pinnedSha` and never moves the pin, so a
  folder that first appears upstream can be installed only after an accept has advanced the pin. The CLI has no
  install command.
- **The dashboard adds sources at Global or Team scope only.** The API also takes an organization; the
  form has no organization picker.
- **A skill left behind keeps its source flagged.** A hand-edited skill that changed upstream, or one left
  out of `skills`, holds the pin back and the source reads `UPDATE_AVAILABLE` until it is updated; there
  is no way to mark an upstream change as declined.
- **Reference files from an accept are stored unscanned,** like the ones from an import; only the
  description and text are scanned.
- **Diff and accept each cost a full budgeted fetch.** Each reads the whole new commit (up to 300
  requests), so the CLI's `accept`, which diffs first, can spend about 600 requests, beside the one
  request of the check. The old side comes from stored revisions, so a skill with no identifiable
  import revision is treated as hand-edited.
- **Diffs are bounded.** A skill with more than 600 line edits (a replaced line is two), or one whose diff would pass
  60,000 characters, or one whose diff needs more than its 200,000-step work budget, has no complete diff
  (`diffTooLarge` or `textDiffTruncated`). Its full incoming text has to be read with `full=true` and
  the skill named in `skills` to accept it; the default accept refuses it.
- **Hand-edit detection is by content.** Text or a description edited back to exactly what the source
  last gave counts as not hand-edited, so the next accept updates it without asking; nothing is lost,
  since every revision stays. If a ref goes back to a commit that a skill already carried (A, then B,
  then A), content equal to the pin reads as unchanged and the pin simply advances; a skill whose
  history holds a description-only edit carrying that commit can read as hand-edited until an accept
  at a new commit, which errs toward asking.
- **Any commit on the ref flags the source.** The check resolves the ref, not the history of `path`,
  so in a monorepo an unrelated commit reads as UPDATE_AVAILABLE. The diff then shows nothing changed
  and an accept with no skills moves the pin. Filtering by path would need a second request per source.
- **`?sha=` diffs any commit, but only `latestSha` can be accepted.**
- **A renamed skill keeps its installed name.** An upstream frontmatter `name` change is shown and
  reported, never applied, because agents refer to skills by name.
- **External skill sources are GitHub and GitHub Enterprise only,** read through the GitHub REST API.
  There is no GitLab, Bitbucket or plain-git support.
- **A source's commit is not verified.** The commit sha pins what was read, but the platform does not
  check a commit or tag signature, so it attests to where the text came from, not who wrote it.
- **A private-network host is trusted by name.** The SSRF guard refuses literal private and metadata
  addresses and names like `localhost` or `*.internal`, and every request also resolves the host and
  refuses a name that answers with a private, loopback, link-local or metadata address. A
  private-network GitHub Enterprise host is allowed only through the two-list opt-in above, and the
  listed name is then trusted to mean the server the admin intends.
- **A source is imported once.** Nothing re-checks the repository or updates the installed skills
  when it changes; a source records the commit it was read at and nothing more. Re-importing under the
  same name is refused as a name conflict, so a changed skill is replaced by editing it or by deleting
  it and importing it again.
- **A skill's scan covers its description and text, not its reference files,** which are stored
  unscanned. Nothing reads them to an agent or a UI; anything that first does must scan them, with
  `skills.import.blockOnScanWarnings` applying, before it may. A clean scan does not make an imported
  skill anything but unverified third-party text.
- **A source costs at most 300 API requests, and a large source loses its reference files first.** A
  repository with more skills than fit, or more reference files than the leftover budget, is imported
  with those files skipped and listed, not in full; narrow the source's path to import the rest. The
  platform's own token pays for the reads wherever it applies, so a rate limit already near its floor
  refuses the import until it recovers.
- **Skill names are not unique in the library.** Imports check for conflicts under a lock, but the
  other ways of creating a skill (the admin API, bundles) do not take it, and `loadSkill` resolves a
  name that two of an agent's skills share to the last one.
- **Node attribution needs the worker's workflow interceptor.** A worker built without
  `workflowModules: [nodeTagInterceptor]` writes traces with null `specNodeId` — every test harness
  that builds its own `Worker`, and a worker still running older code during a rolling deploy. So
  does any activity not dispatched through the interpreter: the non-runnable workflows, and the
  human-gate nodes, which dispatch no traced activity. Traces written before the columns existed
  stay null and nothing backfills them. For those the run viewer falls back to the activity name:
  it lists the trace under every node that runs that activity and labels it ambiguous when two or
  more nodes do (and always when a fan-out branch is selected, since a fallback match cannot name a
  branch). A fallback match with a single candidate node is shown unlabelled.
- **A call that never reaches a tool has no duration.** `runAgent` times the calls that execute;
  one that failed input validation or named no tool is read from the steps of a `generate` that
  returned, with `durationMs` 0, so a `generate` that throws loses those and keeps the rest.
- **Without the model proxy, the Claude Code harness holds a model credential inside the workspace
  container.** The agent runs as root on a network with unrestricted egress, so anything it runs can
  read the key and send it elsewhere; a repository's settings cannot move where the harness itself
  sends it, but the agent's own commands can. The blast radius is whatever the key can spend. Turn
  the proxy on (`HARNESS_MODEL_PROXY_PORT`; the shipped compose files do), or point the credential
  at a gateway key scoped to that run's budget.
- **The model proxy's token is still a bearer token inside the container.** Anything the agent runs
  can read it and spend through the proxy until the turn ends — but only on the Messages API, only
  against the run's budget, and only at the credential's own host. The proxy listens on
  `HARNESS_MODEL_PROXY_BIND` (every interface by default), so any host that can reach that port can
  try a token; tokens are 256-bit random values that die with their turn. A workspace that cannot
  reach the proxy fails its turn with the harness's connection error; nothing falls back to handing
  it the key. A call cut off mid-stream (an aborted turn) is charged the input it was billed and the
  output the provider had reported, which is less than it may have spent.
- **A repository's own hooks and settings run inside the container.** With project settings
  loaded, a repository can ship shell hooks and permission rules. They execute in the untrusted
  container and cannot override the worker-side decision on a tool call (a deny wins), but they
  can run code at session start and shape what the model is told.
- **Some runtimes are still pinned at first use, not at the run's start.** An agent created after a
  run started, and an agent run's agent (it resolves in a narrower scope than the run), are pinned
  the first time the run resolves them, so an edit made before that reaches the run. An agent whose `inheritsModelFrom` chain was broken at run start is left out
  of the snapshot and fails where it is used, as before. The snapshot costs a lookup per agent key at
  run start (a cascade walk of scalar columns, no credential).
- **Generic `agent` nodes never run on the harness.** They have no workspace, so an Agent asking for
  `claude-code` runs on Mastra there, with a trace event saying so; a node that needs the harness has
  to be an implementer-family step or an agent run.
- **A harness turn stops one call late.** The budget is re-checked after each call is debited, so
  an exhausted budget stops the turn after the call that exhausted it (and any running beside it),
  as the Mastra loop stops one step late. Without the model proxy the gap is wider: a streamed call
  is debited only once the next one begins, the calls the harness makes without streaming a message
  (a small-model side task) are charged only from the turn's final totals and never trigger the
  check, and a turn stopped by its deadline or whose process died has no totals, so it is metered
  from its streamed messages and can undercount by those side calls.
- **The seeded agents carry no runtime.** Built-in agents seed with none, so the implementer family
  follows `workspace.implementerRuntime` until an ADMIN sets one; a seeded default-model move keeps
  that choice. A bundle can carry an agent's `runtime` ([bundles.md](./bundles.md)); one that omits
  it leaves an installed agent's runtime as it is.
- **A persona inherits a runtime only through `inheritsModelFrom`.** A persona that names its own model
  does not follow its parent's runtime, and the save-time model check covers only a version's own
  model; an inherited non-Anthropic model is refused when a run resolves it.
- **The harness ignores the `mcp` binding.** It gets at most the six tools the Agent's `toolKeys`
  grant; MCP servers an Agent references are not passed to it, and there is no sub-agent, web or
  plugin tool.
- **`Edit` is content-checked on the inserted text only,** not on the whole resulting file, and
  `Bash` is covered by the same text heuristics as the Mastra `bash` tool — a determined agent can
  evade them.
- **Harness usage is metered conservatively and priced by the model it names.** Cache reads and
  writes count in full against the token budget, though they are priced at the cache rates. The
  SDK's own cost cap is not used because it is a client-side estimate. A model the harness picks that
  has no catalog price records $0 with a warning; the organization-USD-cap guard checks only the
  Agent's configured model.
- **The harness runs unattended.** Anything not allowed by the worker policy is refused, and the
  interactive question tool is not offered, so a flow that depends on asking the user needs a human
  node instead.
- **The session lives and dies with the workspace.** Its transcript is inside the container, which is
  destroyed after the activity, so a Temporal retry starts a fresh session rather than resuming.
- **Anthropic models only, and API-key authentication only.** Anthropic does not allow a third-party
  product to offer claude.ai login, so subscription credentials are not supported.
- **The worker image carries two native binaries (about 240 MB each),** and `supportedArchitectures`
  also installs the musl variants of every other native dependency, which adds about half a gigabyte
  to a `yarn install`.
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
  `SCANNER_REGEX_BUDGET_MS` environment variable (default 250 ms; deployment-wide) and applied per
  scanned window, so a pattern that backtracks catastrophically is terminated instead of wedging
  the process. The scan it overran fails closed for a blocking scanner and degrades for an advisory
  one. An overrun is confirmed by re-running the isolated pattern alone on a fresh thread — one
  observation on a starved host is not evidence — and only a second overrun quarantines it, for
  `REGEX_QUARANTINE_TTL_MS` (10 min) in that process. Inside that window later scans **skip** the
  rule and the executor reports it in `quarantinedPatternKeys` without marking the scan incomplete;
  the caller decides what that means. The blocking scanners (`scanShellCommand`,
  `checkSensitiveFilePath`) block on a non-empty list — a rule they never ran cannot clear the
  input — so a quarantined shell or sensitive-file rule denies `bash` and `writeFile` until an admin
  fixes or disables the row at `/govern/scanner`, instead of costing two budgets per call. The
  advisory scanners proceed without the rule. It is logged on every skip, and quarantine is
  per-process, so gateway and worker decide independently and both forget on restart.
- **The write-time backtracking probe is sound but incomplete.** `POST /admin/scanner-patterns`
  executes a candidate against repetition-heavy input built from its own alphabet and rejects it if
  it overruns the budget. It cannot see a merely polynomial pattern (`a+a+$` is fine at 40
  characters and takes minutes at 20 k) or one whose blow-up needs input the corpus does not
  contain, and it does not run at bundle install, which is pure and synchronous. Runtime bounding
  is what covers those.
- **Tool-output offload retrieval depends on `bash` being enabled.** `readFile` cannot fetch an
  offloaded file — `safePath()` rejects the absolute path it lives at — so `bash` is the only way
  back to the full output. An agent configured with `bash` excluded from `toolKeys` can never see
  past the head + tail excerpt.
- **An offloaded `readFile` splices a notice into what reads as file content.** `readFile` is
  offloaded like any other tool, so for a large file the excerpt carries the elision marker in the
  middle of the file's own text. The marker says it is not part of the content, but a model that
  edits from the excerpt rather than re-reading the range can still carry it into a `writeFile`.
- **Tool-output offload budgets characters, not tokens.** `workspace.maxToolOutputChars` bounds
  string length, which only approximates what a model actually spends on context; two outputs of
  the same character count can tokenize very differently.
- **Offloaded files are ephemeral.** They live on the workspace container's filesystem, not in the
  repo and not in the database, so they do not outlive that container's teardown — nothing later in
  a run, or after it, can retrieve one once the workspace is gone.
