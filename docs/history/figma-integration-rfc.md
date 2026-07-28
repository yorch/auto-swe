# Figma Integration — RFC & Roadmap

> **Frozen.** Point-in-time document, preserved for design rationale. It is not maintained: the code and the current references in [`docs/`](../README.md) are authoritative wherever they diverge.

Planning doc (RFC + roadmap) for **Figma integration**: giving auto-swe agents first-class access
to design source-of-truth so that UI/frontend work requests are implemented *faithfully to the
design*, not guessed from prose. Like the platform pivot and evals, this is framed as a **platform
capability**, not a SWE-only bolt-on: the engine gains a generic "design connection" + a
context-enrichment seam, and SWE ships the first design *content* (a design-fidelity skill, a
design-context provider) as seed material.

> Status: **P0 + P1 implemented** (rev. 2026-07-01). Shipped in this change:
> **P0** — a built-in `design-fidelity` skill (implementer) that steers faithful UI implementation
> whenever a Figma design is referenced and/or Figma MCP tools are bound (the MCP wiring itself
> reuses the P2 `mcp` Connection path with **no schema change** — attach the Figma Dev Mode endpoint
> as an `mcp` Connection and enable `'mcp'` on the agent). **P1** — submit-time design context: a
> `FigmaConfig` singleton + `resolveFigmaConfig()`, a `FigmaProvider` (REST) behind
> `createFigmaDesignProvider`, an `extractFigmaRefs` parser, a best-effort `enrichWithDesignData`
> hook that seeds `ContextSnapshot.rawDesign`, worker wiring that surfaces a compact design block in
> the implementer prompt, an admin panel at `/admin/integrations → Figma`, and unit tests. Token-sync
> (P2) and design-QA review (P3) remain deliberately-later phases (unbuilt). The rest of this doc is
> the original RFC — vision, grounding, and the phased plan; §3–§4 now describe shipped behavior.

---

## 1. Why Figma (the gap today)

auto-swe turns a ticket ID into a reviewed, tested, draft PR. For UI and frontend tickets, the
*design* is the real specification — yet today the implementer agent never sees it. A "build the
new settings page" ticket gives the agent only the prose `description` plus whatever the tracker
and knowledge-base connectors enrich into `ContextSnapshot`. The agent then *guesses* spacing,
colors, component structure, and states. The result is code that compiles and tests green but
visually drifts from what the designer drew — the exact handoff gap Figma's Dev Mode exists to
close.

A search of the codebase confirms there is **zero** design-related functionality today (no figma /
mockup / screenshot / design-token handling; only static wireframe docs in `docs/wireframes.md` and
`docs/redesign/`). So this is greenfield — but it slots cleanly onto three integration seams the
platform *already* has:

| Existing seam | File(s) | What it already does | Figma role it can play |
| --- | --- | --- | --- |
| **`mcp` Connection** (P2/WS3) | `lib/config/mcpConnection.ts`, `agents/mcpTools.ts`, gateway `routes/mcpConnections.ts`, web `/admin/mcp-connections` | Attach an HTTP(S) MCP server to an Agent; its tools bind at run time when the Agent enables the `'mcp'` tool key + references an active `mcp` Connection. Per-call audit + timeout + tracer. | **Agent-time design reads.** Figma's **Dev Mode MCP server** is an HTTP MCP endpoint — point an `mcp` Connection at it and the implementer/reviewer can pull frames, variables, and code-connect on demand. **No schema change.** |
| **Tracker / Knowledge-Base connectors** | `lib/integrations/registry.ts`, `lib/systemConfig.ts` (`resolveIssueTrackerConfig` / `resolveKnowledgeBaseConfig`), gateway `routes/workRequests.ts` (`enrichWithTicketData`) | At submit time, best-effort fetch enriches `ContextSnapshot` (`rawTicketData`, `rawDocumentation`). Provider-registry pattern; encrypted singleton config table; never blocks submission. | **Submit-time design context.** A **Figma provider** that, when a ticket references a Figma file/node URL, fetches frame metadata + design variables and seeds a new `ContextSnapshot.rawDesign` — so *every* downstream agent sees the design, even those without MCP tools. |
| **Workflow nodes** (`mcp`, `agent`, `step`, `containerStep`) | `packages/shared/src/workflow/spec.ts` (15 node types), interpreter, step registry | Insert a step anywhere in a template's DAG; the `mcp` node already calls a single tool on an `mcp` Connection. | **Design-token sync (P2)** as a `step`/`containerStep` node or scheduled work request; **design-QA review (P3)** as an extra reviewer in the network. |

The takeaway: Figma is overwhelmingly a **read** source for a contributor-role SWE tool. We do not
push designs *to* Figma (that is a non-goal — see §7). We pull design truth *in*, at two altitudes:
**on-demand during the run** (MCP) and **eagerly at submit time** (enrichment connector). P0 + P1
deliver exactly those two.

