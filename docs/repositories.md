# Repositories: identity, hosts and sharing

A repository is a `Connection` with `type = 'git_repo'`. This document covers what identifies one,
which hosts its URLs may point at, and which teams may use it.

---

## 1. Identity

A repository is identified by **(host, owner, name)**. `acme/api` on github.com and `acme/api` on a
GitHub Enterprise server are different repositories, and both can be onboarded.

The host is the repository's web base override, `githubUrl`. Null means the instance's own GitHub
host — the web URL configured on the GitHub integration — which is what nearly every repository
uses. The identity is enforced by a partial, expression-based unique index,
`connections_git_repo_host_org_repo_uidx` on `(COALESCE(github_url, ''), organization_name,
repo_name) WHERE type = 'git_repo'`, in a hand-written migration because Prisma cannot express it.

Everything that names a repository by owner and name takes the host into account:

| Where | How |
|---|---|
| Onboarding (`POST /repositories`) | the duplicate check and the unique index include the host |
| Import from GitHub | the list comes from the instance host, so only repositories with no override count as already imported |
| PR and CI webhooks, the access webhook | when the owner/name is onboarded on more than one host, the payload's `repository.html_url` picks which; otherwise the match is by name, as before |
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
it, else the one shared team they lead (several, and none named, is a `400`). A schedule with no
team, from before the column existed, belongs to the owning team. Editing, firing or deleting one
takes a platform admin, a lead of the schedule's team, or a lead of the repository's owning team,
which keeps authority over every schedule on its repository; a shared team's lead cannot touch
another team's schedules. Budgets, the default template and settings stay the owning team's.

When a team stops having a claim on the repository (its share is removed, or the repository moves
to another team), its schedules on it are deactivated in the same request: the row is marked
inactive and the Temporal schedule is paused. They stay listed, and a lead of the owning team may
delete them or re-activate them, which makes the re-activating lead the author.

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
- **Webhooks still use one secret.** A payload from any host is verified against the platform's
  webhook secret, and matched by host only when it carries `repository.html_url`.
- **App installations are not host-scoped.** A GitHub App installation id is unique across the
  deployment, so two hosts cannot use the same numeric installation id.
- **Owner and name are case-sensitive in the unique index.** GitHub treats them case-insensitively;
  onboarding `Acme/API` and `acme/api` on the same host creates two repositories.
- **An override spelling out the instance host is only cleared when the GitHub integration stores
  that host.** On a deployment configuring its host through the environment such an override is
  kept; it works, and onboarding treats it as the same repository as one with no override, but the
  database's unique index does not, so two onboarding requests racing each other could create both.
- **Some runs can only be controlled by a platform admin.** A run on a global template, against no
  repository, that nobody launched (a webhook start, or one from before launchers were recorded) is
  visible to everyone but can be cancelled, or its human steps answered, only by an admin.
- **The team page lists owned repositories only.** Repositories shared with a team appear in its
  members' Connections page and listings, not on the team's own page.
