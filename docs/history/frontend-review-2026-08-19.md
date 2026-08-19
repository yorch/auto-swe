# Frontend Code Review — 2026-08-19

> **Frozen.** A point-in-time review, kept for rationale. Do not consult it to learn current
> behaviour — the code wins wherever they diverge. Its findings were accurate against `341a4f7`;
> eight were fixed on the branch that added this file, and the rest are proposals.

Scope: `packages/web` (`@auto-swe/web`) — Next.js 16 App Router dashboard: 191 git-tracked
`.ts`/`.tsx`/`.mjs` files, 32,569 lines.

## ⚠️ Immediate Attention

**None found.** No leaked secrets, no server-only code reachable from a client module, no
`dangerouslySetInnerHTML` fed by user input, no auth enforced only client-side. Three things
were checked specifically and cleared:

- `app/layout.tsx:41` uses `dangerouslySetInnerHTML`, but the payload is `JSON.stringify` of two
  operator-set env vars with `<`, `>` and `&` escaped to `\u00xx`. Not user-reachable.
- `src/proxy.ts` is a cookie-presence check only, and says so in its own comment. Real
  authorisation is the gateway's `requireAuth` on every `/api/v1/*` call.
- `/admin/sessions` renders `{s.token}`, which reads as full session tokens in an admin table.
  It isn't — `packages/gateway/src/routes/admin.ts:87` truncates to an 8-character prefix
  server-side before responding.

The highest-severity finding is a correctness bug, not a security one: **F-001**, the run
detail rail reads `run.cost` where the API sends `costUsdAccrued`, so the Cost row never renders.

## Summary

Packages reviewed: `@auto-swe/web` · Verification tier: **2** where component tests exist
(20 files), **1** everywhere else. Tier 3 was unavailable — see Baseline.

Files: **191/191 reviewed** — 0 skipped, 0 not reached.
Applied: **8** · Proposed: **39** · Blocked: **0**

### Baseline

Recorded on the clean tree at `341a4f7`, after `yarn install --immutable` (the repo shipped with
no `node_modules`; installing declared dependencies is in scope). These exact commands were
re-run in full after every batch:

| Gate | Command | Baseline |
|---|---|---|
| Typecheck | `yarn typecheck` | exit 0 |
| Lint | `yarn lint` | exit 0 — 677 files checked, no diagnostics |
| Unit / component | `yarn test` | exit 0 — **175 files, 2157 tests** (monorepo-wide; 20 of those files are under `packages/web`) |
| Build | `yarn build` | exit 0 — all six workspaces, Next.js production build |
| E2E | — | **unavailable** |

**Pre-existing failures: none.** Every gate was green at baseline and green after every batch,
with the test count never below 2157.

**Why E2E is unavailable:** there is no E2E harness in the repository. `.github/workflows/ci.yml`
runs docs-check, typecheck, lint, `vitest run --coverage`, build, and a migrations job — no
Playwright/Cypress config, spec directory, or script exists. Nothing in this review could
therefore reach Tier 3, which is why every route-file move, `'use client'` boundary shift and
data-fetching relocation below is report-only.

**A note on the evidence files:** Biome lints the whole repo, so the review
artefacts themselves had to satisfy `yarn lint` (JSON key sorting). They were formatted with
Biome rather than excluded — no ignore file or lint config was touched.

## Coverage Gaps

**None on file coverage** (two verification-depth notes follow). Computed from `frontend-review-2026-08-19/inventory.json`: 191 of 191 `.ts`/`.tsx`/`.mjs` files tracked
by git under `packages/web` are marked `reviewed`, with no `skipped` or `not-reached` entries.
Nothing in the package is generated, vendored, or gitignored — there is no `__generated__`
directory, no `*.gen.*`, and the only excluded file by convention (`next-env.d.ts`) is not
tracked by git.

Two qualifications on what "reviewed" means here:

- **20 `*.test.tsx` / `*.test.ts` files** were read as verification context — to judge what the
  Tier-2 gate actually covers — and were never modified. That reading is what downgraded
  **F-023** from applied to proposed: `TracesTab.test.tsx` exercises node filtering only and
  never renders `TraceOutput`, so an extraction there would have been unverified where it counts.
