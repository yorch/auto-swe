# auto-swe — Multi-Agent Repository Review

> Produced by a six-agent review (Product, Architecture, Security, Documentation, Testing & Reliability, Evolution Strategy), synthesized by a review orchestrator. Review date: 2026-06-09, at commit `9778506`. Findings are namespaced per agent (`PROD-*`, `ARCH-*`, `SEC-*`, `DOC-*`, `TEST-*`, `EVOL-*`); every finding cites code evidence and carries a confidence tag (`[confirmed]` = verified in code, `[suspected]` = needs human verification).

---

## 1. Executive Summary

auto-swe is a feature-deep, architecturally disciplined v1. The hard parts are genuinely good: the Temporal isolate boundary is correctly respected, the workflow spec engine (11 node types, versioning, codemods, A/B experiments) is well-factored and well-tested, credential encryption / webhook HMAC / token-rotation / pgvector parameterization all survived adversarial review, and the documentation is top-decile with an honest Current/Historical taxonomy. A new contributor would be productive within a day.

The risk is concentrated in two places the agents converged on independently:

1. **The production deployment path is the weakest subsystem.** The fail-fast guards against shipping dev-fallback JWT secrets are dead code because `NODE_ENV=production` is never set in the gateway/worker images (SEC-1) — combined with the compose default `JWT_SECRET=dev-secret-change-me`, a default deploy allows **admin token forgery** (SEC-2). Independently, `docker.yml` publishes `:main` images without depending on CI, and the prod compose + Watchtower stack auto-pulls them every 5 minutes — a red main still ships (TEST-1). And the deployment runbook itself instructs operators to set env vars no code reads and gives build commands that don't exist (DOC-1/DOC-2).