---

## 2. Design principles (inherited from the codebase)

These are not new inventions — they are the conventions every existing connector already follows,
and Figma must follow them too:

1. **Best-effort, never-blocking.** Tracker/KB enrichment never throws and never blocks submission
   (`enrichWithTicketData` swallows every error). Figma enrichment must do the same — a Figma
   outage cannot stop a work request.
2. **DB-backed, encrypted config with env fallback.** Every integration's credentials live in an
   encrypted singleton config table (`knowledge_base_config` etc.), resolved by a
   `resolveXxxConfig()` helper with a `process.env` fallback for bootstrap. Figma gets the same
   (`FigmaConfig` + `resolveFigmaConfig()`), using the existing AES-256-GCM envelope
   (`CONFIG_ENCRYPTION_KEY`). **Never read Figma creds from `process.env` directly in new code.**
3. **Reuse the `Connection` model — do not invent a new entity.** MCP already rides the generic
   `Connection` (`type: 'mcp'`, `config.url`). Figma's MCP path is just a `Connection` with
   `type: 'mcp'` pointing at the Figma Dev Mode endpoint — *no new model*. The REST path uses a
   singleton config table like every other connector.
4. **Provider-registry shape.** New external providers are added via the factory in
   `lib/integrations/registry.ts` behind a typed `ResolvedXxxConfig`. The Figma REST provider
   follows `KnowledgeBaseProvider`'s interface shape (a small, explicit set of read methods).
5. **Agents stay declarative.** No bespoke "Figma agent" wiring — the implementer/reviewer bind
   Figma tools through the *existing* `mcp` tool-key + `mcpConnectionId` mechanism. Behavior is
   shaped by a **skill** (prompt fragment), not by new agent plumbing.
6. **Observability for free.** MCP tool calls are already audit-logged (`[mcp:audit]`) and recorded
   on `AgentTracer` as `mcp:<tool>`. Figma calls inherit this — they show up per-attempt in the
   `/runs/[id]` viewer with no extra work.

---

## 3. P0 — Design-faithful implementation via `mcp` Connection

**Goal:** the implementer (and the review network) can read the linked Figma design during a run,
and is *told to use it*. This is the highest-value slice and the cheapest, because it reuses the
fully-built P2 MCP path end to end.

### 3.1 What ships

1. **A Figma `mcp` Connection** — created through the existing admin write-path
   (`POST /mcp-connections`, web `/admin/mcp-connections`) with `{ name: 'Figma', url: <Figma Dev
   Mode MCP endpoint> }`. Stored as `Connection{ type: 'mcp', config: { url }, name }`. **Zero new
   code in the connection layer** — it already accepts any HTTP(S) MCP server.
2. **Bind it to the implementer + reviewer Agents** — set `'mcp'` in each Agent's `toolKeys` and
   point `Agent.mcpConnectionId` at the Figma connection, via the existing agent-library form
   (`/admin/agents/library`). `resolveAgentMcpUrl` then binds Figma's tools at run time through
   `buildImplementerForActivity` and `runReviewNetwork`. **Zero new code in the binding layer.**
3. **A new built-in skill: `design-fidelity`** (`packages/shared/src/skills/`, one file mirroring
   the other 27 skills; seeded `isBuiltIn: true`, `isVerified: true`). This is the *only new
   artifact* in P0. It tells the implementer: when the ticket references a Figma design and Figma
   tools are available, fetch the relevant frame/node first; match spacing, color, typography, and
   component structure to the design's variables/tokens rather than inventing values; prefer
   existing design-system components; and call out any design ambiguity instead of guessing. A
   companion reviewer-side note (folded into the existing review skills or a small
   `design-conformance-review` skill) tells the review network to flag visual drift from the
   referenced design.

### 3.2 Why this is mostly configuration, not code

The P2 MCP work-stream already delivered: the `mcp` Connection type, `mcpUrlForConnection` /
`resolveAgentMcpUrl`, `loadMcpTools` (HTTP(S) only, per-call timeout, audit, tracer), the
`isMcpToolEnabled` gate, the admin CRUD + UI, and the `mcpConnectionId` field on the agent form.
Figma's Dev Mode MCP server is just *one more HTTP MCP endpoint*. So P0 is: **one new skill file +
a seed update + docs + a smoke test**, plus operator steps that are already supported by the UI.

### 3.3 Risks specific to P0

