# Capability-based permissions

Status: approved direction, breaking changes accepted (the platform has no production
deployments to preserve).

## 1. Problem

A person carries a platform role, a team role per team, an organization role per organization, and
settings grants. Platform and team roles share one enum (`Role`: `ADMIN`, `LEAD`, `ENGINEER`), so
"ADMIN" means two things. Authorization is declarative for one axis (`requireAuth` options) and
hand-written everywhere else: about 112 `role === 'ADMIN'` and 40 `role !== 'ADMIN'` comparisons,
32 `canManageTeamRepos` calls, and per-feature helpers. Whether an organization admin counts as a
team admin is decided per feature, and differs. Platform `LEAD` gates three routes and 27 settings
floors and nothing else.

## 2. Goals

1. One vocabulary: three role enums, one per level.
2. One decision point: `can(actor, capability, resource)`.
3. One table of capabilities, from which routes, the web UI and the generated documentation read.
4. A rule for how authority flows between levels, enforced by a test, not by convention.
5. Lifecycle integrity between organization and team membership.
6. Observability: a person can read their own effective permissions, and every use of a bypass is
   distinguishable in the audit log.

Non-goals: changing run visibility, repository reach (team membership AND the GitHub gate),
budget gates, service-principal scopes, MCP scopes, or the assistant policy. Those are separate
mechanisms that stay as they are, except where they name a role value.

## 3. Roles

| Enum | Values | Stored on |
|---|---|---|
| `PlatformRole` | `ADMIN`, `USER` | `users.role` |
| `TeamRole` | `ADMIN`, `LEAD`, `MEMBER` | `team_memberships.role` |
| `OrgRole` | `ADMIN`, `MEMBER` | `organization_memberships.role` (values renamed from `ORG_ADMIN`/`ORG_MEMBER`) |

Platform `LEAD` is removed. Existing rows migrate: platform `ADMIN` stays `ADMIN`; `LEAD` and
`ENGINEER` become `USER`. Team `ENGINEER` becomes `MEMBER`; team `LEAD` and `ADMIN` are unchanged.
Org `ORG_ADMIN` becomes `ADMIN`, `ORG_MEMBER` becomes `MEMBER`.

Team roles are ranked `MEMBER < LEAD < ADMIN` for the hierarchy guard on member changes (a person
may not change or grant a role above their own). Capabilities do not use the rank implicitly: each
capability states the minimum team role it needs, so "LEAD may, ADMIN may, MEMBER may not" is
written down per capability.

## 4. Capabilities

A capability is a named permission with a scope and a class. It is declared once, in
`packages/shared/src/permissions/` (one file per domain, aggregated by an index), as:

```ts
defineCapability('team.secrets.manage', {
  scope: 'team',          // 'platform' | 'org' | 'team'
  class: 'sensitive',     // 'governance' | 'operation' | 'sensitive' | 'read'
  team: 'ADMIN',          // minimum team role; omit = team role does not confer it
  org: undefined,         // minimum org role that confers it for the resource's org
  platformAdmin: true,    // platform ADMIN confers it (default true)
  requiresActiveTeam: true,
  description: '…',
});
```

### 4.1 Classes and how authority flows

Authority flows down containment (platform, then organization, then team), but a capability's
class limits how far.

| Class | Meaning | Who may hold it |
|---|---|---|
| `governance` | Shapes who and what belongs to a team: members, repositories, shares, budget cap, team creation, templates' ownership | team role, org `ADMIN` of the owning org, platform `ADMIN` |
| `operation` | Does the team's work: launch, answer approvals, nudge, author workflow templates and prompts | team role, platform `ADMIN`. Org `ADMIN` does **not** |
| `sensitive` | Runs code or holds credentials: team secrets, shell, container and gate-command steps, repository onboarding, sandbox policy | team `ADMIN` (or platform `ADMIN` only), platform `ADMIN`. Org `ADMIN` does **not** |
| `read` | Reads state | any of the above, plus org `MEMBER` where the data is org-wide |

A test walks the catalog and fails when a `sensitive` or `operation` capability grants an org role,
or when a capability has no way to be held.

### 4.2 The organization admin rule

An organization `ADMIN` holds every `governance` capability on every team of the organization,
without a team membership. For `operation` and `sensitive` capabilities they need a team role,
which they obtain deliberately: `team.members.manage` lets an org admin add themselves to a team of
their organization at any team role. The step is explicit, audited with `authority: 'org-admin'`,
and visible in the team's member list. It is a visible, deliberate escalation, not a barrier: an
org admin who wants team powers can have them. The point is that no one acquires them silently.

### 4.3 Platform admin

Platform `ADMIN` holds every capability, with no membership. It is the instance operator. Every
decision that platform admin passes only because of their platform role (they hold no role in the
team or org concerned) is recorded as `authority: 'platform-admin'` in the audit context.

## 5. The resolver

```ts
can(actor: Actor, capability: CapabilityKey, resource?: { teamId?: string; orgId?: string }): Promise<Decision>
type Decision = { allowed: true; authority: 'platform-admin' | 'org-admin' | 'team-role' | 'org-member' }
              | { allowed: false; code: 'FORBIDDEN' | 'NOT_FOUND'; reason: string; missing: CapabilityKey }
```

