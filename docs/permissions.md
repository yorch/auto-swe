# Permissions

Who may do what is decided in one place. Every action a person can take is a **capability**: a
named permission with a scope, a class and the minimum role that confers it. One function,
`can(actor, capability, resource)`, answers "may this person do this here", and the same answer
drives the gateway's routes, the worker's execution-time re-checks and the dashboard. The catalog
of capabilities is the source of the matrix at the end of this page.

The code is in `packages/shared/src/permissions/`, exported as `@auto-swe/shared/permissions`.
Gateway routes declare a capability with `requireAuth({ capability })` (`packages/gateway/src/plugins/auth.ts`),
and a handler that decides from a body or a lookup calls `can()` from `packages/gateway/src/lib/authz.ts`.

## Roles and levels

A person holds a role at up to three levels, and each is independent:

| Level | Roles | Stored on |
|---|---|---|
| Platform | `ADMIN`, plus every other person as a plain user | the user |
| Organization | `ADMIN`, `MEMBER` | the organization membership |
| Team | `ADMIN`, `LEAD`, `MEMBER` (lowest first) | the team membership |

Only one module, `packages/shared/src/permissions/standing.ts`, reads stored role values. The rest
of the code works in abstract ranks and booleans (`isPlatformAdmin`, `teamRankOf`, `orgIsAdmin`),
so how a role is spelled in the database is not something a capability depends on.

A capability does not use the team ranking implicitly. Each states the minimum team role that
confers it, so "a lead may, an admin may, a member may not" is written down per capability. The
ranking is used for one thing only: the hierarchy guard on member changes, where nobody changes or
grants a role above their own.

## Capabilities

A capability has:

- a **scope**: `platform`, `org` or `team`, which says what kind of resource it is asked about;
- a **class**: `governance`, `operation`, `sensitive` or `read`, which says how far authority
  flows down from the levels above (below);
- an optional minimum **team role** and **org role** that confer it;
- whether **platform admin** confers it (default yes);
- whether the team must be **active** for a role to confer it (default: every class but `read`);
- a description.

Keys are `<scope>.<noun>[.<noun>…]` in lower-case kebab case. A key is a string literal in the
type `CapabilityKey`, so a misspelt key is a compile error wherever it is used.

### Classes and how authority flows

Authority flows down containment (platform, organization, team), but a capability's class limits
how far.

| Class | Meaning | Who may hold it |
|---|---|---|
| `governance` | Shapes who and what belongs to a team: members, repositories, shares, the budget cap, team creation | the team role, an organization `ADMIN` of the owning organization, platform `ADMIN` |
| `operation` | Does the team's work: launch, answer approvals, nudge, author templates and prompts | the team role, platform `ADMIN`. An organization `ADMIN` does not |
| `sensitive` | Runs code or holds credentials: team secrets, shell and gate-command steps, repository onboarding, sandbox policy, service principals, callback endpoints | the capability's own minimum team role, platform `ADMIN`. An organization `ADMIN` does not |
| `read` | Reads state | any of the above, plus organization members where the data is organization-wide |

The class decides only whether organization authority reaches a team-scoped capability. The
resolver enforces it even if a definition says otherwise, and a test fails when a team-scoped
`operation` or `sensitive` capability names an organization role or when a capability has no way
to be held. Organization-scoped and platform-scoped capabilities are classed by who they are for:
an organization `ADMIN` holds the organization's own governance, including its GitHub App link and
its budget.

### Three authorities

A decision that allows records why, as `authority`:

| Authority | Meaning |
|---|---|
| `team-role` | The person's own team membership confers it |
| `org-member` | An organization membership short of `ADMIN` confers it (read capabilities only) |
| `org-admin` | The person administers the organization that owns the team |
| `platform-admin` | Only the platform role confers it: the person holds no qualifying role in the team or organization concerned |