- **Reachability.** The Figma Dev Mode MCP server historically runs as a *local* endpoint
  (`http://127.0.0.1:3845/...`) tied to the desktop app, and may require an auth/seat. The worker
  runs in a container and must be able to reach whatever Figma MCP endpoint is configured. P0 must
  verify the deployment's networking (egress allowlist / DNS gating already exist per-team) and
  document the supported endpoint shape. If only a local endpoint is available, the REST path (P1)
  becomes the *primary* mechanism and P0 is gated on a reachable hosted/remote Figma MCP. **This is
  the single biggest open feasibility question and P0's build plan must resolve it first** (a
  connectivity spike before any skill work).
- **Token cost / context bloat.** Figma frame payloads can be large. The skill must steer the agent
  to fetch *targeted* nodes, and we rely on `loadMcpTools`' existing per-call timeout. Watch
  `mcp:audit` volume in early runs.

---

## 4. P1 — Submit-time design context (Figma REST connector)

**Goal:** when a work request's ticket references a Figma file/node, attach the design metadata to
`ContextSnapshot` at submit time — so the design is present for `validateContext`, the implementer,
*and* the reviewers, independent of whether any Agent has MCP tools. This mirrors the
tracker/knowledge-base enrichment exactly.

### 4.1 What ships

1. **`FigmaConfig` singleton table** (`packages/shared/src/prisma/schema.prisma`) — same shape as
   `KnowledgeBaseConfig`: `id = 'default'`, `enabled`, encrypted `apiToken*` columns (AES-256-GCM
   envelope), `maxNodes`, and an optional default file allowlist. Managed under
   `/admin/integrations → Figma`.
2. **`resolveFigmaConfig()`** in `lib/systemConfig.ts` returning a typed `ResolvedFigmaConfig`
   (`{ enabled, apiToken, maxNodes, ... }`), DB-primary with `process.env` fallback for bootstrap —
   exactly the pattern of `resolveKnowledgeBaseConfig`.
3. **A `FigmaDesignProvider`** in `lib/integrations/` behind a small read interface (e.g.
   `fetchFile(fileKey)`, `fetchNodes(fileKey, nodeIds)`, `fetchVariables(fileKey)`,
   `extractFigmaRefs(text)` to pull `figma.com/(file|design)/...` URLs out of ticket/description
   text), created via a `createFigmaDesignProvider(config)` factory in `registry.ts`. Uses the
   Figma REST API (`GET /v1/files/:key/nodes`, `/v1/files/:key/variables/local`, image-render
   endpoints) with `X-Figma-Token`.
4. **Enrichment hook** in `enrichWithTicketData` (or a sibling `enrichWithDesignData`) in
   `routes/workRequests.ts`: if Figma is enabled and the ticket/description references a Figma URL,
   fetch a *compact* design summary (frame names, layout/auto-layout summary, resolved
   variables/tokens, optional rendered-image URLs) and write it to a **new
   `ContextSnapshot.rawDesign` JSON column**. Best-effort, never-blocking, swallow-and-log —
   identical contract to the existing enrichment.
5. **`ContextSnapshot.rawDesign Json?`** column (one additive migration) + surface it in the
   `/workflows/:id/context` read view alongside ticket data and documentation.

### 4.2 Why both P0 and P1 (not one or the other)

They cover different altitudes and degrade independently:

- **P0 (MCP)** is *interactive and high-fidelity* — the agent pulls exactly the node it needs, mid-
  reasoning, with full Dev Mode richness. But it only helps Agents that have the `'mcp'` tool key,
  and depends on Figma MCP reachability from the worker.
- **P1 (enrichment)** is *eager and universal* — every agent in the run (including the tool-free
  `validateContext` agent that extracts success criteria) sees a compact design summary, with no
  MCP dependency. It works even where the Dev Mode MCP endpoint is unreachable.

Together: P1 guarantees a baseline of design context everywhere; P0 lets capable agents go deeper on
demand. If P0's reachability question (§3.3) blocks, P1 still delivers standalone value.

---

## 5. Later phases (scoped, not committed)

### 5.1 P2 — Design-token / design-system sync

Pull Figma **Variables** (design tokens) into the codebase and open a PR that updates a tokens file
/ Tailwind theme / CSS custom properties. Natural fits:

- A **scheduled work request** (Temporal Schedule, like the nightly lesson-consolidation / eval
  schedules) — "nightly Figma token sync".
- Or a workflow **`step` / `containerStep` node** in a dedicated template, so token-sync runs the
  same review → PR → human-merge pipeline as any other change.

This is heavier (token-mapping conventions are repo-specific) and is explicitly *after* P0+P1.

### 5.2 P3 — Design QA / visual review

A **design-conformance reviewer** added to the review network (alongside security / domain /
performance) that compares the implemented UI against the Figma reference. Highest payoff, heaviest
lift: needs a way to *render* the implemented UI (headless browser screenshot in the DinD workspace)
and a multimodal compare against Figma's rendered frames. Scoped here so the data model (e.g. a
`designFindings` channel on the review result) is designed with it in mind, but deferred until P0+P1
prove the design-context plumbing.