- Lives in `packages/shared/src/permissions/can.ts` (pure decision over loaded standing) with a
  Prisma loader in the gateway. The decision function takes already-loaded standing so it is
  unit-testable without a database.
- For a team-scoped capability the resolver loads the actor's `TeamMembership` for `teamId` and the
  team's `{ isActive, orgId }`; for org-scoped, the `OrganizationMembership`. When `teamId` is given
  and the capability grants an org role, the team's org is looked up so the org rule in 4.2 applies.
- A deactivated team confers nothing except to platform `ADMIN` when `requiresActiveTeam` is false.
- `allowed:false` with `NOT_FOUND` is used where today's handler hides existence (the existing
  `404 TEAM_NOT_FOUND` behaviour); each domain keeps its current status code for a refusal.
- The decision is cached per request, not across requests. Memberships are read per check as today.

### 5.1 Route declaration

`requireAuth({ requiredRole, requiredTeamRole, requiredOrgRole, … })` is replaced by:

```ts
requireAuth()                                           // any signed-in person
requireAuth({ capability: 'team.repos.manage', team: { param: 'id' } })
requireAuth({ capability: 'platform.users.manage' })
```

A handler whose resource is derived from the body or a lookup calls `can()` itself. The
`RBAC_OPTIONS` symbol and the registration-time checks stay: a route that declares `serviceScopes`
may not declare a capability (service principals hold no role), and the route walk test asserts it.

`request.teamRole` and `request.authority` are set by the hook for handlers that need them.

## 6. Settings

The registry's `requiredRole` floor (`'ADMIN' | 'LEAD'`) becomes `writeAccess: 'admin' | 'grantable'`.
`'admin'` means only platform `ADMIN`; `'grantable'` means platform `ADMIN` or a covering grant.
Former `LEAD` floors become `'grantable'`. Grants are `config_permissions` rows keyed by
`userId` or by a **team role**, matched against the actor's role in the grant's team, so a
role-grantee grant requires `scope = TEAM`. Existing role-grantee rows at GLOBAL or ORGANIZATION
scope are deleted by the migration (they matched a platform role that no longer exists); TEAM-scope
rows map `ENGINEER` to `MEMBER`. The CHECK constraint on the table is updated by a hand-written
migration step (see the `prisma-pgvector-hnsw` skill).

## 7. Lifecycle

- Removing an organization membership removes the user's memberships in every team of that
  organization, in the same transaction, with an audit row per removal. Refused with
  `409 LAST_TEAM_ADMIN` when it would leave a team with no `ADMIN`, unless the actor is platform
  `ADMIN`; refused with `409 LAST_ORG_ADMIN` when it removes the organization's last `ADMIN`
  (platform `ADMIN` is exempt).
- Deactivating a user already ends their access; unchanged.

## 8. Effective permissions

`GET /api/v1/me/permissions` returns the caller's platform role, their team standings (team id,
slug, role, organization) and organization standings, and the list of capability keys the caller
holds for each team and organization they belong to plus the platform-level capabilities.
`GET /api/v1/me/permissions?teamId=` is the same narrowed to one team, including capabilities held
only through authority (org admin, platform admin), each tagged with its authority. Refusals (403)
carry `error.missing` naming the capability. The dashboard reads `me/permissions` through one hook
(`useCan`) in place of its local role helpers.

## 9. Invariants and generated documentation

- `yarn invariants:check` fails on a comparison of a role value to `'ADMIN'`, `'LEAD'`,
  `ORG_ADMIN` or `role ===` outside `packages/shared/src/permissions/`, the Prisma seed, the
  sign-in and invitation code, and tests.
- `docs/permissions.md` is the reference; its capability matrix is generated from the catalog by
  `scripts/gen-permissions-doc.mjs` and `yarn docs:check` fails when the committed matrix differs
  from the generated one.
- A route walk test asserts every non-public route declares either a capability, a documented
  `requireAuth()` (any signed-in person), or `serviceScopes`.

## 10. Migration order

1. Core: enums, catalog, `can()`, `requireAuth` capability option, generated doc, Prisma migration.
2. Domains, in parallel, each owning disjoint files: teams and members; repositories; templates and
   agents; runs and approvals; org, platform and admin; settings and config; usage, reports,
   automations and the rest.
3. Web, CLI, SDK, worker: role values and labels; web reads `me/permissions`.
4. Invariant, lifecycle cascade, `me/permissions`, audit authority.
5. Upgrade note: an operator deploying earlier code has roles renamed by the migration; role-grantee
   settings grants at GLOBAL or ORGANIZATION scope are deleted and must be re-issued per user.

## Limitations

- Capability checks are per request and read memberships each time; there is no cross-request
  cache beyond the existing user-state cache.
- An org admin can obtain operation and sensitive powers by adding themselves to a team; the
  protection is visibility and audit, not prevention.
- Run visibility, repository reach and budgets are separate gates and are not capabilities.