- **`next.config.ts` and `postcss.config.mjs`** were read but treated as gate-adjacent and not
  modified.

**Out of scope by design:** the other five workspaces (`shared`, `gateway`, `worker`, `cli`,
`sdk`) were not reviewed — this is a frontend review. `packages/shared` was read only where the
web package's types come from it (`types/api.ts`, `workflow/`), and one finding (**F-001**)
proposes a change there because the web-side fix is not possible without it. That change would
require running the gateway's and worker's gates too, so it is report-only.

## Codebase Health

This is a well-maintained frontend. The evidence is not impressionistic: there is **not one `any`**
in 32,569 lines,
not one non-null assertion, not one `@ts-ignore` or `@ts-expect-error`, no `React.FC`, no
`IFooProps`, no enums, and exactly one array-index `key` — on positional diff lines, with a
`biome-ignore` explaining why. Import style is essentially perfect: 594 `@/`-aliased imports,
87 same-directory relative imports, and **zero** `../` traversals. Default exports appear only
in `app/` route files, where Next.js requires them. Biome's recommended preset is on and green,
which means unused imports and unused locals are structurally impossible here — that whole
category of finding is closed before a reviewer arrives.

The comments are the strongest signal. They are unusually good, and they are load-bearing:
`lib/api.ts` explains why a 401 on a request that carried no token must not trigger refresh;
`useConfigForm` explains the seed-once ref guard and what clobbering it would cost the admin;
`AddMemberModal` explains why two effects rather than one; `hooks/useEpics` explains why `retry: 5`;
`WorkflowDag` explains why it keys a memo on serialized content rather than identity. Every
`biome-ignore` in the package carries a real justification. This is a codebase where someone
wrote down *why*, and it made the review dramatically faster.

Where it is drifting, it drifts in one direction: **abstractions get built, adopted partially,
and then bypassed.** This is the through-line connecting most of what follows. `errMsg` exists
and is used 3 times against 74 hand-written copies of the same ternary (F-002). `LoadingState`
exists and is used 34 times, alongside 18 verbatim inline `<p>Loading…</p>` copies and one
hand-rolled pulse-dot re-implementation (F-014, F-042). `ConfirmModal` exists and is used 10
times, alongside 2 `window.confirm()` calls, 2 hand-rolled confirm modals, and one destructive
delete with no confirmation at all (F-039). `SecretInput` exists for the masked variant of an
admin config field, while the plain-text variant is copy-pasted 37 times (F-004). `PageHeader`
is used on 27 pages and ignored on 9 (F-013). `useConfigForm` and `useIntegrationConfigForm`
both exist, and the modelConfig tabs use neither (F-027). Most tellingly, `lib/utils.ts` carries
a comment describing bare `toLocaleString()` calls as the exact bug the shared formatters were
written to fix — and 11 of them are still in the tree (F-036). None of these are bad decisions.
They are good decisions rolled out partway and then left: adoption runs from 4% (`errMsg`, 3 of
77 sites) to 75% (`PageHeader`, 27 of 36 pages).

The second pattern is **hard-coded values drifting from their source of truth**, with comments
that make the drift invisible. `specToFlow.ts` labels `#e26b3c` as `ember-400`; the token has
been `#7c6cff` for some time. Eight tokens in that file and five in `chartChrome.tsx` are stale
in the same way, so the DAG edges and chart axes render a palette the app abandoned — while
`charts/colors.ts` two directories away holds the current values (F-005). The same class of
problem produced **F-033**, which *was* fixed: `NODE_WIDTH`/`NODE_HEIGHT` were declared twice,
once for dagre's layout input and once for the rendered card, with nothing to keep them equal.
And it produced **F-001**, the Cost row: a double cast let the author write `.cost` where the
API sends `costUsdAccrued`, and the compiler had nothing to say.

**The three structural changes with the highest leverage**, in order:

