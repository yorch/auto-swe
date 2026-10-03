# Per-user GitHub credentials

By default the platform reaches GitHub with one credential an admin configures — a PAT or a GitHub
App, at `/studio/integrations`. A user can instead save **their own** GitHub token for a
repository, and runs they launch against that repository clone, push and open pull requests as
that token.

This is what lets a team work against GitHub or GitHub Enterprise repositories when no admin has
configured a platform credential for their host, and it attributes the pull requests a user's runs
open to that user.

The feature is off by default, and an admin decides both whether it is on and which hosts a token
may be sent to.

---

## 1. Whose token a run uses

A run resolves its credential in this order:

1. The token **the user who launched this execution** saved for the repository, when it is
   usable (see §3).
2. The platform credential **of the repository's host** — its GitHub App installation, or the PAT.
   A repository on the instance's own host uses the instance's credential; one on another approved
   host uses the credential an admin configured for that host (§6).
3. Neither: the run fails with a non-retryable configuration error.

**A saved token is used only for executions its owner launched.** Never for anyone else's run, and
never for a run nobody launched. This is the property the rest of this document exists to keep.

"Launched" means started *this execution*, which is not the same as having asked for the work:

| Launch path | Launched by |
|---|---|
| `POST /work-requests` | the caller |
| `POST /work-requests/:id/retry` | **the caller of the retry**, not the original requester |
| `POST /workflow-templates/:id/runs` | the caller |
| `POST /epics` | the caller; each per-repository child run inherits it |
| `POST /prd-runs` | the caller; each story the PRD becomes inherits it |
| Scheduled work requests — cron fire or `POST /scheduled-work-requests/:id/fire` | the schedule's author (below) |
| Slack — the `/auto-swe run` modal | the linked platform user who submitted it |
| Slack — a channel-assistant code task | the linked platform user who asked for it |
| Webhooks, the issue-tracker auto-trigger | nobody |

A run launched by nobody uses only the platform credential of the repository's host.

**A schedule runs as its author.** `ScheduledWorkRequest.actsAsUserId` is set to whoever creates
the schedule, and moves to whoever later changes what it does (its description or template), how
often it runs (its cron expression), what it may spend (its budget tier), or switches it back on.
Pausing and renaming leave it alone — neither can cause anything to run. Becoming the author is a
launch decision about the editor, taken by the repository access gate before anything is saved,
exactly as creating a schedule is. So a lead editing, reviving or speeding up another person's
schedule takes it over rather than borrowing their token, and the schedules page shows who each one
runs as. The launcher is stored in the Temporal schedule's own arguments, so a cron fire and a fire
by hand launch as the same person. Pressing **fire** follows the same rule as editing: whoever
causes a run is who it runs as. A firer who is not the current author is judged by the access gate
as themselves, becomes the author (recorded in the audit log), and the Temporal schedule is
re-synced to carry them before it is triggered. A paused schedule cannot be fired by hand: it is
refused with `409 SCHEDULE_INACTIVE` before anything changes, because the worker would refuse the
fire anyway. If the trigger fails, the row is reverted to the author first, only if it is still as
the takeover left it, and the Temporal schedule is then re-synced from the row as it stands (the
revert is recorded in the audit log); if Temporal cannot be brought back, it already holds the
firer, so the row keeps the firer too and that is recorded. The row writes are conditional on the
version read, so a fire that overlaps an edit or a deactivation is a `409 SCHEDULE_CONFLICT`. The author firing their own schedule changes nothing, and is judged as
themselves too. The schedules page asks for confirmation before a fire that would change the
author.

Each scheduled fire checks the Temporal arguments against the row before anything else: the
launcher in the arguments must be the row's author, the row must be active (`schedule-inactive`),
and the author must be an active user (`acting-user-missing`). A mismatch (a takeover or edit whose
Temporal restore failed) is refused with a non-retryable `launcher-out-of-sync` reason until the
schedule is saved again (an owning-team lead pausing it re-syncs it without taking it over;
resuming it makes the resumer the author), so a run never uses one person's token on the strength
of another's access. Schedules created before authors were recorded have none and run as
nobody until someone fires or edits them.

**Slack launches run as the linked platform user.** The request is signature-verified and the
account link names the platform user — the same identity the repository access gate judges on those
paths. A code task carries that user only when it targets a repository; a thread steer by someone
else does not change who the run acts as.

### How the launcher is recorded

The launch path puts the authenticated caller's id on the workflow's input (`launchedById`), and the
run's first activity writes it to `WorkflowRun.launchedById` together with Temporal's run id for
that execution (`WorkflowRun.temporalRunId`). Every later activity that needs a GitHub token reads
the launcher back from that row — and trusts it only when the row's `temporalRunId` is its own.

The run-id check matters because the row is keyed by workflow id and never rewritten, and Temporal
lets a workflow id be started again once its earlier execution closes. A later execution that
lands on an earlier execution's row finds a run id that is not its own, and so gets no user
credential rather than the earlier launcher's.