A person who qualifies in more than one way is recorded under the first that applies, in this
order: `org-admin` (an organization `ADMIN` on a governance capability, so being a team member
never narrows what organization authority allows), `team-role`, `org-member`, `platform-admin`.
Every decision that passes only because of the platform role is recorded as `platform-admin`, so a
use of the bypass is distinguishable in the audit context. A route's own
capability check sets `request.authority`, which the audit context records; a handler that calls
`can()` reads the authority from the decision it gets back. When one question names several resources, the decision reports the least exceptional
authority for `anyOf` and the most exceptional for `allOf`.

### The organization admin rule

An organization `ADMIN` holds every `governance` capability on every team of their organization,
without a team membership. For `operation` and `sensitive` capabilities they need a team role,
which they obtain deliberately: `team.members.manage` lets them add themselves to a team of their
organization at any team role. The step is explicit, audited with `authority: 'org-admin'` and
visible in the team's member list. It is a visible escalation, not a barrier.

For the member-change hierarchy guard, a person acting under organization or platform authority
with no membership in the team ranks `ADMIN`; a person acting through a team membership ranks as
that role. `actingRank(standing, teamId)` computes it per team from standing alone: platform
`ADMIN`, or an organization `ADMIN` of that active team's own organization, ranks `ADMIN`; anyone
else ranks as their membership. A check on another team never changes it.

### Platform admin

Platform `ADMIN` holds every capability with no membership, unless a capability sets
`platformAdmin: false`. The platform admin is also the only holder of a capability asked with no
resource (a template with no team, for example) and of platform-scoped capabilities.

### Deactivated teams

A deactivated team confers nothing through a role for a capability that requires an active team,
for organization authority as for team roles. Platform `ADMIN` is not stopped by it. A `read`
capability does not require an active team unless it says so.

## Asking

```ts
can(prisma, actor, capability, resource?)  // Promise<Decision>
heldScope(prisma, actor, capability)       // Promise<{ all, teamIds, orgIds }>
decide(standing, capability, resource?)    // Decision, with no database
```

- A **resource** names one thing, `{ teamId }` or `{ orgId }`, or several: `{ anyOf: [...] }` (the
  actor needs the capability on at least one, as for a lead of any owning team), `{ allOf: [...] }`
  (every one, as for a campaign over several repositories), or `{ anyTeam: true }` for a person-level
  question such as "leads at least one active team". With no resource, a team or organization
  capability is platform admin only. Empty sets are refused.
- A **decision** is `{ allowed: true, authority }` or `{ allowed: false, code, reason, missing }`,
  where `code` is `FORBIDDEN`. A person with no standing gets the same refusal whether the team
  exists or not, and is not told it is deactivated; platform admin passes on a team that does not
  exist so the handler can answer 404. A route that hides existence sets `hideAs404`, and both
  cases are then 404; each domain keeps the status it has always used.
- `heldScope` is what a list endpoint filters by, so a list and the action behind it cannot
  disagree. Platform admin gets `all: true` with no query; everyone else costs one membership query
  and, where an organization role can confer the capability, one organization-membership query and
  one lookup of those organizations' teams.
- A **service principal** is judged by its token scopes, never by `can()`: `can()` with a principal
  returns `FORBIDDEN`, and a route that declares `serviceScopes` and a capability fails at
  registration.
- The gateway caches a decision for the life of a request and never across requests. Memberships
  are read on each check.

### Reading your own permissions

`GET /api/v1/me/permissions[?teamId=]` returns the caller's effective permissions, derived from the
same standing and decision code as the checks above, so it cannot disagree with them. See
[teams](./teams.md#leaving-an-organization) for the shape. The in-app assistant may call it.

### Declaring a route

```ts
requireAuth()                                                      // any signed-in person
requireAuth({ capability: 'team.repos.manage', team: { param: 'id' } })
requireAuth({ capability: 'platform.users.manage' })
requireAuth({ handlerChecked: ['team.repos.manage'] })            // the handler calls can()
```

A capability check answers `403 FORBIDDEN` with `error.missing` naming the capability. A team
capability reads the team id from `team.param` (default `id`); an organization capability reads the
organization id from `org.param` (default `orgId`).

Every route's `config.authz` is one of `capability`, `handler-checked`, `service` (the route
declares `serviceScopes`), `authenticated` (a bare `requireAuth()`), `legacy` (the older role
options) or `public` (declared by the route). A `handler-checked` route that answers 2xx without
`can()` having run throws under test and logs `authz.unchecked` elsewhere. The route-walk test
`packages/gateway/src/routes/authzCoverage.test.ts` asserts every route's metadata and counts the
routes still on the older declaration against a ratchet that only goes down.

