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

Importing lists repositories from the instance's own host and onboards them with no override. The
repository-level URLs a GitHub listing returns are not base URLs; stored as overrides they made every
clone and API call land on a path that does not exist.

### Who may onboard

Onboarding (`POST /repositories`, which the import dialog also uses) needs the LEAD role in the
target team. A caller who is not a platform ADMIN must also be able to **read the repository on
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

### Gate commands

A repository can give each gate step its own command (`Connection.gateCommands`): `runLint`,
`runTypecheck`, `runTests`, `runBuild`, `runVulnScan` and `runPerfBench`. A gate step that sets no
`command` of its own runs the repository's, else the worker's built-in default; the implementer's
test loop reads `runTests` the same way. They are edited in the connection form's **Gate commands**
section (when onboarding or editing), with `POST /repositories` / `PATCH /repositories/:id`
`{ gateCommands }` — a PATCH replaces the stored set; a gate left out, null or blank falls back to
the default, and `null` clears them all — or with the CLI's `auto-swe repos gate-commands`.

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
a `/workspace` the exec user can write to. When `git` is missing the workspace
tries to install it (`apk`, then `apt-get`) before giving up with an error
naming this contract; `ripgrep` is optional but recommended — Pi's grep
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

`defaults/` holds curated executor bases — `Dockerfile.node`, plus
`Dockerfile.python` (Python slim + `uv`), `Dockerfile.go` (Go on Debian) and `Dockerfile.jvm` (Temurin JDK +
Maven, daemons off). `build-executor.yml` builds one of them per run: the
`stack` input (`node`|`python`|`jvm`|`go`, default `node`) selects it, unless
`use_repo_dockerfile` builds the repository's own Dockerfile instead.

**Recording the build.** A build writes the image back to the connection together with
`executorImageBuild` (`{ stack, useRepoDockerfile }`), the settings it was built with. Like the
image, only a platform admin may set the record; anyone may clear it. Clearing or changing the
image without a new record clears it too. Re-saving the connection with its current image keeps
it.

**Weekly rebuild.** Every Monday a scheduled run lists the active repositories and rebuilds each
one that has an `executorImageBuild`, using the recorded settings, so its image picks up
base-image fixes. Each stored value is validated before it is used. Rebuilds run four at a time,
and one repository's failure doesn't stop the others.

### Detected stack

The dependency scan also records the repository's stacks on the connection
(`detectedStack`, with `detectedStackAt`). It reads the repository tree recursively. It runs on the
weekly schedule and once more when a repository is onboarded, so a new repository has its stack
before its first run. The onboarding scan is started after the repository is saved and is
best-effort: if it cannot be started, or runs before the repository's credentials work (it then
records nothing and is not retried), the weekly sweep records the detection.

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
  rc=0; ur=0; ck() { if [ "$1" -ne 0 ]; then if [ "$1" -eq 126 ] || [ "$1" -eq 127 ]; then ur=$1; elif [ "$rc" -eq 0 ]; then rc=$1; fi; fi; }; echo; echo '== auto-swe component: api =='; (cd 'api' && mvn -B -ntp test) 2>&1; ck $?; echo; echo '== auto-swe component: web =='; (cd 'web' && npm test) 2>&1; ck $?; if [ "$rc" -ne 0 ]; then exit $rc; fi; exit $ur
  ```

  The exit status is the first **real** failure's — any status other than 126 or 127, a missing
  directory included. A part that is not runnable (126, 127) decides the status only when no part
  really failed, and then the last of them does, so a missing tool in one component cannot hide
  another component's failing tests from the test loop. All parts passing is 0.

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
| `GET /api/v1/repositories/:id/share-candidates` | the owning team's leads, platform admins | Active teams in the owning team's organization, other than the owner |
| `PUT /api/v1/repositories/:id/shares` | the owning team's leads, platform admins | Replace the set of teams it is shared with; audited |

Shares are limited to the owning team's organization, so a repository never crosses a tenant
boundary this way. Moving a repository to a team in another organization drops the shares that no
longer fit.

---

## Limitations

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
- **A mixed-stack layout has no single image.** Set the repository's `executorImage` to one that
  carries every toolchain, or the components whose tools the default image lacks exit 127.
- **The composite shares one run's test budget.** The timeout scales with the number of components
  but is capped at four times the single-run limit, and the output the agent sees is split evenly
  across components.
- **The stack fallback follows the stored detection.** A repository is scanned when it is onboarded
  and then weekly; one whose onboarding scan did not record anything keeps the built-in `yarn` gates
  until the next weekly scan, and a root that changed stack is followed only after a rescan. Each activity reads the detection itself, so a scan that
  lands mid-run can move the run's later steps to another image or directory than its earlier ones; a run
  is not pinned to the detection it started with. A polyglot root (root `package.json` plus a Python
  service) is a Node target, and the service gets nothing. A single component is chosen only when it is
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
