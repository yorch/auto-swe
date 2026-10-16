# Service principals

A service principal is a team-owned machine identity: a CI pipeline, a release tool or another
internal service that starts runs and follows them with a token of its own, instead of borrowing a
person's personal access token or an anonymous template webhook.

What separates a principal from a person's token:

- **It belongs to a team, not a person.** It keeps working when the person who set it up leaves, and
  its runs are attributed to it, not to whoever minted the token.
- **It can do only what its lists name.** Each principal carries an explicit allowlist of
  repositories and of workflow templates. An empty list allows nothing.
- **Its tokens are scoped.** A token carries one or more of four scopes, and a route accepts it only
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
| `POST /api/v1/agent-runs` | `runs:agent` | Starts an [agent run](./agent-runs.md) on a repository on the principal's allowlist |
| `POST /api/v1/workflow-templates/:id/runs` | `runs:launch` | Starts a run of a template on the principal's allowlist; a `connectionId` in the payload must be on its repository allowlist |
| `GET /api/v1/workflow-runs` | `runs:read` | Lists the runs this principal started, and no others, whatever `scope` asks for |
| `GET /api/v1/workflow-runs/:id` | `runs:read` | Reads one of them: status, steps with their inputs and outputs, the run's context and result. `includeTraces` and `fullTraces` answer `403 TRACES_NOT_AVAILABLE` |
| `POST /api/v1/workflow-runs/:id/cancel` | `runs:cancel` | Cancels one of them |

`runs:agent` is a scope of its own because an agent run takes a free-form prompt and an agent of
the caller's choosing (the implementer has a shell), so a repository grant with it lets the principal
do anything an agent can on that repository. `runs:launch` starts only the templates on the
principal's template list. Grant `runs:agent` only to a caller trusted with that.

Every other route answers a service token with `401 SERVICE_TOKEN_NOT_ALLOWED`, including the MCP
endpoint, which accepts only its own OAuth tokens. A route that has opted in but whose scope the token
lacks answers `403 INSUFFICIENT_SCOPE`.

An `Idempotency-Key` works as it does for a person: a retry with the same key answers
`409 RUN_CONFLICT` instead of starting a second run. The key is scoped to the principal, so it can
neither collide with a person's key nor reveal through a `409` that someone else used it. The scope
is the principal's whole id, so no two principals share one.

## 2. Authentication

`requireAuth` resolves an `ats_` token by its SHA-256 hash in `api_tokens`, the one table for both kinds
of token. A row has exactly one owner, a user or a service principal; a CHECK constraint
(`api_tokens_exactly_one_owner`) holds that.

A service token is refused with `401` when it is revoked or expired, when its principal is disabled,
or when the principal's team or that team's organization is inactive. It never becomes
`request.user`: the gateway sets a separate `request.principal`, so a handler that reads the user
cannot take a machine for a person. Whether the route accepts it is decided centrally, in the same
hook, from the route's own declaration (a route that opts in behind a platform role above ENGINEER,
or any team or organization role, is refused at registration, since a principal holds no role):

```ts
app.post('/', {
  config: { serviceScopes: ['runs:launch'] },
  onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
  // …
}, handler);
```

A route without `serviceScopes` is closed to service tokens, so a new route stays closed until
someone decides otherwise. A person's token ignores scopes entirely and keeps acting with its
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
| Organization cap of a run with no repository | The template team's org, which the run is billed to | The template team's org and the principal's own team's org; the run is billed to the principal's own team's org |
| Own limits | — | At most `maxRunsPerDay` runs requested in any 24 hours, and `maxInFlight` runs not yet finished |

A run with no connection is billed to the organization of the principal's own team. A principal
launches only global templates and its own team's, so that is the template team's organization
whenever the template has a team. The request records it (`RunInput.billingOrgId`), so the run is
billed to it at finalization, counts toward its in-flight spend and is capped mid-run against it,
like a run on a repository. A person who re-runs such a run is gated against that same organization,
so they must be a member of the principal's team's organization.

A connection that is not on the principal's list answers `404 CONNECTION_NOT_FOUND`, the answer a
connection that does not exist gets, before anything is looked up, so a principal cannot probe which
connection ids exist.

