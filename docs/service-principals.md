# Service principals

A service principal is a team-owned machine identity: a CI pipeline, a release tool or another
internal service that starts runs and follows them with a token of its own, instead of borrowing a
person's personal access token or an anonymous template webhook.

What separates a principal from a person's token:

- **It belongs to a team, not a person.** It keeps working when the person who set it up leaves, and
  its runs are attributed to it, not to whoever minted the token.
- **It can do only what its lists name.** Each principal carries an explicit allowlist of
  repositories and of workflow templates. An empty list allows nothing.
- **Its tokens are scoped.** A token carries one or more of three scopes, and a route accepts it only
  when the route has opted in and the token holds the scopes that route asks for.
- **Its runs use the platform credential.** A principal has no GitHub login, so its runs never act as
  a person and never use anyone's saved GitHub token.

## 1. Calling the API with a service token

A service token looks like a personal access token (`ats_` and 43 characters) and is sent the same
way:

```bash
curl -X POST "$AUTO_SWE_URL/api/v1/agent-runs" \
  -H "Authorization: Bearer $AUTO_SWE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: release-2026.10.14' \
  -d '{"agent":"implementer","prompt":"Bump the version to 2.4.0","repoId":"<connection-uuid>","deliver":"draft_pr"}'
```

The routes a service token can reach, and the scope each needs:

| Route | Scope | What it does for a principal |
|---|---|---|
| `POST /api/v1/agent-runs` | `runs:launch` | Starts an [agent run](./agent-runs.md) on a repository on the principal's allowlist |
| `POST /api/v1/workflow-templates/:id/runs` | `runs:launch` | Starts a run of a template on the principal's allowlist; a `connectionId` in the payload must be on its repository allowlist |
| `GET /api/v1/workflow-runs` | `runs:read` | Lists the runs this principal started, and no others, whatever `scope` asks for |
| `GET /api/v1/workflow-runs/:id` | `runs:read` | Reads one of them |
| `POST /api/v1/workflow-runs/:id/cancel` | `runs:cancel` | Cancels one of them |

Every other route answers a service token with `401 SERVICE_TOKEN_NOT_ALLOWED`, including the MCP
endpoint, which accepts only its own OAuth tokens. A route that has opted in but whose scope the token
lacks answers `403 INSUFFICIENT_SCOPE`.

An `Idempotency-Key` works as it does for a person: a retry with the same key answers
`409 RUN_CONFLICT` instead of starting a second run. The key is scoped to the principal, so it can
neither collide with a person's key nor reveal through a `409` that someone else used it.

## 2. Authentication

`requireAuth` resolves an `ats_` token by its SHA-256 hash in `api_tokens`, the one table for both kinds
of token. A row has exactly one owner, a user or a service principal; a CHECK constraint
(`api_tokens_exactly_one_owner`) holds that.

A service token is refused with `401` when it is revoked or expired, when its principal is disabled,
or when the principal's team or that team's organization is inactive. It never becomes
`request.user`: the gateway sets a separate `request.principal`, so a handler that reads the user
cannot take a machine for a person. Whether the route accepts it is decided centrally, in the same
hook, from the route's own declaration:

```ts
app.post('/', {
  config: { serviceScopes: ['runs:launch'] },
  onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  // …
}, handler);
```

A route without `serviceScopes` is closed to service tokens, so a new route stays closed until
someone decides otherwise. A route that requires a team or organization role refuses a principal
outright, since it holds no role. A person's token ignores scopes entirely and keeps acting with its
user's role.

## 3. What a launch checks

A principal's launch goes through the same handler, and the same checks, as a person's, with the
person-specific steps swapped for the principal's own:

| Check | A person | A service principal |
|---|---|---|
| Repository reach | Member of the owning team or a team it is shared with | Repository on the principal's allowlist, and owned by or shared with the principal's team |
| GitHub permission (the [access gate](./repo-access-gating.md)) | Judged on the person's login or saved token | Not judged at launch: it was judged when a lead put the repository on the list (section 4) |
| Organization membership | Required | Not applicable |
| Organization monthly cap | Applies | Applies |
| Template | Visible to the person | On the principal's template allowlist, and global or the principal's team's own |
| Retired installation, repository host allowlist, agent-run ceilings and concurrency | Apply | Apply |
| Own limits | — | At most `maxRunsPerDay` runs requested in any 24 hours, and `maxInFlight` runs not yet finished |