## Constraints

Some checks are not "may this role do this" but separation of duties or ownership: only the
launcher steers an orchestration, a template's author may not review their own change, nobody
removes or demotes themselves, a step assigned to named approvers is answered by one of them.
These are **constraints**, in `packages/shared/src/permissions/constraints.ts`: `notSelf`,
`isLauncher`, `notAuthor`, `isAssignee`. Domain code composes one with a capability:
`can(...)` and `constraint(...)`. Platform `ADMIN` does not satisfy a constraint, and a constraint
never widens access. The matrix lists each beside the capabilities it accompanies.

There is one documented exception, taken by the caller and not by a helper: a platform `ADMIN` may
review a generated template version they created themselves. A single-admin deployment could
otherwise never promote a generated version, and an administrator can already author an unreviewed
version. Any other author is refused with `SELF_REVIEW_FORBIDDEN`.

## Reach is not a capability

Which repositories a person reaches (team membership or a share, `canLaunch` on a share, the
GitHub permission gate), run visibility, budget gates, service-principal allowlists, MCP scopes and
the assistant policy are separate mechanisms with their own documents. Where one of them needs
"may lead", it asks the matching capability.

## Capability matrix

<!-- permissions:matrix:start -->

_Generated from `packages/shared/src/permissions/catalog/` by `scripts/gen-permissions-doc.mjs`. Do not edit between the markers._

### Platform

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `platform.agents.runtime.set` | platform | sensitive | — | — | yes | — | Change an agent's runtime. |
| `platform.audit.read` | platform | read | — | — | yes | — | Read the audit log, security events, activity, assistant diagnostics and platform transcript exports. |
| `platform.budgets.read-all` | platform | read | — | — | yes | — | Read budget alerts across every organization. |
| `platform.callbacks.private-network` | platform | sensitive | — | — | yes | — | Let a callback endpoint reach a private network address. |
| `platform.catalog.manage` | platform | governance | — | — | yes | — | Manage the model and tool catalogs, global skills and agents, autonomy policies, harness profiles, evals, readiness and outcome reports. |
| `platform.config.grants.manage` | platform | governance | — | — | yes | — | Create and remove settings grants. |
| `platform.integrations.manage` | platform | sensitive | — | — | yes | — | Configure GitHub credentials, webhook secrets and installations, system config, Slack install, MCP connections, package registries, marketplaces, skill sources and bundles. |
| `platform.lessons.stats` | platform | read | — | — | yes | — | Read platform-wide lesson statistics. |
| `platform.orgs.trust-invites.manage` | platform | governance | — | — | yes | — | Decide which email domains an organization trusts for invitations. |
| `platform.pr-evaluation.auto-mode` | platform | sensitive | — | — | yes | — | Set a repository's pull-request evaluation to auto mode, or enable bot approval. |
| `platform.repo-dependencies.scan` | platform | operation | — | — | yes | — | Start a repository dependency scan. |
| `platform.reports.read-all` | platform | read | — | — | yes | — | Read platform-wide usage and delivery reports, with approver identities unmasked. |
| `platform.repos.executor-image.probe` | platform | sensitive | — | — | yes | — | Probe a repository's executor image. |
| `platform.repos.installation.bind` | platform | sensitive | — | — | yes | — | Link an unverified GitHub installation to a repository, set the executor image build, and change a repository tool allowlist. |
| `platform.scanner.manage` | platform | sensitive | — | — | yes | — | Create, change and remove runtime scanner patterns. |
| `platform.sessions.manage` | platform | governance | — | — | yes | — | List and revoke access tokens and sessions. |
| `platform.shell-audit.prune` | platform | sensitive | — | — | yes | — | Prune the shell audit trail. |
| `platform.slack-channels.manage` | platform | governance | — | — | yes | — | Create and change Slack channels, erase a user, edit channel memory. |
| `platform.transcripts.retention.manage` | platform | sensitive | — | — | yes | — | Place and lift legal holds on runs and transcripts, and verify transcript integrity. |
| `platform.users.directory.read` | platform | read | LEAD | — | yes | yes | Look people up in the user directory. Held by a lead of any active team. |
| `platform.users.manage` | platform | governance | — | — | yes | — | Create users, change their platform role, activate or deactivate them. |