---

## 6. Phased build plan (summary)

| Phase | Scope | New code surface | Schema change | Lands as |
| --- | --- | --- | --- | --- |
| **P0** | Design-faithful implementation via Figma `mcp` Connection + `design-fidelity` skill (+ reviewer note) | 1 skill file + seed update + docs + smoke test; **connectivity spike first** | **None** (reuses `Connection`/MCP) | 1 PR |
| **P1** | Submit-time design context: `FigmaConfig` + `resolveFigmaConfig()` + `FigmaDesignProvider` + enrichment hook + `ContextSnapshot.rawDesign` | provider + resolver + 1 enrichment hook + admin UI panel | `FigmaConfig` table + additive `rawDesign` column (one migration) | 1–2 PRs |
| **P2** | Design-token sync (scheduled work request / workflow node) | token-mapping step + schedule wiring | possibly a schedule config field | later |
| **P3** | Design QA / visual review (design-conformance reviewer) | reviewer + headless render in workspace | review-result `designFindings` channel | later |

**Sequencing rule:** P0's build plan opens with a *connectivity + auth spike* against a real Figma
MCP endpoint (§3.3) before any skill work, because the answer determines whether P0 or P1 is the
load-bearing mechanism. P1 has no such dependency (REST API + token) and can proceed in parallel if
desired.

---

## 7. Non-goals

Consistent with the platform's contributor-role posture (`docs/product-overview.md` §non-goals):

- **No writing/pushing designs to Figma.** auto-swe consumes design truth; it does not generate or
  mutate Figma files. (Code→Figma is explicitly out of scope.)
- **No auto-merge of design-driven PRs.** Humans merge, same as every other work request.
- **No new agent-binding mechanism.** Figma tools bind only through the existing `'mcp'` tool-key +
  `mcpConnectionId` path. No bespoke Figma agent.
- **No bypass of the security model.** Figma MCP tool calls go through the same `loadMcpTools` audit
  + timeout + tracer wrapper; the REST token lives in the encrypted singleton config like every
  other credential.
- **No blocking on Figma availability.** Enrichment and MCP binding are best-effort; a Figma outage
  degrades gracefully to today's prose-only behavior.

---

## 8. Risks & open feasibility gaps

1. **Figma MCP reachability from the worker (P0).** The Dev Mode MCP server may be local/desktop-
   bound and seat-gated. If no worker-reachable endpoint exists in a given deployment, P0 degrades
   and P1 (REST) carries the value. **Resolve via a spike before P0 implementation.** (Biggest
   unknown.)
2. **Figma REST coverage & rate limits (P1).** The REST API exposes file/node/variable/image
   endpoints but not the full Dev Mode richness, and is rate-limited. The provider must fetch
   *compact* summaries, cap with `maxNodes`, and stay best-effort.
3. **Design payload size vs. context budget.** Frame trees and variable sets are large. Both phases
   must summarize aggressively (P1 server-side; P0 via skill-steered targeted fetches) to avoid
   blowing the agent's context / cost budget. Cost is already tracked per-run — watch it in early
   runs.
4. **Ref extraction precision (P1).** Pulling the *right* Figma file/node from free-form ticket text
   is heuristic. Start with explicit `figma.com/(file|design)/<key>?node-id=<id>` URL parsing;
   expand only if needed.
5. **Token-mapping conventions (P2).** There is no universal Figma-variable → code-token mapping;
   it is repo-specific. This is why P2 is deferred and will likely need per-repo config.
6. **Rendering for visual QA (P3).** Headless-browser screenshotting inside the DinD workspace +
   multimodal compare is a substantial new capability; deferred deliberately.

---

## 9. References

- **Existing MCP path:** `docs/platform-pivot-p2.md` (WS2/WS3/WS4), `packages/worker/src/agents/mcpTools.ts`,
  `packages/worker/src/lib/config/mcpConnection.ts`, `packages/gateway/src/routes/mcpConnections.ts`,
  `packages/web/src/app/admin/mcp-connections/page.tsx`.
- **Connector pattern to mirror:** `packages/shared/src/lib/integrations/registry.ts`,
  `packages/shared/src/lib/integrations/knowledgeBase.ts`, `packages/shared/src/lib/systemConfig.ts`
  (`resolveKnowledgeBaseConfig`), `packages/gateway/src/routes/workRequests.ts` (`enrichWithTicketData`).
- **Context model:** `ContextSnapshot` (`packages/shared/src/prisma/schema.prisma`),
  `packages/worker/src/activities/validateContext.ts`.
- **Skills:** `packages/shared/src/skills/` (27 built-ins), `docs/agents.md` (skill + tool assignment API).
- **Product framing & non-goals:** `docs/product-overview.md`, `docs/architecture.md`.