It is deliberately not `RunInput.requestedById`. A re-run reuses the original request, so reading
the requester would let anyone who can re-run someone's work act as them.

---

## 2. Configuration

Two settings, both `ADMIN`-only and deployment-wide, at `/govern/platform-settings`:

| Setting | Default | Meaning |
|---|---|---|
| `github.userCredentialsEnabled` | `false` | Whether saved tokens may be used. Off, every saved token is inert — kept, so turning it back on needs no re-entry. Users can still remove theirs. |
| `github.userCredentialHosts` | `github.com` | Hosts a token may be sent to, as `host` or `host:port`. Both the repository's web URL and its API URL must be listed. `github.com` also covers `api.github.com`. |

The host list is how an admin permits a GitHub Enterprise server, including one on a private
network: listing it by name is the same explicit opt-in the tracker and knowledge-base connectors
require for a private address. Matching is exact — no wildcards and no suffix matching — and only
over HTTPS, and only for a URL already in canonical form. The list is returned to platform admins
only; it can name internal hosts, and a user refused at save time is told which of their
repository's own URLs was refused.

A repository's URLs must also be on an approved host for any credential to reach them — see
[repositories.md](./repositories.md) for `github.repositoryHosts`.

---

## 3. When a saved token is usable

A token is used only when all of these hold at the moment it is needed:

- `github.userCredentialsEnabled` is on;
- its owner is active, and still a member of the repository's team or of a team it is shared with
  (platform `ADMIN`s pass this, as they do every repository check);
- both of the repository's current URLs — web and API — are on `github.userCredentialHosts`;
- both URLs still have the origins the token was verified against when it was saved.

The last condition binds a token to where its owner confirmed it. A team lead can repoint a
repository's `githubUrl` or `githubApiUrl`; when that happens, saved tokens stop being used rather
than following the repository to a new host, and their owners save them again.

When any condition fails, the run falls back to the platform credential of the repository's host. It
never falls back to another user's token.

A token that passes every check but **cannot be decrypted** — written under a key version the
process no longer holds — is different: the run fails at once with a non-retryable
`CREDENTIAL_UNREADABLE` error telling its owner to save it again. It neither retries a condition
that cannot clear by itself nor quietly switches the run to the platform's identity.

---

## 4. Saving a token

From the dashboard: **Connections** → a repository → **My token**. Over the API:

| Route | Who | Does |
|---|---|---|
| `GET /api/v1/repositories/credentials/mine` | any signed-in user | The policy, and which repositories the caller has saved a token for. Never returns a token. |
| `PUT /api/v1/repositories/:id/credential` | a member of the repository's team, or of a team it is shared with | Save or replace the caller's token |
| `DELETE /api/v1/repositories/:id/credential` | the token's owner | Remove it — allowed with the feature off, and after leaving the team |

Every route acts on the caller's own token. There is no route that reads, lists or removes
another user's token, `ADMIN` included; deleting the user or the repository removes it.

Saving is refused unless the feature is on, the repository is an active `git_repo`, both of its
hosts are allowed, and GitHub confirms the token's owner has **write** access to the repository —
runs push a branch and open a pull request, so a read-only token would only fail later. The token
is checked with `GET /repos/{owner}/{repo}` and its `permissions`.

The token is stored AES-256-GCM encrypted (`connection_credentials`), is covered by
`yarn keys:rotate`, and only its last four characters are ever returned. Saves and removals are
written to the governance audit log as `ConnectionCredential`, without the token.

The narrowest token that works is a fine-grained token scoped to the one repository with
**Contents** and **Pull requests** write access.

---

## 5. Repository access gating

When [repository access gating](./repo-access-gating.md) is on, a launch whose run acts as the
caller — the paths in §1 that record a launcher — judges a caller with a usable saved token by that
token: GitHub is asked what the token's owner may do with the repository, rather than what the
stored GitHub login may do. That is the identity the run acts as, it needs no linked GitHub
account, and it works on a GitHub Enterprise host whose usernames the github.com login does not
name.

Creating a schedule, the Slack run modal and a channel-assistant code task all launch as the
caller, and so does firing a schedule by hand, which first makes the firer its author. One decision
is not: a Slack thread steer acts on a run someone else launched — so the person steering is judged
by their login, whatever they saved. Judging them by their own token would refuse for a token the
run never touches, or admit someone on an identity the run does not act as.

The scheduled sweep and the webhook refresh prefer the token where one is usable, and fall back to
the login-based lookup where it is not. A token GitHub rejects, or that
cannot see the repository, refuses a launch with `user-credential-rejected` rather than retrying
against the login: the run would use that token and fail the same way. Saving a token records the
verification answer in `repo_access` like any other lookup.

---

## 6. Platform credentials for other hosts

A platform credential belongs to one GitHub host family and is sent there and nowhere else: the
instance's PAT and App to the instance's own host, and never to another host. A host
family is a hosted GitHub's web and API names taken together (`github.com` with `api.github.com`,
`<tenant>.ghe.com` with `api.<tenant>.ghe.com`); a GitHub Enterprise Server's web and API share one
hostname.

