# Repositories: identity, hosts and sharing

A repository is a `Connection` with `type = 'git_repo'`. This document covers what identifies one,
which hosts its URLs may point at, and which teams may use it.

---

## 1. Identity

A repository is identified by **(host, owner, name)**, with owner and name compared
case-insensitively as GitHub does: `Acme/API` and `acme/api` on one host are the same repository.
`acme/api` on github.com and `acme/api` on a
GitHub Enterprise server are different repositories, and both can be onboarded.

The host is the repository's web base override, `githubUrl`. Null means the instance's own GitHub
host — the web URL configured on the GitHub integration — which is what nearly every repository
uses. The identity is enforced by a partial, expression-based unique index,
`connections_git_repo_host_org_repo_ci_uidx` on `(COALESCE(github_url, ''),
lower(organization_name), lower(repo_name)) WHERE type = 'git_repo'`, in a hand-written migration because Prisma cannot express it.

Everything that names a repository by owner and name takes the host into account:

| Where | How |
|---|---|
| Onboarding (`POST /repositories`) | the duplicate check and the unique index include the host and compare owner and name case-insensitively |
| Import from GitHub | the list comes from the instance host, so only repositories with no override count as already imported |
| PR and CI webhooks, the access webhook | the delivery is first bound to the host its secret proved (see [Webhook secrets per host](#webhook-secrets-per-host)). Within that, when the owner/name is onboarded on more than one distinct host, the payload's `repository.html_url` picks which; otherwise the match is by name, as before. Owner and name match case-insensitively and literally (`_` and `%` in a name are not wildcards), whatever casing the payload uses |
| Workflow ids | a repository with a `githubUrl` override gets the host in its id (`eng-<host>-<owner>-<name>-<ticket>`); one on the instance host keeps `eng-<owner>-<name>-<ticket>`. A run still in flight under the id without a host blocks a new one, as one under the new id does |
| Dependency detection | a dependency URL that names a host matches only a repository on that host |
| Dependency checkouts | two neighbours with the same owner/name get distinct directories |

---

## 2. URL overrides and approved hosts

`githubUrl` and `githubApiUrl` are **base** URLs. The clone is `<githubUrl>/<owner>/<name>.git` and
the API is `<githubApiUrl>/repos/<owner>/<name>`. They exist for a repository on a different GitHub
host than the instance's.

Every GitHub credential — the platform's App or PAT, and a user's own token — is sent to a
repository's own bases. A team lead can set those, so an unchecked override would let a lead point a
repository at a host they control and collect the platform's token on the next run. Overrides are
therefore restricted:

| Setting | Default | Meaning |
|---|---|---|
| `github.repositoryHosts` | empty | Hosts, as `host` or `host:port`, that a repository override may point at beyond the instance's own web and API hosts. `ADMIN`-only and deployment-wide; its value is shown to admins only, because it can name internal servers. |

An override must be a canonical HTTPS URL on the instance's own hosts or on that list. The check runs
in two places:

- **When a repository is created or edited**, for every role, `ADMIN` included — an admin adding a
  new host lists it first. The web base must be an origin (no path), the API base must not be a
  repository's API URL, and both are normalised for storage: the web base to its origin, the API
  base without a trailing slash, and either one equal to the instance's own host to null.
- **Before any credential is sent**, so a repository already pointing somewhere unapproved gets
  nothing. A run fails with a non-retryable `REPO_HOST_NOT_ALLOWED` error naming the setting; a
  permission lookup reports that it could not ask, never that access is denied.

A repository with no overrides is never checked, so the common case costs nothing.

### Webhook secrets per host

The GitHub integration holds one webhook secret. Each GitHub Enterprise Server host configures its
own webhooks, so each can have its own secret (`GitHubHostWebhookSecret`, managed by platform admins
at `/studio/integrations → GitHub` or under `/api/v1/platform/github-webhook-secrets`). The host
must be the integration's own host or listed in `github.repositoryHosts`; a secret for any other
host is refused.

GitHub Enterprise Server names the sending host in `X-GitHub-Enterprise-Host`. For every
`/webhooks/git`, `/webhooks/ci` and `/webhooks/access` delivery:

- If the header names a host that has a secret, the signature is verified with that secret **only**.
  A payload signed with the instance secret is rejected.
- If the header is absent, or names a host with no secret, the instance secret is used.
- A matched secret whose host is no longer approved verifies nothing: the delivery is refused with
  `401`, never handed to the instance secret. Rotating such a secret is refused too, with
  `HOST_NOT_APPROVED`.

GitHub documents the header as a hostname. It is compared lowercase and matches the row for exactly
that `host[:port]` first; failing that, the one row whose hostname is the header's, whatever its
port. A hostname shared by several rows with no exact match matches none of them.

A secret proves who sent a delivery, not which repository it may act on, so the verified host is
carried into the lookup that finds the repository:

- **A per-host secret** confines the delivery to repositories on that host: those whose web base
  (`githubUrl`) has that `host[:port]`, or, when it is the instance's own host, those with no
  override. This holds whether or not the owner/name is ambiguous. A payload whose
  `repository.html_url` names a different host is ignored, so a host's secret cannot sign a payload
  about a repository on another host.
- **The instance secret** reaches no repository on a host that has a secret of its own: those hosts
  are verified with theirs alone. Elsewhere the host is consulted only when the owner/name is
  ambiguous, as above.

This applies to `/webhooks/git`, `/webhooks/ci` and `/webhooks/access`; a user-wide access event
(membership or organization) names no repository, and is confined the same way. Secrets are
encrypted at rest like every other credential, are write-only (the API returns the last four
characters), and are re-encrypted by key rotation.

### CI status lookups

When a check run succeeds, the gateway asks GitHub for the other check runs on the commit before
signalling the workflow. That request goes to the tracked repository's own API base, with a token
for the repository's own installation. The instance's credentials stay on the instance's own API
host: a repository with no installation of its own would take the instance's installation, which
lives on the instance's host, so on another host it is sent no token; the instance PAT is likewise
never sent to another host. A user's token is never used, since no user launched a webhook. A
repository whose overrides fail the approved-host check, or that has no credential valid on its
host, is sent none, and its run is signalled per check run instead.

The same commit can be tracked on repositories on different hosts (a mirror, or the same name on
two hosts). Matched pull requests are grouped by repository and each group is aggregated on its own
host with its own credential, so one host's checks never decide another's verdict. A group whose
checks are still running keeps waiting while the others are signalled.

### Importing from GitHub

Importing lists repositories from the instance's own host and onboards them with no override. The
repository-level URLs a GitHub listing returns are not base URLs; stored as overrides they made every
clone and API call land on a path that does not exist.

---

## 3. Sharing with other teams

A repository belongs to one team, which manages it. It can also be **shared** with further teams in
the same organization (`ConnectionTeamShare`).

| | Owning team | Shared team |
|---|---|---|
| See the repository, its runs, lessons and dependencies | yes | yes |
| Start runs (work requests, template runs, epics, PRDs, Slack) | yes | yes |
| Cancel a run, or answer a human step on it | yes | only runs they launched |
| Save a personal GitHub token for it | yes | yes |
| Be a channel-assistant code task's repository, by name | yes | yes, unless the team owns one by that name |
| Be a channel-assistant code task's repository by default (no name given) | if it is the team's only repository | never |
| Edit, deactivate or move the repository | lead | no |
| Change who it is shared with | lead | no |
| Create a schedule | lead | lead |
| Edit, fire or delete a schedule | any schedule on the repository (lead) | the team's own schedules only (lead) |
| Add or confirm dependency edges | lead | no |

Runs keep the owning team's budget, default template and settings, whoever launches them.

**Schedules.** A `ScheduledWorkRequest` belongs to a team (`teamId`): the repository's owning team or
a team it is shared with. A lead of either may create one; the body's optional `teamId` must be the
owning team or a shared team the caller leads. Omitted, it is the owning team if the caller leads
it, else the one shared team they lead (several, and none named, is a `400`). Editing, firing or
deleting one takes a platform admin, a lead of the schedule's team, or a lead of the repository's
owning team, which keeps authority over every schedule on its repository; a shared team's lead
cannot touch another team's schedules. Budgets, the default template and settings stay the owning
team's. A schedule whose `teamId` is null (its team was deleted; the migration gave every earlier
schedule its repository's owning team) is managed only by a platform admin or a lead of the owning
team, and is deactivated like a schedule of a team that lost its claim.

When a team stops having a claim on the repository (its share is removed, or the repository moves
to another team), its schedules on it are deactivated after the change commits, and the change is
audited first: the row is marked inactive and the Temporal schedule is paused. Each schedule is
handled on its own, and a failure on one is logged and never fails the request. The worker also
refuses to fire a schedule whose row is inactive, so a pause that did not reach Temporal still
stops it. They stay listed, and a lead of the owning team may delete them or re-activate them,
which makes the re-activating lead the author.

Writes to a schedule row are conditional on the state the request read. An edit, a fire by hand
and a deactivation that overlap are not merged: the loser answers `409 SCHEDULE_CONFLICT` and the
Temporal schedule is re-synced from the row as it then stands.

A team never asks to receive a share, so a shared repository never changes what that team's own
repositories resolve to: a code task names it to reach it, and a name the team also owns resolves to
the team's own.

Every membership test — listings (`reachableConnections`), the launch decision
(`decideRepoAccess`), the personal-token resolver, the permission sweep and the webhook refresh —
accepts a member of the owning team or of any shared team. The definition lives in one place,
`@auto-swe/shared/lib/repoMembership`. Controlling a run is narrower: cancelling one, answering its
human steps, and the Slack **approve merge** and **retry CI** buttons go through
`buildWorkflowRunControlFilter`, which reaches repositories through the owning team only, plus runs
on a template the caller's team owns and runs the caller launched. Unlike visibility, running on a
global built-in template grants no control.

Sharing is managed from the repository card on the **Connections** page, or over the API:

| Route | Who | Does |
|---|---|---|
| `GET /api/v1/repositories/:id/share-candidates` | the owning team's leads, platform admins | Active teams in the owning team's organization, other than the owner |
| `PUT /api/v1/repositories/:id/shares` | the owning team's leads, platform admins | Replace the set of teams it is shared with; audited |

Shares are limited to the owning team's organization, so a repository never crosses a tenant
boundary this way. Moving a repository to a team in another organization drops the shares that no
longer fit.

---

## Limitations

- **Overrides must be base URLs on one host each.** A GitHub Enterprise server served under a path
  prefix rather than at the root of its host cannot be expressed: the web base is stored as an
  origin.
- **Only GitHub Enterprise Server hosts can have their own webhook secret.** The choice of secret
  keys on the `X-GitHub-Enterprise-Host` header (see below), which github.com does not send, so
  github.com deliveries always use the instance secret. Outside the binding a per-host secret
  provides, a payload is matched to a repository by host only when it carries
  `repository.html_url` and the owner/name is onboarded on more than one host.
- **App installations are not host-scoped.** A GitHub App installation id is unique across the
  deployment, so two hosts cannot use the same numeric installation id.
- **Existing case-only duplicates keep the case-sensitive index.** The migration that makes the
  unique index case-insensitive does not fail on a deployment that already holds two repositories
  differing only by case; it raises a `WARNING` that `prisma migrate deploy` does not show, and
  leaves the previous, case-sensitive index in place. The gateway checks for the new index at
  startup and, when it is missing, logs a warning that names each duplicate group and gives the SQL
  to create the index once they are resolved. Onboarding still refuses new case-variants through its
  case-insensitive duplicate check, but two onboarding requests racing each other are not stopped by
  the database until the duplicates are merged or deleted and the case-insensitive index is created
  by hand.
- **Workflow ids keep the stored casing.** The id embeds owner and name as stored, so the same
  repository onboarded under two casings (possible only through the case above) gets different ids.
- **An override spelling out the instance host is only cleared when the GitHub integration stores
  that host.** On a deployment configuring its host through the environment such an override is
  kept; it works, and onboarding treats it as the same repository as one with no override, but the
  database's unique index does not, so two onboarding requests racing each other could create both.
- **Some runs can only be controlled by a platform admin.** A run on a global template, against no
  repository, that nobody launched (a webhook start, or one from before launchers were recorded) is
  visible to everyone but can be cancelled, or its human steps answered, only by an admin.
- **The team page lists owned repositories only.** Repositories shared with a team appear in its
  members' Connections page and listings, not on the team's own page.