### Organization

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `org.baselines.manage` | org | governance | — | ADMIN | yes | — | Create and remove the organization's human-error baselines. |
| `org.baselines.read` | org | read | — | MEMBER | yes | — | Read the organization's human-error baselines. |
| `org.budget.manage` | org | governance | — | ADMIN | yes | — | Read the organization's spend in dollars and set its budget cap. |
| `org.digests.manage` | org | governance | — | ADMIN | yes | — | Manage report digests delivered at organization scope. |
| `org.github.manage` | org | governance | — | ADMIN | yes | — | Link, change and unlink the organization's GitHub App. |
| `org.knowledge.publish` | org | governance | — | ADMIN | yes | — | Publish knowledge at organization visibility and approve knowledge that has it. |
| `org.members.manage` | org | governance | — | ADMIN | yes | — | Add, invite, change the role of and remove organization members, including the team role an invitation carries. |
| `org.members.read` | org | read | — | MEMBER | yes | — | List the organization's members. |
| `org.read` | org | read | — | MEMBER | yes | — | See the organization, its detail and its budget alert level. |
| `org.reports.read` | org | read | — | ADMIN | yes | — | Read the organization's usage and delivery reports. |
| `org.settings.manage` | org | governance | — | ADMIN | yes | — | Change the organization's name and slug. |
| `org.teams.create` | org | governance | — | ADMIN | yes | — | Create a team in the organization, from either team-creation route. |

### Teams

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `team.agents.manage` | team | operation | ADMIN | — | yes | yes | Create and change a team's agents and agent versions. |
| `team.agents.read` | team | read | MEMBER | — | yes | no | List the agents a team may use. |
| `team.attention.manage` | team | operation | LEAD | — | yes | yes | Assign unowned failures to a member of the team. |
| `team.attention.read` | team | read | LEAD | — | yes | no | See what is waiting on the team: approvals, failures, budget requests. |
| `team.budget-requests.create` | team | operation | LEAD | — | yes | yes | Ask for more budget for a team. |
| `team.budget.manage` | team | governance | ADMIN | ADMIN | yes | yes | Set a team's budget cap and decide budget requests. |
| `team.budget.read` | team | read | MEMBER | ADMIN | yes | no | Read a team's budget and spend. |
| `team.callbacks.manage` | team | sensitive | LEAD | — | yes | yes | Create, change, rotate and delete a team's callback endpoints. |
| `team.callbacks.read` | team | read | MEMBER | — | yes | no | See a team's callback endpoints and their deliveries. |
| `team.credentials.manage` | team | sensitive | ADMIN | — | yes | yes | Manage a team's model provider credentials. |
| `team.delete` | team | governance | — | — | yes | yes | Delete a team. |
| `team.members.manage` | team | governance | LEAD | ADMIN | yes | yes | Invite, add, change the role of and remove team members, never above the actor’s own rank. |
| `team.members.read` | team | read | MEMBER | — | yes | no | List a team's members. |
| `team.persona.manage` | team | operation | LEAD | — | yes | yes | Set the prompt of a team's channel assistant, which can start runs. Organization admins do not hold it without a team role. |
| `team.plugins.manage` | team | operation | ADMIN | — | yes | yes | Enable and disable plugins for a team. |
| `team.plugins.read` | team | read | MEMBER | — | yes | no | See which plugins a team has enabled. |
| `team.read` | team | read | MEMBER | — | yes | no | See a team's detail. |
| `team.sandbox-policy.manage` | team | sensitive | — | — | yes | yes | Set a team's shell image allowlist and egress allowlist. Platform admin only. |
| `team.sandbox-policy.read` | team | read | MEMBER | — | yes | no | Read a team's shell image allowlist and egress allowlist. |
| `team.secrets.manage` | team | sensitive | ADMIN | — | yes | yes | Create, rotate and delete a team's secrets. |
| `team.service-principals.manage` | team | sensitive | LEAD | — | yes | yes | Create service principals and mint, rotate and revoke their tokens. |
| `team.settings.manage` | team | governance | LEAD | ADMIN | yes | yes | Change a team's name, description and settings. |
| `team.skills.assign` | team | operation | ADMIN | — | yes | yes | Assign skills to a team’s agents. |

