# Research — LangChain "Deep Agents" (`deepagents`)

> External research on LangChain's **Deep Agents** framework (the `deepagents`
> Python package + its docs surface on `docs.langchain.com`), compiled
> 2026-07-05 via a multi-source adversarially-verified research pass (21
> primary/secondary sources fetched, 101 claims extracted, top 25 verified by
> independent 3-vote panels — 22 confirmed, 3 refuted). This documents an
> **external framework**, not our code — see `docs/agents.md` for how
> **auto-swe**'s own multi-agent review network and workflow engine actually
> work, and §7 below for how the two compare conceptually.

---

## 1. What it is, and why it exists

**Deep Agents** (package name `deepagents`, `pip install deepagents`) is
LangChain's opinionated, "batteries-included" harness for building LLM agents
that can execute **long-horizon, multi-step tasks** rather than the short
tool-call loops most agent frameworks are tuned for.

Its origin is unusually well-documented and consistent across sources
(GitHub README, PyPI page, LangChain's own blog, a LangChain podcast
interview): the project was **explicitly reverse-engineered from Claude
Code**. The team's own framing (near-verbatim across the README and PyPI
page):

> "This project was primarily inspired by Claude Code, and initially was
> largely an attempt to see what made Claude Code general purpose, and make
> it even more so."

The motivating observation was that people were using Claude Code for far
more than coding — and LangChain wanted to extract *what made that possible*
(planning discipline, a persistent workspace, delegation) into a reusable,
domain-agnostic package that works with any tools, not just a coding
sandbox. The shipped default system prompt is described as "inspired by
Claude Code, but modified to be more general," including reusing the **same
no-op Todo-list planning tool**.

### The "shallow vs. deep agents" framing

A widely-cited (though **vendor/single-author, not industry-standard**)
framing comes from a LangChain-adjacent blog post (philschmid.de, "Agents
2.0: Deep Agents"), which draws a distinction:

- **Shallow agents ("Agents 1.0")** — simple `while` loops bound entirely to
  the LLM's context window. They work well for short tasks (roughly 5–15
  tool-call steps) but degrade as the transcript grows: the model loses track
  of the original goal, forgets earlier decisions, and can't survive a
  process restart.
- **Deep agents ("Agents 2.0")** — systems that **decouple planning from
  execution** and maintain **external memory/state** outside the model's
  live context, letting them run for hours or days and **delegate** discrete
  chunks of work to specialized sub-agents.

This is marketing-adjacent terminology (2-1 verification vote, single
primary source) rather than a settled taxonomy, but it's the framing
LangChain itself leans on to explain *why* Deep Agents exists as a distinct
product from a bare LangGraph `ReAct` loop.

---

## 2. Core architecture: three built-in pillars

Deep Agents' architecture is consistently described (GitHub README,
`docs.langchain.com/oss/python/deepagents/overview`, and independent
write-ups) as resting on three built-in primitives, all wired up
automatically when you call `create_deep_agent()`:

### 2.1 Planning — `write_todos`

A **no-op planning tool**: calling it doesn't execute anything against the
world, it just writes a structured todo list (`pending` /
`in_progress` / `completed` per item) into the agent's persisted state. The
value is entirely in forcing the model to **externalize its plan** —
decomposing a large task up front, and having something durable to refer
back to after context has been compacted or a sub-agent has returned. This
mirrors Claude Code's own `TodoWrite` tool almost exactly.

### 2.2 Virtual filesystem — `ls` / `read_file` / `write_file` / `edit_file` / `glob` / `grep`

A **pluggable virtual filesystem** the agent can read and write to as
working memory. It serves two purposes at once:

1. **Workspace state** — the agent's scratch space for intermediate
   artifacts (drafts, research notes, generated files), inspectable/editable
   like a real filesystem.
2. **Context-window pressure valve** — large tool outputs get written to a
   file and replaced in the live context with a path + short preview, so the
   model's context doesn't balloon just because one tool call returned a lot
   of data.

The filesystem is **backend-pluggable**: in-memory (default, ephemeral),
local disk, a LangGraph-store-backed persistent backend, a composite of
multiple backends, or a remote/sandboxed backend (Modal, Daytona, Runloop —
these also add an `execute` tool for actually running code in an isolated
sandbox, not just reading/writing files).

### 2.3 Sub-agents — the `task` tool

A `task` tool lets the orchestrating agent **delegate a self-contained unit
of work to a fresh sub-agent instance**. This is the most architecturally
interesting piece:

- Each sub-agent invocation gets its **own context window** — it does not
  inherit the parent's conversation history, and the parent's context isn't
  polluted by the sub-agent's internal tool-call chatter.