The principal's own checks run inside the transaction that writes the run's ledger rows, under a lock
on the principal's row. Two launches by one principal are therefore counted one after the other, and
an edit to its allowlists or limits lands either before a launch reads them or after it commits. A
refusal there writes nothing and starts nothing: `403 SERVICE_PRINCIPAL_DISABLED`,
`403 SERVICE_CONNECTION_NOT_ALLOWED`, `403 SERVICE_TEMPLATE_NOT_ALLOWED`,
`429 SERVICE_DAILY_LIMIT_REACHED` or `429 SERVICE_IN_FLIGHT_LIMIT_REACHED`. A template not on the
allowlist answers `404`, as a template that does not exist does.

## 4. Granting: a launch decision by a lead

Putting a repository on a principal's allowlist is a launch decision, taken by the lead making the
change, the same one saving an [event automation](./automations.md#managing-event-automations) takes.
The repository must be active and owned by or shared with the principal's team, and `authorizeLaunch`
must admit the lead with the platform run identity: repository membership, the access gate on the
lead's own GitHub login, membership of the repository's organization and its monthly cap. A refusal is
sent as it would be for the lead's own launch. Only what a change **adds** is decided; taking a
repository off is always allowed.

A template may go on the list when it is global or the principal's team's own, not archived, and one a
person may run by hand. Platform-started templates (the agent-run template, the Channel Assistant)
cannot.

## 5. Attribution and visibility

A principal's run records it in `RunInput.requestedByServiceId`; `requestedById` and `launchedById` are
null, which is what makes the worker use the platform credential. The run is visible to, and may be
cancelled and steered by, the members of the principal's team, wherever the repository is, as a
person controls a run they launched. The principal itself reads and cancels only the runs it started.

## 6. Managing principals and tokens

On the dashboard, a team's page (**Govern → Teams → the team**) has a **Service principals** card for
those who may manage the team: create, edit the lists and limits, disable and enable, delete, and
manage tokens.

| Route | Purpose |
|---|---|
| `GET` / `POST /api/v1/teams/:teamId/service-principals` | List, create |
| `GET` / `PATCH` / `DELETE /api/v1/teams/:teamId/service-principals/:id` | Read, update (`name`, `description`, `maxRunsPerDay`, `maxInFlight`, `connectionIds`, `templateIds`, `disabled`), delete |
| `GET` / `POST /api/v1/teams/:teamId/service-principals/:id/tokens` | List tokens (prefix, scopes, expiry, last use), mint one |
| `DELETE /api/v1/teams/:teamId/service-principals/:id/tokens/:tokenId` | Revoke a token |

Every route needs a platform ADMIN, or a platform LEAD who is LEAD or ADMIN on the team — the bar the
team's members and settings have. Names are unique within a team. Limits are positive:
`maxRunsPerDay` 1–10,000 (default 50) and `maxInFlight` 1–100 (default 5); disabling is the switch for
"none".

A token is minted with a name, at least one scope (`runs:launch`, `runs:read`, `runs:cancel`) and an
expiry of 1 to 365 days; a service token without an expiry cannot be minted. The plaintext appears in
the mint response once and is never stored. A principal holds at most two live tokens at a time, so a
replacement can be rolled out before the old one is revoked; a third answers
`409 SERVICE_TOKEN_LIMIT_REACHED`. Deleting a principal deletes its tokens; its runs keep running and
lose their attribution.

Platform admins also see service tokens on **Govern → API tokens**, with their principal and team, and
may revoke them there.

Every change is written to the audit log: entity `ServicePrincipal` for the principal (allowlists and
limits before and after) and `ServiceToken` for a token (prefix, scopes, expiry, revocation; never the
plaintext or the hash). A cancel by a principal is audited under `WorkflowRun` with no user actor and
the principal's id in the record.

## Limitations

- **A grant is decided once.** The lead's launch decision is taken when a repository goes on the list.
  If the lead later loses access to the repository, or the access gate would now refuse them, the
  grant stands until someone edits the list; launches still require the repository to be reachable by
  the principal's team and the organization to be under its cap.
- **A run with no connection on a global template spends no organization's cap**, exactly as for a
  person: the run has no repository or template team to charge, so only the principal's own limits
  bound it.
- **The daily limit counts requests, not finished runs.** A run that is refused later (by the
  worker's concurrency admission, say) still counts against the principal's 24 hours.
- **Deleting a principal loses attribution.** Its runs remain, with `requestedByServiceId` cleared,
  and are then visible only through the repository, template or channel terms of run visibility. To
  stop a principal while keeping its history, disable it.
- **Only the run routes accept service tokens.** A principal cannot submit a work request, an epic or
  a PRD run, re-run an agent run, read traces through `/workflow-runs/:id/traces`, or call the MCP
  endpoint.
- **The CLI does not manage principals.** Principals and their tokens are managed from the dashboard
  or the REST API.
