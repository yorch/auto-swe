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
| `sensitive` | Runs code or mints/holds credentials: team secrets, shell, container and gate-command steps, repository onboarding, sandbox policy, service principals, callback endpoints | the capability's own minimum team role (most are team `ADMIN`; service principals and callbacks stay `LEAD`, as today), platform `ADMIN`. Org `ADMIN` does **not** on a team-scoped capability |
| `read` | Reads state | any of the above, plus org `MEMBER` where the data is org-wide |

A test walks the catalog and fails when a **team-scoped** `sensitive` or `operation` capability grants
an org role, or when a capability has no way to be held. Org-scoped and platform-scoped capabilities
are classed by who they are for (org `ADMIN` holds the org's own governance, including org GitHub
App linking and org budget).

The class decides only whether org authority reaches a team capability; the minimum team role is
always per capability. Moving a capability between classes changes who holds it, so the catalog
records both and the generated reference shows both.

### 4.2 The organization admin rule

An organization `ADMIN` holds every `governance` capability on every team of the organization,
without a team membership. For `operation` and `sensitive` capabilities they need a team role,
which they obtain deliberately: `team.members.manage` lets an org admin add themselves to a team of
their organization at any team role. The step is explicit, audited with `authority: 'org-admin'`,
and visible in the team's member list. It is a visible, deliberate escalation, not a barrier: an
org admin who wants team powers can have them. The point is that no one acquires them silently.

**Effective rank.** The hierarchy guard on member changes ("no change to a member above your rank,
no grant above your rank") ranks the actor by a `TeamRank` value, a `TeamRole` only, never a
platform role. A person acting under org or platform authority with no membership in that team has
effective rank `ADMIN`; a person acting through a team membership has that role's rank. A person
who is both an org `ADMIN` and a team `LEAD` acts under whichever authority the capability check
returned (`Decision.authority`), so being a member never narrows what org authority allows.
Self-removal and self-demotion remain refused for everyone (4.4).

**One path.** Adding a member, inviting by email with a team role, and the organization's invite
with `teamId`/`teamRole` all require `team.members.manage` on the target team, apply the same rank
rule and write the same audit record with `authority`. No invitation code is exempt.

### 4.3 Platform admin

Platform `ADMIN` holds every capability, with no membership. It is the instance operator. Every
decision that platform admin passes only because of their platform role (they hold no role in the
team or org concerned) is recorded as `authority: 'platform-admin'` in the audit context.

### 4.4 Constraints are not capabilities

Some current checks are not "may this role do this" but separation of duties or ownership: only the
launcher may steer an orchestration (an admin gets an emergency stop only on a run a service
principal launched), a template's author may not review their own change (`SELF_REVIEW_FORBIDDEN`),
nobody removes or demotes themselves (`SELF_REMOVAL`, `SELF_DEMOTION`), a failure assigned to
someone, a run's launcher. Platform `ADMIN` does **not** satisfy these, with one documented
exception: `notAuthor` at template review. A platform `ADMIN` may review a generated template version
they created themselves, as before, because a single-admin deployment could otherwise never promote
a generated version, and an administrator can already author an unreviewed version. Any other author
is refused (`SELF_REVIEW_FORBIDDEN`). The exception is taken by the review route, not by the helper:
`notAuthor` itself takes no role. The constraints are written as named
constraints in `packages/shared/src/permissions/constraints.ts` (`notSelf`, `isLauncher`,
`notAuthor`, `isAssignee`), composed with a capability by the domain code
(`can(...)` AND `constraint(...)`), and listed in the generated reference beside the capabilities
they accompany. A constraint never widens access.

### 4.5 Reach is not a capability

Which repositories a person reaches (team membership or a share, `canLaunch` on a share, the GitHub
gate), run visibility, budgets and service-principal allowlists are separate gates. They keep their
mechanisms. Where they today read a role value (for example "member of the owning team"), they read
the team membership, and where they test "may lead", they call `can()` for the matching capability.

## 5. The resolver

```ts
can(actor: Actor, capability: CapabilityKey, resource?: { teamId?: string; orgId?: string }): Promise<Decision>
type Decision = { allowed: true; authority: 'platform-admin' | 'org-admin' | 'team-role' | 'org-member' }
              | { allowed: false; code: 'FORBIDDEN' | 'NOT_FOUND'; reason: string; missing: CapabilityKey }
```

- The pure decision (`decide`) is in `packages/shared/src/permissions/can.ts` and takes
  already-loaded standing, so it is unit-testable without a database. The Prisma loader and `can()`
  are in `packages/shared/src/permissions/load.ts`, so the gateway **and the worker** use one
  implementation. The worker's execution-time re-checks (scheduled fires, campaigns, planned
  runs, PRD workflow, template runs, channel run plans) call it, so a launch and a fire cannot
  disagree about the same person.
