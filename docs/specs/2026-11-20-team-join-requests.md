# Team directory, join requests and self-service teams

Status: approved direction.

## 1. Problem

A new user lands on the default team and can reach no other team unless someone who manages it adds
or invites them. A user cannot see which teams exist, ask to join one, or create one. Team creation is
limited to organization and platform admins.

## 2. Goals

1. Every signed-in user can list the teams on the platform (name, description, organization, size).
2. A user can ask to join a team; the team's leads and admins accept or reject.
3. A request that crosses organizations needs a second decision from an admin of the team's organization.
4. An operator can let users create teams in an organization they belong to.

Non-goals: changing repository reach, budgets, or what a team member may do; notification channels
beyond the app (the requester sees status in the app; reviewers see counts and a queue).

## 3. Decisions

| Question | Decision |
|---|---|
| Who sees the directory | Every signed-in user. `teams.directoryScope` (`platform` default, or `organization`) narrows it to the teams of organizations the viewer belongs to. GLOBAL scope only. |
| Where a request may go | Any active team the viewer can see in the directory. |
| Who decides a same-organization request | A holder of `team.members.manage` for that team: team `LEAD`/`ADMIN`, organization `ADMIN`, platform `ADMIN`. One decision. |
| Who decides a cross-organization request | Two decisions. The team step as above; then a holder of `org.members.manage` for the team's organization approves the organization membership. |
| Role granted | `MEMBER` unless the team approver names a `role`, which may not exceed the approver's own rank (the hierarchy rule of member-add). |
| Team creation | Off by default. `teams.selfServiceCreation` (boolean; GLOBAL and ORGANIZATION scope, platform `ADMIN` writes) lets any member of that organization create a team in it. The creator becomes team `ADMIN`. `teams.maxCreatedPerUser` (default 3) bounds how many teams one user has created. |

## 4. Data model

`TeamJoinRequest` (`team_join_requests`):

| Field | Notes |
|---|---|
| `id` | uuid |
| `teamId`, `userId` | FKs, `onDelete: Cascade` |
| `message` | text, at most 500 characters, default empty |
| `status` | enum `JoinRequestStatus`: `PENDING_TEAM`, `PENDING_ORG`, `APPROVED`, `REJECTED`, `WITHDRAWN` |
| `requiresOrgApproval` | boolean, set at creation: the requester is not a member of the team's organization |
| `grantedRole` | `TeamRole?`, set by the team approver (default `MEMBER`) |
| `teamDecidedById`, `teamDecidedAt`, `teamDecisionNote` | the team step; users FK `SetNull` |
| `orgDecidedById`, `orgDecidedAt`, `orgDecisionNote` | the organization step |
| `createdAt`, `updatedAt` | |

A partial unique index on `(user_id, team_id)` where `status IN ('PENDING_TEAM','PENDING_ORG')` allows one
open request per user and team. It is hand-written DDL in the migration (the Prisma DSL cannot express it).
`Team` gains `createdById String?` (FK to users, `SetNull`, no backfill); self-service creation sets it.

Transitions: `PENDING_TEAM` → `APPROVED` (same organization) or `PENDING_ORG` (cross-organization) or
`REJECTED` or `WITHDRAWN`; `PENDING_ORG` → `APPROVED` or `REJECTED` or `WITHDRAWN`. Terminal states do not
change. A decision is a conditional update on the expected status, so two reviewers cannot both win.

## 5. Settings (registry)

| Key | Type / default | Scopes | Write |
|---|---|---|---|
| `teams.directoryScope` | `platform` \| `organization`, `platform` | GLOBAL | admin |
| `teams.selfServiceCreation` | boolean, `false` | GLOBAL, ORGANIZATION | admin |
| `teams.maxCreatedPerUser` | int 1–100, `3` | GLOBAL, ORGANIZATION | admin |
| `teams.maxOpenJoinRequests` | int 1–50, `5` | GLOBAL | admin |
| `teams.joinRequestCooldownHours` | int 0–720, `72` | GLOBAL | admin |

None is run-pinned.

## 6. Capabilities