- Sub-agents are **stateless / ephemeral by design**: they run to
  completion autonomously and return **exactly one final report** to the
  caller. There's no back-and-forth — official docs describe them as
  "stateless" and unable "to send multiple messages back." This is a
  deliberate **single-handoff model**, not a persistent conversational
  sub-thread.
- Implemented via a middleware/schema stack: `SubAgent` / `CompiledSubAgent`
  / `SubAgentMiddleware` for synchronous, in-process, hierarchical
  delegation (`TaskToolSchema` defines the subtask interface), plus a
  separate `AsyncSubAgentMiddleware` (`StartAsyncTaskSchema` /
  `CheckAsyncTaskSchema`) for **background/remote** task execution when
  deployed on LangGraph Platform — i.e. a sub-agent can run out-of-process
  and be polled for completion rather than blocking the parent turn.
- Practical purposes: **parallelization** (fan out independent subtasks),
  **context isolation** (a sub-agent can churn through a huge amount of
  exploration/search without any of that noise reaching the orchestrator),
  and **specialization** (a sub-agent can be given a narrower tool set,
  system prompt, or even a different/cheaper model).

---

## 3. Built on LangGraph, not a new runtime

Deep Agents is explicitly **not** a from-scratch orchestration engine. The
object returned by `create_deep_agent()` is a **compiled LangGraph
`StateGraph`** — LangChain's own docs state this directly:

> "deepagents is a standalone library built on top of LangChain's core
> building blocks... It uses the LangGraph runtime for durable execution,
> streaming, human-in-the-loop, and other features."

Practical consequences of that choice:

- It inherits LangGraph's **durable execution** (checkpointed state,
  resumability), **streaming**, and **interrupt-based human-in-the-loop**
  machinery for free — Deep Agents doesn't reimplement any of it.
- It can be opened and stepped through in **LangGraph Studio** like any
  other LangGraph graph, since structurally it *is* one.
- Its state schema is **middleware-layered rather than one monolithic
  blob**: `DeepAgentState` is the foundational/customizable state schema for
  the compiled graph, with additional per-middleware state objects layered
  on for newer features — `MemoryState` (for a `MemoryMiddleware` handling
  long-term memory), `SkillsState` (for a skills middleware — reusable
  prompt/tool bundles, conceptually adjacent to auto-swe's own `Skill`
  entity), and `RubricState` (for a rubric/evaluation middleware). This
  finding is medium-confidence (single primary source: LangChain's Python
  API reference) — the newer Skills/Rubric pieces in particular look
  early-stage relative to the core planning/filesystem/sub-agent trio.

### Context management specifics

Beyond the filesystem-as-overflow mechanism in §2.2, Deep Agents ships an
explicit **conversation summarization** mechanism: once a token threshold is
crossed, older messages are compacted via an LLM call, with the evicted raw
messages offloaded to a markdown file on the virtual filesystem so they
remain retrievable later rather than being destroyed. Separately, individual
tool outputs over roughly 20,000 tokens are automatically written to disk
and replaced in-context with a file path + preview (this is the same
mechanism as §2.2, just with a concrete threshold attached from LangChain's
dedicated blog post on the topic).

---

## 4. Human-in-the-loop and persistence

HITL is implemented as a `HumanInTheLoopMiddleware` riding directly on
LangGraph's `interrupt()` primitive:

- Passing an `interrupt_on` parameter to `create_deep_agent()` names which
  tools require human approval before they execute.
- When the agent tries to call one of those tools, execution **pauses** and
  surfaces an interrupt; a human can **approve**, **edit** the call's
  arguments, **reject** it, or **respond** with a message instead — these
  four are the documented default outcomes.
- A **checkpointer is mandatory, not optional**, for HITL to work at all —
  LangChain's docs state this in bold: state has to be durably persisted
  across the pause/resume boundary, since the process may not even be alive
  when a human eventually acts on the interrupt.