- A resource names one thing or several: `{ teamId }`, `{ orgId }`, `{ anyOf: Resource[] }` (the
  actor needs the capability on at least one, as in "a lead of any owning team"), `{ allOf:
  Resource[] }` (every one, as in a campaign naming several repositories), or no resource at all
  for a person-level question ("leads at least one active team", used by the user lookup:
  `{ anyTeam: true }`).
- `heldScope(actor, capability)` returns `{ all: boolean; teamIds: string[]; orgIds: string[] }`,
  the set a list endpoint may filter by, so a list and the action behind it cannot disagree. It
  replaces every hand-written Prisma `role: { in: ['LEAD','ADMIN'] }` filter.
- A service principal calling a route that admits both people and principals is judged by its
  `serviceScopes`, never by `can()`: `can()` called with a principal actor returns `FORBIDDEN`.
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

A handler whose resource is derived from the body or a lookup calls `can()` itself and declares so:
`requireAuth({ handlerChecked: ['team.repos.manage'] })`. Every route's `config.authz` is then one
of `capability`, `authenticated` (any signed-in person, nothing sensitive), `handler-checked`,
`service` or `public`, set by `requireAuth` from its options. `can()` marks the request as checked;
an `onSend` hook on a `handler-checked` route that answers 2xx without a recorded check throws in
test and logs `authz.unchecked` in production. The route walk asserts every route has a value, that a
`service` route has no capability, and that the set of `handler-checked` capabilities names only
catalog keys. The `RBAC_OPTIONS` symbol and the registration-time checks stay.

`request.teamRole` and `request.authority` are set by the hook for handlers that need them.

## 6. Settings

The registry's `requiredRole` floor (`'ADMIN' | 'LEAD'`) becomes `writeAccess: 'admin' | 'grantable'`.
`'admin'` means only platform `ADMIN`; `'grantable'` means platform `ADMIN` or a covering grant.
Former `LEAD` floors become `'grantable'`. Grants are `config_permissions` rows keyed by
`userId` or by a **team role**, matched against the actor's role in the grant's team (a TEAM-scope
`LEAD` grant now means "this team's leads"), so a role-grantee grant requires `scope = TEAM`,
enforced by `CHECK (role IS NULL OR scope = 'TEAM')`; the `role_global` and `role_org` partial
unique indexes are dropped.

**The migration does not reinterpret old grants; it keeps only those that worked.** Today the
role floor is checked before any grant, so a grant on a key whose floor the actor's platform role did
not meet did nothing, and a role grant matched the platform role, not a team's. The migration
therefore deletes: every role-grantee row (they matched a role that no longer exists in that
meaning); every user grant on a key whose old floor was `ADMIN`; and every user grant whose user did
not hold platform `LEAD` or `ADMIN` at migration time. The remaining user grants (live before, live
after) are kept. It reports the count deleted. Operators re-issue team-role grants through the
settings API.

The sensitive-setting redaction in `configSettingsService` keys on `writeAccess: 'admin'` where it
keyed on the `ADMIN` floor.

## 7. Lifecycle

- Removing an organization membership removes the user's memberships in every team of that
  organization, in the same transaction, with an audit row per removal.
- **Locking.** The transaction takes the organization's row lock first, then the affected teams'
  row locks in ascending id order (the existing `FOR UPDATE` convention, marked
  `// CLAUDE.md §7 exception:`), and adding a team member re-reads the org membership under the
  same org lock. A concurrent add can therefore not leave someone on a team with no org membership.
- **Last-admin rules.** Refused with `409 LAST_ORG_ADMIN` when it removes the organization's last
  `ADMIN`, unless the actor is platform `ADMIN`. The cascade may leave a team with no `ADMIN` only
  when the actor holds org or platform authority (they govern the team and can appoint another);
  a team-level removal still refuses `409 LAST_TEAM_ADMIN`. A team without an `ADMIN` shows
  `needsAdmin: true` on its overview so org admins see it.
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