1. **Delete the double casts and close the type gap they paper over** (F-001). Thirteen
   `as unknown as` sites across six files are the package's only real type-safety holes, and one
   is already shipping a silent bug. Adding `costUsdAccrued` to `WorkflowRunSummary` fixes that
   bug and removes its cast in the same edit; the other twelve (`TemplateEditor` ×4,
   `NodeInspector` ×3, the two agent-library pages ×2 each, `lib/config.ts` ×1) are spec-node and
   config-bag widening that wants a narrower shared type. Only the `RunMetaRail` site is
   catalogued as its own finding.
2. **Finish the abstractions that are already half-adopted** (F-002, F-004, F-014, F-027, F-036,
   F-039, F-042). Individually these are nits; together they are ~150 call sites and the reason
   the app looks like several apps. Each is a mechanical, independently shippable PR, and
   `errMsg` alone is a single-afternoon change touching 40 files with no behavioural difference.
3. **Move the palette to CSS custom properties at the last three hold-outs** (F-005, F-006).
   Recharts and React Flow both accept `var(--color-*)` in the style props actually used here,
   so this is achievable without a design decision — and it permanently removes a class of drift
   that no gate can catch.

Two smaller things deserve attention out of proportion to their size: `ErrorBoundary` is the
app's *only* error boundary, has no `componentDidCatch`, and renders `text-gray-500` on
`bg-blue-600` — light-theme colours on a dark ground, at the app's most visible failure moment
(F-006, F-029). And `useUserPreferences` is a complete, correct, optimistic read/write hook
against a live `/me/preferences` endpoint that nothing calls, whose type has since diverged from
the one the UI actually uses (F-011). Per-user layout persistence is documented as shipped; the
client half was written and never wired up.

## Applied Fixes

