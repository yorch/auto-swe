# Closing the known gaps of capability permissions

Follow-up to `2026-11-18-capability-permissions.md`. Three gaps were listed when that work merged.
This records what each one actually is on the current code and the rule that closes it.

## A. An organization admin cannot open a team they are not on

**What is true today.** `GET /api/v1/teams` already lists the teams an organization admin
administers (`repositoryManagementTeams`), unless the caller passes `member=true`. Two things stop
them going further:

1. `GET /api/v1/teams/:id/overview` answers `404 TEAM_NOT_FOUND` to anyone who is neither a member
   nor a platform admin (`buildTeamOverview`, `lib/teamOverview.ts`).
2. The dashboard resolves a team slug (`/teams/<slug>`, `?team=<slug>`) only through the caller's
   member teams, or the full list for a platform admin (`app/teams/[slug]/layout.tsx`,
   `hooks/useTeamParam.ts`), so an organization admin who is not a member gets "not found".

**Rule.** An organization `ADMIN` of the team's organization may open that team's overview and
space without being a member, under the same terms as `team.read` (a governance-and-read capability
the organization `ADMIN` already holds). They get a **governance view**, not the team's work:

- `viewerLevel` is `admin`, `team.myRole` is `null`, and the overview carries
  `team.access`: `'member'`, `'org-admin'` or `'platform-admin'` (new, always present).
- Run visibility is a separate gate and is unchanged. The sections that read runs (`needsYou`,
  `mine`, `running`, `queued`, `last7d`, `activity`, `pullRequests`) are computed with the caller's
  own visibility filter, so for a non-member organization admin they are empty or partial, exactly
  as they are for any person who cannot reach that team's repositories. Nothing here widens what
  runs a person may see. A platform admin's view is unchanged.
- The sections that are governance (`team`, `repos` the caller may reach, `budget` as percent,
  `lead`/`admin` blocks the server already withholds by level, `needsAdmin`, `pendingJoinRequests`,
  the setup checklist) are returned.
- A plain organization `MEMBER`, and anyone in another organization, still gets the same 404 as an
  unknown team. The refusal never differs between "exists" and "does not exist".
- The dashboard resolves a slug through the member teams first and then through the full visible
  list (`GET /api/v1/teams`) for **everyone**, not only platform admins. The team switcher gains an
  **Administered** group, below the member teams, for teams the caller administers but is not on.
  A non-member sees a notice that they are viewing as an organization admin and not a member, and
  that adding themselves is an audited step done from the Members tab.

## B. A role grant covers exactly one role

**What is true today.** A settings grant whose grantee is a team role is matched by equality
(`shared/src/config/permissions.ts`), so a grant to `LEAD` does not cover the team's `ADMIN`s, who
outrank leads and hold everything a lead holds.

**Rule.** A team-role grant covers that role **and every role above it** in the grant's own team
(`MEMBER < LEAD < ADMIN`), using the one rank function in `permissions/standing.ts`. A grant to
`MEMBER` covers every member of the team; a grant to `ADMIN` covers team admins only. The grant stays
valid only at `TEAM` scope. This widens who a stored grant covers; it is listed in the upgrade note.
The grants page says "this role or above".

## C. Legacy role spellings in the resolver

**What is true today.** `permissions/standing.ts` accepts the pre-split spellings (`ENGINEER`, the
platform `LEAD`, `ORG_ADMIN`, `ORG_MEMBER`) so that role strings persisted in earlier workflow inputs
(`sourceAuthorization.actor.role`) keep resolving.

**Rule.** The shim stays only if something still reads a persisted role string to make an
authorization decision. The review of the role split found that the gateway and the worker re-read
the person's role from the database and use the persisted actor only for its `sub`. If a trace of
every reader confirms that, the shim is deleted: an unrecognised role string resolves to no
standing, never to a privileged one, and the synthesized run-plan actor carries the platform role
`USER`. If any reader does depend on the string, the shim stays, its readers are listed beside it,
and no behaviour changes.

## Documentation

`docs/permissions.md` Limitations and `docs/teams.md` describe the system as it is. A limitation that
no longer holds is removed, not rewritten as history. `docs/upgrade-notes.md` gets one entry per
behaviour change an operator can notice (B for sure).