- This extends to interrupts **raised inside sub-agents**, though at least
  one open GitHub issue (#554) flags rough edges in resume behavior for
  edit/reject specifically when the interrupt originates inside a `task`-tool
  sub-agent — an implementation caveat worth checking before relying on
  HITL deep inside a delegated sub-agent, not a wholesale refutation of the
  feature.

---

## 5. Basic usage

The primary entry point is a single factory function:

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",   # provider:model string, or a bound model instance
    tools=[internet_search],                # your own tools, in addition to the built-ins
    system_prompt=research_instructions,    # your domain-specific instructions
)
```

- `model` accepts either a `"provider:model"` string (resolved via
  `resolve_model()` / `get_model_identifier()` / `get_model_provider()`
  helpers) or an already-instantiated model object — so you can swap
  providers without touching the rest of the config.
- `tools`, `system_prompt`, and `subagents` are the three first-class
  customization axes documented alongside `model`; sub-agents are configured
  as a list of `{name, description, prompt, tools, model}`-shaped specs
  passed into the same factory call, letting you give a research sub-agent
  a narrower tool set or a cheaper/faster model than the orchestrator.
- Because the result is a compiled LangGraph graph, it composes with
  anything else in the LangGraph ecosystem: `.invoke()`, `.stream()`,
  checkpointers, LangGraph Platform deployment, LangSmith tracing, etc.

---

## 6. Version trajectory (context, not settled fact)

The GitHub README and changelog entries surfaced in this research describe
active, fast-moving development through 2025–2026:

- A **v0.2** release generalized the filesystem into the pluggable-backend
  design (in-memory / disk / store / composite / sandbox).
- A **v0.4** changelog added the remote sandbox integrations (Modal, Daytona,
  Runloop) and the async/background sub-agent path.
- A **v0.6** blog post (LangChain's own) describes a **"Code Interpreter" /
  Programmatic Tool Calling (PTC)** feature: instead of the model making one
  LLM round-trip per tool call, the agent can *write code* that composes
  multiple tool calls and executes it directly, cutting token consumption
  from repeated per-call model turns.

Given the pace of releases, treat specific API surface details (parameter
names, exact middleware class names) as **likely to drift** — verify against
the installed version's docs before depending on them.

---

## 7. Comparisons

### 7.1 To other frameworks (light coverage — flagged as a gap)

The research surfaced framework-vs-framework blog content (LangGraph vs.
DeepAgents, DeepAgents vs. OpenAI Agents SDK, Pydantic AI's own deep-agents
port vs. LangChain's) but **no rigorous, reproducible benchmark** — one
critical Medium post claims deepagents' convenience carries roughly a
**20x token-consumption overhead** versus hand-rolled LangGraph for
equivalent tasks (attributed largely to the always-on planning +
summarization + filesystem-offload machinery running even when a task
doesn't need it), but this is a single blog's informal benchmark, not
independently reproduced. Treat "deep agents are more expensive per task
than a bare loop" as directionally plausible (more built-in machinery = more
LLM calls) but **not a verified quantitative claim**.

No hard evidence surfaced on production case studies, adoption at scale, or
head-to-head task-success-rate comparisons against AutoGen, CrewAI, or
OpenAI's Swarm/Agents SDK — this is a real gap in what's publicly written
up, not a finding either way.

### 7.2 To auto-swe's own architecture

This wasn't part of the underlying web research (it's an internal
comparison), but worth stating plainly given `docs/agents.md` and
`docs/architecture.md` describe a structurally different, but
conceptually related, system:

| Concern | Deep Agents | auto-swe |
| --- | --- | --- |
| **Orchestration substrate** | A single compiled LangGraph `StateGraph` — one process/graph, in-context tool loop | Temporal workflow engine — durable, out-of-process, replay-based; the interpreter drives a **declarative node graph** (15 node types per `architecture.md`), not one model's tool loop |
| **Planning** | Implicit, in-model: a no-op `write_todos` tool the agent calls voluntarily | Explicit, out-of-model: a `plan`/`decomposer` step and a `cond` node produce a structured subtask list *before* any agent runs (e.g. the channel-assistant "plan → cond → {single agent \| composite}" pattern) |
| **Sub-agent delegation** | A `task` tool the *orchestrator LLM* decides to call at runtime, sub-agent is ephemeral and stateless, single report back | A fixed **multi-agent review network** (`runReviewNetwork`) with named personas (`securityReviewer`, `domainLogicReviewer`, `performanceReviewer`) invoked by workflow logic, not by an LLM's own tool choice; results are structured (`CodeResult`), not free-text reports |
| **Context management** | Automatic summarization + filesystem-offload, transparent to the agent author | No equivalent automatic mechanism — context is managed per-activity via explicit prompt construction (skills injected via `skillsToPromptSuffix`, progressive disclosure via `loadSkill`) |
| **Long-term memory** | `MemoryMiddleware` / `MemoryState` (framework-level, generic) | `MemoryItem` + pgvector semantic search (`commitToMemory`, `consolidateLessons`) — domain-specific, SWE-lesson-shaped |
| **HITL** | `interrupt_on` + LangGraph `interrupt()`, checkpointer-backed pause/resume | Dedicated HITL **node types** (approval/decision/input/review) with signal-based resume — see `docs/hitl-workflows.md` |
| **Durability model** | LangGraph checkpointer (can be Postgres-backed, but is a per-graph-run concept) | Temporal's replay-based durability — survives worker crashes/restarts across the *entire* multi-day workflow, not just one agent's turn |

The high-level takeaway: Deep Agents solves "how do I make **one LLM call
loop** behave like a disciplined long-horizon agent" (planning tool +
scratch filesystem + delegatable sub-calls, all inside one LangGraph run).
auto-swe already solves the adjacent-but-different problem of "how do I
durably orchestrate a **fixed pipeline of many LLM-backed steps** across
hours/days with human checkpoints" — via Temporal rather than a single
in-process agent loop. The parts of Deep Agents most worth stealing
conceptually, if any, are the **filesystem-as-context-overflow pattern**
(auto-swe's implementer already writes/reads files in its Docker workspace,
but doesn't use that as a deliberate summarization escape valve for its own
tool outputs) and the **stateless single-report sub-agent contract**
(cleaner than letting a sub-agent's whole transcript leak back into a
parent's context) — both are incremental prompt/tool-design ideas, not
architectural rewrites, since the durable-workflow layer they'd sit inside
already exists and is arguably more robust than a LangGraph checkpointer for
multi-day runs.

---

## 8. Open questions / gaps in the public record

- **TypeScript parity is unverified.** A companion `deepagentsjs` repo
  exists, but three specific claims about its design — that its tool
  module mirrors the Python package 1:1 (`writeTodos`/`readFile`/`writeFile`
  /`editFile`/`ls`), that it uses a dynamic task-delegation tool with an
  agent-name registry, and that `createDeepAgent` wraps LangGraph's
  `createReactAgent` with a `DeepAgentState` annotation class — **all
  failed independent verification** (votes of 1-2, 1-2, and 0-3). The only
  source for all three was a single GitHub *feature request* issue
  (`langchain-ai/deepagentsjs#2`), which describes an *intended* design, not
  confirmed shipped behavior. **Do not assume the JS/TS port has parity
  with the Python package** based on this research.