New: `platform.team-directory.read` (read; every signed-in user) and `team.join-requests.create` (operation;
any signed-in user who is not a member and can see the team). Deciding reuses `team.members.manage` (team
step) and `org.members.manage` (organization step) so the people who decide are the people who already manage
membership. Self-service creation is `org.teams.create` OR (`teams.selfServiceCreation` resolved for the
organization AND the caller is a member of it). The capability catalog tests, the generated permission
documentation and the web client capability list stay consistent.

## 7. API

All under `/api/v1`, authenticated. Errors use the gateway's `sendError` codes.

| Route | Purpose |
|---|---|
| `GET /teams/directory?q=&orgId=&limit=&cursor=` | `{ teams: [{ id, name, slug, description, orgId, orgName, memberCount, relationship: 'MEMBER' \| 'REQUESTED' \| 'NONE', requestId? }], creatableOrgs: [{ id, name }], scope, nextCursor }`. Active teams only, public fields only. `creatableOrgs` lists organizations where the caller may create a team now. Registered before `/teams/:id`. |
| `POST /teams/:id/join-requests` `{ message? }` | Create. `404 TEAM_NOT_FOUND` for an unknown, inactive or out-of-scope team; `409 ALREADY_MEMBER`; `409 REQUEST_PENDING`; `429 JOIN_REQUEST_COOLDOWN` (after a rejection, `teams.joinRequestCooldownHours`); `429 TOO_MANY_OPEN_REQUESTS`. |
| `GET /me/join-requests` | The caller's requests, newest first, with team and organization names. |
| `POST /me/join-requests/:requestId/withdraw` | Withdraw an open request of one's own. |
| `GET /teams/:id/join-requests?status=` | The team's requests (`team.members.manage`). |
| `POST /teams/:id/join-requests/:requestId/approve` `{ role?, note? }` | Team step. Same organization: creates the team membership (audited, one transaction). Cross-organization: moves to `PENDING_ORG`. |
| `POST /teams/:id/join-requests/:requestId/reject` `{ note? }` | Team step rejection. |
| `GET /platform/organizations/:orgId/join-requests?status=` (also under the admin prefix) | Requests awaiting the organization step (`org.members.manage`). |
| `POST /platform/organizations/:orgId/join-requests/:requestId/approve` `{ note? }` and `.../reject` | Organization step. Approve creates the organization `MEMBER` membership and the team membership in one audited transaction. |
| `POST /platform/organizations/:orgId/teams` (existing) | Authorization widens per §6; sets `createdById`; enforces `teams.maxCreatedPerUser` (`409 TEAM_LIMIT_REACHED`). |

A team's overview carries `pendingJoinRequests` (a count) for callers who hold `team.members.manage`.

Writes take the organization row lock before the team's (the order every membership write uses), re-read
the requester's organization membership under it, write `ConfigAuditLog` rows (`entityType` `TeamJoinRequest`,
`TeamMembership`, `OrganizationMembership`) and refuse a requester who is no longer active. Approving a
request whose requester is already a member completes it without creating a duplicate.

Assistant policy: directory and own-list are `read`; create and withdraw are `confirm`; every decision route is `never`.

## 8. Web

- A **Directory** view of all visible teams with search, a relationship badge and **Request to join**
  (message dialog). Reached from the teams navigation for every user.
- **Create team** in the directory, shown only when `creatableOrgs` is non-empty; the dialog picks one of those
  organizations.
- A **My requests** list with status, decision notes and **Withdraw**.
- A **Requests** panel on the team space's Members tab for reviewers, with approve (optional role), reject
  (optional note) and the pending count on the tab.
- An **Approvals** panel on the organization detail page for the organization step.
- The settings above appear in `/admin/platform-settings` through the registry with no bespoke form.

## 9. Documentation and upgrade

`docs/teams.md` describes the flow, with its gaps under `## Limitations`; `docs/configuration.md` and
`docs/permissions.md` stay consistent with the registry and catalog. `docs/upgrade-notes.md` gains an entry:
deployments that keep teams private to an organization set `teams.directoryScope` to `organization`, because
the default now lists every team to every signed-in user. The CLI gains `teams directory`, `teams request`,
`teams requests`, `teams requests approve|reject` and `teams requests withdraw`.

## Limitations

- Only the app shows a request's status; there is no email or Slack notification.
- `teams.directoryScope` is deployment-wide, not per organization.
- A request asks for a team, not a role; the approver chooses the role.
