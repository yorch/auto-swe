# Glossary

> Indexed at commit `d0a90fb5` on 2026-10-06 · [view on GitHub](https://github.com/yorch/auto-swe/tree/d0a90fb5)

## Relevant source files

- [docs/concepts.md](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md)
- [packages/shared/src/prisma/schema.prisma](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma)
- [packages/shared/src/workflow/spec.ts](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts)
- [packages/shared/src/config/registry.ts](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts)
- [AGENTS.md](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md)

## Overview

This page lists the domain terms used across auto-swe in alphabetical order. Each entry gives a one-sentence definition and links to where the term is defined in code or in the concepts document. The shape of the system is: a work request starts a run of a workflow template, the run walks the template's nodes on Temporal, and agent nodes resolve their configuration through the scope cascade ([docs/concepts.md:L6-L12](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L6-L12)).

Sources: [docs/concepts.md:L6-L12](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L6-L12) [AGENTS.md:L11-L24](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L11-L24)

## Terms

**`ActiveWorkflow`** — The ledger row for a long-lived workflow, keyed by `temporalWorkflowId`, that accrues token and cost usage and anchors pull requests and memory items. [packages/shared/src/prisma/schema.prisma:L109-L120](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L109-L120)

**Agent** — A versioned, named configuration of a model, system prompt, skills and tool keys; identity is a free-form `key` string, not an enum, so a new agent is a row rather than a deploy. [packages/shared/src/prisma/schema.prisma:L2621-L2682](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2621-L2682) [docs/concepts.md:L68-L70](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L68-L70)

**Agent run** — One library agent, one prompt and one repository launched on demand, outside an authored workflow, in a throwaway workspace; its workflow ID and branch use the `agent-<repo8>-<hex8>` pattern. [docs/concepts.md:L24-L27](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L24-L27) [AGENTS.md#L142](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L142)

**`AgentTrace`** — The row persisted per tool call, LLM response or activity event by `AgentTracer`, which powers the `/runs/[id]` viewer; it is always persisted from a `finally` block. [packages/shared/src/prisma/schema.prisma#L1655](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1655) [AGENTS.md:L802-L822](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L802-L822)

**Autonomy policy** — The fail-closed rule deciding whether an action may happen without a person, per risk class, team and template. [docs/concepts.md:L62-L64](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L62-L64) [packages/shared/src/prisma/schema.prisma#L1869](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1869)

**Budget tier** — The token ceiling a run is held to (`STANDARD`, `LARGE`, `EPIC`); exceeding it stops the run with `BUDGET_EXCEEDED`, and the caps live on the `WorkflowDefaults` singleton. [docs/concepts.md:L33-L34](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L33-L34) [AGENTS.md#L389](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L389)

**Bundle** — A signed package of agents, skills, scanner patterns and templates moved between deployments; an `InstalledBundle` records its content hash and trust state. [docs/concepts.md:L99-L100](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L99-L100) [packages/shared/src/prisma/schema.prisma:L2727-L2735](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2727-L2735)

**Channel** — A Slack channel (`SlackChannel`) that hosts an assistant; it is a scope level in the cascade and owns thread sessions and open items. [packages/shared/src/prisma/schema.prisma#L845](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L845) [packages/shared/src/prisma/schema.prisma#L954](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L954) [packages/shared/src/prisma/schema.prisma#L987](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L987)

**`ConfigPermission`** — A grant row naming a key pattern (exact, `group.*` or `*`) and a grantee, with the widest scope it authorises writes at; the registry's `requiredRole` is a floor no grant lowers. [packages/shared/src/prisma/schema.prisma:L2394-L2402](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2394-L2402) [AGENTS.md:L452-L483](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L452-L483)

**`ConfigSetting`** — The storage row for a setting, one JSON `value` per key and scope with team, org, channel or template foreign keys. [packages/shared/src/prisma/schema.prisma:L2352-L2372](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2352-L2372)

**Connection** — A configured link to an outside system (git repository, tracker, MCP server); its `type` defaults to `git_repo`. [packages/shared/src/prisma/schema.prisma:L281-L290](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L281-L290) [docs/concepts.md:L95-L97](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L95-L97)

**Epic** — A brief spanning several repositories that a planner agent splits into per-repository runs started in dependency order, using `RepoDependency` edges. [docs/concepts.md:L29-L31](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L29-L31) [packages/shared/src/prisma/schema.prisma:L596-L606](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L596-L606)

**Eval** — A quality measurement, scored in a run by an `eval` node or offline by an `EvalRun` against a frozen dataset; scorer kinds include `gate`, `assert`, `trajectory`, `judge`, `policy` and `pii`. [docs/concepts.md:L102-L103](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L102-L103) [packages/shared/src/workflow/spec.ts:L286-L295](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L286-L295) [packages/shared/src/prisma/schema.prisma#L1604](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1604)

**Fan-out** — A `fanOut` node running parallel branches, bounded by `MAX_FANOUT_CONCURRENCY` (20) and defaulting to the run-pinned `workflow.fanoutConcurrency` setting (4). [packages/shared/src/workflow/spec.ts#L381](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L381) [packages/shared/src/config/registry.ts:L340-L352](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L340-L352)

**Gate** — A place where a run stops for a person; the four human nodes park the run until someone answers or a timeout routes elsewhere. [docs/concepts.md:L57-L60](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L57-L60) [packages/shared/src/workflow/spec.ts:L540-L599](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L540-L599)

**Harness** — The Claude Code loop (`claude-code` runtime) that runs inside the workspace container in place of the platform's own Mastra tool loop, restricted to Read, Write, Edit, Bash, Glob and Grep. [packages/shared/src/config/registry.ts:L506-L523](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L506-L523)

**HITL step (human-in-the-loop)** — A `WorkflowHumanStep` row of kind `APPROVAL`, `DECISION`, `INPUT` or `REVIEW` and status `PENDING`, `RESOLVED`, `TIMED_OUT` or `CANCELLED`, created when a human node pauses a run. [packages/shared/src/prisma/schema.prisma:L77-L89](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L77-L89) [packages/shared/src/prisma/schema.prisma:L1758-L1774](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1758-L1774)

**Invariants** — Source rules enforced by `yarn invariants:check` that the type checker and tests cannot state, each added only because its violation was silent under the other gates. [AGENTS.md:L182-L201](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L182-L201)

**Lesson** — What a finished run learned, stored as a pgvector-embedded `MemoryItem` (default scope `swe-lessons`) and retrieved as context for later runs. [docs/concepts.md:L85-L86](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L85-L86) [packages/shared/src/prisma/schema.prisma:L146-L150](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L146-L150)

**Node** — One step of a spec; the discriminated union covers `step`, `agent`, `mcp`, `eval`, `set`, `cond`, `signal`, `terminate`, `fanOut`, `shell`, `containerStep` and four human types, with optional `title` and `group` presentation labels. [packages/shared/src/workflow/spec.ts:L602-L619](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L602-L619) [packages/shared/src/workflow/spec.ts:L128-L129](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L128-L129)

**Platform explorer** — The public `/platform-explorer/` page, generated by `site/scripts/platformExplorer.mjs`, whose inventories derive from code while narrative lives in `analysis.json` and is guarded by a code-fingerprint warning. [AGENTS.md:L86-L90](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L86-L90)

**Pull request lifecycle states** — A `PullRequest` row's `status` is `OPEN`, `MERGED` or `CLOSED` (closed unmerged), alongside a separate `ciStatus` and an `isDraft` flag; merging remains the human gate. [packages/shared/src/prisma/schema.prisma:L225-L236](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L225-L236)

**Reaper** — The sweep that reconciles stranded `RUNNING` runs against Temporal; `WorkflowRun.reapCheckedAt` records the last time it found a run still live so the sweep orders never-checked runs first. [packages/shared/src/prisma/schema.prisma:L1401-L1404](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1401-L1404)

**Review network** — Three reviewer agents (security, domain logic, performance) that inspect a change in parallel and must all approve. [docs/concepts.md:L79-L80](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L79-L80) [AGENTS.md#L485](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L485)

**Run** — One execution of one template version as a durable Temporal workflow, stored as `WorkflowRun` with status `RUNNING`, `SUCCESS`, `FAILED`, `TIMED_OUT`, `SKIPPED` or `CANCELLED`. [docs/concepts.md:L20-L22](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L20-L22) [packages/shared/src/prisma/schema.prisma:L32-L39](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L32-L39) [packages/shared/src/prisma/schema.prisma:L1332-L1444](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1332-L1444)

**Run pin** — A value frozen into the run at start so later edits cannot change a decision the run already made: `pinnedSettings`, `agentVersions`, `agentRuntimes` and `skillRevisions`. [packages/shared/src/prisma/schema.prisma:L1359-L1378](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1359-L1378) [packages/shared/src/config/registry.ts#L560](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L560)

**`RunInput` (work request)** — One run submission: `externalTicketId`, a free-text description and a generic `payload` validated against the template's input schema; the public API still calls it a work request. [packages/shared/src/prisma/schema.prisma:L1186-L1237](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1186-L1237) [docs/concepts.md:L16-L18](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L16-L18)

**`runPinned`** — The registry flag that copies a setting's value into `WorkflowRun.pinnedSettings` at run start; `RUN_PINNED_SETTING_KEYS` filters the definitions by it. [packages/shared/src/config/registry.ts#L560](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L560) [AGENTS.md:L452-L483](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L452-L483)

**Runtime** — The loop driving an agent inside a workspace, `mastra` or `claude-code`; an `Agent.runtime` wins over the `workspace.implementerRuntime` setting, whose default is `mastra`. [packages/shared/src/prisma/schema.prisma:L2653-L2655](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2653-L2655) [packages/shared/src/config/registry.ts:L506-L523](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L506-L523)

**Scanner pattern** — A data row of type `INJECTION`, `EXFILTRATION`, `SHELL_COMMAND`, `CODE_SECURITY`, `SENSITIVE_FILE` or `PII` that runtime scanners run against agent text. [packages/shared/src/prisma/schema.prisma:L2581-L2588](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2581-L2588) [AGENTS.md#L607](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L607)

**Schedule fire** — One launch of a `ScheduledWorkRequest`, a cron-driven request whose ticket is synthetic (`<prefix>-sched-<id8>`) and whose launcher is the user who last defined the schedule. [packages/shared/src/prisma/schema.prisma:L1253-L1275](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1253-L1275)

**Scope cascade** — The resolution order for a setting, agent or credential, most specific first: `WORKFLOW_TEMPLATE`, `CHANNEL`, `TEAM`, `ORGANIZATION`, `GLOBAL`. [packages/shared/src/prisma/schema.prisma:L55-L69](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L55-L69) [docs/concepts.md:L90-L93](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L90-L93)

**Setting** — One operator-tunable knob declared once in `SETTING_DEFINITIONS` with schema, default, `overridableAt` scopes, `requiredRole` and `runPinned`; adding a knob needs no migration or route. [packages/shared/src/config/registry.ts:L43-L52](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L43-L52) [packages/shared/src/config/registry.ts:L340-L352](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L340-L352) [AGENTS.md:L452-L483](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L452-L483)

**Skill** — A named prompt fragment injected into an agent's system message; built-ins are `isBuiltIn` and verified, custom ones start unverified. [packages/shared/src/prisma/schema.prisma:L2446-L2460](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2446-L2460) [docs/concepts.md:L72-L74](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L72-L74)

**Skill revision** — An immutable `SkillRevision` written on every text or description change, deduplicated by a sha256 `contentHash`, and pinned per run in `WorkflowRun.skillRevisions`. [packages/shared/src/prisma/schema.prisma:L2497-L2520](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2497-L2520) [packages/shared/src/prisma/schema.prisma#L1378](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1378)

**Skill source** — A `SkillSource` row naming an external host, owner, repository, path and ref with a `pinnedSha`, from which skills are imported; it carries a `status` and a `scriptMode` defaulting to `TEXT_ONLY`. [packages/shared/src/prisma/schema.prisma:L2543-L2562](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2543-L2562)

**Spec** — A template version's JSON content: `name`, `entry`, a `nodes` map and `schemaVersion`, refined so the entry exists and every edge targets a known node. [packages/shared/src/workflow/spec.ts:L637-L660](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L637-L660) [packages/shared/src/workflow/spec.ts#L28](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L28)

**Step (`WorkflowStep`)** — The per-node execution record of a run, with status `PENDING`, `RUNNING`, `PASSED`, `FAILED` or `SKIPPED`; also the name of the `step` node type that runs a built-in activity. [packages/shared/src/prisma/schema.prisma:L41-L47](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L41-L47) [packages/shared/src/prisma/schema.prisma:L1735-L1739](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1735-L1739) [packages/shared/src/workflow/spec.ts#L226](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L226)

**Synthetic ticket (`ticketIsSynthetic`)** — A flag on `RunInput` set when the platform generated `externalTicketId` (no ticket named, a PRD run, a scheduled fire), making it a correlation key the ticket view hides by default. [packages/shared/src/prisma/schema.prisma:L1189-L1192](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1189-L1192)

**Team** — The tenant unit that owns repositories and templates; templates use `Restrict` on delete because a null team means `GLOBAL`. [packages/shared/src/prisma/schema.prisma#L662](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L662) [packages/shared/src/prisma/schema.prisma:L1819-L1824](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1819-L1824)

**Tool** — Something an agent can execute; `Agent.toolKeys` is null for all workspace tools, `[]` for none, or an explicit list that may include `mcp`. [packages/shared/src/prisma/schema.prisma:L2662-L2666](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L2662-L2666) [docs/concepts.md:L76-L77](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L76-L77)

**V8 isolate** — The sandbox that workflow files under `packages/worker/src/workflows/` run in, which allows only `import type` for external packages; activities are the boundary to non-determinism. [AGENTS.md:L824-L829](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L824-L829) [AGENTS.md#L80](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L80)

**Version** — Every template save creates an immutable `WorkflowTemplateVersion`; a run records its `templateVersion` and keeps that version. [packages/shared/src/prisma/schema.prisma:L1891-L1896](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1891-L1896) [docs/concepts.md:L42-L43](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L42-L43)

**Workflow template** — A named, versioned workflow with status `DRAFT`, `ACTIVE` or `ARCHIVED` and a declarative input schema for run submission. [packages/shared/src/prisma/schema.prisma:L49-L53](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L49-L53) [packages/shared/src/prisma/schema.prisma:L1819-L1830](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1819-L1830) [docs/concepts.md:L38-L40](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L38-L40)

**Workspace** — The isolated Docker container an agent works in, created with `docker run` and driven with `docker exec`, and always cleaned up in a `finally` block. [docs/concepts.md:L82-L83](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L82-L83) [AGENTS.md:L831-L836](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L831-L836)

Sources: [packages/shared/src/prisma/schema.prisma:L1-L60](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/prisma/schema.prisma#L1-L60) [packages/shared/src/workflow/spec.ts:L602-L619](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/workflow/spec.ts#L602-L619) [packages/shared/src/config/registry.ts:L43-L52](https://github.com/yorch/auto-swe/blob/d0a90fb5/packages/shared/src/config/registry.ts#L43-L52) [docs/concepts.md:L16-L103](https://github.com/yorch/auto-swe/blob/d0a90fb5/docs/concepts.md#L16-L103) [AGENTS.md:L182-L201](https://github.com/yorch/auto-swe/blob/d0a90fb5/AGENTS.md#L182-L201)

## Related Pages

- Sibling: [Repository Structure](./1-repository-structure.md)
- Sibling: [Data Model](./2.1-data-model.md)
- Sibling: [Workflow Spec and Interpreter](./2.2-workflow-spec-and-interpreter.md)