- `yarn invariants:check` fails when source under `packages/*/src` (tests, generated Prisma code and
  `packages/shared/src/permissions/` excluded) does any of: compare a `.role` or `Role`-typed value
  with `===`, `!==`, `in`, `.has(`, `.includes(` against a role literal or `*Role.*` member; call
  `hasRole`/`roleMeets`/`isOrgAdmin`; name `LEAD_ROLES`/`TEAM_LEAD_ROLES`; write a Prisma filter
  `role: { in: [...] }` or `role: 'ADMIN'` on a membership; or declare `z.enum([...])` over role
  literals. A role literal means any of `ADMIN`, `LEAD`, `MEMBER`, `USER`, `ENGINEER`, `ORG_ADMIN`,
  `ORG_MEMBER` appearing next to the word `role`. The few allowed places (the Prisma seed, sign-up
  default, the member-role request schemas that import `TEAM_ROLES` from the permissions module)
  are listed by file in the script with a reason. A tripwire over source text, like its siblings.
- `docs/permissions.md` is the reference; its capability matrix is generated from the catalog by
  `scripts/gen-permissions-doc.mjs` and `yarn docs:check` fails when the committed matrix differs
  from the generated one.
- A route walk test asserts every non-public route declares either a capability, a documented
  `requireAuth()` (any signed-in person), or `serviceScopes`.

## 9.1 Decisions on today's inconsistencies

The inventory found places where one action has several rules. They resolve as follows; each is a
deliberate behaviour change and goes in the upgrade note.

1. **Create a team** is one capability, `org.teams.create`: org `ADMIN` of the target organization or
   platform `ADMIN`, on both `POST /teams` and `POST /platform/organizations/:orgId/teams`.
2. **Org admin on team capabilities** follows the class rule (4.1) everywhere: governance includes
   org `ADMIN` (members, settings, repositories, budget, shares, lessons, knowledge bases); operation
   and sensitive do not (templates, automations, schedules, secrets, agents, plugins, callbacks,
   service principals). The web reads the same answer from `/me/permissions`.
3. **A deactivated team confers nothing** on a non-platform-admin for any non-read capability
   (`requiresActiveTeam` defaults to true, false only for `read` capabilities). `requiredTeamRole`
   routes used to ignore `isActive`.
4. **"May lead"** is one expression per capability (`team: 'LEAD'`); `LEAD_ROLES`, `TEAM_LEAD_ROLES`,
   `isLead()`, `role in ['LEAD','ADMIN']` and `roleMeets(…, 'LEAD')` all disappear.
5. **Sandbox policy PUTs** are `team.sandbox-policy.manage`, platform `ADMIN` only, declared as such
   (the team-role half of the old declaration never ran).
6. **Platform-admin sub-rules** inside team routes (private-network callbacks, agent runtime,
   installation binding, executor image build, PR-evaluation auto mode) stay platform-only
   capabilities with their own keys. Linking an ORG-scope eval dataset is `org.repos.eval-dataset.link`:
   org `ADMIN` of the repository's organization or platform `ADMIN`, the legacy rule.
7. **Human-error baselines** (platform `LEAD` + any org member today) become `org.baselines.manage`:
   org `ADMIN` of the target org or platform `ADMIN`; reading them (`org.baselines.read`) is open to
   any org member, a widening from platform `LEAD`.
7a. **No silent widening.** A capability's minimum role is never lower than the rule it replaces
   unless this section says so. Repository onboarding launch stays team `ADMIN` (it needed both
   `canManageTeamRepos` and shell authorship); the onboarding routes that only needed
   `canManageTeamRepos` keep `team.repos.manage`. Orchestration emergency stop stays platform
   `ADMIN` only.
7b. **Refusals do not reveal existence.** A person with no standing on a team gets the same `403`
   whether the team exists or not, as `requiredTeamRole` did; a route that hid existence with a
   `404` keeps it by declaring `hideAs404`.
8. **The planner** (platform `ENGINEER` minimum today) needs only an active user; the check is
   removed, with the synthesized run-plan actor becoming a plain `USER`.