### Repositories

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `org.repos.eval-dataset.link` | org | sensitive | — | ADMIN | yes | — | Link an organization-scope eval dataset to a repository's setup secrets, for a repository of the organization. |
| `team.repos.create` | team | governance | LEAD | ADMIN | yes | yes | Create a repository under a team. |
| `team.repos.deps.manage` | team | governance | LEAD | ADMIN | yes | yes | Create, delete and veto dependency edges between repositories. A new edge needs it on both teams, a deletion on either. |
| `team.repos.eval-link` | team | sensitive | ADMIN | — | yes | yes | Link a team-scope eval dataset to a repository. |
| `team.repos.gate-commands.author` | team | sensitive | ADMIN | — | yes | yes | Write a repository's gate commands, which run as code in the workspace. |
| `team.repos.manage` | team | governance | LEAD | ADMIN | yes | yes | Edit, share, deactivate and test access to a repository, and change its pull-request evaluation settings. |
| `team.repos.onboarding.launch` | team | sensitive | ADMIN | — | yes | yes | Start a repository onboarding run, which proposes gate commands and previews that run as code. Other onboarding routes need team.repos.manage. |

### Templates, knowledge and lessons

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `team.knowledge-bases.manage` | team | governance | LEAD | ADMIN | yes | yes | Attach, change and detach a repository's knowledge bases. |
| `team.knowledge.approve` | team | operation | LEAD | — | yes | yes | Approve knowledge for publication at team visibility. |
| `team.knowledge.manage` | team | operation | LEAD | — | yes | yes | Curate and manage a team's knowledge items. |
| `team.lessons.manage` | team | governance | LEAD | ADMIN | yes | yes | Edit, retire and review a repository's lessons. |
| `team.templates.generate` | team | operation | LEAD | — | yes | yes | Generate or refine a template from a description. |
| `team.templates.review` | team | operation | LEAD | — | yes | yes | Review and approve a change to a team template. The author may not review it. |
| `team.templates.shell.author` | team | sensitive | ADMIN | — | yes | yes | Put shell, container and gate-command steps in a team template. |
| `team.templates.write` | team | operation | LEAD | — | yes | yes | Create, change, publish and retire a team's workflow templates. |

### Runs and approvals

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `team.approvals.answer` | team | operation | MEMBER | — | yes | yes | Answer an approval, decision or input step of a team’s run. |
| `team.approvals.merge` | team | operation | LEAD | — | yes | yes | Approve the merge gate of a team’s run from Slack. Asked on the run’s owning teams; any one suffices. |
| `team.approvals.nudge` | team | operation | LEAD | — | yes | yes | Nudge an overdue approval step. |
| `team.launch` | team | operation | MEMBER | — | yes | yes | Start a run for a team. |
| `team.launch.as-lead` | team | operation | LEAD | — | yes | yes | Start a run attributed to a team the caller leads, as a schedule’s fire does for its own team. |
| `team.launch.multi-repo` | team | operation | LEAD | — | yes | yes | Start a campaign, epic or PRD run across repositories. Asked on every repository’s owning team. |
| `team.orchestrations.stop` | team | operation | — | — | yes | yes | Emergency-stop an orchestration that a service principal launched. Platform admin only. |
| `team.runs.control` | team | operation | MEMBER | — | yes | yes | Cancel or retry a team’s run. |

