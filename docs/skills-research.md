# Agent Skills: Discovery, Utilization, and Composition — Research Report

> Deep research report generated 2026-06-06.
> Methodology: 5 parallel search angles → 40+ sources fetched → verified claims synthesized.
> Companion document: `docs/agent-dreaming-research.md`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Skills vs. Tools Distinction](#2-the-skills-vs-tools-distinction)
3. [Framework Taxonomy (2024–2026)](#3-framework-taxonomy-20242026)
4. [Skill Injection Patterns](#4-skill-injection-patterns)
5. [Runtime Skill Discovery and Selection](#5-runtime-skill-discovery-and-selection)
6. [Skill Composition and Chaining](#6-skill-composition-and-chaining)
7. [Emerging Standards](#7-emerging-standards)
8. [Security Considerations](#8-security-considerations)
9. [Implications for auto-swe](#9-implications-for-auto-swe)
10. [Key Papers and Sources](#10-key-papers-and-sources)

---

## 1. Executive Summary

Between late 2025 and mid-2026, **"skill"** emerged as a first-class concept in AI agent engineering — and the word now has a precise, cross-industry meaning that is distinct from "tool." The shift was catalyzed by:

1. **The SKILL.md open standard** (Anthropic, December 18, 2025): a portable, file-based format for packaging procedural knowledge — instructions, scripts, and references — that agents load on demand. Adopted by 32+ platforms within months.

2. **Progressive disclosure** as the dominant injection pattern: agents receive only a skill's `name` + `description` at startup (~100 tokens), then load the full instructions only when the skill is relevant to the task at hand. This replaced the older practice of dumping all capabilities into the system prompt.

3. **Retrieval-augmented skill selection (SRA)**: as public skill registries grew to 490,000+ skills, vector search + LLM reranking became the standard mechanism for matching user intent to executable capabilities at runtime.

The clearest conceptual split comes from CrewAI:
- **Action capabilities** (Tools, MCPs, Apps) — callable functions that *do* things
- **Context capabilities** (Skills, Knowledge) — instruction bundles that shape *how agents think*

auto-swe currently implements skills as prompt-fragment injection — the right architectural choice, and consistent with this taxonomy. The models, tools (readFile/writeFile/listDirectory/bash), and skills all compose through the scope cascade (GLOBAL → TEAM → WORKFLOW_TEMPLATE).

---

## 2. The Skills vs. Tools Distinction

### The formal definition (agentskills.io, December 2025)

The [Agent Skills specification](https://agentskills.io/home), originated by Anthropic:

> "Agent Skills are a lightweight, open format for extending AI agent capabilities with specialized knowledge and workflows. At its core, a skill is a folder containing a `SKILL.md` file. This file includes metadata (`name` and `description`, at minimum) and instructions that tell an agent how to perform a specific task."

A `SKILL.md` file looks like:

```yaml
---
name: code-change-verification
description: |
  Verifies that code changes are complete, tested, and safe to ship.
  Use when: a user has finished implementing a feature or fix.
---

# Code Change Verification

1. Run the full test suite and confirm it passes.
2. Check for any new lint errors or type errors.
3. Verify all affected files have been staged.
4. Confirm the change matches the original task description.
```

### The academic definition (arXiv:2605.07358)

> "Reusable procedural artifacts that encode the specific 'how-to' knowledge for coordinating tools, memory, and runtime context under concrete constraints."

And the key distinction from tools:

> "Tools expose operations; skills package know-how for using them in context. A tool does not say when search is preferable to memory retrieval; an API tool does not say what to do when the schema changes."

| Dimension | Tools | Skills |
|---|---|---|
| What they are | Callable functions | Instruction packages |
| Implementation | Code (function schema + executor) | Markdown/text (SKILL.md) |
| Effect | Agent *does* something | Agent knows *how to think* |
| Selection | Invoked by LLM via function call | Loaded into context by progressive disclosure |
| Portability | Platform-specific schema (MCP, OpenAI) | Platform-agnostic (SKILL.md spec) |
| Token cost | Schema in system prompt | Only metadata at startup; body on demand |

### Why this matters

The old approach — listing all capabilities in the system prompt — fails at scale. Both token budget and attention degradation impose hard limits. The skill-as-instructions model solves this through progressive disclosure (§4) and retrieval (§5).

---

## 3. Framework Taxonomy (2024–2026)

### CrewAI — The clearest taxonomy

CrewAI (docs.crewai.com) defines **five capability types** in two groups:

**Action-Based Capabilities** (agent can *do* things):
- **Tools** — callable Python functions (web search, file operations, API calls)
- **MCPs** — remote tool servers connected via Model Context Protocol
- **Apps** — SaaS integrations (Gmail, Slack, Jira)

**Context-Based Capabilities** (shapes how the agent *thinks*):
- **Skills** — domain expertise injected as instructions and guidelines
- **Knowledge** — retrieved facts from documents via semantic search (RAG)

Direct quote: "They don't give agents new actions; they shape how agents think and what information they have access to."

### Google ADK (Agent Development Kit)

Google ADK formalizes **four implementation patterns** for skills:

1. **Inline skills** — Python objects defined directly in code; for small behavioral rules
2. **File-based skills** — SKILL.md directories; for complex organization-wide knowledge
3. **External skills** — downloaded from community registries (follows agentskills.io spec)
4. **Meta skills** — self-generating skills that write new SKILL.md files

Skills in ADK are accessed via a `SkillToolset` that exposes three auto-generated tools: `list_skills` (L1 metadata), `load_skill` (L2 instructions), `load_skill_resource` (L3 files). The toolset itself appears as a tool in the agent's tool list — tools and skills compose cleanly.

### LangChain / LangGraph

LangChain adopted the agentskills.io definition:

> "Skills are curated instructions, scripts, and resources that improve coding agent performance in specialized domains... dynamically loaded through progressive disclosure."

Skills are domain-specific instruction sets (LangChain / LangGraph / Deep Agents categories). Tools remain callable functions. LangGraph 1.0 went GA October 22, 2025, providing StateGraph DAG orchestration.

### AutoGen / Microsoft Agent Framework

AutoGen 0.2 used "skill" as a synonym for Python callable (same as "tool" elsewhere). AutoGen is now in maintenance mode. Its successor, **Microsoft Agent Framework (MAF, early 2026)**, dropped the "skill" term entirely — agents use `tools=[]` and MCP servers.

**Semantic Kernel evolution**: skills (2022) → plugins (2024) → functions → tools. Tracks the industry's gradual standardization.

### Comparative table

| Framework | "Skill" means | Distinct from Tool? | Primary mechanism |
|---|---|---|---|
| agentskills.io / Anthropic | SKILL.md folder with procedural instructions | Yes | Progressive disclosure |
| CrewAI | Domain expertise injected into agent prompts | Yes (explicit split) | `skills=[]` on Agent/Crew |
| Google ADK | Self-contained unit: instructions + resources + tool references | Partially | `SkillToolset` |
| LangChain/LangGraph | Markdown instruction sets, dynamically loaded | Yes | Progressive disclosure |
| AutoGen 0.2 | Python callable (equivalent to "tool") | No | `skills` attached to agent |
| Microsoft MAF | (No concept; uses "tools" only) | N/A | `tools=[]` + MCP |
| Semantic Kernel | Originally groups of functions; now "plugins" | No (evolved to plugins) | Plugin registry |

---

## 4. Skill Injection Patterns

Four patterns for getting skill content into an agent's context, ordered from older to newer:

### Pattern 1: Static System Prompt Injection

All skill instructions are placed directly in the system prompt at startup.

- **Token cost**: O(N × avg_skill_size) — grows linearly with skills
- **Attention quality**: Degrades at scale; LLM ignores distant instructions
- **When to use**: ≤3 skills, always relevant, short instructions

### Pattern 2: Tool Definition Injection (Schema-Based)

Skills are expressed as tool schemas (JSON Schema `parameters` + `description`). The agent invokes them as function calls.

- Used by MCP, OpenAI function calling, Mastra's `createTool()`
- `description` field guides the LLM on when to invoke the tool
- `inputSchema` / `outputSchema` provide structured contracts
- **When to use**: Skills that map cleanly to discrete executable actions

### Pattern 3: RAG-Retrieved Skill Instructions

Skill instructions are stored in a vector database. At inference time, the query is embedded and the top-k most relevant skills are retrieved and injected.

- **Pros**: Scales to thousands of skills; no startup token cost
- **Cons**: Retrieval latency; embedding quality affects recall; misses dependency chains
- **2026 note**: Being displaced for workspace code search, but remains dominant for large external skill registries

### Pattern 4: Progressive Disclosure (Dominant 2025–2026)

The agent receives only a skills "menu" (name + description) at startup. When a skill is relevant, the agent calls a tool (`load_skill(name)`) to retrieve the full instructions on demand.

**Three-tier model** (formalized by ADK, adopted by Spring AI, pydantic-ai-skills, Claude Code):

| Level | Content | Size | When loaded |
|---|---|---|---|
| L1 Metadata | `name` + `description` only | ~100 tokens/skill | System prompt at startup |
| L2 Instructions | Full SKILL.md body | <5,000 tokens | On-demand when skill activated |
| L3 Resources | Scripts, reference docs, API specs | Variable | On-demand when instructions require them |

Google ADK reports "an agent with 10 skills starts each call with roughly 1,000 tokens of L1 metadata instead of 10,000 tokens in a monolithic prompt" — a ~90% reduction in baseline context usage.

**Spring AI implementation** (representative):
```
SkillsTool scans configured skills directories at startup, parses YAML frontmatter,
builds a lightweight registry embedded in the tool's description. When a user request
semantically matches a skill's description, the LLM invokes the Skill tool with the
skill name as a parameter.
```

**Security note — the data-instruction boundary**: Unlike MCP (typed schema) or ChatGPT Plugins, SKILL.md collapses the data-instruction boundary. Full SKILL.md content is executable instructions injected directly into context. This creates distinct injection attack surfaces (see §8).

---

## 5. Runtime Skill Discovery and Selection

### The registry ecosystem (as of June 2026)

| Registry | Size | Type |
|---|---|---|
| SkillsMP | 219K+ (89K tool / 70K dev / 60K business) | Community |
| skills.sh (Vercel) | 57,000+ | Primary (npx skills add) |
| ClawHub | 5,700+ | Community |
| MCP.so | 17,000+ | MCP servers |
| JFrog Agent Skills Registry | Enterprise | Private, signed, vulnerability-scanned |
| OpenAI Official Catalog | 35 curated | Curated reference |

Registries expose MCP servers. A crawler continuously indexes public GitHub repos for SKILL.md files. When an agent needs a capability, it queries the registry with natural language; the registry returns matches via semantic search.

### Selection mechanisms: from simple to state-of-the-art

#### 1. Description-matching (LLM-mediated routing)

The simplest mechanism: the agent reasons over L1 metadata to decide which skill matches the task. Effective up to ~50 skills before attention and context limits degrade accuracy.

#### 2. Embedding-based retrieval

Task description is embedded; skill descriptions are pre-embedded. Cosine similarity finds top-k candidates. Used by Voyager (2023, foundational), AppAgent, and most RAG-based systems. Scales to thousands of skills.

#### 3. Retrieval-Augmented Skill Selection (SRA — arXiv:2604.24594)

Three-stage pipeline:
1. **Skill Retrieval**: retriever R maps (query, skill corpus) → ranked candidates `ℒk` where k ≪ N total
2. **Skill Incorporation**: agent selects which retrieved skills to integrate
3. **Skill Application**: incorporated skills assist task-solving

Five retrieval methods compared: BM25, TF-IDF, BGE embeddings, Contriever, LLM reranking over BM25 top-50. **Key finding: "LLM-based reranking is the strongest overall retrieval strategy"** — skill selection requires recognizing "actionable capability" beyond topical relevance.

#### 4. SkillFlow four-stage funnel (arXiv:2504.06188)

Progressive filtering pipeline for large corpora:

| Stage | Method | Output | Latency |
|---|---|---|---|
| Dense retrieval | Bi-encoder, cosine similarity | ~1,000 candidates | Fast |
| Shallow reranking | Cross-encoder, 512-token truncation | ~100 candidates | ~1.6s |
| Deep reranking | Cross-encoder, 4,096-token full content | ~10 candidates | ~25.6s |
| LLM selection | Relevancy + specificity filters | ≤5 final skills | ~2.7s |

Achieves 84.1% of oracle ceiling on SkillsBench. Critical finding: "retrieval gains are bounded by what the library contains."

#### 5. SkillRouter (arXiv:2603.22455) — on-device scale

A 1.2B-parameter retrieve-and-rerank pipeline for edge deployment:
- **SR-Emb-0.6B**: Qwen3-Emb fine-tuned on 37,979 skill-routing queries; bi-encoder for ANN search
- **SR-Rank-0.6B**: Qwen3-Rank cross-encoder; scores full skill text per query-skill pair
- Retriever supplies top-20 candidates to reranker
- **Listwise cross-entropy loss** (not pointwise): "+30.7pp Hit@1 vs. pointwise variant"
- Result: 74.0% Hit@1, 13× fewer parameters, 5.8× faster than next-best baseline

#### 6. Graph-of-Skills dependency diffusion (arXiv:2604.05333)

Pure semantic similarity fails for interdependent skills. GoS builds a typed directed dependency graph with four edge types (Dependency, Workflow, Semantic, Alternative) and applies **Reverse-Aware Graph Diffusion** (modified Personalized PageRank that propagates both forward and backward along edges).

Results on SkillsBench (1,000 skills): **+25.55% reward, −56.72% input tokens** vs. full-load baseline. 43.6% average reward improvement over 2 benchmarks.

### Hybrid strategies (emerging dominant pattern)

The SoK survey (arXiv:2602.20867) finds that hybrid approaches are increasingly dominant: "embedding retrieval narrows the candidate set, and the agent's reasoning selects the final skill."

**Unresolved problem**: Skill conflict resolution. When multiple skills simultaneously satisfy applicability conditions, current systems rely on ranking heuristics. An explicit conflict-resolution policy analogous to method specificity in Hierarchical Task Networks (HTNs) is an open research problem.

### Tool-driven search vs. vector search

A notable counterpoint (Anthropic Claude Code team, Amazon Science AAAI 2026): for **code and document search within a workspace**, agent-driven tool loops (`grep`, `glob`, `read`) outperform vector retrieval "by a lot." Cursor, Windsurf, Devin, and Cline have dropped vector databases for workspace search.

**Reconciliation**: Vector/semantic search remains dominant for **registry lookup** (matching NL queries against skill metadata across thousands of options). Tool-driven search is superior for **workspace-scoped document/code retrieval** within an agent's active context.

---

## 6. Skill Composition and Chaining

### Sequential chaining (pipeline)

Agent A's output schema maps directly to Agent B's input. Used for deterministic, ordered workflows (outline → draft → SEO). Brittle — no feedback loops, a single failure collapses the chain.

### Graph-based DAG orchestration (LangGraph)

LangGraph 1.0 (GA: October 22, 2025) models agents as nodes in a **directed cyclic graph**. The cyclic capability enables loops, retries, and iterative reasoning — the key differentiator from linear pipelines.

```python
workflow.add_conditional_edges(
    "research",
    route_decision,   # evaluates state, returns string key
    {"analyze": "analyze", "clarify": "clarify", "end": END}
)
```

State is persistent and checkpointed. Sub-graphs allow composition of reusable modular agent pipelines. LangGraph surpassed CrewAI in GitHub stars in early 2026, driven by enterprise adoption for audit trails and rollback points.

### Event-driven flows (CrewAI)

CrewAI Flows uses decorator-driven composition. Workflow topology emerges from annotations, running 12M+ executions/day in production:

```python
@start()
def kickoff(self): ...

@listen(kickoff)
def research(self, result): ...

@router(research)
def decide(self, result):
    if result.needs_refinement:
        return "refine"
    return "analyze"
```

### Deterministic YAML orchestration (Microsoft Conductor, May 2026)

Rejects dynamic LLM-based routing entirely. Workflows are YAML-defined at authoring time with Jinja2 conditional expressions:

```yaml
route:
  when: "{{ output.confidence > 0.8 }}"
  next: finalize
  else: human_review
```

Supports parallel execution groups with `fail_fast | continue_on_error | all_or_nothing` modes. Each agent gets an isolated session/prompt/model — no state bleed between agents.

### Learned routing (SkillOrchestra — arXiv:2602.19672)

Rather than hard-coded routing rules, SkillOrchestra:
1. Encodes each agent's capabilities as learned skill embeddings
2. Decomposes incoming tasks into required skill vectors
3. Routes to the agent with highest skill similarity score
4. Updates skill representations from performance feedback

### Fallback and retry composition — five-layer hierarchy

The field converged on a layered fallback model in 2025. Layers engage sequentially:

| Layer | Mechanism | Trigger |
|---|---|---|
| 1 | Exponential backoff + jitter retry | Transient errors (429, 5xx, ETIMEDOUT) |
| 2 | Model swap fallback | Primary LLM consistently failing |
| 3 | Deterministic fallback rules | Known failure patterns with known responses |
| 4 | Human-in-the-loop handoff | Semantic failure, ambiguity, high-stakes |
| 5 | Circuit breaker | Service down, cascading failure risk |

**Error classification** governs retry behavior:
- **Transient** (429, 502–504, ETIMEDOUT): retry with backoff
- **Model output failure** (wrong format/schema): rephrase the instruction, add an example — never repeat the identical prompt
- **Semantic failure** (passes schema but contextually wrong): quality-aware handling, human gate
- **Unrecoverable** (401/403, 400 validation): fail immediately — never retry auth or validation errors

### Multi-agent composition patterns

**Maker-Checker**: one agent produces output, a second independently verifies it. High trust for consequential actions (PR merge, deployment).

**Hierarchical supervisor**: an orchestrator agent delegates subtasks to specialized worker agents, which can further delegate. Enables specialization at scale.

**Google Agent2Agent (A2A) protocol** (April 2025, 150+ orgs): open standard for agent-to-agent delegation. Agents expose an Agent Card (JSON capability manifest). Delegation is discoverable, typed, and auditable. Now under the Linux Foundation.

---

## 7. Emerging Standards

### MCP (Model Context Protocol)

- **Origin**: Anthropic, November 2024
- **Governance**: Linux Foundation / AAIF (Dec 2025), co-founded by Anthropic, Block, OpenAI
- **Spec version**: `2025-11-25` (canonical URL: `modelcontextprotocol.io/specification/2025-11-25`)
- **Adoption**: ~97 million monthly SDK downloads (vs. 2M at launch); all major LLM providers

**Tool definition schema** (key fields from `tools/list` response):

```json
{
  "name": "get_weather_data",
  "title": "Weather Data Retriever",
  "description": "Get current weather data for a location. Use when...",
  "inputSchema": {
    "type": "object",
    "properties": { "location": { "type": "string" } },
    "required": ["location"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": { "temperature": { "type": "number" } }
  },
  "annotations": {},
  "execution": { "taskSupport": "optional" }
}
```

**Key fields**:
- `name`: 1–128 chars, `[A-Za-z0-9_\-.]`, must be unique per server
- `title`: human-readable display name (new in 2025 spec)
- `outputSchema`: when present, server MUST return `structuredContent` conforming to it (new in 2025)
- `execution.taskSupport`: `"forbidden"` (default) | `"optional"` | `"required"` — for long-running tasks
- Tools with no parameters: `"inputSchema": { "type": "object", "additionalProperties": false }`

**Transport**: JSON-RPC 2.0, stateful Streamable HTTP (enables remote servers).

**2026 roadmap**: `.well-known` endpoint for stateless capability discovery; Tasks primitive for retry/expiry; enterprise SSO gateway extensions.

### SKILL.md Open Standard (agentskills.io)

- **Origin**: Anthropic, December 18, 2025
- **Governance**: AAIF / Linux Foundation (same body as MCP)
- **Platforms**: 32+ as of June 2026 (Claude Code, OpenAI Codex, Google Gemini CLI, GitHub Copilot, Cursor, Windsurf, AWS Kiro, JetBrains Junie, Goose, Databricks Genie Code, Snowflake Cortex Code, Spring AI, and more)

**Core format**:
```yaml
---
name: skill-name
description: |
  What this skill does and when to use it.
  Include domain, capabilities, trigger phrases.
---

# Skill Content — instructions, workflows, examples
```

**Minimal required fields**: `name`, `description`.

**Optional directory structure**:
```
my-skill/
  SKILL.md       # required: metadata + instructions
  scripts/       # executable scripts
  references/    # reference documentation
  assets/        # binary/media assets
```

**Installation**: `npx skills add <owner/repo>` (from skills.sh registry)

**Registry scale** (June 2026):
- skills.sh: 57,000+ skills
- SkillsMP: 219,000+ skills
- Total across major platforms: 490,000+

### OpenAI function calling / Responses API

**Tool schema** (Responses API):
```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Retrieves current weather. Use when user asks about weather.",
  "parameters": {
    "type": "object",
    "properties": { "location": { "type": "string" } },
    "required": ["location"],
    "additionalProperties": false
  },
  "strict": true
}
```

**Strict mode** (recommended always): enforces `additionalProperties: false`, all properties in `required`, optional fields as `{ "type": ["string", "null"] }`.

**Namespace grouping** (new in 2025, for organizing related tools):
```json
{ "type": "namespace", "name": "crm", "description": "CRM tools", "tools": [...] }
```

**Agents SDK** (open-sourced early 2026): primitives are Agent, Tools, Handoffs, and Guardrails. Agent handoffs are exposed to the LLM as tools (`transfer_to_<agent_name>`).

### ACI.dev — Agent tool integration platform

- **What**: Open-source platform connecting agents to 600+ integrations via unified interface and MCP
- **Key feature**: Intent-aware tool selection — rather than exposing all tools at once, ACI.dev selects the most relevant tools based on the query, solving the "too many tools degrades performance" problem
- **Two-phase selection**: broad intent matching → top-k tools passed to agent context
- Reduces irrelevant tool exposure while maintaining full capability coverage

---

## 8. Security Considerations

### SkillJect injection attacks (arXiv:2602.14211)

The SKILL.md format collapses the data-instruction boundary that MCP and ChatGPT Plugins maintain via typed schemas. This creates three attack layers and seven distinct threat categories:

- **Supply-chain**: typosquatting skill names, hallucinated package references in instructions
- **Prompt injection via skill content**: malicious instructions embedded in SKILL.md body
- **Multi-agent propagation**: one compromised skill can instruct an agent to inject into other agents' contexts

**Measured impact**: 13.4% of community skills surveyed have critical security issues (ClawHub dataset, 7.1% API key leakage alone).

### Mitigations

1. **Source verification**: only load skills from signed/verified sources (JFrog enterprise registry pattern)
2. **Content scanning**: scan SKILL.md bodies for credential patterns before loading
3. **Sandbox execution**: treat L2/L3 content as untrusted until validated
4. **Audit trails**: log all skill load/activation events for post-incident review
5. **Scope limiting**: skills cannot modify their own instructions or write to registry (immutable after registration)

---

## 9. Implications for auto-swe

### Current architecture assessment

auto-swe implements skills as **prompt-fragment injection** (`AgentSkillAssignment` + scope cascade GLOBAL → TEAM → WORKFLOW_TEMPLATE). This is architecturally correct — skills shape how agents think (prompt fragments), tools provide executable actions (readFile, writeFile, listDirectory, bash). The terminology and architecture align with the 2025–2026 industry consensus.

### What's working well

- **Clear tools vs. skills separation**: The `AgentToolConfig` model (enabledTools: string[]) and `AgentSkillAssignment` (skill prompt fragments) map directly to the CrewAI taxonomy: action capabilities vs. context capabilities.
- **Scope cascade** (GLOBAL → TEAM → WORKFLOW_TEMPLATE): Aligns with the progressive override pattern used by enterprise skill registries.
- **UI-managed configuration**: Admin UI for global skill assignment, team UI for team overrides — consistent with how skills.sh and SkillsMP allow per-project skill configuration.
- **Mastra integration**: The worker's Mastra agents already accept dynamic skill injection at activity construction time, making progressive disclosure feasible.

### Potential improvements (not prescriptive — for consideration)

**1. Progressive disclosure for skill loading**

Currently, all assigned skill prompt fragments are injected into the system prompt at agent construction. If skill libraries grow large, consider implementing L1/L2 separation: store only `name` + `description` in the system prompt, with a `load_skill(name)` tool that injects the full `promptText` on demand. This would require adding a tool to Mastra agent definitions and restructuring skill injection in `packages/worker/src/activities/`.

**2. Skill dependency metadata**

The `Skill` model has `promptText` but no dependency or sequencing metadata. For complex multi-step skill workflows, adding a `requires: string[]` or `sequence: string[]` field (inspired by Graph-of-Skills) would enable the implementer agent to load prerequisite skills automatically.

**3. Skill effectiveness tracking**

Skills are currently static assignments. Frameworks like SkillOrchestra learn skill effectiveness from usage. The `AgentTrace` and `AgentLesson` models could be extended to track which skills were active during successful vs. failed runs, enabling data-driven skill curation.

**4. Skill security**

As the skill library grows, consider adding a `isVerified: boolean` flag and content-scanning pipeline before new skills become available to agents. The SkillJect research found 13.4% of community skills have critical issues — internal skills need the same scrutiny.

**5. MCP server for external skill discovery**

If auto-swe ever exposes its skill library externally, the MCP `tools/list` format (with `outputSchema` and `execution.taskSupport`) is the standard way to do so. The existing `/api/v1/teams/:teamId/skills` and `/api/v1/admin/skills` endpoints could be adapted to serve an MCP-compliant skill manifest.

---

## 10. Key Papers and Sources

### Open Standards

- [agentskills.io](https://agentskills.io/home) — Agent Skills specification (Anthropic, Dec 2025)
- [github.com/anthropics/skills](https://github.com/anthropics/skills/blob/main/spec/agent-skills-spec.md) — SKILL.md spec source
- [modelcontextprotocol.io/specification/2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) — MCP spec (current)
- [developers.openai.com — function calling](https://developers.openai.com/api/docs/guides/function-calling) — OpenAI tool schema

### Framework Documentation

- [docs.crewai.com/en/concepts/agent-capabilities](https://docs.crewai.com/en/concepts/agent-capabilities) — CrewAI skills vs. tools taxonomy
- [developers.googleblog.com — ADK Skills guide](https://developers.googleblog.com/developers-guide-to-building-adk-agents-with-skills/) — Google ADK skills
- [langchain.com/blog/langchain-skills](https://www.langchain.com/blog/langchain-skills) — LangChain skills
- [spring.io/blog/2026/01/13/spring-ai-generic-agent-skills](https://spring.io/blog/2026/01/13/spring-ai-generic-agent-skills/) — Spring AI implementation

### Research Papers

| Paper | arXiv | Key contribution |
|---|---|---|
| Comprehensive Survey on Agent Skills | [2605.07358](https://arxiv.org/html/2605.07358v3) | Four-stage lifecycle taxonomy; skills vs. tools formal distinction |
| SoK: Agentic Skills — Beyond Tool Use | [2602.20867](https://arxiv.org/html/2602.20867v1) | Routing taxonomy; conflict resolution as open problem |
| Skill Retrieval Augmentation (SRA) | [2604.24594](https://arxiv.org/html/2604.24594v1) | Three-stage SRA pipeline; LLM reranking dominance |
| SkillFlow: Scalable Skill Retrieval | [2504.06188](https://arxiv.org/html/2504.06188v2) | Four-stage funnel; 84.1% oracle ceiling |
| SkillRouter: Retrieve-and-Rerank | [2603.22455](https://arxiv.org/html/2603.22455v4) | 1.2B-param model; 74.0% Hit@1; listwise training |
| Graph-of-Skills (GoS) | [2604.05333](https://arxiv.org/abs/2604.05333) | Dependency graph; +25.55% reward, −56.72% tokens |
| SkillJect: Security Threats | [2602.14211](https://arxiv.org/html/2602.14211) | 3 attack layers, 7 threat categories; 13.4% critical |
| Agent Skills Architecture Survey | [2602.12430](https://arxiv.org/html/2602.12430) | Injection architecture survey |
| SkillOrchestra: Learned Routing | [2602.19672](https://arxiv.org/pdf/2602.19672) | Embedding-based dynamic agent routing |
| EvoSkills: Self-Evolving Skills | [2604.01687](https://arxiv.org/pdf/2604.01687) | Co-evolutionary skill generation and verification |
| SkillC: Contrastive Credit | [2605.27899](https://arxiv.org/html/2605.27899v1) | RL-based parametric skill internalization |

### Commentary and Analysis

- [Anthropic Engineering — Equipping Agents with Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [LangGraph 1.0 GA announcement](https://changelog.langchain.com/announcements/langgraph-1-0-is-now-generally-available)
- [Microsoft Conductor blog](https://opensource.microsoft.com/blog/2026/05/14/conductor-deterministic-orchestration-for-multi-agent-ai-workflows/)
- [AI Agents Don't Need Vector Search Anymore](https://buzzgrewal.medium.com/ai-agents-dont-need-vector-search-anymore-inside-the-agentic-search-stack-replacing-rag-in-2026-58efcabe4f6f)
- [JFrog Agent Skills Registry](https://jfrog.com/ai-catalog/skills-registry/)
- [DEV: AI Agents Can Now Discover Skills at Runtime](https://dev.to/catalin_crisan_5685ca8fcf/ai-agents-can-now-discover-skills-at-runtime-without-any-human-intervention-36ih)
- [paperclipped.de — Agent Skills Open Standard](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)