9. **Platform-admin bypass idiom** (`user.role === 'ADMIN' ? {} : filter`, about 75 files) calls
   `isPlatformAdmin(actor)` from the permissions module, which records nothing by itself; list
   endpoints use `heldScope` instead where a capability applies, and the visibility filters (reach,
   non-goal) keep their shape.
10. **Per-resource rules** (a lead of a shared team may create schedules on the shared repository, a
    schedule's own team may manage it, an edge between repositories needs both teams to create and
    either to delete) are `anyOf`/`allOf` resource sets over the same capability. Run control (the
    launcher may steer their own run) and the answering of approvals stay in the run-control filter
    (reach, non-goal), reading `can('team.launch', …)` where they test "may lead".

## 10. Persisted and serialized role values

All of these change with the enums, and each is a place a missed update breaks sign-in or a gate:

- `users.role`, `team_memberships.role`, `config_permissions.role` (three columns on one Postgres
  type, `Role`), `organization_memberships.role`; the better-auth `additionalFields` default in
  `betterAuth.ts` (`'ENGINEER'` becomes `'USER'`); the Prisma seed.
- `JwtPayload.role`, the session cache, `MCP_ROLES` in `plugins/auth.ts` (must contain `USER`, or
  every non-admin MCP call is a 401), `serviceAdmissible` (compares to `'ENGINEER'`).
- `shared/types/api.ts` role schemas, `teamOverview.ts` view levels, the MCP team tools' enum, the
  configuration settings API schemas, CLI output, and the web's role types and labels.
- `transcript_access_log.actor_role` (text) and audit `context` JSON hold historical values. They are
  not rewritten; readers treat unknown values as opaque, new rows carry the new names, and the
  upgrade note says so.
- The three routes in `humanErrorBaselines.ts` that ask for platform `LEAD` become org-scoped
  capabilities (`org.baselines.read` / `org.baselines.manage`, class `governance`), decided by
  organization membership as their handlers already do.

### 10.1 Prisma migration

Prisma's generated diff cannot cast a populated enum column to a new enum type and the hand-written
DDL (CHECK constraints, partial indexes) reads as drift, so the migration is hand-written SQL, in
this order, in one transaction: drop the `ENGINEER` column defaults; delete the grants the settings
section removes; add `CHECK (role IS NULL OR scope = 'TEAM')`; drop the `role_global` and
`role_org` partial unique indexes; create `PlatformRole` and `TeamRole`; `ALTER COLUMN … TYPE …
USING (CASE role::text … END)` on each column; set the new defaults; `ALTER TYPE "OrgRole" RENAME
VALUE`; drop the old `Role` type. It is checked by `yarn db:deploy` on a fresh database and on a
database seeded from the previous schema, per the `prisma-pgvector-hnsw` skill (never `migrate dev`).

## 11. Migration order

The rename of stored role values is last, so it is small: by then no code outside the permissions
module compares a role value.

1. Core (additive, old enum untouched): the permissions module with the catalog, `decide`/`can`,
   `heldScope`, constraints, `isPlatformAdmin`; `requireAuth` accepts `capability`/`handlerChecked`
   beside the old options; route `authz` metadata and walk test; generated reference.
2. Domains, in parallel, each owning disjoint files (six packages, below). Each replaces its role
   comparisons with capabilities, constraints, `heldScope` or `isPlatformAdmin`, and keeps its tests
   green. Nothing here changes a stored value.
3. Settings registry and grants, the lifecycle cascade and last-admin rules, `me/permissions`, the
   `authority` audit field, the invariant (now enforceable because step 2 is done).
4. The rename: three enums, hand-written Prisma migration, seed, better-auth default, `MCP_ROLES`,
   JWT and API types, worker, CLI, web labels and a `useCan` hook backed by `me/permissions`.
5. Documentation, upgrade note, adversarial review, all quality gates.
5. Upgrade note: an operator deploying earlier code has roles renamed by the migration; every
   role-grantee settings grant, and every user grant that was inert before, is deleted (the
   migration reports the count) and must be re-issued; historical `actor_role` and audit values keep
   their old spelling.

## Limitations

- Capability checks are per request and read memberships each time; there is no cross-request
  cache beyond the existing user-state cache.
- An org admin can obtain operation and sensitive powers by adding themselves to a team; the
  protection is visibility and audit, not prevention.
- Run visibility, repository reach and budgets are separate gates and are not capabilities.