### Automations, reports and review

| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |
|---|---|---|---|---|---|---|---|
| `team.automations.manage` | team | operation | LEAD | — | yes | yes | Create, change and delete event automations. |
| `team.automations.read` | team | read | MEMBER | — | yes | no | See a team's automations and their decision ledger. |
| `team.codereview.manage` | team | operation | LEAD | — | yes | yes | Create and change a team's code review presets and attachments. |
| `team.codereview.read` | team | read | MEMBER | — | yes | no | See a team's code review presets and attachments. |
| `team.digests.manage` | team | governance | LEAD | ADMIN | yes | yes | Manage report digests delivered at team scope. |
| `team.event-endpoints.manage` | team | sensitive | LEAD | — | yes | yes | Create, rotate and delete a team's inbound event endpoints and their signing secrets. |
| `team.schedules.create` | team | operation | LEAD | — | yes | yes | Create a schedule on a repository. Asked on the owning team and on each team the repository is shared with. |
| `team.schedules.manage` | team | operation | LEAD | — | yes | yes | Change, pause and delete a schedule. Asked on the repository’s owning team and on the schedule’s own team. |
| `team.slack-channels.read` | team | read | MEMBER | — | yes | no | See a team's Slack channels. A private channel also needs Slack membership. |
| `team.usage.read` | team | read | LEAD | — | yes | no | Read a team's usage report. |

### Constraints

| Constraint | Applies beside | Rule |
|---|---|---|
| `notSelf` | `team.members.manage`, `org.members.manage`, `platform.users.manage` | Nobody removes or demotes themselves (`SELF_REMOVAL`, `SELF_DEMOTION`); nobody deactivates or demotes their own platform account. |
| `isLauncher` | `team.runs.control`, `team.orchestrations.stop` | Only the launcher steers an orchestration; an administrator may emergency-stop one only when a service principal launched it. |
| `notAuthor` | `team.templates.review` | A template’s author may not review their own change (`SELF_REVIEW_FORBIDDEN`). The one exception: a platform administrator may review a generated version they created, because a single-admin deployment could otherwise never promote one. |
| `isAssignee` | `team.approvals.answer` | A step assigned to named approvers is answered by one of them. |

<!-- permissions:matrix:end -->

`yarn docs:check` fails when the matrix differs from the catalog. Regenerate it with
`node scripts/gen-permissions-doc.mjs`.

## Limitations

- Capability checks are per request and read memberships each time; there is no cross-request
  cache beyond the existing user-state cache.
- An organization admin can obtain operation and sensitive powers by adding themselves to a team;
  the protection is visibility and audit, not prevention.
- Run visibility, repository reach and budgets are separate gates and are not capabilities.
- Settings writes are decided by the setting registry's write access and its grants, not by a
  capability. Run-plan, orchestration and agent-run ownership, transcript visibility, Slack
  identity linkage and personal access tokens are ownership or visibility rules and are not in the
  catalog.
- A route still declared with the older role options is counted by the route-walk ratchet and is
  decided by its own check, not by the catalog, until it is converted.
- `{ anyTeam: true }` reaches organization authority only where the organization has a team the
  capability's class and activity rule would let that authority act on.
- The resolver does not consult an organization's or a team's `isActive` beyond a capability's
  `requiresActiveTeam`. Organization deactivation is enforced by authentication (service tokens)
  and by launch gates, not by capabilities.
- The audit context's `authority` is the one decision of the route's own capability check. A
  `handler-checked` route's handler passes the authority of its decision to the audit writer
  itself; nothing records it for it.