The principal's own checks run inside the transaction that writes the run's ledger rows, under a lock
on the principal's row. Two launches by one principal are therefore counted one after the other, and
an edit to its allowlists or limits lands either before a launch reads them or after it commits. The
repository is re-read there too, under its own row lock: it must still be active and owned by or
shared with the principal's team, so a share removed since the grant ends the grant's effect. A
refusal there writes nothing and starts nothing: `403 SERVICE_PRINCIPAL_DISABLED`,
`403 SERVICE_CONNECTION_NOT_ALLOWED`, `403 SERVICE_TEMPLATE_NOT_ALLOWED`,
`429 SERVICE_DAILY_LIMIT_REACHED` or `429 SERVICE_IN_FLIGHT_LIMIT_REACHED`. A template not on the
allowlist answers `404`, as a template that does not exist does.

### Reporting the outcome

A principal's launch (`runs:launch` or `runs:agent`) may carry a `callback`, as a person's may
([run-callbacks.md](./run-callbacks.md)), and it is resolved against the **principal's own team's**
callback endpoints only — never another team's, whatever teams the principal's repositories are
shared with. Every delivery names the principal in `launchedBy`
(`{ "kind": "service_principal", "id": "<principal id>" }`, plus `templateId` for a template run).

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
null, which is what makes the worker use the platform credential.

Who else sees it follows the run's repository, exactly as for a person's run: a run on a repository is
visible to those who reach the repository (owning or shared team, under the [access
gate](./repo-access-gating.md)) and controlled — cancelled, its human steps answered — by the owning
team. Having a machine launch it changes neither. Only a run that names no repository, which no
repository rule can reach, is visible to and controlled by the members of the principal's team. The
principal itself reads and cancels only the runs it started.

## 6. Managing principals and tokens

On the dashboard, a team's page (**Admin → Teams → the team**) has a **Service principals** card for
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

A token is minted with a name, at least one scope (`runs:launch`, `runs:agent`, `runs:read`,
`runs:cancel`) and an
expiry of 1 to 365 days; a service token without an expiry cannot be minted. The plaintext appears in
the mint response once and is never stored. A principal holds at most two live tokens at a time, so a
replacement can be rolled out before the old one is revoked; a third answers
`409 SERVICE_TOKEN_LIMIT_REACHED`.

Deleting a principal is refused (`409 SERVICE_PRINCIPAL_HAS_RUNS`) while any run it started is still
in flight: disable it to stop new launches, and delete it once its runs finish. Deleting deletes its
tokens; its finished runs keep their history but lose their attribution.

Platform admins also see service tokens on **Admin → API tokens**, with their principal and team, and
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
- **The daily limit counts requests, not finished runs.** A run that is refused later (by the
  worker's concurrency admission, say) still counts against the principal's 24 hours.
- **Deleting a principal loses attribution.** Its finished runs remain, with `requestedByServiceId`
  cleared, and are then visible only through the repository, template or channel terms of run
  visibility. To stop a principal while keeping its history, disable it.
- **Disabling is not a reset.** Tokens can be minted and revoked while a principal is disabled (so a
  replacement is ready before it is re-enabled), and re-enabling it takes no new decision about its
  allowlists: the grants made before it was disabled apply again as they were.
- **A principal's team does not control its runs on a shared repository.** On a repository the team
  has only through a share, the owning team controls the run; the principal can still cancel it with
  `runs:cancel`.
- **Only the run routes accept service tokens.** A principal cannot submit a work request, an epic or
  a PRD run, re-run an agent run, read a run's traces (through `/workflow-runs/:id/traces` or
  `includeTraces`), or call the MCP endpoint.
- **Only traces are withheld.** A principal reads its own runs' step inputs and outputs and the
  run's context, which can hold diffs and text the run fetched from the tracker or knowledge base
  with platform credentials. The traces (every prompt and tool call) are what it cannot read.
- **A run that is never finalized blocks deleting its principal.** Deletion is refused while the
  principal has a run in flight, and a run whose workflow ended without updating its row counts as in
  flight until the run reaper finalizes it. Disabling the principal still works meanwhile.
- **The CLI does not manage principals.** Principals and their tokens are managed from the dashboard
  or the REST API.