| ID | Category | Severity | Files | Commit | Change |
|---|---|---|---|---|---|
| F-032 | dead-code | low | `lib/workflowLayout.ts` | `394cdd6` | Removed `RANK_X_SPACING`, `NODE_Y_SPACING`, `nodeCategoryColor`, `diffStrokeColor`, `statusFill` — zero references anywhere in the monorepo. The three colour helpers returned the pre-redesign light palette that `dagNode.tsx` replaced. |
| F-033 | dry | medium | `components/workflow/dagNode.tsx` | `8088e59` | `NODE_WIDTH`/`NODE_HEIGHT` were declared independently in `workflowLayout.ts` (dagre's layout input) and `dagNode.tsx` (the rendered card size). Both were 220/88; dagNode now imports the canonical pair so they cannot drift. |
| F-034 | dead-code | low | `app/runs/[id]/page.tsx` | `391a14d` | Removed `runStartMs` and `leftPct` from `WaterfallBar`, along with the two bare `void` statements that existed only to silence the unused-variable rule. |
| F-035 | types | low | `app/runs/[id]/page.tsx` | `a7971e9` | Dropped `(run as WorkflowRunDetail)` — `run` is already narrowed by the guard four lines above. |
| F-043 | best-practice | high | `lib/workflowLayout.ts`, `shared/workflow/spec.ts` (+ tests) | follow-up | `collectEdges` was a second hand-maintained switch over `node.type`, duplicating shared's `nodeEdges` — the documented single source of truth for graph traversal. The copy had drifted and had no case for `agent`, `mcp`, `eval` or `containerStep`, so the canvas, diff viewer and run viewer drew those four types as dead ends. `collectEdges` now maps over `nodeEdges` (~50 lines deleted) and `nodeEdges` gained a `never` sentinel, so the source of truth fails to build on a new variant. |
| F-044<br>(F-028) | consistency | medium | `components/workflow/dagNode.tsx` | follow-up | `HandleKind` was a character-identical duplicate of `EdgeKind`; it is now an alias. A drift between them would have detached edges with no type error. This supersedes **F-028**, which reported the same duplication but took the code comment's word that it was deliberate — nothing actually depended on the two being separate. |
| F-030 | best-practice | low | `app/runs/[id]/page.tsx` | follow-up | Hoisted `PLAY_DURATION_S` out of the component body to module scope. |

Every batch was verified with the four baseline commands unmodified, at 2157/2157 tests. No
batch was reverted; nothing is blocked.

**F-043 and F-044 were found by reviewing this review, not by the review itself.** An adversarial
re-read of F-032 noticed that `nodeCategoryColor` — one of the five symbols deleted as dead — was
the file's only exhaustiveness sentinel over the `Node` union: a 15-case switch with no `default`
and a non-nullable return, which fails to compile the moment a variant is added. `collectEdges`
returns unconditionally after its switch and so never had that protection, which is how four node
types came to be missing from it unnoticed. Deleting the sentinel was still right — it returned a
palette the app abandoned — but the deletion is what surfaced the older bug underneath it.

A reuse pass then found the deeper problem: `collectEdges` should never have existed. Shared's
`nodeEdges` is documented as *"the single source of truth for graph traversal ... so every node
type's edges are enumerated in exactly one place"*, is already used by the schema's ref validation
and by `validateSpec`'s reachability analysis, and had all four node types right the whole time.
The first attempt at F-043 patched the four missing cases into the duplicate — a bandaid that
would have let the next node type drift again. The landed fix deletes the duplicate instead.

That pass also surfaced three enumerations of `node.type` that are still unguarded, two of them
carrying live bugs: **F-045** (a multi-option `humanDecision`'s edges do not render at all — the
same symptom as F-043, in a node type F-043 did not touch) and **F-046** (`eval` is missing from
the editor's node palette, so there is no way to create one). Both are reported rather than fixed:
F-045 needs a product decision about handle topology that breaks an assumption in `TemplateEditor`,
and F-046 wants the palette retyped as an exhaustive record rather than a one-entry patch.

**Why so few.** Not because there was little to find — there are 37 proposed findings below,
several of them substantial. The constraint is verification depth. With no E2E harness, the
affected files sit at Tier 1 (build + typecheck + lint) unless a component test covers them, and
Tier 1 permits only unused-symbol removal, naming, import style, type-level cleanup, constant
extraction, and moving a symbol between modules. That rules out, by construction:

- **`errMsg` adoption** (F-002) — consolidating duplicated logic is a Tier-2 operation and the
  ~40 files involved have no component tests. It is mechanical and provably equivalent, and it
  is still the wrong thing for an agent to land unverified across 74 call sites.
- **Every consistency fix** (F-005, F-006, F-013, F-014, F-036, F-039) — each changes rendered
  output. NN1 forbids that regardless of tier, and the brief excludes design changes from scope.
- **Every genuine bug** (F-001, F-007, F-008, F-021, F-020) — fixing a bug changes behaviour by
  definition. These are the most valuable items in the report and the least appropriate to
  auto-apply.
- **Every accessibility item** (F-015, F-016, F-017) — report-only by rule.
- **The best DRY candidate** (F-037) — component extraction at Tier 1.

Four fixes were applied under those rules: three remove code that cannot be called, and the
fourth removes a redundant assertion. F-033 is the only one that changes what an importer
resolves, and both values were already identical.

Two more (F-030, F-043) were applied in a follow-up round after this report was itself reviewed.
F-030 — hoisting a constant — was in-tier and behaviour-preserving all along and should have been
in the first batch; leaving it out while claiming the applied set was complete was an error in
the original draft. F-043 is a genuine behaviour change and would have been report-only under the
original rules, but it is a real bug in code this branch already touched, so it was fixed with a
regression test rather than deferred.

## Proposed — Needs Your Decision

Ordered by severity, then by leverage. Full evidence for each is in `frontend-review-2026-08-19/findings.json`.

### High

**F-001 · The run detail Cost row never renders** — `components/runs/RunMetaRail.tsx:43`
reads `(run as unknown as Record<string, unknown>).cost`, but
`packages/gateway/src/routes/workflowRuns.ts:244` sends the field as `costUsdAccrued`. The
double cast is what let the wrong name compile. *Why not applied:* the real fix adds
`costUsdAccrued: number` to `WorkflowRunSummary` in `packages/shared`, whose consumers include
the gateway and worker — a cross-package change needing their gates too. It also makes a new row
appear in the UI. *Recommended fix:* add the field to the DTO, read `run.costUsdAccrued`, delete
the cast. *Effort:* 20 minutes. *Risk of leaving it:* cost is a headline governance signal and
it is silently absent from the primary run view; the same double-cast habit will hide the next
one too.

**F-002 · `errMsg` exists and is used 3 times against 74 inline copies** — the identical
`err instanceof Error ? err.message : '<fallback>'` ternary appears at 74 sites in ~40 files.
The helper lives in `hooks/useIntegrationConfigForm.ts`, a `'use client'` hook module, which is
the wrong home for a pure function and probably why nobody imports it. *Why not applied:*
consolidating duplicated logic is Tier 2; these files have no component tests. *Recommended fix:*
move `errMsg` to `lib/errors.ts`, substitute mechanically. The expressions are exactly
equivalent — this is a find-and-replace with a compiler check. *Effort:* one afternoon.
*Risk of leaving it:* low today, but it is the single largest duplication in the package and it
grows with every new mutation handler.

**F-003 · Ten copy-pasted config-resource hook triples** — `hooks/useAdminConfig.ts` carries
~350 lines of `useXConfig` / `useUpdateXConfig` / `testXConnection` that differ only in a URL
slug, a query key, and two type parameters. *Recommended fix:* a
`makeConfigResource<TConfig, TInput>(slug)` factory, with the existing exported names kept as
thin bindings so no call site changes. *Effort:* half a day. *Risk of leaving it:* an eleventh
integration means copy-pasting three more functions.

**F-007 · `ShellAllowlistEditor` clobbers in-progress edits** — it re-seeds its textarea from
query data on every `data` identity change. Its sibling `EgressAllowlistEditor` guards the
identical effect with `isDirtyRef`. TanStack Query hands back a new reference on any background
or window-focus refetch, so an admin editing the shell-image allowlist can watch their work
vanish. *Why not applied:* it is a bug, and the fix changes behaviour. *Recommended fix:* copy
the sibling's guard — six lines. *Effort:* 15 minutes. *Risk of leaving it:* silent data loss in
a security-relevant editor.

**F-036 · Ten bare `toLocaleString()` calls against a written convention** — `lib/utils.ts:8-21`
names this exact situation as the bug the shared formatters were written to fix. Seven files
still bypass them, and the two formats differ in shape, so one screen can show two date styles.
*Recommended fix:* route all ten through `formatDate` / `formatRelativeTime`. *Effort:* an hour.

**F-037 · `SkillRefEditor` and `ToolKeysEditor` duplicated verbatim** — ~130 lines shared
between `app/admin/agents/library/page.tsx` and `components/teams/TeamAgentLibrarySection.tsx`,
differing by one `label` prop. This is the one DRY candidate in the package that clears the
two-occurrence exception: byte-identical, substantial, one domain concept, one reason to change.
*Recommended fix:* move both into `components/agents/`. *Effort:* an hour.

**F-045 · A multi-option `humanDecision` node's edges do not render** — `nodeEdges` labels each
option edge `options[i].next`, the renderer flattens them to the `onSubmit` kind, and
`handleKindsFor(humanDecision)` exposes no `onSubmit` port, so React Flow drops them. A decision
node shows its timeout branch and none of its decision branches. *Why not applied:* the two
plausible fixes (one port per option, or one shared port) both collide with `TemplateEditor`'s
assumption that a handle id is a top-level spec field name — `patched[handleKind] = target` is
false for `options[i].next`. That assumption has to change first, which is a design call.
*Effort:* half a day plus a decision. *Risk of leaving it:* the decision node is a headline HITL
feature and its graph is wrong today.

### Medium

- **F-046 · `eval` is missing from the node palette**, so an eval node cannot be created from the
  editor at all. The palette is a plain array; typing it as an exhaustive
  `Record<SpecNode['type'], …>` — the pattern `CATEGORY_RING` already uses next door — would have
  caught it and will catch the next one.
- **F-047 · Two more unguarded `node.type` enumerations** — `subLabelFor` returns
  `string | undefined` so a missing case silently drops a node's sublabel, and `NodeInspector`
  dispatches through `===` comparisons so a new type gets no inspector section.
- **F-004 · 37 copy-pasted admin config text fields.** `SecretInput` proves the abstraction for
  the masked variant; the plain-text variant has none. The label class string alone repeats 32
  times. Add a `ConfigTextField` sibling.
- **F-005 · The DAG and chart chrome render a stale palette.** `specToFlow.ts` calls `#e26b3c`
  `ember-400` (actual: `#7c6cff`); eight tokens there and five in `chartChrome.tsx` are wrong.
  Comments naming the tokens hide the drift. Move to `var(--color-*)`.
- **F-006 · ~50 off-palette default Tailwind colours** against 1899 design-token uses, mostly
  `text-emerald-400` in the integration tabs. `ErrorBoundary` is the worst case: `text-gray-500`
  on `bg-blue-600`, a light-theme fragment at the app's most visible failure moment.
- **F-008 · `SetSection` resets the user's JSON mid-typing.** Unguarded re-seed on a `values`
  prop that is a fresh object every parent render. `FanOutSection` in the same file solves this
  with a ref guard.
- **F-009 · `FanOutSection`'s effect has no dependency array at all** — the one effect in the
  package that opts out of the dependency system, hand-rolling the comparison with a ref.
- **F-010 · `chartUtils` computes its 30-day window once at module load**, and mixes local-time
  arithmetic with UTC keys. A dashboard open across midnight silently drops new runs from the
  chart.
- **F-011 · `useUserPreferences` is dead, and its type has diverged.** A complete optimistic
  read/write hook against a live endpoint that nothing calls; its `RunDetailLayout` is
  `'split' | 'inline'` while the UI's is `'A' | 'B' | 'C'`. Per-user layout persistence is
  documented as shipped and the layout resets on every navigation. **Do not delete this without
  a decision** — deleting cements the regression.
- **F-013 · 9 pages bypass `<PageHeader>`** (27 use it), including Runs, Inbox, Teams and
  Workflows — the most-visited operational pages.
- **F-014 · Four competing loading treatments**, including 11 verbatim copies of one inline
  `<p>`.
- **F-015 · `Input` and `Textarea` never set `aria-describedby` or `aria-invalid`**, though
  `FieldWrapper` renders the hint/error ids for them and `Select` wires them up correctly.
  Validation errors on the two most-used field primitives are visible but not announced.
- **F-016 · Two search/filter inputs labelled only by `placeholder`** — the step-registry filter
  in the workflow palette and the template filter on the analytics page. A scripted scan flagged
  24 of 88 raw `<input>` elements as lacking both an id and an aria-label, but 22 of those are
  checkboxes and radios correctly wrapped in a `<label>`; only these two are genuinely unnamed.
- **F-038 · `/admin/skills` declares its own data hooks**, duplicating `hooks/useSkills.ts`'s
  endpoint under a different query key — so creating a skill leaves the agent-library and team
  skill pickers stale.
- **F-039 · Four different confirmation treatments**, including two `window.confirm()` calls and
  one destructive lesson delete with no confirmation at all.

### Low

F-012 (unreferenced exports left deliberately — `NodeConfigForm`, `relayoutNodes`,
`withGatewayDiagnostics`, five `useTeam*Credential` hooks, `useChannelBudget`; each looks like
scaffolding for work in flight, so the author should decide) · F-017 (dialogs lack
`aria-labelledby`) · F-018 (5 uncleaned confirmation timers; one sibling does it properly) ·
F-019 (`window.location.assign` for an in-app navigation on the dashboard) · F-020 (an invalid
`var(--x)/15` alpha shorthand in a plain CSS value, so the inbox badge has no background) ·
F-021 (the "Step timing" waterfall draws every bar at `left: 0` — it is not a waterfall, and the
correct offset is computed 250 lines above) · F-022 (`Button`'s inline `fontSize` makes its
per-size text classes inert, so `size="sm"` doesn't shrink its text) · F-023 (the trace `<pre>`
written five times in one file, in three visual variants) · F-024 (the partial `hooks/useWorkflows`
barrel — 35 imports through it, 52 around it, and its name collides with the function it
re-exports) · F-025 (`ConnectionFormModal` is a superset of `RepositoryFormModal`) · F-026
(`SubmitWorkRequestModal` hand-rolls `ui/Modal`'s dialog effect) · F-027 (modelConfig tabs use
neither of the two config-form hooks) · F-029 (the sole error boundary has no `componentDidCatch` and no per-route
`error.tsx` exists) · F-031
(internal navigations via raw `<a>` in the docs renderer — every cross-doc link is a full page
reload) · F-040 (the login page's hardcoded "gateway online" indicator, shown even while the
page reports the gateway unreachable) · F-041 (`new Date().getFullYear()` during render on a
prerendered page) · F-042 (`Th` declared in three pages — identically in two, with an
optional-`children` variant in the third; plus two hand-rolled loading blocks).

## Blocked — Verification Failed

**None.** All four batches passed every gate on the first attempt; no repair attempt or revert
was needed.

## Convention Conflicts

**Authority.** `CLAUDE.md` at the repo root is the conventions doc and therefore the top
authority. It is thorough on the backend and near-silent on the frontend — its entire entry for
`packages/web` is "TanStack Query for server state, Zustand for client state; `app/page.tsx` is
the dashboard home." No `CONVENTIONS.md` was written, because one authority already exists and a
second competing document is worse than a gap; the derived frontend conventions are recorded
here instead.

**Where authorities disagreed:**

- **Props declaration style.** `CLAUDE.md` is silent; the codebase is 145 inline object types in
  the signature against 25 named `XProps` declarations. Precedence falls to the dominant codebase
  pattern (level 3), so the inline form is the convention and the 25 outliers are reported, not
  migrated. Under the Prevalence Rule this is a decision for a human, not a fix.
- **Hook import path.** Two established patterns (`@/hooks/useWorkflows` barrel, 35 uses;
  direct module import, 52 uses), with several files using both in adjacent lines. Neither is
  dominant enough to call a convention. Reported as F-024 with a recommendation rather than
  resolved.
- **Date formatting.** Here the codebase's own comment *is* the authority — `lib/utils.ts`
  states the rule and the reason. Ten violations remain (F-036). This is a consistent defect,
  not a convention, so the Prevalence Rule does not protect it.
- **Colour tokens.** `app/globals.css` is the unambiguous source of truth (1899 uses); ~50
  default-Tailwind uses and ~13 stale hard-coded hexes contradict it. Again a defect, not a
  competing convention.

**Derived frontend conventions** (evidence in parentheses):

| Dimension | Convention | Split |
|---|---|---|
| Exports | Named, except `app/` route files | 100% / Next.js requirement |
| Import paths | `@/` alias; relative only within a directory | 594 alias, 87 same-dir, **0** `../` |
| Props | Inline object type in the signature | 145 vs 25 |
| Types | No `any`, no `!`, no `React.FC`, no enums | 0 occurrences of each |
| Server state | TanStack Query hooks in `hooks/`, one file per domain | 23 modules |
| Client state | Zustand, two stores (`authStore`, `teamStore`) | — |
| Styling | Tailwind + `cn()`; design tokens from `globals.css` | 1899 token uses |
| Page header | `<PageHeader>` | 27 vs 9 |
| Loading | `<LoadingState>` | 34 vs 18 |
| Confirmation | `<ConfirmModal>` | 10 vs 5 |
| Dates / numbers | `lib/utils` formatters, never bare `toLocale*` | 33 vs 11 |
| Error text | *undecided* — `errMsg` exists but is unused | 3 vs 74 |
| Tests | Co-located `*.test.tsx`, jsdom via a per-file pragma | 20 files |

**Codebase-wide migrations worth considering**, in dependency order: adopt `errMsg` (F-002) →
finish the `LoadingState` / `ConfirmModal` / `PageHeader` rollouts (F-013, F-014, F-039, F-042)
→ move the remaining hard-coded colours to CSS custom properties (F-005, F-006) → extract
`ConfigTextField` and collapse `useAdminConfig` behind a factory (F-004, F-003).