For any other approved host (`github.repositoryHosts`, see [repositories.md](./repositories.md)) an
admin can record that host's own credentials at `/studio/integrations` → GitHub → **Per-host
credentials**: a PAT, a GitHub App (id and private key), or both. A repository on that host then
resolves its platform credential exactly as an instance repository does — an installation token for
the repository's own installation when it has one and the App is configured, otherwise the PAT —
minted at that host's API with that host's App. A saved user token still wins for runs its owner
launched.

| Repository | Platform credential used |
|---|---|
| On the instance's host (no overrides, or overrides naming it) | The instance's PAT or App |
| On another host with credentials configured for it | That host's PAT or App |
| On another host with none, or whose approval has lapsed | None: runs fail with `REPO_CREDENTIAL_HOST_MISMATCH`; only a user's saved token reaches it |
| Web and API overrides on different hosts | None, not even a user's token: `REPO_HOST_MISCONFIGURED` |

A host's credential set contains nothing of the instance's: a host with only an App does not borrow
the instance's PAT, and the instance's singleton installation id is never used there. The App
installation a repository uses on a host is an installation recorded for that host (see
[github-app-setup.md](./github-app-setup.md)); an installation recorded for another host is refused
when it is chosen.

Rules the API enforces, ADMIN-only: the host must be approved and must not be the instance's own
(those credentials are the GitHub integration's); an App needs its id and private key together; a
row cannot be left with no credential (delete it instead). Secrets are encrypted like every other
credential, covered by `yarn keys:rotate`, and only last-fours are ever returned; every change is
written to the audit log as `GitHubHostCredential`, without secrets.

Credentials are allowed for a data-residency tenant (`<tenant>.ghe.com`) that is not the instance.
A webhook secret is not: those hosts send no `X-GitHub-Enterprise-Host` header and always sign with
the instance secret, so the per-host webhook secret table refuses them.

---

## Limitations

- **Webhook and issue-tracker runs never use a saved token.** They carry no platform user to act
  for. Against a repository on a host with no platform credential (§6), those runs fail with a
  configuration error.
- **A schedule runs as its author for as long as it exists.** Its author leaving the team or being
  deactivated makes every fire refuse with `acting-user-missing`; it does not fall back to the
  platform credential. The schedule keeps that author recorded until an admin or team lead edits
  or re-activates it, which takes it over. Schedules created before
  authors were recorded run as nobody until then.
- **Overlapping changes to a schedule resolve by retry, except one case.** Writes are
  compare-and-set on the row's `version`. An edit that loses to a fire-by-hand takeover is retried
  internally (three attempts, the decision and the launch check taken again on the re-read row);
  an edit that loses to anything else, and a fire by hand or a deactivation that loses to any
  overlapping write, gets `409 SCHEDULE_CONFLICT` and repeats it (a fire by hand of a paused
  schedule is `409 SCHEDULE_INACTIVE` instead: resume it first). Temporal is re-synced
  from the row on a best-effort basis, and the out-of-sync refusal above is what stops a fire if
  that re-sync also fails.
- **A Slack launch is only as trustworthy as the account link.** Whoever controls the linked Slack
  account launches as the platform user it is linked to, including with their saved token.
- **Other people can steer a run that acts as you.** A human step, a review comment fed to the
  review fixer, or a Slack thread steer can be answered by anyone the existing rules allow, and the
  run keeps acting with its launcher's token. This is the same exposure the platform credential
  always had; a personal token usually reaches more repositories than the one being worked on, so
  scope it to this one.
- **The access check reads the owner's role, not the token's scopes.** GitHub reports a
  fine-grained token's owner as `admin` even when the token itself can only read, so such a token
  passes both the save check and the access gate and then fails when the run pushes.
- **Webhooks still use the platform's secret.** The `signal` CI wait strategy needs GitHub to
  deliver webhooks signed with the platform's webhook secret, which a user cannot configure on a
  repository they connected themselves. A deployment whose repositories are reached through user
  tokens sets the CI wait strategy to `poll` at `/govern/workflow-defaults`; it is deployment-wide,
  not per repository.
- **A user outside the owning team and every shared team cannot save a token for it.** Getting
  access is a matter of the owning team sharing the repository with theirs — see
  [repositories.md](./repositories.md).
- **Runs in flight keep their identity.** Removing a token, or turning the feature off, takes
  effect on the next GitHub call; a call already made is not undone, and a pull request already
  opened stays attributed to the token's owner.
- **CI logs are fetched with the credential of the repository's host.** A user token is sent only
  to the repository's own web and API origins, and the platform credential only to the origins of
  its host's own credential set; a log URL anywhere else gets no token at all.
- **One credential set per host.** A host has one PAT and one App; two Apps on the same host, or a
  different PAT per organization, are not expressible. An App's installations are per host, and
  which one a repository uses is chosen per repository.
- **Credentials follow the approval.** A host removed from `github.repositoryHosts` keeps its row
  but is inert until it is approved again, and the host's repositories then fail like any other
  host with none.