2. **The implementer activity layer has drifted into a security and reliability gap.** The four implementer-session activities are ~80% copy-pasted, and the drift already shipped a real hole: CI-fix, review-fix, and gate-fix pushes skip the diff security/code scanners that the initial implementation path runs (ARCH-3). Four of the six runtime security scanners — the enforcement boundary against agent-generated commands — have zero tests (TEST-3), and the 555-line `RunnableWorkflow` has none either, despite CLAUDE.md claiming `@temporalio/testing` is the pattern (the package isn't even a dependency, TEST-2).

On the product side, the headline promise ("intent → PR for human merge") breaks at the last step: the dashboard KPIs are structurally wrong because no workflow ever writes a terminal failure status back to `ActiveWorkflow` (PROD-1), and the PR URL — the single thing a user needs at the end of every successful run — is never persisted or rendered (PROD-2). Epics dead-end with a guaranteed "not found" after launch (PROD-3); re-running a failed ticket 500s and leaves a zombie Temporal workflow (PROD-4).

**The single biggest opportunity** (Evolution agent): close the loop on three nearly-finished subsystems — ticket-tracker connectors (the `ContextSnapshot.rawTicketData` slot exists but nothing fills it), Slack-resolvable HITL approvals (notifier + interactive handler both shipped), and scheduled work requests (the Temporal Schedule pattern is already used for lesson consolidation). Together they convert auto-swe from "a demo you drive by hand" into "automation that runs your backlog" with near-zero architectural risk.

### Five most important findings

| # | Finding | Why it leads |
|---|---|---|
| 1 | **SEC-1/SEC-2 (P0):** prod secret guards gated on a `NODE_ENV` that is never set; compose defaults `JWT_SECRET` to a public value → forgeable admin tokens on default deploys | Only exploitable-as-shipped finding |
| 2 | **TEST-1 (P1):** image publish is independent of CI; Watchtower auto-deploys `:main` every 5 min → failing tests don't stop a production deploy | Negates the entire (good) test suite |
| 3 | **ARCH-3 (P1):** fix-loop pushes (CI/review/gate) bypass the diff security + code scanners that initial implementation runs | Shipped security-control regression caused by code duplication |
| 4 | **PROD-1 + PROD-2 (P1):** dashboard failure/active KPIs structurally wrong; PR link never shown anywhere | Breaks the product's core promise and trust in the UI |
| 5 | **ARCH-1/EVOL-2 (P1):** all Docker workspace ops are `execSync`/`spawnSync` → worker event loop blocks, heartbeats starve, throughput effectively serial | Biggest reliability/scale lever; causes spurious activity timeouts today |

---

## 2. Scorecard

| Dimension | Grade | Justification | P0 | P1 |
|---|---|---|---|---|
| Product | **B–** | Deep, polished core (templates, run forensics, teams) undermined by broken KPIs, missing PR link, dead-end epics, no re-run, broken CLI `run` output | 0 | 5 |
| Architecture | **B** | Boundaries and data integrity are excellent; worker activity layer (sync exec, 4× duplication w/ security drift, branch-as-FK) drags it down | 0 | 3 |
| Security | **B–** | Strong controls throughout the code — but the one P0 (dead prod guards + dev-secret default) is exactly the kind that voids the rest | 1 | 2 |
| Documentation | **A–** | Top-decile docs; deployment.md is the exception (phantom env vars, broken commands) plus systemic version drift | 0 | 2 |
| Testing & Reliability | **B–** | Healthy unit culture (57 files, ~534 cases, zero skips) but no integration/workflow/scanner tests and an ungated deploy pipeline | 0 | 4 |

---

## 3. Cross-Cutting Themes

These are the places multiple agents hit the same root cause from different angles — the real problems.

### Theme A — "Production deploy" is documented, gated, and secured worse than everything else
**SEC-1 + SEC-2 + SEC-4 + TEST-1 + TEST-11 + DOC-1 + DOC-2 + DOC-7 + DOC-19.** Dev-loop quality is high (CI runs lint/typecheck/tests; quickstarts verified accurate), but every artifact specific to production is broken or missing: dead secret guards, public default credentials (`JWT_SECRET`, Postgres `password`, MinIO `minioadmin`), CI-independent image publishing auto-deployed by Watchtower, a runbook with phantom env vars and nonexistent commands, and no mention of the shipped prod/Traefik/Watchtower compose files anywhere in docs. The team has clearly not yet run this in production in anger; the docs/guards encode an aspiration, not a practice.

### Theme B — The implementer fix-loop is the unowned corner of the worker
**ARCH-3 + ARCH-2 + TEST-3 + TEST-9 + SEC-5.** The initial-implementation path is carefully built (scanners, tracing, budget checks) and the three fix paths (CI-fix, review-fix, gate-fix) are copy-pastes that drifted: no security scans, divergent trace persistence, and workflow resolution by **branch string** — which is non-unique across repos and null for epic children. The enforcement layer those paths should rely on (shell/sensitive-file/code-security/skill scanners) is simultaneously the least-tested code in the repo. One extraction (`runImplementerSession(mode, …)`) plus scanner unit tests closes the entire theme.

### Theme C — The last mile of the core journey is unfinished
**PROD-1 + PROD-2 + PROD-4 + PROD-7 + PROD-8 + ARCH-7.** Everything from submit to PR-open works; everything after is frayed: terminal statuses never reach `ActiveWorkflow` (so the dashboard lies), the PR URL is computed then discarded, the two views of one execution (`/workflows/[id]` vs `/runs/[id]`) don't link to each other, failed runs have no re-run path, and the run-detail page spins forever on a 404. These are individually small fixes with outsized trust impact.

### Theme D — Documentation drift tracks the June feature burst
**DOC-8 + DOC-15 + DOC-10 + TEST-2.** Docs written before PRs #58–#68 (HITL, skills, scanners, GitHub App) lag in exactly those areas; the newest docs are flawless. CLAUDE.md's testing-convention claim (`@temporalio/testing`) describes a pattern that was never implemented. Add a docs-touch check to feature-PR review.

### Theme E — Scale ceilings are all in one file's blast radius
**ARCH-1 + EVOL-2 + EVOL-3 + ARCH-6 + ARCH-7 + PROD-11.** Sync exec in `workspace.ts`/`shellStep.ts`, singleton config resolvers without a tenant parameter, missing indexes on `active_workflows`, and unbounded list endpoints are each cheap to fix today and each become an organization-wide rewrite once more callers accumulate. The Evolution agent's two "de-risking refactors" (async exec; org-aware resolver signatures) are the same items the Architecture agent ranked #1 in tech debt.

### Conflict to resolve explicitly
**EVOL-7 (wire `Repository.mcpServerRef` to MCP tool loading) vs. SEC/TEST (the scanner enforcement boundary is untested).** Expanding the implementer's executable tool surface before the existing scanners have tests would widen an unverified control. **Recommended sequencing:** scanner unit tests (TEST-3) and fix-path scan parity (ARCH-3) land first; MCP tool loading follows, gated by `AgentToolConfig` and the audit pattern. Similarly, the EVOL "Now" growth items should not jump the queue ahead of SEC-1 and TEST-1 — a security incident or bad auto-deploy would cost more trust than the growth items earn.

---

## 4. Consolidated P0/P1 Findings

Remediation status reflects the fixes applied in this review's remediation phase (see §7).

| Rank | ID(s) | Sev | Finding | Evidence | Remediation | Status |
|---|---|---|---|---|---|---|
| 1 | SEC-1, SEC-2 | **P0** | Prod secret fail-fast guards dead (`NODE_ENV` never set in gateway/worker images); compose defaults `JWT_SECRET=dev-secret-change-me` → forgeable ADMIN tokens | `packages/gateway/src/plugins/auth.ts:79-108`, `packages/gateway/src/lib/betterAuth.ts:38-50`, `docker-compose.app.yml`, gateway/worker Dockerfiles | Set `NODE_ENV=production` in both runtime images; reject known dev-fallback secrets unconditionally; remove the compose default | **Fixed in this PR** |
| 2 | TEST-1 | P1 | `docker.yml` publishes `:main` independent of CI; Watchtower auto-deploys it every 300 s | `.github/workflows/docker.yml:68-72`, `docker-compose.prod.yml`, `docker-compose.watchtower.yml:11` | Gate publish on lint+typecheck+tests; pin prod to immutable tags | **Publish gated in this PR**; tag pinning left to operators |
| 3 | ARCH-3 | P1 | CI-fix/review-fix/gate-fix pushes skip `scanDiffForSecurityIssues`/`scanDiffForCodeIssues`; 4× duplicated activity bodies | `executeImplementation.ts:180,255,265` vs `ciFixLoop.ts` (no scanner imports), `qualityGates.ts:276+` | Extract `runImplementerSession`; restore scans on all push paths | Open — needs careful extraction + tests |
| 4 | PROD-1 | P1 | No workflow ever writes FAILED/TIMED_OUT/CANCELLED to `ActiveWorkflow.currentStatus`; dashboard Failed/Active/Needs-attention KPIs structurally wrong | `packages/worker/src/activities/templates.ts:98-127`, `packages/web/src/app/page.tsx:33-38` | `finalizeWorkflowRun` writes terminal status back to the `ActiveWorkflow` row | **Fixed in this PR** |
| 5 | PROD-2 | P1 | PR URL computed then discarded; no PR link rendered anywhere in the UI | `createOrUpdatePullRequest.ts:137`, `schema.prisma` `PullRequest` (no URL), `workflows/[id]/page.tsx:67-75` | Derive URL from `repository.githubUrl` + `prNumber` (both stored) and render links | **Fixed in this PR** (derived link on workflow detail) |
| 6 | ARCH-1 / EVOL-2 | P1 | All workspace Docker ops `execSync`/`spawnSync`; worker event loop blocks; heartbeats starve; no concurrency cap | `workspace.ts:41-97`, `execUtils.ts:14-18`, `worker/src/index.ts:47-55` | Async `spawn` + heartbeat pumping; explicit `maxConcurrentActivityTaskExecutions` | Open — behavioral change, needs load verification |
| 7 | ARCH-2 | P1 | Branch string used as FK to resolve workflows: non-unique across repos, null for epic children → fix loops break | `ciFixLoop.ts:64-71`, `qualityGates.ts:279-285`, `state.ts:17-22`, `schema.prisma:82-102` | Thread `workRequestId`/`repoId` through `CodeResult`; add `(repoId, assignedBranch)` index | Open — schema + plumbing change |
| 8 | PROD-3 | P1 | Epic launch redirects to a Temporal ID the workflow page can't resolve → guaranteed dead end; no epic list/status view exists | `epics/page.tsx:46`, `routes/epics.ts` (POST only), `routes/workflows.ts:40-50` | Resolve by `temporalWorkflowId` or return the row UUID; add minimal epic status view (or hide epics from nav) | Open — product decision (finish vs hide) |
| 9 | PROD-4 | P1 | Re-submitting a finished ticket 500s on unique constraint and leaves an untracked zombie Temporal workflow; no re-run UI | `routes/workRequests.ts:125,198-207`, `plugins/temporal.ts:114-123` | Upsert the `ActiveWorkflow` row on resubmission; add re-run action | Open |
| 10 | PROD-5 | P1 | CLI `auto-swe run`: `--workflow` silently stripped by gateway Zod schema; success output prints `undefined` ×3 | `cli/src/commands/workRequests.ts:172-205`, `routes/workRequests.ts:71-76` | Accept `templateId` in POST schema; print `workRequestId`/workflow IDs | **CLI output fixed in this PR**; `templateId` acceptance open (API change) |
| 11 | SEC-3 | P1 | `protobufjs` transitive with multiple HIGH advisories (code injection, prototype-pollution gadget, recursion DoS) via gRPC/Temporal/OTel stack | `yarn npm audit --all` | Bump parent deps; add audit gate to CI | Open — needs dependency bump validation; audit step added to CI as non-blocking |
| 12 | TEST-2 | P1 | Zero tests for the 555-line `RunnableWorkflow`; `@temporalio/testing` claimed in CLAUDE.md but not a dependency | `workflows/runnable.ts`, `worker/package.json` | Add TestWorkflowEnvironment suites or correct the doc | **Doc corrected in this PR**; test suites open |
| 13 | TEST-3 | P1 | 4 of 6 runtime security scanners (shell, sensitive-file, code-security, skill) have zero tests | no matching `*.test.ts` for those scanners | Unit-test against the 50 built-in patterns | Open — prerequisite for EVOL-7 |
| 14 | TEST-4 | P1 | No integration tests at all; CI sets `DATABASE_URL` to `invalid.local`; migrations never run against real Postgres in CI | `.github/workflows/ci.yml:17` | Add a Postgres+pgvector service-container CI job | Open |
| 15 | DOC-1, DOC-2 | P1 | deployment.md: phantom `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`EMBEDDING_MODEL` env vars (read nowhere); two nonexistent build commands | `docs/deployment.md:35,66-68,226-228` | Remove phantom vars; fix commands | **Fixed in this PR** |
| 16 | EVOL-1 | P1 | GitHub hard-coded across ~6 worker/gateway modules; no SCM abstraction → caps market (GitLab enterprise) | `createOrUpdatePullRequest.ts:14-31`, `workspace.ts:38`, `routes/webhooks.ts:10-22` | Extract a 5-method `ScmProvider` interface before more call sites accumulate | Open — strategic refactor |
| 17 | EVOL-3 | P1 | Six singleton config tables (`id='default'`) + tenant-less resolvers block any multi-org future | `schema.prisma:639-815`, `systemConfig.ts` | Thread optional `orgId` through resolvers now; defer full tenancy | Open — strategic refactor |

### P2/P3 appendix (abridged — full detail in each agent's report)

- **Security:** SEC-4 default Postgres/MinIO creds in compose `${VAR:-default}` (P2); SEC-5 pre-write secret scanner bypasses, test-path exemption (P2); SEC-6 unescaped email interpolation in auth emails (P3, **fixed in this PR**); SEC-7 raw `error.message` returned on 5xx (P3, **fixed in this PR**); SEC-8 moderate advisories (`@hono/node-server`, `postcss`) (P3).
- **Architecture:** ARCH-4 triple auth stack (P2); ARCH-5 god route files, no service layer (P2); ARCH-6 missing indexes on `active_workflows` FKs and `agent_lessons` (P2); ARCH-7 unbounded queries + full trace payloads on a 5 s poll (P2); ARCH-8 money as `Float` (P3); ARCH-9 duplicated helpers, 1,359-line `TemplateEditor.tsx`, stale schema comment (P3); ARCH-10 test skew (P3).
- **Product:** PROD-6 HITL resolve is DB-first + fire-and-forget signal → strandable step (P2); PROD-7 `/workflows/[id]` ↔ `/runs/[id]` not cross-linked (P2, **link added in this PR**); PROD-8 run page infinite spinner on 404 (P2, **fixed in this PR**); PROD-9 onboarding skips admin bootstrap (P2); PROD-10 no requester attribution, no `GET /work-requests` (P2); PROD-11 unbounded `/workflows` polled every 10 s (P2); PROD-12 epic creation skips team authorization (P2); PROD-13 runs table shows version without template name (P3); PROD-14 no HITL push notification (P3).
- **Docs:** DOC-3 PG17 vs pg18 drift (P2, **fixed in this PR**); DOC-7 "three migrations" vs 12 (P2, **fixed in this PR**); DOC-8 STATUS.md three weeks stale (P2); DOC-9 nonexistent `yarn db:migrate:reset` (P2, **fixed in this PR**); DOC-10 Mastra 1.32→1.40 doc drift (P2); DOC-11–DOC-18 version/path/index drift (P3, partially fixed); DOC-19 no CHANGELOG/CONTRIBUTING/SECURITY.md, prod compose path undocumented (P3).
- **Testing:** TEST-5 GitHub webhook path untested (P2); TEST-6 HITL nodes untested (P2); TEST-7 no graceful shutdown in gateway (P2); TEST-8 no coverage measurement (P2); TEST-9 core agent activities untested (P2); TEST-10 `createOrUpdatePullRequest` violates the tracer-in-`finally` rule (P3, **fixed in this PR**); TEST-11 no audit/SAST/image-scan gate (P3, **non-blocking audit added in this PR**).
- **Evolution:** EVOL-4 embedding dim frozen at 1536, no re-embed path (P2); EVOL-5 ticket-tracker slot unfilled (P2 — also the top growth opportunity); EVOL-6 CI signal fires on first `check_run`, not suite conclusion (P2, [suspected]); EVOL-7 `mcpServerRef` is a dead column (P2); EVOL-8 `skillsActive` recorded but never analyzed (P3).

---

## 5. 90-Day Action Plan

**Weeks 1–2 — Stop the bleeding (mostly done in this PR)**
1. SEC-1/SEC-2 secret-guard fix + compose default removal — S, done here.
2. TEST-1 gate image publish on CI — S, done here. Operators: pin prod compose to the immutable `timestamp-commit` tags `docker.yml` already produces.
3. DOC-1/DOC-2 deployment.md repair — S, done here.
4. PROD-1/PROD-2/PROD-8 dashboard truth + PR links + 404 state — S, done here.

**Weeks 3–6 — Close the enforcement and recovery gaps**
5. ARCH-3: extract `runImplementerSession`, restore scan parity on fix paths — M; eliminates a shipped security regression and ~600 duplicated lines.
6. TEST-3: unit-test the four untested scanners against the 50 built-in patterns — S/M; prerequisite for any tool-surface expansion.
7. PROD-4: re-run failed tickets (upsert row + UI action) — S/M; the most common recovery action in the category.
8. ARCH-2 + ARCH-6: replace branch-string lookups with IDs; add the three missing indexes — M.
9. TEST-4: one real-Postgres CI job running migrations + a route-test slice — M.
10. ARCH-1 stage 1: async exec + heartbeat pumping + explicit concurrency cap — M; biggest reliability lever.

**Weeks 7–12 — Build value on the de-risked base (Evolution "Now/Next")**
11. Ticket-tracker connectors (Jira/Linear/GitHub Issues) filling `ContextSnapshot.rawTicketData` — M; highest value-to-effort adjacency.
12. Slack-resolvable HITL approvals (Block Kit buttons; `User.slackId` and the interactive handler already exist) — S.
13. Scheduled/recurring work requests reusing the Temporal Schedule pattern — S.
14. EVOL-6: aggregate CI signals at suite level before selling "CI self-healing" hard — S.
15. PROD-3: finish or hide epics (minimal status view) — M; product decision required.
16. Begin TEST-2 (`@temporalio/testing` suites for `RunnableWorkflow`) and the two strategic chokepoint refactors (EVOL-1 `ScmProvider` interface, EVOL-3 org-aware resolver signatures) — L; start before more call sites accumulate.

---

## 6. Open Questions for the Team

1. **Is any deployment currently running with unset `JWT_SECRET`/`BETTER_AUTH_SECRET`?** (SEC-1/SEC-2) Check the running gateway container's env. If yes, rotate secrets and invalidate sessions after deploying the fix.
2. **EVOL-6 [suspected]:** does any target repo run multiple check runs per PR today? If so, has the CI-fix loop ever resumed on a partial result? Confirms/denies the suite-aggregation priority.
3. **Epics: finish or hide?** (PROD-3/PROD-12) The backend orchestrator is solid; the UX is a guaranteed dead end. This is a roadmap call, not an engineering one.
4. **Is multi-org/SaaS on the roadmap?** EVOL-3's resolver-signature change is cheap now and expensive later; the answer determines whether it makes the next quarter.
5. **Was `@temporalio/testing` (CLAUDE.md §5) ever used, or aspirational?** (TEST-2) Determines whether the fix is tests or docs — docs corrected in this PR pending the team adding suites.
6. **Watchtower in production: intentional continuous deployment?** (TEST-1) If yes, the CI gate added here is the minimum; consider also pinning immutable tags and adding an image-scan step.
7. **`Repository.mcpServerRef`:** still planned? It's accepted by the gateway and read by nothing (EVOL-7). Wire it (after TEST-3) or drop it.
8. **STATUS.md:** keep as a living "what shipped" doc (then it needs the June burst added) or freeze it with a cutoff banner? (DOC-8)

---

## 7. Remediation Applied in This Review

The following fixes were applied in the remediation phase (each as a separate commit on this branch):

1. **SEC-1/SEC-2** — `NODE_ENV=production` set in gateway and worker runtime images; JWT/better-auth dev-fallback secrets rejected unconditionally (not just when `NODE_ENV=production`); `JWT_SECRET:-dev-secret-change-me` default removed from `docker-compose.app.yml`.
2. **TEST-1** — `docker.yml` publish job now runs lint, typecheck, and the full test suite before building/pushing images; non-blocking `yarn npm audit` step added (TEST-11).
3. **PROD-1** — `finalizeWorkflowRun` writes terminal statuses (`FAILED`/`TIMED_OUT`/`CANCELLED`/`COMPLETED`) back to the `ActiveWorkflow` row, fixing the dashboard KPIs.
4. **PROD-2/PROD-7** — PR links (derived from `repository.githubUrl` + `prNumber`) rendered on the workflow detail page; workflow detail now links to its runs.
5. **PROD-8** — run detail page shows a "Run not found" error state instead of an infinite spinner.
6. **PROD-5 (partial)** — CLI `run` prints the actual response fields (`workRequestId`, workflow IDs) instead of `undefined`.
7. **TEST-10** — `createOrUpdatePullRequest` persists its trace in a `finally` block per the project's own AgentTracer rule.
8. **SEC-6/SEC-7** — auth-email HTML interpolation escaped; 5xx responses return a generic message instead of raw `error.message`.
9. **DOC-1/DOC-2/DOC-3/DOC-7/DOC-9/DOC-12** — deployment.md phantom env vars removed and commands fixed; PG version references aligned with compose; migrations table corrected; `db:migrate:reset` reference fixed; `.env.example` script names fixed; CLAUDE.md/AGENTS.md testing claim corrected (TEST-2).

Everything not listed above remains open and is tracked in §4/§5.
