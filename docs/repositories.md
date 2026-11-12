# Repositories: identity, hosts and sharing

A repository is a `Connection` with `type = 'git_repo'`. This document covers what identifies one,
which hosts its URLs may point at, and which teams may use it.

Repository settings also accept an optional `previewConfig` JSON recipe for UI validation, overriding
the repository's `.auto-swe/preview.yml`. Only
`git_repo` connections can store one, and changing it takes the same team shell-authoring role as
changing gate commands; see [UI validation](./ui-validation.md) for its schema and runtime behavior.
Preview sessions need a browser in the repository's executor image: `defaults/Dockerfile.node-browser`
is that image, and a repository without one fails the `uiVerify` step rather than passing it.

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
| Import from GitHub | lists active installations and the default credential; imported identity includes the host as well as owner/name |
| PR and CI webhooks, the access webhook | the delivery is first bound to the host its secret proved (see [Webhook secrets per host](#webhook-secrets-per-host)). Within that, when the owner/name is onboarded on more than one distinct host, the payload's `repository.html_url` picks which; otherwise the match is by name, as before. Owner and name match case-insensitively and literally (`_` and `%` in a name are not wildcards), whatever casing the payload uses |
| Workflow ids | a repository with a `githubUrl` override gets the host in its id (`eng-<host>-<owner>-<name>-<ticket>`); one on the instance host keeps `eng-<owner>-<name>-<ticket>`. Owner and name are lowercased in the id; the ticket id keeps its casing. A run still in flight under an earlier form of the id (stored casing, or without the host) blocks a new one, as one under the current id does. So does a run of another row for the same repository — the same host (no override is the instance's host) and the same owner and name compared case-insensitively; a repository on another host with the same owner and name is a different repository and never blocks |
| Dependency detection | a dependency URL that names a host matches only a repository on that host |
| Dependency checkouts | two neighbours with the same owner/name get distinct directories |

---

## 2. URL overrides and approved hosts

`githubUrl` and `githubApiUrl` are **base** URLs. The clone is `<githubUrl>/<owner>/<name>.git` and
the API is `<githubApiUrl>/repos/<owner>/<name>`. They exist for a repository on a different GitHub
host than the instance's.

A user's own token is bound to the origins it was verified on. A **platform credential** — a PAT,
any App installation token, or an App JWT (which can mint a token for every installation of the
App) — belongs to one GitHub host family and goes nowhere else. There are two credential sets: the
instance's (the GitHub integration, valid on the instance's own host) and, for any other approved
host, the credentials an admin recorded for that host (see
[Per-host credentials](#per-host-credentials)). A repository is reached with the set of the host it
lives on, whatever installation it records: an App and all its installations live on one host, so an
installation cannot exist on another, and an App JWT posted to a foreign host would be replayable
against the real one. One rule (`@auto-swe/shared/lib/githubHostScope`, resolved to a credential set
by `@auto-swe/shared/lib/githubHostCredential`) decides this for the worker, the gateway's check-run
lookup and the shared permission lookup, and `resolveGitHubToken` enforces its API-host half as a
last line against the host family the set carries (`credentialHost`), so even a caller that forgot to ask cannot send
a platform credential, or post an App JWT, to a host it does not belong to. A repository on another
host with no credentials recorded for it is reachable only with a user's own saved token; without one
it is refused with a non-retryable `REPO_CREDENTIAL_HOST_MISMATCH` (add credentials for the host, or,
if the instance's own credential belongs to that host, set the GitHub integration's web and API URLs
to it). A permission lookup reports `host-mismatch` rather than a transient failure, and a launch
under the access gate is refused with the `host-mismatch` reason, which names the same remedies
instead of suggesting a retry.

**The web base and the API base must be on the same host.** github.com with api.github.com, and
`<tenant>.ghe.com` with `api.<tenant>.ghe.com`, are each one host; a GitHub Enterprise Server keeps
both on one hostname. A web base on one host with an API base on another (a "half override", or one
override set and the other left to the instance) would have a token minted for one host sent to the
other — embedded in a clone URL, or sent as a bearer — so the repository API refuses it with
`REPO_HOST_MISMATCH` (a PATCH is judged against the stored value of the field it does not set), and at
run time such a repository fails with `REPO_HOST_MISCONFIGURED` on every path that would use a
credential, a user's own token included. An existing half-override repository therefore stops
working until both URLs are set to the same host. A team
lead can set the overrides, so an unchecked one would let a lead point a repository at a host they
control and collect a token on the next run. Overrides are therefore restricted:

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

At startup the gateway warns, listing them (the first 20 and the total), when active repositories sit
on a host with no platform credential: another host than the instance's that has none recorded, or a
half override. Each entry names the error its runs will hit. When many repositories share one foreign
host, either add credentials for it (Admin → Integrations → GitHub → Per-host credentials) or, if the
instance's credential belongs to that host, correct the instance's own web and API URLs.

### Per-host credentials

An admin records the platform credentials of a host other than the instance's at
`/admin/integrations → GitHub → Per-host credentials`, or under
`/api/v1/platform/github-host-credentials` (ADMIN-only): a PAT, a GitHub App (id and private key), or
both. The host is the lowercase `host[:port]` of its family (`github.com`, `ghe.corp`,
`<tenant>.ghe.com`); it must be approved (the GitHub integration's own hosts or
`github.repositoryHosts`) and not the instance's own. A repository on that host then resolves its
platform credential as an instance repository does: an installation token for its own installation
where it has one and the App is configured, otherwise the PAT — minted at that host's API with that
host's App. A saved user token still wins for runs its owner launched. A host's set carries nothing of
the instance's. Secrets are encrypted, write-only (last four characters returned), re-encrypted by key
rotation, and every change is audited as `GitHubHostCredential`. Credentials stay in effect only while
the host is approved. See [user-github-credentials.md](./user-github-credentials.md) §6.

An App installation belongs to one host (`GitHubInstallation.host`: empty for the instance's own). The
same numeric id on two hosts is two installations, the pair being unique. Choosing an installation for
a repository (an admin action) is refused unless it is recorded for the repository's host, and
repointing a repository to another host is refused while it points at an installation of the old one.

### Webhook secrets per host

The GitHub integration holds one webhook secret. Each GitHub Enterprise Server host configures its
own webhooks, so each can have its own secret (`GitHubHostWebhookSecret`, managed by platform admins
at `/admin/integrations → GitHub` or under `/api/v1/platform/github-webhook-secrets`). The host
must be the integration's own host or listed in `github.repositoryHosts`; a secret for any other
host is refused. So is one for `github.com`, `api.github.com`, or a GitHub Enterprise Cloud
data-residency host (`<tenant>.ghe.com`, `api.<tenant>.ghe.com`) (`HOST_SENDS_NO_HEADER`): they send
no header, so such a row could never be selected. A legacy row for them is ignored when scoping
deliveries and the gateway warns about it at startup.

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

A delivery without an `X-Hub-Signature-256` of the form `sha256=` and 64 lowercase hex digits is
refused with `401` before any secret is looked up, because the sender, and the host header it
names, is not yet authenticated. The row lookup for a host header is remembered for a few seconds
(a bounded set of hosts; a failed lookup is never remembered) and dropped whenever an admin
creates, rotates or deletes a secret, so a rotated-out secret stops verifying at once on the
gateway that took the change and within those seconds on any other replica.

A secret proves who sent a delivery, not which repository it may act on, so the verified host is
carried into the lookup that finds the repository:

- **A per-host secret** confines the delivery to repositories on that host: those whose web base
  (`githubUrl`) has that `host[:port]`, or, when it is the instance's own host, those with no
  override. This holds whether or not the owner/name is ambiguous. A payload whose
  `repository.html_url` names a different host is ignored, so a host's secret cannot sign a payload
  about a repository on another host.
- **The instance secret** reaches no repository on a host that has a secret of its own: those hosts
  are verified with theirs alone, so an instance-secret delivery whose `repository.html_url` names
  such a host is ignored. Elsewhere the host is consulted only when the owner/name is
  ambiguous, as above.

This applies to `/webhooks/git`, `/webhooks/ci` and `/webhooks/access`; a user-wide access event
(membership or organization) names no repository, and is confined the same way. Secrets are
encrypted at rest like every other credential, are write-only (the API returns the last four
characters), and are re-encrypted by key rotation.

### CI status lookups

When a check run succeeds, the gateway asks GitHub for the other check runs on the commit before
signalling the workflow. That request goes to the repository's own API base, with a token from the
platform credential set of its host: for the repository's own installation where it has one, else
the singleton's (the instance's set only; a host's set has no singleton installation, so it uses its
PAT). A platform credential stays on its own host's API: the instance's is never sent to another
host, and a host's is sent to no other. A user's token is never used, since no user launched a
webhook. A repository whose overrides fail the approved-host check, whose host has no platform
credential, or whose web and API bases are on different hosts, is sent none and gets no aggregation,
and its run is signalled per check run instead.

The same commit can be tracked on more than one repository (a mirror, or the same name on two
hosts). Matched pull requests are grouped by repository and each group is aggregated on its own
with its own credential, so one repository's checks never decide another's verdict. A group whose
checks are still running keeps waiting while the others are signalled.

### Importing from GitHub

Connections → **Import from GitHub** lists repositories from every active registered GitHub App
installation, including other approved GitHub hosts, plus the instance's default PAT or singleton
App installation. Installation entries take precedence when sources overlap. Each row identifies
its installation account; a source that cannot be listed shows an error without hiding other sources.
Already-imported identity includes the host, with case-insensitive owner and repository names.

Select up to 50 repositories and one team, then import the batch. Imported rows are disabled;
**Access unchecked** rows remain selectable because the server checks access again at creation.
The result view shows created repositories and individual failures without rolling back successes.
`POST /repositories/import` verifies each chosen installation against its repository listing and
sets the installation and host base URL overrides server-side. Manually choosing an installation
on the ordinary create or edit endpoint remains restricted to platform admins.

For non-admins, discovery first tries the caller's linked GitHub sign-in token on its own host.
A complete App-user-token installation listing is authoritative; other token-visible repositories
are positive evidence only. Remaining repositories use the caller's verified GitHub login and
platform-credential read-permission lookups. Known unreadable repositories are omitted. Platform
admins see every listed repository without filtering.

### Who may onboard

Onboarding (`POST /repositories` and `POST /repositories/import`) requires a platform ADMIN,
LEAD or ADMIN membership in the active target team, or ORG_ADMIN membership in that team's
organization. The caller's platform role need not be LEAD. These roles also govern editing,
moving and sharing connections; moving requires permission in both the owning and target teams.
GitHub discovery (`GET /repositories/github/available`) requires a platform ADMIN or permission
to manage repositories in at least one active team.

A caller who is not a platform ADMIN must also be able to **read the repository on
GitHub themselves**: once the row exists, the team's members can launch runs that clone and push
with the platform's credential, so a lead naming any `owner/name` that credential can see would
otherwise give their team a repository nobody on it can open. The check is made live on every
onboarding, whatever [`repoAccess.mode`](./repo-access-gating.md) is set to, and it is made again
when a non-admin moves a repository to another host with a URL override (`PATCH`), because the same
owner and name on another host is another repository.

The caller's GitHub identity is their recorded GitHub login (`users.github_login`, captured when a
GitHub account is linked by signing in with GitHub), verified to still belong to them — the identity
the launch gate asks about. GitHub is asked with the platform credential for the repository's host,
under the same host rules as every other lookup. The refusals:

| Code | Status | When |
|---|---|---|
| `GITHUB_ACCESS_UNVERIFIED` | 403 | the caller has no linked GitHub login; GitHub reports no access for them, the repository does not exist, or the platform credential cannot see it (one answer for all three, so the refusal reveals nothing about which private repositories exist); or no platform credential applies to the repository's host |
| `GITHUB_UNAVAILABLE` | 503 | GitHub could not be asked (outage, rate limit, a database error); it is not taken as a yes |

The access check runs before the duplicate check, so a refused caller does not learn whether the
repository is already onboarded.

### Testing a repository's access

`POST /repositories/:id/test-access` (the **Test access** action on a connection's row, or
`auto-swe repos test-access <org/name>`) answers what a run on the repository could do, in order:
the repository's URLs are on an approved host; the platform credential for its host exists and
GitHub issues a token for it; that credential can see the repository and, where the credential
reports a permission level, can push (a read-only credential cannot open the pull request a run
ends with); and the default branch exists. When the caller saved their own token for the
repository ([`user-github-credentials.md`](./user-github-credentials.md)), the same checks run with
it, because that token is the identity their runs act as. The answer is always `200` with
`{ ok, detail, checks[], durationMs }`; a failing step is a check, not an error, and the wording is
fixed per status class.

Only a platform ADMIN, a lead of the owning team or its organization's ORG_ADMIN may ask, the rule that governs editing the
repository. The check is about a repository that is already connected, so it cannot be used to
find which private repositories the platform credential can see.

### Gate commands

A repository can give each gate step its own command (`Connection.gateCommands`): `runLint`,
`runTypecheck`, `runTests`, `runBuild`, `runVulnScan` and `runPerfBench`. A gate step that sets no
`command` of its own resolves each key from the connection override, then `.auto-swe/gates.yml`,
then the detected stack default, then the worker's built-in default. A connection override for
`runTests` does not hide a file's `runLint`. The implementer's test loop reads `runTests` from the
connection, then the file, then its stack/package-script detection. Overrides are edited in the connection form's **Gate commands**
section (when onboarding or editing), with `POST /repositories` / `PATCH /repositories/:id`
`{ gateCommands }` — a PATCH replaces the stored set; a gate left out, null or blank falls back to
the next source, and `null` clears them all — or with the CLI's `auto-swe repos gate-commands`.

The file uses the same command validation as the connection (4,000 characters per command);
unknown keys are errors. Null or blank entries fall through to the next source.

```yaml
runTests: make test
runLint: make lint
runBuild: make build
```

Repository gate and preview files are read from trusted base-branch content, never the agent-editable
working tree. Provisioning captures an immutable base commit SHA before setup or agents run;
workspace consumers read files using `git cat-file` at that SHA, even after branch changes or agent
commits. On resume, the saved snapshot's checkout pin restores the agent's work, but configuration
comes from the run's trusted base branch, not that snapshot pin. Preview services needed before a
workspace exists use the SCM provider at a resolved SHA of the same base branch. A missing file is
unset. An invalid file names its path in a typed failure; workspace consumers attach an
`invalid_config` setup blocker. Test-command evidence labels file-selected commands `repo-file`.

The test loop runs `runTests` when set, else a command guessed from `package.json` that falls back to
`npm test`. When the command cannot run in the workspace — exit status 127 or 126, npm's
`Missing script: "test"` (npm's own line at the start of a line, with exit status 1), or npm's
missing-`package.json` error (what the `npm test` fallback hits in a repository that is not a Node
project) — the loop ends after that test run instead of starting another agent pass, records a
`tdd.test_unrunnable` event, still commits and pushes the work, and says so in the implementation
notes. The missing-`package.json` case counts only as npm's own
`npm error enoent Could not read package.json` line at the start of a line together with exit status
254, so a suite that runs npm itself and then fails an assertion keeps iterating. This holds for a
configured `runTests` too. Set `runTests` to a command the workspace can run, or pin an
`executorImage` that carries the repository's toolchain.

A command derived from the [detected stack](#detected-stack) (pytest, `go test ./...`, `cargo test`,
`mvn`, `gradle`) can run in an image that has the toolchain and still show no tests. Two outcomes
end the loop after that test run, which is not always the first. The run is recorded as not run and
the work is still committed and pushed:

- **Exit status 5** (pytest's no-tests status; among the stack defaults only pytest exits 5): the
  runner looked for tests and found none. A `tdd.no_tests_found` event is recorded and the
  implementation notes say the command found no tests and that `runTests` should be set.
- **Exit 0 with no readable test counts** (`go test` printing `[no test files]`, a Gradle build
  whose `test` task was up to date, one component of a composite whose output showed no tests):
  whether tests ran is unknown, and a green suite looks the same. A `tdd.tests_unreadable` event is recorded and the notes say the command exited 0
  but printed no test counts, so a reviewer is not told tests are missing.

A fix session (CI, review, gate or pull-request feedback) has one test run and no loop; it records
the same events and appends the same sentences without loop wording. A configured `runTests` and the
`package.json` guess never take this path. `runTests` is still how a repository gets a real command.
The pull request body says "No test results could be read" for any not-run result, which also covers
a `maxTddIterations` of 0 and a configured or Node command whose zero-exit output carries no counts.

A gate command runs in the agent workspace of every run on the repository, so changing the set takes
the same role as writing a command into a template: a platform admin, or an admin of the team that
will own the repository (`403 GATE_COMMANDS_FORBIDDEN` otherwise; see
[`nl-workflow-authoring.md`](./nl-workflow-authoring.md#5-design-notes)). Re-sending the stored set
is not a change, so a lead can still edit the rest of the repository, and onboarding with none (or
only blank ones) needs no role. Moving a repository that has gate commands to another team takes
the same role on the destination, because its commands start running in that team's runs. Each
change writes a `Connection` entry to the config audit log with the set before and after. Only a
`git_repo` connection has gate commands.

### Executor images

A run's workspace container starts on the deployment's workspace image
(`WORKSPACE_IMAGE`), or on the repository's `executorImage` override — a
platform-admin-only field, because the image is code that runs next to the
clone credential. An executor image must meet the **image contract**: it
provides `sh`, `git` and `tar`, runs `sleep infinity` under `--init`, and has
a `/workspace` the exec user can write to. Docker workspaces use UID/GID 1000 and
`HOME=/workspace/.home` unless `WORKSPACE_RUN_AS_ROOT=true` preserves the image's user and home.
Docker preparation installs missing git and bash through absolute apk/apt-get paths as root before
any repository code. That authority closes before returning the workspace; clone, setup and agent
commands run as UID 1000. Images without a supported package manager must preinstall both tools,
as must Kubernetes images. The curated images provide both. `ripgrep` is optional but recommended — Pi's grep
honours `.gitignore` only through it.

**An image per stack.** A deployer may map a detected stack to an image with `WORKSPACE_IMAGE_PYTHON`,
`WORKSPACE_IMAGE_JVM` and `WORKSPACE_IMAGE_GO` (environment-only, validated at worker boot like
`WORKSPACE_IMAGE`). A repository's workspace then starts on, most specific first:

1. its `executorImage`, when a platform admin set one;
2. the image for its detected stack — the root's, or the only component's — when that variable is set;
3. `WORKSPACE_IMAGE`.

Node has no variable: `WORKSPACE_IMAGE` is the Node image, and a repository the scan found to be Node
behaves exactly as before. Unset variables, an ambiguous layout and a repository the scan has not
reached all fall through to `WORKSPACE_IMAGE`. The stored detection only *selects* among images the
deployer configured and never names one, so a committed `go.mod` can move a repository onto the Go
image but cannot choose which image that is. The images are not built into the platform: build
`defaults/Dockerfile.<stack>` (see below) and publish it where the workers can pull it. On Kubernetes,
`K8S_WORKSPACE_IMAGE_PULL_SECRETS` must cover those registries too. The probe below, run with no image named,
tests the image the repository's runs would use: its override, else its stack's image, else the
default.

A platform admin can check a candidate image without waiting for a run: the
**Check image** button in the repository's connection form, or
`POST /api/v1/repositories/:id/executor-image/probe` (`{ image? }`, defaulting
to the repository's override, else the resolved workspace default). It runs a
short `ExecutorImageProbeWorkflow` on the worker, which starts the image as a
hardened workspace container, runs the contract checks inside it, removes the
container, and returns each check with `required`/`ok`/`detail`.

`defaults/` holds curated executor bases — `Dockerfile.node`, `Dockerfile.node-browser`,
`Dockerfile.python` (Python slim + `uv`), `Dockerfile.go` (Go on Debian) and `Dockerfile.jvm`
(Temurin JDK + Maven, daemons off). `build-executor.yml` builds one of them per run: the `stack`
input (`node`|`node-browser`|`python`|`jvm`|`go`, default `node`) selects it, unless
`use_repo_dockerfile` builds the repository's own Dockerfile instead.

`Dockerfile.node-browser` is the browser-enabled Node variant: Debian with Playwright's Chromium
and the same Node toolchain, for repositories that verify app previews. Select `node-browser` with
`use_repo_dockerfile` false in `build-executor.yml` to build it for a repository; the workflow records
the resulting image and build settings on that connection. It is a repository executor-image choice,
not a detected stack for `WORKSPACE_IMAGE_<STACK>` ([deployment.md](./deployment.md) and
[ui-validation.md](./ui-validation.md)).

**Recording the build.** A build writes the image back to the connection together with
`executorImageBuild` (`{ stack, useRepoDockerfile }`), the settings it was built with. Like the
image, only a platform admin may set the record; anyone may clear it. Clearing or changing the
image without a new record clears it too. Re-saving the connection with its current image keeps
it.

**Weekly rebuild.** Every Monday a scheduled run lists the active repositories and rebuilds each
one that has an `executorImageBuild`, using the recorded settings, so its image picks up
base-image fixes. Each stored value is validated before it is used. Rebuilds run four at a time,
and one repository's failure doesn't stop the others.

### On-demand tools

A repository whose toolchain the executor image lacks (a task runner, say) can have a workspace install
pinned tools before the run starts, without an admin building a new image. The install runs as the
container's own user with every capability dropped, so it needs no root and no package manager: each
tool is a static binary downloaded inside the container, checked against a SHA-256, and placed in
`/workspace/.tools/bin`, which is appended to `PATH` after the image's own directories for the agent's
and the gates' commands, so a tool never replaces a binary the image provides (the agent can write there,
and a planted `git` must not shadow the real one). That directory sits outside the clone, so `git add -A` never sweeps it into a pull request.

**The catalog is the allowlist.** A tool is a row of the tool catalog (`GET /api/v1/platform/tool-catalog`,
readable by any signed-in user, written only by platform admins and audited per row). A row pins a
version, one download URL and SHA-256 per architecture, the archive member to extract, and the C
library the binary needs (`musl`, `glibc`, or `any` for a static build). Everything that asks for a
tool — a repository's file, the connection's admin list, an agent — can only name a catalog `key`
and optional `version`; none can supply a URL, a script or a checksum. Without a version the newest
`ACTIVE` row is used. `DEPRECATED` rows install and record a warning. `REVOKED` rows never install,
for any repository, from the moment an admin revokes them. Built-in rows are seeded at gateway
startup and kept in step with code until an admin edits one.

**Who declares what.** Installing is off until the setting `workspace.toolInstall.enabled` is on for
the run's team or organization. Then a run installs the union of:

- the connection's admin list (`tools`, a platform-admin-only field of the repository PATCH), and
- the repository's `.auto-swe/tools.yml`, only when a platform admin also set `toolsFileEnabled` on the
  connection,

minus the connection's `toolsDeny` keys, which win over both. At most `workspace.toolInstall.maxTools`
tools install per run; a run that declares more fails at setup instead of being truncated.

The file is `version: 1` and a `tools:` list of `{ key, version? }`, at most 8 KB, with unknown keys,
YAML aliases and a repeated key all refused. It is read from the **base ref** (the default-branch tip
the workspace was cut from, or the pinned commit), never from the agent's branch, so a run that edits
the file changes nothing until a person merges it.

**A declared tool that cannot be installed fails workspace creation.** The run never starts on a
toolchain the repository said it needs. A failed download is retried by the activity's normal retry
policy; a checksum mismatch, an unknown, revoked or unsupported tool, an unreadable catalog and a
malformed file fail at once, with a message naming the tool and the reason. An unreadable catalog
does not fall back to the built-in table, which would bypass a revoked row.

**Egress.** Downloads go directly from the workspace to the catalog's URLs; they do not use the
package-registry proxy, and the installer clears the workspace's proxy variables, so a team egress
allowlist does not apply to them. That is deliberate and safe: the install runs before the network is
locked, from URLs an administrator vetted, and a catalog URL must be a plain `https` URL on a public
DNS name (no credentials, query, fragment, IP address or internal name). On Kubernetes a NetworkPolicy that blocks those hosts makes every install a
hard failure, so allow the catalog's download hosts (the built-in rows use `github.com` release
assets). Tools count against the workspace's ephemeral storage, and the volume must allow executing
files: an `emptyDir` or node mount mounted `noexec` breaks installs.
Installs happen before the egress policy locks the network; a tool an agent requests after the workspace
started (`provisionTool`) is refused under the `blocked` and `restricted` policies. An agent may not pin
a `DEPRECATED` row, and a workspace stops running installers after `max(3, maxTools)` failed attempts.

**Letting the platform propose the files.** In Connections, **Open onboarding PR** in a git
repository's row menu opens a dialog for `.auto-swe/tools.yml` and `.auto-swe/pr-policy.yml`.
Each file has its own include checkbox. The tools picker lists non-revoked catalog keys, allows
up to 32 selections, and suggests only available keys from the detected stacks: Node suggests
`jq`, Python `uv` and `ruff`, JVM `maven` and `gradle`, and Go `golangci-lint`. Unknown or truncated
stack detection supplies no suggestions. Sensitive-path globs are editable, one per line; the
defaults protect auth and migration directories. The dialog polls the workflow and shows whether
the pull request is opened, updated, already matches, or fails, with a link when available.

A repository's owning-team lead, the owning organization's admin, or a platform admin can propose
these files; sharing does not grant management. The API is
`POST /api/v1/repositories/:id/onboarding-pr` with the files to include, and
`GET /api/v1/repositories/:id/onboarding-pr/:workflowId` for the outcome. A team the repository is only
shared with cannot do this. The tools named must exist in the catalog and not be revoked. The files
are rendered by the platform from that selection (the request supplies no path and no free-form
content), cloned from the default branch, committed on `<branch prefix>/onboard-<hash>`, pushed, and
opened as one ordinary pull request. Asking again with identical content reuses the branch and pull
request; a file already identical on the branch is skipped; one that differs is changed on the
branch only, so a person reviews the diff. Nothing is ever merged or force-pushed. Merging the pull
request enables nothing: `toolsFileEnabled` stays an administrator's separate switch, so the file is
inert until then. The pull request touches `.auto-swe/**`, a sensitive path in pull request
evaluation, so it never qualifies for bot-approved auto-merge.

### First-run checklist

New git repositories show an expandable **First-run checklist** in Connections to their managers.
It tracks the last successful **Test access**, a completed stack scan (`detectedStackAt`), no
unresolved setup blockers, an opened or updated onboarding pull request, and at least one launched
workflow run. The action links open access testing, repository settings (stack and setup health),
the onboarding dialog or stored pull request, and the launch page. Stack scans run on onboarding
and on the dependency schedule; the checklist does not run a scan itself. Setup operations retain
their team-ADMIN or platform-ADMIN restriction.

Access failures do not clear earlier success: this is a first-run milestone, not a live health
indicator. The onboarding URL and number are recorded when its status endpoint observes an opened
or updated pull request. The list and detail responses derive the checklist with relation counts,
without per-repository client requests. Managers can dismiss it for everyone on the connection
with `POST /api/v1/repositories/:id/onboarding-checklist/dismiss`; it also hides when all milestones
are complete. Repositories present before checklist storage is introduced are backfilled as
dismissed. New repositories start undismissed.

### Detected stack

The dependency scan also records the repository's stacks on the connection
(`detectedStack`, with `detectedStackAt`). It reads the repository tree recursively. It runs on the
weekly schedule and once more when a repository is onboarded, so a new repository has its stack
before its first run. The onboarding scan is started after the repository is saved and is
best-effort: if it cannot be started, or runs before the repository's credentials work (it then
records nothing and is not retried), the weekly sweep records the detection. A scan changes what
later runs read: a run is pinned to the detection of each connection it may use as it was when the
run began (`WorkflowRun.pinnedDetections`).

- **What it scans.** Stack signals (`package.json`, `pyproject.toml`, `requirements.txt`,
  `setup.py`, `pom.xml`, `build.gradle[.kts]`, `settings.gradle[.kts]`, `go.mod`) up to four directories deep. Paths under
  `node_modules`, `vendor`, `.git`, `dist`, `build` and `target` are ignored.
- **What it records:**
  - `components`: every directory with a signal and its stacks, capped at 50
  - `stacks`: the union of the components' stacks
  - `primary`: the root's stack when the root has one. Otherwise it is the stack with the most
    components. Ties are broken by the fixed precedence node, then python, then jvm, then go.
  - a suggested curated Dockerfile
  - conservative suggested gate commands: for a Node root, the scripts the root `package.json`
    declares; for a Python, JVM or Go root, the stack's fixed commands (see below). A repository
    whose root has no stack signal gets no suggestions: its run-time defaults already apply, and a
    suggestion applied through the form is copied into `gateCommands` and would freeze there, going
    stale when a component is added
- **Fallback.** When the tree cannot be listed, the scan falls back to the root directory. When
  neither listing works, the previous detection is kept.

**Run-time fallback for a non-Node root.** When a repository's root is Python, JVM or Go and a
gate has no step `command` and no entry in the repository's `gateCommands`, the gate runs the
stack's command instead of the built-in `yarn` one, and the TDD and fix-session test loop runs the
stack's test command when `runTests` is unset (the same chain, so loop and gate never disagree):

| Root | `runTests` | `runBuild` | `runLint` |
|---|---|---|---|
| Python | `python -m pytest` | — | — |
| JVM, Maven (`pom.xml`) | `mvn -B -ntp test` | `mvn -B -q -DskipTests package` | — |
| JVM, Gradle | `./gradlew test --no-daemon` | `./gradlew build -x test --no-daemon` | — |
| Go | `go test ./...` | `go build ./...` | `go vet ./...` |

The Maven test command is not quiet (`-q` prints nothing on success): the test loop needs Surefire's
`Tests run: N, Failures: 0, Errors: 0` summary as evidence that tests ran, and a run with no tests
does not pass. For Gradle, an executed `test` task (a `> Task :test` line, not one marked
`UP-TO-DATE` or `NO-SOURCE`) is the evidence. A custom `runTests` for a JVM repository must print one
of those for the loop to see it pass.

A gate the table leaves blank resolves to no command and fails as unconfigured (`onFail: 'warn'`
on its node makes it optional); it is never filled with a command from another ecosystem. The
commands come from this fixed table, not from the stored `suggestedGateCommands`. A Node root, a
polyglot root (node outranks the rest) and a repository with no detection keep the built-in gates.

**Node package manager.** A Node root's manager comes from its `package.json` `packageManager` pin
when it has one — Corepack enforces the pin, so it outranks the lockfile — else from its lockfile
when exactly one exists. A root on npm or pnpm runs that manager's commands (`npm run build`,
`npm run lint`, `npm test`, `npm run typecheck`, `npm audit --audit-level=high`; `pnpm …` likewise),
so its vulnerability scan is not Yarn 4's `yarn npm audit`. Yarn's flavour comes from the pin's major
version, else from a root `.yarnrc.yml` (Berry's config file), else from the first 2 KB of the root
`yarn.lock`: `# yarn lockfile v1` means Classic and `__metadata:` means Berry. The scan fetches that
file only for an unpinned yarn root with neither of the others:

| Root | Gates |
|---|---|
| Yarn Berry, Yarn of unknown flavour, no recorded manager | the built-in `yarn` gates, including `yarn npm audit --severity high` |
| Yarn Classic (`yarn@1.x`) | the built-in `yarn` gates **without** `runVulnScan`, which resolves as unconfigured |

Yarn Classic has no `yarn npm audit`, and its `yarn audit` posts to a hard-coded `registry.yarnpkg.com`
whatever registry is configured, so it can never go through the registry proxy and would send every
package name in the lockfile, private ones included, to a public host. Set `runVulnScan` on the
repository if you want it anyway. The test loop does not take a manager's `npm test` for a Node
target — it keeps its `package.json` guess.

**Components.** A repository whose root has no stack signal resolves by its components:

- exactly **one** component, with a complete listing (`treeTruncated` and `componentsTruncated` both
  unset), is the target. The stack's default gates and test command run in that directory, so the
  recorded command reads `cd 'backend' && mvn -B -ntp test` — the directory is visible in the run's gate
  result. A Node component's manager comes from its own lockfile (and `.yarnrc.yml`) alone; one with no
  lockfile gets npm's commands, because Yarn 4 refuses a directory that is not part of a project (its
  audit then fails, as `npm audit` needs a lockfile). Its test command is guessed from the component's
  own `package.json`. A Gradle `settings.gradle[.kts]` makes the root a JVM target, so a subproject is
  never picked in place of the root's `./gradlew`.
- **two to eight** components and no root signal, with a complete listing, resolve to **composite**
  gates: one command per gate that runs the gate in every component, in path order, and fails if
  any component fails. Every component runs even after an earlier one fails, and its output follows
  an `== auto-swe component: <dir> ==` marker line, so a failure names its directory (a runner can
  print `== a ==`; it will not print this). Each component's command is the one a single component
  would get (its own Node manager, its own JVM build tool), run in a subshell `cd` so one
  directory never moves the next one's starting point. The script is plain `sh` (dash, busybox ash
  and bash alike):

  ```sh
  rc=0; ur=0; ck() { if [ "$1" -ne 0 ]; then if [ "$1" -eq 126 ] || [ "$1" -eq 127 ] || [ "$1" -eq 5 ]; then ur=$1; elif [ "$rc" -eq 0 ]; then rc=$1; fi; fi; }; echo; echo '== auto-swe component: api =='; (cd 'api' && mvn -B -ntp test) 2>&1; ck $?; echo; echo '== auto-swe component: web =='; (cd 'web' && npm test) 2>&1; ck $?; if [ "$rc" -ne 0 ]; then exit $rc; fi; exit $ur
  ```

  The exit status is the first **real** failure's — any status other than 126, 127 or 5, a missing
  directory included. A part that is not runnable (126, 127) or that collected no tests (pytest's
  5) decides the status only when no part really failed, and then the last of them does. Those are
  the statuses the test loop stops on instead of iterating, so a missing tool or an untested Python
  component cannot hide another component's failing tests from the loop. All parts passing is 0.

  The test loop reads the output per section: every component must show that its tests ran (a
  parsed passing count of at least one, or a runner's own `ok`/`PASS` lines) and none may show a
  failure, so a component that tested nothing is not covered by another's green run. The reported
  passing and failing counts are the sums across components. The output fed back to the agent is
  bounded per component — each section keeps its marker line and its last characters, an even share
  of the 10,000-character budget — so every component's failure is represented. The test run's
  timeout is the usual ten minutes times the number of components, at most four times, for the test
  loop and for the `runTests` quality gate alike (a step's own `timeoutMs` still wins). Each
  component's stderr is merged into its stdout inside the composite, so a gate summary that shows
  one stream still carries the markers.

  The rule is all-or-nothing per gate: a gate is composite only when **every** component has a
  command for it. A gate any component lacks stays unconfigured, because running it in only some
  components would verify part of the repository and read as a pass. The TDD and fix-session test
  loop uses the composite `runTests` by the same chain. When every component's first stack is the
  same non-Node stack, `executorImageFor` gives the layout that stack's configured image; a mixed
  layout, or one with a Node component, gets none.
- **more than eight** components, a stored path that does not validate, or a component with no
  known stack leave every gate unconfigured instead of running a root command that cannot work
  there.
- anything else keeps the built-in behaviour.

Only the stack defaults get the `cd`: a step's `command` and the repository's `gateCommands` are
written relative to the repository root and run exactly as written. A stored component path is
re-validated where it is used (plain segments, at most four, never absolute, `..` or starting with
`-`) and quoted, since the column is JSON the worker wrote, not trusted input.

The repository edit form shows the detection as a suggestion: the detected stacks and components,
the suggested `defaults/Dockerfile.<stack>` for `build-executor.yml`, and a **Use suggested gate
commands** button that fills the gate fields without saving them.

### Workspace setup

A repository can say how a fresh checkout is prepared before anything works on it: install its
dependencies, fetch its submodules and Git LFS objects, run a code generator. Every workspace runs
it — the agent's, the quality gates', UI and CI verification, merges and evals — so each sees the
tree the agent worked in.

Managing setup requires the owning team's ADMIN role or platform ADMIN. Team LEAD and
ORG_ADMIN alone do not grant shell-authoring permission. This restriction covers changing the
setup definition, proposing its pull request, managing setup secrets, moving preview environment
values to secrets, and reading or dismissing setup blockers. Non-platform administrators also
need the owning team to be active.

The definition is one schema (`RepoSetupSchema`, in `@auto-swe/shared/lib/repoSetup`), read from
the first of:

1. the repository's `setup` field (`Connection.setup`), set in the connection form's **Workspace
   setup** section (fields for submodules, LFS, steps, cache, env and secret names; no JSON to
   write), with
   `auto-swe repos setup <org/name> --file=setup.yml`, or as `setup` on
   `POST`/`PATCH /api/v1/repositories`;
2. `.auto-swe/setup.yml` in the commit the workspace was cut from — the run's base branch, never
   the working tree a run changed — and, for an eval, its pinned commit;
3. defaults inferred from the [detected stack](#detected-stack), only when
   `workspace.repoSetupStackDefaults` is on (off by default), for a single target whose directory
   holds the file its install needs:

   | Target | Needs | Install | Cached |
   |---|---|---|---|
   | Node | its package manager's lockfile | `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (Classic: `--frozen-lockfile`) | `node_modules` |
   | Python | `uv.lock` | `uv sync --frozen` | `.venv` |
   | Python | `requirements.txt` (no `uv.lock`) | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` | `.venv` |
   | Go | `go.sum` | `go mod download` | `~/go/pkg/mod` |
   | JVM | `pom.xml` | `mvn -B -q dependency:go-offline` | `~/.m2/repository` |
   | JVM | `gradlew` (no `pom.xml`) | `./gradlew --no-daemon dependencies` | `~/.gradle/caches`, `~/.gradle/wrapper` |

   The lockfile or build files are the cache's key files. Anything else — Poetry, a `pyproject.toml`
   without `uv.lock`, Gradle without its wrapper, several targets — gets no default.

```yaml
submodules: recursive   # false | true | recursive
lfs: true
env: { CI: "1" }        # upper-case names; not for secrets
secrets: [NPM_TOKEN]    # setup secrets saved on the repository, by name
steps:
  - name: install
    run: yarn install --immutable
    timeoutSeconds: 600   # default 600, at most 3600
  - run: ./scripts/codegen.sh
    workdir: packages/api # relative to the checkout
cache:
  paths: [node_modules, ~/.cache/yarn]
  keyFiles: [yarn.lock, "packages/*/package.json"]   # paths or globs over tracked files
```

**Writing the file.** Three ways start one from the same stack defaults:

- the form's **Keep it in the repository** panel shows the definition its fields describe (or, with
  the section off, a starter from the detected stack) as `.auto-swe/setup.yml`, to copy or
  download;
- `auto-swe repos setup init [dir]` writes the starter into a local checkout, detecting the stack
  from its tracked files, without a token;
- the panel's **Open a PR adding .auto-swe/setup.yml** button (`POST
  /api/v1/repositories/:id/setup/pull-request` with `{ setup }`) commits the file through the
  host's API to a fresh `<BRANCH_PREFIX>/setup-yml-<hex8>` branch cut from the default branch and
  opens a pull request, under the same permission as the field and written to the audit log. The
  request is validated and answered at once (`202` with a `requestId`); the worker does the rest,
  and the form polls `GET /api/v1/repositories/:id/setup/pull-request/:requestId`, which reports
  `queued`, `opened` (with the branch and pull request) or `failed` (with a reason). A request no
  worker finishes within 10 minutes fails. It fails with `exists` when the default branch already
  has the file: it never edits one.

**Setup secrets.** A step that needs a credential, say for a private registry the
[registry proxy](./package-registries.md) does not cover, names it under `secrets`. The value is
saved on the repository, in the form's **Setup secrets** panel or with `PUT
/api/v1/repositories/:id/setup/secrets/:name` (`{ value }`), by the people who may edit the
definition. It is stored encrypted with `CONFIG_ENCRYPTION_KEY` (and re-encrypted by key rotation),
and is write-only: `GET …/setup/secrets` and the form show only each name, its last four characters
and when it changed; `DELETE …/setup/secrets/:name` removes one. A repository holds at most 20. The
worker decrypts the named secrets right before the steps, hands them to each step as environment
variables through the workspace's secret channel (never the exec command line or the audit line),
and masks them in the output tail. The agent's own commands never get them. A name the repository
holds no value for, or one that cannot be decrypted, fails setup with `WORKSPACE_SETUP_FAILED`. A
name may not be both an `env` key and a secret. Saving and deleting are written to the audit log,
by name only.

### Setup blockers

Workspace setup failures carry typed diagnostics and retain the `WORKSPACE_SETUP_FAILED`
failure type and retry behavior. For a workspace associated with a repository connection, the
worker records each blocker by kind and subject, incrementing its occurrence count when it
recurs. Details contain a redacted output tail, capped at 2,000 characters; remedies are fixed
hints computed from the kind, not instructions generated from the output.

| Kind | Raised when |
|---|---|
| `missing_secret` | A named setup secret has no saved value. |
| `secret_decrypt_failed` | A saved setup secret cannot be decrypted. |
| `missing_tool` | A step exits 127 or its output indicates a shell command is missing. |
| `egress_denied` | A failed step has a blocked egress-proxy audit row since its start. |
| `git_auth` | A submodule or LFS fetch reports an authentication failure. |
| `git_fetch` | A submodule or LFS fetch fails without an authentication indicator. |
| `lfs_missing` | Setup enables LFS but the workspace lacks git-lfs. |
| `step_failed` | A step exits unsuccessfully without a more specific classification. |
| `step_timeout` | Capturing a setup step throws, including timeout. |
| `invalid_config` | The definition is invalid, submodule configuration is refused, a secret is too short to scan, or secrets are requested without a repository connection. |
| `secret_leak` | The secret scan finds secret-bearing files after cleanup. |
| `internal` | Reading the setup file, cleanup, marker creation, process sweeping or completion of the secret scan fails. |

The repository edit form's **Workspace setup** section includes a **Setup health** card with
open blockers, remedies, expandable details and occurrence timestamps. The next successful
setup resolves all open blockers on that connection. **Dismiss** manually resolves one; if it
recurs, setup reopens the same row and increments its occurrence count. Resolving a blocker
does not change the setup definition or retry a run.

When a run's blamed failed step reports `WORKSPACE_SETUP_FAILED`, the run and request panels
look up that repository's blockers, including resolved rows, and match the run's workflow ID
against `lastWorkflowId`. A match shows the kind, remedy, subject and setup step; the recorded
error stays under diagnostics. The request panel also names the kind on its blocker line.
Without a match, repository or workflow identity, permission to read blockers, or a successful
lookup, the panels keep the recorded error without an additional error message. Blocker rows
are deduplicated: a later workflow can replace `lastWorkflowId`, so an older run then falls back
to its recorded error.

`GET /api/v1/repositories/:id/setup-blockers` returns open blockers newest first; use
`?includeResolved=true` to include resolved rows. `POST
/api/v1/repositories/:id/setup-blockers/:blockerId/resolve` dismisses one. Both use the same
repository access and team-admin permission checks as setup secrets and editing setup.

**Keeping secrets out of the tree.** A step that writes a secret to disk — an `.npmrc` with an auth
token, say — lists that file under `cleanup` (`cleanup: [~/.npmrc]`; paths relative to the
checkout, or `~/` under the home directory, at most 20). After the steps, every process they left
running is stopped, whether or not the definition names secrets (all but the workspace's keeper;
sidecars in other mount namespaces are untouched): a database or other long-running dependency
belongs in the preview recipe's or the workflow's `services`, not in a setup step. Then the
`cleanup` files are deleted, and, when the definition names secrets, the checkout (`.git`
included), the workspace user's home directory (which holds every `~/` cache path), `/tmp`,
`/var/tmp` and `/dev/shm` are searched for each secret value. The search reads every file of up to
20 MiB, and a larger one when it was modified after the steps started (by the workspace clock,
recorded right before the first step), since only a step can have written this run's secrets into
it. Each value is searched for as written, URL-encoded, hex-encoded in either case, base64-encoded
at any byte offset in either alphabet (so a token inside `_auth=base64(user:token)` is found), and
base64-encoded twice; a multi-line value by its longest line. A match fails setup with `WORKSPACE_SETUP_FAILED`, naming up to 20 files and never the value,
before the cache is saved or any agent runs. The search gets the values through the workspace's
secret channel, like the steps, and a search that does not finish within 5 minutes fails setup too.

A setup secret is at least 8 characters, since a shorter one matches unrelated files by chance:
saving a shorter value is refused, and a value stored before that rule fails workspace setup that
names it (before any step runs) until it is replaced. An app preview that names it still runs,
since preview setup is not scanned.

A file is at most 64 KiB and 20 steps; unknown keys, absolute paths and `..` are refused. Setting
or changing the field takes the same permission as [gate commands](#gate-commands) and is written
to the audit log; re-saving an unchanged value needs none.

**How it runs.** The definition is resolved while the workspace is provisioned, and everything it
asks for runs after the network lock, as the workspace's normal user:

1. **Submodules**, shallow. Each URL in `.gitmodules` — relative, `https://` or `git@host:` — must
   name an `owner/repo` on the repository's own host. Its URL is pinned in `.git/config` and the
   fetch carries a credential minted for that repository, never the parent's; on a GitHub App that
   needs the App installed on the submodule's repository. Another host, scheme or shape fails setup.
   `recursive` follows nested submodules three levels deep, 25 in all.
2. **LFS**: `git lfs pull` in the repository and in every submodule fetched in step 1, each against
   its own repository's LFS endpoint with its own credential. The image needs `git-lfs`, which
   every default executor image has. Under a
   `blocked` or `restricted` egress policy, the lock also admits the storage hosts that
   `workspace.lfsStorageHosts` lists for the repository's git host when the definition asks for
   LFS. That platform-admin setting holds `git-host=storage-host` entries (host or `host:port`) and
   lists github.com's two content hosts by default; an LFS server that serves files from its own
   host needs none. A repository cannot widen it.
3. **Cache restore**, then the **steps** in order, each with `env`, the named secrets and its own
   timeout. The network
   is what the egress policy leaves, so installs go through the
   [registry proxy](./package-registries.md).
4. **Cleanup** of the `cleanup` paths, then the **secret scan** (see above).
5. **Cache save** on a miss, before any agent has run.

A failing step fails the workspace with `WORKSPACE_SETUP_FAILED` and the redacted tail of its
output; an invalid definition fails it without a retry. Each run of setup writes a
`workspace.setup` audit line with its source, steps, timings and cache outcome. A caller that moves
the checkout to the run's branch runs setup after the move; the trusted workspace that commits an
agent's tree runs none.

**Dependency cache.** With `cache`, the listed paths (relative to the checkout, or `~/` for the
home directory) are saved as one gzipped tarball in the artifact store after a successful setup,
and restored before the steps of the next workspace with the same key: the repository's team, the
repository, the definition, the contents of `keyFiles`, the image and the CPU architecture. A
`keyFiles` entry with `*`, `**` or `?` is a glob over the files git tracks (no absolute paths or
`..`); the paths it matches and their contents both go into the key, so adding a matching file
starts a fresh cache, and a key over more than 500 files fails setup. The Gradle default keys on
`**/build.gradle` and `**/build.gradle.kts`, so a subproject's build file counts. Teams
never share a cache; repositories with no team share one scope. The steps still run,
so an install on a restored tree is quick rather than skipped. The tarball is capped by
`workspace.setupCacheMaxMb` (1024 by default, `0` turns caching off); a larger one is not stored. A
cache works on both workspace backends but only on the S3 and filesystem artifact backends; on the
Postgres backend it is skipped. A cache nobody restored for 14 days is deleted with its tarball by
the transcript-retention sweep. A cache that cannot be read or written costs only time.

**Preview setup.** An [app preview](./ui-validation.md) recipe's own `setup` command is separate:
it runs only in preview sessions, after workspace setup, with the recipe's `env` (which may carry
secrets). Dependency installs belong in workspace setup, where every workspace and the cache get
them; the preview's `setup` is for what only a running app needs, such as seeding its database.

### Onboarding agent

The built-in `repo-onboarding` workflow takes a required `connectionId` for a Git repository.
Run it through the workflow library's normal launch form. The `repo-onboarder` agent explores
the trusted base checkout, reads repository guidance and build evidence, tries commands and
returns a structured proposal for `.auto-swe/setup.yml`, `.auto-swe/gates.yml` and an optional
`.auto-swe/preview.yml`.

The draft workspace has temporary download access controlled by
`onboarding.draftEgressHosts`, applicable active package-registry upstreams and non-revoked
tool-catalog download hosts. Open policy is unchanged. Restricted policy adds these hosts to
the team allowlist; blocked policy uses only these hosts plus the existing Git/platform access.
The proxy registration belongs to that workspace and is revoked on destruction. Without the
egress proxy there is no widening. Worker verification requires the onboarder agent in the
seeded global template and a seeded version; copying or editing the template does not grant it.

A deterministic trial provisions a fresh base-branch workspace under the **real run policy**,
with no setup-only widening. It applies the proposed setup in memory, runs the exact drafted
gate commands and checks optional preview readiness. Trial setup neither records nor resolves
the repository's **Setup health** blockers; it returns typed blockers in the trial report instead.

Invalid proposals and repairable trial failures return to the drafter, up to three draft visits
(two repair rounds). Operator-only blockers, such as missing secrets or denied egress, go to
review without an automatic repair. A person sees both the draft summary and the trial report,
including blockers. They can approve even a failed trial, request changes within the same draft
visit budget, or reject. Exhaustion still reaches review; an invalid draft is explicitly marked
and cannot reach delivery even when approved. Approval opens one configuration PR; it does not
merge it. On merge, connection overrides retain precedence over the files.

### Pull request titles

A repository can choose how the pull requests opened for it are titled (`Connection.prTitleFormat`
and `Connection.prTitleTemplate`). Both are edited in the connection form, under **PR title format**
and **PR title template**, by the same people who can edit the rest of the repository. Left on
**Inherit** (stored as `NULL`), the repository follows the registry cascade; a value set here wins
over every scope in it. The formats, the placeholders and how a Conventional Commits title is built
are in [`configuration.md` §10](./configuration.md#10-pull-request-titles).

---

## 3. Sharing with other teams

A repository belongs to one team, which manages it. It can also be **shared** with further teams in
the same organization (`ConnectionTeamShare`).

| | Owning team | Shared team |
|---|---|---|
| See the repository, its runs, lessons and dependencies | yes | yes |
| Start runs (work requests, template runs, PRDs, Slack) | yes | yes, unless the share is view-only |
| Start an epic that names the repository | lead | no |
| Cancel a run, or answer a human step on it | yes | only runs they launched |
| Save a personal GitHub token for it | yes | yes |
| Be a channel-assistant code task's repository, by name | yes | yes, unless the team owns one by that name |
| Be a channel-assistant code task's repository by default (no name given) | if it is the team's only repository | never |
| Edit, deactivate or move the repository | team lead or owning organization's ORG_ADMIN | no |
| Change who it is shared with | team lead or owning organization's ORG_ADMIN | no |
| Create a schedule | lead | lead |
| Edit, fire or delete a schedule | any schedule on the repository (lead) | the team's own schedules only (lead) |
| Add or confirm dependency edges | lead | no |

Runs keep the owning team's budget, default template and settings, whoever launches them: the
owner's cap refuses a sharee's launch ([teams.md](./teams.md#5-team-budgets)). A share is
**view-only** when its `canLaunch` is `false`: the sharing team's members see the repository and its
runs, and a launch is refused with `403 REPOSITORY_VIEW_ONLY`, whose message names no team. Members of
the owning team and platform admins are never limited by a share.

The team list (`GET /api/v1/teams`) tells the caller their own role in each team as `myRole`
(`ADMIN`, `LEAD`, `ENGINEER`, or `null` for a team they do not belong to, which a platform admin
sees), plus the owning organization's `orgId` and `orgName`; it never carries another member's
role. `?member=true` restricts the list to the caller's own teams, even for a platform admin. The
dashboard derives which teams the caller leads from this list, with no per-team request. The
default list also includes active teams of organizations the caller administers, with a null
`myRole` when they are not a team member. Connection controls combine `myRole` with the caller's
organization roles from `GET /api/v1/platform/organizations`; platform ADMIN-only controls remain
restricted to platform administrators.

On the connections list, a row's "More actions" menu keeps **Share with teams** and
**Deactivate** (or **Reactivate**) for everyone and shows them disabled, with the owning team's
leads named as the ones who can, when the caller does not lead the owning team.

A team's own page (`GET /api/v1/teams/:id`) lists the repositories it owns and, separately, the ones
shared with it, each marked "shared by" its owning team and read-only. The shared list shows only
active repositories, and under an enforcing repo-access gate only those the viewer's GitHub
permission reaches, as the Connections page does.

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
handled on its own, and a failure on one is logged and never fails the request. Every schedule the
change deactivates gets its own audit entry (entity `ScheduledWorkRequest`, naming the team that lost
its claim and the person who changed the share or moved the repository); a failed audit write is
logged and does not skip the pause. The worker also
refuses to fire a schedule whose row is inactive, so a pause that did not reach Temporal still
stops it, and refuses one whose team is no longer the repository's owning team or a current
sharer (`schedule-team-unclaimed`, non-retryable), which covers a create that raced an unshare. A
schedule whose team was deleted has no team to check and is refused the same way until an admin or
the owning team's lead re-assigns it. They stay listed, and a lead of the owning team (or an admin) may delete them or
re-activate them, which makes the re-activating person the author and moves the schedule to the
repository's owning team (recorded in the audit log), so the next share change does not pause it
again. A paused schedule cannot be fired by hand (`409 SCHEDULE_INACTIVE`); resume it first.

Writes to a schedule row are compare-and-set on its `version`, which every edit, fire-by-hand
takeover and deactivation increments. Fire bookkeeping (when it last ran) does not, so a fire never
makes an edit lose. An edit that loses to a fire-by-hand takeover is retried (up to three attempts)
on the re-read row, with the launch decision taken again; an edit that loses to anything else (a
pause, another edit, a deactivation) answers `409 SCHEDULE_CONFLICT`, as does a fire-by-hand
takeover or deactivation that loses. The Temporal schedule is then re-synced from the row as it
stands.

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
| `GET /api/v1/repositories/:id/share-candidates` | the owning team's leads, its organization's ORG_ADMINs, platform admins | Active teams in the owning team's organization, other than the owner |
| `PUT /api/v1/repositories/:id/shares` | the owning team's leads, its organization's ORG_ADMINs, platform admins | Replace the set of teams it is shared with; audited. A team that stays keeps its `canLaunch`, a new team starts with `true`. Answers each share with its `canLaunch` |
| `PATCH /api/v1/repositories/:id/shares/:teamId` | the owning team's leads, its organization's ORG_ADMINs, platform admins | Body `{ "canLaunch": boolean }`: make one share view-only or launching again; audited; `404 SHARE_NOT_FOUND` for a team the repository is not shared with |

`GET /api/v1/repositories?teamId=<team>` lists only the repositories that team owns or that are
shared to it. The filter is its own `AND` term beside reachability, so it only narrows; the caller
must be a member of the team (a platform ADMIN may name any), otherwise `404 TEAM_NOT_FOUND`.

Each listed repository the caller can start work on carries `launchBudget`: where the owning team's
cap, which a launch there is held to, stands (percent and state, no amount; `null` where no cap is
set or the caller cannot launch). The semantics are in [teams.md](./teams.md#the-cap-a-launch-is-held-to).

Shares are limited to the owning team's organization, so a repository never crosses a tenant
boundary this way. Moving a repository to a team in another organization drops the shares that no
longer fit.

---

## Limitations

- **Onboarding preview readiness is only an HTTP check.** A response below 500 counts as ready,
  including authentication errors and missing pages. The trial does not perform browser or
  functional end-to-end verification, or run a preview recipe's smoke/e2e checks.
- **Secrets are not independently verified against their upstream services.** Existing secrets
  are resolved and may be used by commands; the agent only names requirements in `setup.secrets`
  and does not invent, create or validate new secret values.
- **Onboarding is bounded, not a guarantee of correctness.** Approval can accept a failed trial.
  Changes requested after all draft visits return to review without another agent visit.
  Bash is a general-purpose tool, not a technical read-only or no-push boundary; the seeded
  agent is instructed not to push and has no dedicated PR/push tools.
- **Onboarding trial reports remain in the run.** The configuration delivery activity renders
  the proposed files; it does not copy the trial report or its blockers into the PR body.

- An organization-linked GitHub installation is offered only to platform admins and callers who
  manage an active team in that organization. New imports and installation changes must target a
  team in the linked organization. Unlinked, admin-registered installations remain available across
  organizations. Linking an installation does not disconnect its existing repositories or block
  their runs, even when their teams belong to another organization.
  A registered singleton default App follows the same link scope; omitting an installation ID
  does not bypass it. An independent default PAT remains a separate source.
- Organization admins connect new installations from their organization's **GitHub** section.
  They can retire their links, but only platform admins can unlink, relink or reactivate them.
  Self-service uses only the instance's own App and host; see [GitHub App setup](./github-app-setup.md#connecting-an-organization).

- Gate and preview file edits on a work branch do not change that run's commands or services;
  they must reach the trusted base branch first. Pre-provisioning preview reads and workspace
  provisioning can see different trusted commits if the base branch advances between them.
- Preview connection overrides replace the entire file recipe; fields and services are not merged.
  Invalid overridden preview files are not read. Repository configuration files are limited to 64 KiB.

- **Discovery permission checks are bounded.** A request makes at most 100 uncached per-repository
  lookups. Missing linked identities, unanswered lookups and repositories beyond that cap are
  **Access unchecked**, not readable. Reloading uses cached answers and checks further repositories.
- **GitHub sign-in token evidence is best effort.** No additional OAuth scopes are requested.
  OAuth-App sign-in tokens only see public repositories with the sign-in scopes; refused or expired
  tokens fall back to platform-credential permission checks. A GitHub login is used only on its
  linked account's host.
- **Discovery caches can be stale for three minutes.** Source listings and access answers are
  cached in-process, including unanswered permission lookups. Each source lists up to 500
  repositories; a truncated user installation listing supplies positive evidence only. Creation
  still performs the normal live onboarding read-access check.
- **Egress blocker detection relies on proxy audit rows.** Kernel-dropped traffic is not classified
  as `egress_denied`, and only the first denied host is reported for a failed step.
- **Missing-tool detection is heuristic.** Exit 127, `command not found` and shell missing-command
  messages identify `missing_tool`; other failures remain `step_failed` unless another classifier applies.

- **Workspace setup files that git tracks become part of the change.** Setup runs on the tree the
  agent then edits, so a step that rewrites a tracked file puts that rewrite in the diff. Keep setup
  output in ignored paths.
- **LFS storage off the git host needs a platform admin.** Under `blocked` or `restricted`, an LFS
  server that hands out object URLs on a host `workspace.lfsStorageHosts` does not list for the
  repository's git host fails setup.
- **A dependency cache is shared within a team by every workspace with the same key.** The key
  covers the team, the repository, the definition, the key files, the image and the architecture,
  not the run, and a hit is restored before the steps run. It is saved before any agent code runs,
  but the setup steps themselves run the repository's code. Repositories with no team share one
  scope.
- **Setup `env` values are passed on the command line of the exec**, so they are not for secrets;
  setup secrets are the way to give a step a credential.
- **The secret scan finds a value only as written or in a standard encoding.** A step that splits
  a secret, encrypts or hashes it, encodes it some other way, or wraps an encoded value across
  lines is not caught, nor is a file outside the checkout, the home directory and the temporary
  directories. A file over 20 MiB whose modification time a step set back to before the steps
  started (`touch -d`, `cp -p`, unpacking an archive) is not read.
- **Setup steps cannot leave a process running.** Everything the steps started is stopped before
  the agent runs, so a step that starts a server for the agent to use has it stopped; run it as a
  service instead.
- **An eval reads setup secrets only through its dataset's linked repository.** A dataset with no
  linked repository runs setup with no secrets, so a case whose pinned setup names one fails setup
  ([evals.md](./evals.md#3-offline-harness)).
- **The access test does not look at webhooks.** Listing a repository's hooks needs an
  administrative permission the platform's credential does not otherwise hold, so a missing or
  mis-signed webhook is not found by it. An installation token reports no permission level for a
  repository, so for an App the push check says it cannot judge rather than passing or failing.
- **Onboarding asks about the caller's linked login, not a saved token.** A per-repository token
  (see [`user-github-credentials.md`](./user-github-credentials.md)) belongs to a connection that
  does not exist yet, so it cannot stand in; a lead whose only GitHub identity is such a token asks a
  platform admin to onboard. The login is asked about on the repository's host as recorded, so on a
  GitHub Enterprise host it names whoever holds that username there — the same caveat the launch
  gate carries.
- **Onboarding access is checked once.** Losing access on GitHub afterwards does not remove the
  repository; only [`repoAccess.mode`](./repo-access-gating.md) gates later use. A platform ADMIN is
  never asked.
- **An unrunnable test command ends the loop even when another pass might have fixed it.** Exit
  status 127 also means a runner the platform never installed (for example `pytest` in an image
  without it), and a further agent pass might have installed it. The implementer already runs the
  tests itself in its first pass, and a wasted pass costs a whole budget, so the loop stops; the
  diff is still committed and goes to review. A compound `runTests` that ran the tests and then hit
  127 in a later tool is stopped the same way. A repository with no `package.json` and no
  `runTests` falls back to `npm test`, which cannot run there, so the loop stops after one pass until
  `runTests` is set. Only npm 11's output with exit 254 is recognised: yarn, pnpm, bun and older npm
  with no `package.json` still iterate.
- **A stack-derived test command that shows no tests ends the loop on two signals, as a cost
  trade-off.** Exit status 5 and a zero exit with no readable counts stop it. After exit 5 the agent
  could still add a test file, but the implementer already runs the tests itself in its first pass,
  so a further pass costs a whole budget for a rarely different outcome; the diff is still committed
  and reviewed. A collection error, a compile error or real failures (any other status) keep
  iterating, because the agent can fix them, and `go test ./...` in a tree with no Go packages exits
  1 and iterates. A zero exit counts as unreadable unless the output carries a count, an
  `ok  <pkg>` / `Ran N tests` line, Surefire's `Tests run:` totals or an executed Gradle `test`
  task. The default Maven and Gradle commands print those, so a green run of them does not stop the
  loop; a composite counts as unreadable when any one component shows none.
- **Gate commands are checked when they are saved or moved, not when a run starts.** The worker runs
  whatever set the row holds, so a command stays in use after the admin who set it loses the role,
  and a value written to the column outside the API has no audit entry.
- **An executor image is checked when it is saved, not when a run starts.** Only a platform admin
  may set one (see [`deployment.md`](./deployment.md)), but the worker runs whatever image the row
  holds, so an image already stored stays in use until an admin changes or clears it.
- **A rebuilt executor image is built from the platform's Dockerfile unless a run opts in.**
  `build-executor.yml` builds `defaults/Dockerfile.node` by default and writes the result to the
  connection with an admin token. Dispatching with `use_repo_dockerfile` (a `workflow_dispatch`
  input, or the same field in a `repository_dispatch` `client_payload`) builds the target
  repository's own `.auto-swe/Dockerfile` for that run instead, and fails if it has none. An opted-in
  run lets anyone who can merge to that repository's default branch decide what the rebuilt image
  runs, and that image receives the run's GitHub credential, so opt in only for repositories whose
  merge access is trusted at that level.
- **Only images built by `build-executor.yml` are rebuilt on the schedule.** A repository whose
  image was set by hand, or built before `executorImageBuild` was recorded, has no record and is
  skipped until one dispatched build records it. A scheduled rebuild of an opted-in
  `use_repo_dockerfile` repository builds whatever its default branch holds at that moment, so the
  merge-trust caveat above applies to every scheduled run, not only the first one.
- **Rust, .NET and Ruby have no curated executor image and are not detected.** A repository on
  one of them needs its own image or `use_repo_dockerfile`, and its own `gateCommands`.
- **`runVulnScan` relays through the registry proxy only to the default registry.** The proxy serves
  the audit queries `npm audit`, `pnpm audit` and `yarn npm audit` send (see
  [`package-registries.md`](./package-registries.md)). An audit that names a private-scope package
  is refused, and an upstream that does not serve the endpoint a client uses fails the gate — pnpm
  uses the older `audits` endpoints, which a registry may no longer implement.
- **An unknown Yarn is treated as Berry.** A root with `yarn.lock` but neither a `packageManager` pin nor a
  `.yarnrc.yml` is read from the lockfile's header; a header that names neither flavour, or a lockfile
  that could not be fetched, keeps the built-in gates, whose audit is Berry's `yarn npm audit`. On a
  Classic repository that gate fails until a pin or `runVulnScan` says otherwise. A root `yarn.lock`
  over 1 MB cannot be read by the scan, so the flavour stays unknown and is treated as Berry: pin
  `packageManager` to fix it.
- **Composite gates cover a bounded layout.** More than eight components, or a gate that some
  component has no command for (a Python component has no build or lint default, for example), is
  still unconfigured: set the repository's `gateCommands` for it.
- **On-demand tools reach only the commands the platform runs through its own exec.** The agent's
  `bash`, the gates and other workspace commands see `/workspace/.tools/bin` on `PATH`; the Claude Code
  runtime and any command started outside that exec do not.
- **A catalog entry is a `.tar.gz` holding one executable.** There is no post-install script, no
  package-manager install and no heavy toolchain (a full JDK, Rust, .NET); those stay on executor
  images. A row is as trustworthy as the person who wrote it: the platform verifies the download
  against the row's digest, not the digest against anything upstream.
- **The onboarding pull request uses the platform credential only.** A user's own token
  ([`user-github-credentials.md`](./user-github-credentials.md)) is not used for it. The checklist
  records its URL only after a client reads the completed onboarding workflow status.
- **A standalone gate run installs no tools.** The path that runs gates outside an implementation
  run has no connection to read tool declarations from, so a repository whose gates need an
  on-demand tool fails there with exit 127. Gates inside an implementation, CI verification and UI
  verification do get them.
- **A revoked built-in row stops following code.** Resetting a revoked built-in restores the code's
  values but keeps it revoked and customized, so a later corrected digest in code does not reach it;
  un-revoke it with an edit, then reset it, to follow code again.
- **Changing a repository's URLs, team or default branch clears `toolsFileEnabled` when a non-admin
  does it.** The administrator's decision to honour the file was about that repository at that ref,
  so an administrator has to enable it again.
- **There is no download mirror setting.** An air-gapped cluster has to allow the catalog's hosts or
  carry its own catalog rows pointing at an internal mirror.
- **Tools are downloaded on every run.** There is no cache across runs, so each run pays the
  download.
- **A tool's checksum is verified at install, not afterwards.** The agent can overwrite the binaries
  in its own container, as it can any file it can write.
- **A mixed-stack layout has no single image.** Set the repository's `executorImage` to one that
  carries every toolchain, or the components whose tools the default image lacks exit 127.
- **The composite shares one run's test budget.** The timeout scales with the number of components
  but is capped at four times the single-run limit, and the output the agent sees is split evenly
  across components.
- **The stack fallback follows the stored detection.** A repository is scanned when it is onboarded
  and then weekly; one whose onboarding scan did not record anything keeps the built-in `yarn` gates
  until the next weekly scan, and a root that changed stack is followed only after a rescan. A run
  reads the detection its connections had when it began (for the connections it may use), found
  through the run's workflow id, so a scan landing mid-run does not move its later steps to another
  image or directory. A later execution that reuses the workflow id takes a fresh snapshot; every attempt and
  retry of one execution keeps that execution's first. A repository first scanned after the run began has no
  recorded detection for that run. Runs that began before the pin existed, and a connection
  outside the run's authorized set, read the live value. A polyglot root (root `package.json` plus a Python
  service) is a Node target, and the service gets no default gates: making the defaults cover both would run
  `pytest` in an image that may not have it. The repository form says so instead, listing the components
  the root's defaults do not cover (those whose first stack differs from the root's), and a `gateCommands`
  entry that `cd`s into them is the fix. A single component is chosen only when it is
  the only one seen, which a repository whose real build is a `Makefile` beside one lone nested `package.json`
  would satisfy wrongly; the `cd` in the recorded command is how that shows, and `gateCommands` is the
  fix. A Python `runTests` assumes `pytest` is installed by the repository's own setup.
- **Stack detection is bounded.** It ignores signals deeper than four directories, and anything
  under the ignored build/vendor directories. It records at most 50 components
  (`componentsTruncated`). When the provider truncates a very large tree (`treeTruncated`), it
  only sees part of the repository. Node gate-command suggestions come from the root
  `package.json` only, so a repository with no root stack gets none.
- **Overrides must be base URLs on one host each.** A GitHub Enterprise server served under a path
  prefix rather than at the root of its host cannot be expressed: the web base is stored as an
  origin.
- **Only GitHub Enterprise Server hosts can have their own webhook secret.** The choice of secret
  keys on the `X-GitHub-Enterprise-Host` header (see below), which github.com does not send, so
  github.com deliveries always use the instance secret. Outside the binding a per-host secret
  provides, a payload is matched to a repository by host only when it carries
  `repository.html_url` and the owner/name is onboarded on more than one host.
- **A host has one credential set.** One PAT and one App per host; installations are per host and
  chosen per repository. A repository's installation host is checked when an admin chooses it or
  repoints the repository, and again whenever a token is minted: a repository whose installation is
  recorded for another host gets no token (`REPO_INSTALLATION_HOST_MISMATCH` for runs, `host-mismatch`
  for lookups) until it is pointed at an installation of its own host. An installation whose host is absent counts as
  a mismatch, so no caller can skip the check by not loading it.
- **Installation webhook events only update installations an admin has registered, on the host
  that signed them.** An `installation` event with `deleted`, `suspend` or `unsuspend` makes the platform ask
  GitHub for the installation's state with its host's App credentials, and apply only what GitHub
  reports (retire when deleted or suspended, reactivate a webhook-retired one when active); an
  `installation_target` rename reads the login from GitHub. A host with no App credentials, or a
  failed lookup, changes nothing; lookups on a GitHub Enterprise Server host go to
  `https://<host>/api/v3`, so a host on plain http or a non-default API path is never updated. Each change is audited with no actor. An event for an
  installation nobody registered, or on a host the delivery's secret does not prove, changes nothing,
  so GitHub can never add one. A retirement an admin made is never undone by GitHub, and any admin
  edit of the active flag clears the webhook's claim. An installation on github.com or a `*.ghe.com`
  host, whose deliveries always use the instance secret, is updated only when that host is the
  instance's own.
- **Rolling upgrades can start one ticket twice.** A gateway or worker still running the code that
  built workflow ids from the stored casing starts `eng-Acme-Api-T-1` while an upgraded one starts
  `eng-acme-api-T-1`, and neither sees the other's run as a duplicate. Drain the old gateways and
  workers before upgrading, so no process is allocating ids under the old form.
- **A run's earlier id form is derived from the casing stored now.** The legacy ids that block a
  duplicate are rebuilt from the repository's current owner and name, which no API route edits, so
  they match the id a run was started under; a database edit that changes only the casing while a
  run is in flight would leave that run's id unmatched.
- **A run on an archived duplicate row still blocks the ticket.** Rows for one repository count as
  one when workflow ids are allocated, whether or not they are active, and deactivating a connection
  does not cancel its runs. A non-terminal run on an archived duplicate therefore blocks a second
  start of that ticket on the live row until it finishes or is cancelled.
- **Changing the instance's host does not rewrite stored overrides.** An override spelling out the
  instance's host is cleared when it is written, against the host the integration resolves (the
  saved one, else the environment's), so two onboarding requests racing each other collide on the
  database's unique index. A repository onboarded on a host that later becomes the instance's keeps
  its override: it works, and onboarding treats it as the same repository as one with no override,
  but the unique index does not.
- **Some runs can only be controlled by a platform admin.** A run on a global template, against no
  repository, that nobody launched (a webhook start, or one from before launchers were recorded) is
  visible to everyone but can be cancelled, or its human steps answered, only by an admin.
- **A deactivated team keeps its members' access and its shares.** `Team.isActive` gates managing
  (creating, editing and moving repositories, leading templates, saving a per-user credential
  against a repository, creating an MCP connection) and the team listing, not
  membership: the members of an inactive owning team still reach its repositories, and the members
  of an inactive team a repository was shared with still reach that one. Removing the share is what
  ends a shared team's access, and only active teams of the organization can be chosen when sharing.