- No empirical performance/benchmark data, and no documented large-scale
  production deployments, surfaced in this pass.
- The newer middleware (`SkillsState`, `RubricState`, async/remote
  sub-agents via Modal/Daytona/Runloop) is documented in the API reference
  but its production maturity relative to the core three pillars is
  unknown.

---

## 9. Sources

Primary (LangChain-authored):
- https://github.com/langchain-ai/deepagents — README, architecture overview
- https://pypi.org/project/deepagents/ — package description
- https://docs.langchain.com/oss/python/deepagents/overview
- https://docs.langchain.com/oss/python/deepagents/quickstart
- https://docs.langchain.com/oss/python/deepagents/human-in-the-loop
- https://reference.langchain.com/python/deepagents — API reference (state classes, middleware, entry points)
- https://blog.langchain.com/deep-agents/
- https://www.langchain.com/blog/deep-agents-0-6
- https://www.langchain.com/blog/runtime-behind-production-deep-agents

Secondary / community:
- https://www.philschmid.de/agents-2.0-deep-agents — "shallow vs. deep agents" framing
- https://talkpython.fm/episodes/show/543/deep-agents-langchains-sdk-for-agents-that-plan-and-delegate
- https://medium.com/@phoenixarjun007/shallow-agents-vs-deep-agents-how-deep-research-actually-works-inside-gpt-like-systems-4490538f3f56
- https://medium.com/@techofhp/building-deep-agents-with-langgraph-a-practical-guide-686422c1324e
- https://milvus.io/blog/how-to-build-productionready-ai-agents-with-deep-agents-and-milvus.md
- https://medium.com/@shubham.shardul2019/deep-agents-chapter-2-building-a-deep-agent-step-by-step-code-implementation-aeb97a61b36c
- https://krishcnaik.substack.com/p/building-deep-agents-with-langchain
- https://dev.to/samadhi_patil_294a4ff7fea/building-advanced-ai-agents-with-langchains-deepagents-a-hands-on-guide-1bk4
- https://medium.com/@kylas.kai/langgraph-vs-deepagents-what-if-the-cost-of-convenience-is-20x-24e0d1859ba2 — critical/skeptical benchmark claim (unverified quantitatively)
- https://dev.to/thedailyagent/langchain-deep-agents-vs-openai-agents-sdk-2026-2bb1
- https://vstorm.co/open-source/pydantic-deep-agents-vs-langchain-deep-agents-which-python-ai-agent-framework-should-you-choose/
- https://theaiengineer.substack.com/p/the-4-single-agent-patterns
- https://github.com/langchain-ai/deepagentsjs/issues/2 — TS-port feature request (claims from this source were **refuted**, see §8)

Verification stats: 5 search angles, 21 sources fetched, 101 claims
extracted, 25 verified by independent 3-vote panels → 22 confirmed, 3
refuted, 0 left unverified; 9 findings survived synthesis after merging
duplicates.
