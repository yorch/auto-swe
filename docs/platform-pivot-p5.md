# Platform Pivot — P5 Epic: UX layering + multi-org

> Build plan for **Phase P5** of the [platform pivot](./platform-pivot.md) (§P5). P5 is the final
> phase: it promotes the `orgId` stub from P3/EVOL-3 into a first-class **tenant boundary** (org-scoped
> RBAC, config cascade, and billing), and polishes the authoring/canvas UX layered on the P0–P4 engine.
>
> Status: ✅ **Done** — all work-streams merged (#91, #102). Current state is documented in
> [`AGENTS.md`](../AGENTS.md) (§"System Config", §"Multi-Model Support" → "Org multi-tenancy (P5)") and
> [`architecture.md`](./architecture.md). This file is the **archived build plan**; code is
> authoritative where they diverge.

---

## Outcomes (definition of done)

- **Multi-org foundation** — a first-class `Organization` model that every `Team` nests under, an
  `ORGANIZATION` tier added to `ConfigScope`, and the agent + credential cascades extended to
  4 levels: `WORKFLOW_TEMPLATE → TEAM → ORGANIZATION → GLOBAL`. The `ORGANIZATION` tier is consulted
  only when the run's team belongs to an org, so single-tenant deployments behave exactly as the
  3-level cascade did.
- **Org-level RBAC** — `OrganizationMembership` join table + `OrgRole` enum (`ORG_ADMIN` /
  `ORG_MEMBER`), enforced declaratively by the `requireAuth({ requiredOrgRole, orgIdParam })`
  onRequest hook (mirroring the team-scoped `requiredTeamRole`). Platform `ADMIN` bypasses the org
  check; an `ORG_ADMIN` self-serves their own org regardless of platform role.
- **Application-layer row isolation** — org-scoped routes enforce the hook; work-request submission
  (where the org is derived from the target connection, not a route param) uses the `assertOrgAccess`
  helper inline.
- **Org-granularity billing** — `OrgMonthlyUsage` aggregates per-org cost/runs/tokens via race-safe
  Prisma `increment` upserts at run finalize (guarded by the pre-read `endedAt` so a Temporal retry
  can't double-count); `Organization.monthlyBudgetUsdCents` caps monthly spend and returns
  `402 ORG_BUDGET_EXCEEDED` at submit time.
- **Authoring-SDK polish + canvas org-scope polish** (see work-streams below).

## Work-streams

| WS | Scope | Key artifacts |
|----|-------|---------------|
| **WS1 — Org foundation + config scope** | First-class `Organization`; `ORGANIZATION` added to `ConfigScope`; 4-level cascade in `resolveAgent` / credential resolvers (`ctx.orgId` derived transitively from `Team.orgId`) | `Organization` model, `ConfigScope.ORGANIZATION`, `resolveAgent` org tier |
| **WS2 — Org RBAC** | `OrganizationMembership` + `OrgRole`; `requireAuth({ requiredOrgRole, orgIdParam })` hook; member CRUD; platform-ADMIN bypass | `requireAuth` org path, `/api/v1/admin/organizations/:orgId/members` |
| **WS3 — Row isolation** | App-layer org gate on work-request submit via `assertOrgAccess`; org-scoped routes enforce the hook | `packages/gateway/src/lib/orgAccess.ts` |
| **WS4 — Org billing** | `OrgMonthlyUsage` increment-upsert in `finalizeWorkflowRun` (one transaction); `monthlyBudgetUsdCents` cap → `402 ORG_BUDGET_EXCEEDED`; budget read/update API + admin UI; shared `currentYearMonth` (`'YYYY-MM'`) key | `OrgMonthlyUsage`, `@auto-swe/shared/lib/billing`, `/api/v1/admin/organizations/:orgId/budget` |
| **WS5 — Authoring-SDK + canvas polish** | `auto-swe bundle init\|validate\|sign` (token-free, over `@auto-swe/sdk`) + `auto-swe bundles list\|export\|install\|install-from-url`; coded-step transports (containerStep NDJSON streaming + sidecar HTTP); `ORGANIZATION` tier in agent/credential scope selectors + Scope column + `/admin/organizations/[orgId]` page | `packages/sdk`, `packages/cli` bundle commands, `/admin/organizations/[orgId]` |

## Notes

- **`currentYearMonth`** (`'YYYY-MM'`) lives in `@auto-swe/shared/lib/billing` so the worker writer
  and gateway reader share one month-bucket formula.
- `runsCompleted` counts only `SUCCESS`; cost/tokens accrue for every terminal status.

### Open questions (remaining)

- None. Postgres-level RLS remains a possible future hardening over today's application-layer
  isolation, but is not required for the P5 deliverable.
