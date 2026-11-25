# Campaigns

A campaign is a **goal over a set of repositories, worked until the goal holds**: "no repository
declares `lodash` below 4.17.21", or "every service has moved to the new client library". It owns
three things a one-shot fan-out does not: a **check** that says whether one repository satisfies the
goal, a **target set** that can grow, and a **delivery state** per target that follows its draft
pull request through review to merge. A target is done when the check passes on the base branch,
whether the platform's pull request merged or a person fixed the repository by hand.

The platform starts one child run per repository, a few at a time, and records for each repository
what happened: a draft pull request opened, merged, satisfied, blocked, or waiting for a person.
Humans review and merge every pull request, unless its repository is in `auto` mode, where GitHub
may merge a qualifying low-risk one once a person has marked it ready
([pull-request evaluation](./pr-evaluation.md)). The campaign itself never merges and never closes a
pull request; it reads what happened to them.

A campaign is deterministic first. When the launch names a **recipe**, a script the platform owns
and versions makes the change in a sandbox, with no model involved, and the same recipe can run
read-only as the check. The agent runs only when there is no recipe or the recipe cannot apply, and
once more to fix a change that fails verification. Every change, whoever made it, is verified by the
repository's **original** tests.

Campaigns are off by default (`workflow.campaignsEnabled`). The API is described in §8 and the
dashboard in §8.1; every child also appears in the existing run and pull-request views. An epic is a
`PLANNED` campaign (§12). A campaign launched on the legacy campaign workflow runs to the end on
it (§13).

## 1. The model

| Concept | Meaning |
|---|---|
| **Campaign** | A goal, its check, the targets reconciled toward it, and how work is decided and ordered. Workflow ID `campaign-<campaignId>` |
| **Check** | A recipe run read-only against a repository's default branch (§3.1). Exit 0 means satisfied, exit 1 means not satisfied, any other code means the check could not run. A campaign with no check has no discovery and cannot confirm a merge, so it ends when its pull requests merge (§6) |
| **Target** | One repository in the campaign, with a state (§6) and a list of attempts |
| **Attempt** | One child run for one target. A retry adds an attempt; it never rewrites one |
| **Plan** | How the work of each target is decided. `UNIFORM`: the campaign's brief and recipe apply to every target. `PLANNED`: the `planner` agent decomposes the brief into one brief per repository and the order between them, and the launcher reviews that before anything starts |
| **Gate** | When a target with upstream targets may start: `OPENED` (each upstream has a draft pull request open, or is merged or satisfied) or `MERGED` (each upstream has merged and its check has passed; with no check, merged is enough). It has an effect only where targets have `dependsOn` edges, and only a planned campaign has edges. The default is `OPENED` |
| **Scope** | Where the check may look for repositories that are not targets yet: a team's repositories, or the campaign's organization. Absent means the target list changes only when a person adds one. A scope needs a recipe with a check |
| **Launcher** | The person every child acts as. Frozen at launch; a lead of the owning team or an administrator can take the campaign over (§11.5) |

### How a campaign runs

A campaign launches on one of two workflows, chosen at launch by `workflow.campaignReconciler` for the
owning team and recorded on the campaign (`workflowKind`, `RECONCILER` or `LEGACY`). A campaign runs
to the end on the workflow it launched on, so turning the setting on or off moves no running campaign.
The setting is off by default, so a deployment launches legacy campaigns until an administrator turns
it on for a team or an organization at `/admin/platform-settings`.

- **The reconciler** (`CampaignReconcilerWorkflow`) holds no queue. The database rows are the
  truth, and the workflow reads them on every pass, decides, and acts through activities: it asks the
  gateway to start an attempt, runs a sandboxed check, and writes rows conditionally. It sleeps
  between events, and a daily backstop recovers any wake-up that never arrived (§11).
- **The campaign workflow** (`CampaignWorkflow`) fans a fixed list of repositories out once, keeps its
  queue in the workflow for up to 30 days, and ends when every target has an outcome. §13 describes
  it, and §9 and the Limitations say what only a reconciled campaign can do.

Every section below describes the reconciler unless it says it is about a legacy campaign.

## 2. Launch

One `POST /api/v1/campaigns` writes, in one database transaction with the launch ledger:

- a `Campaign` row: the name, the brief, the owning team and its organization, the recipe and its
  parameters, the pinned template and version, the frozen limits, the launcher, the workflow kind
  and the Temporal workflow ID `campaign-<campaignId>`;
- one `CampaignTarget` row per repository, in the order the request listed them, each carrying the
  repository's owning team at launch and a `org/repo` label;
- a work request and a spend-ledger row for the campaign as a whole, marked cross-repository and
  pinned to a template, which keeps a campaign out of the legacy epics list.

The campaign workflow is started after those rows commit. If it cannot be started, the ledger rows
are removed and the campaign and its targets go with them, so a failed launch leaves nothing behind.
A reconciled campaign's workflow input is only the campaign's id: everything else is read from the
rows. A legacy campaign's input carries the limits, template version, target order and recipe payload
the gateway froze, because that workflow cannot read the database.

A uniform campaign pins the built-in `dependency-upgrade-campaign` template at its active version, so
editing the template later does not change a campaign in flight. A planned campaign pins the owning
team's default template; each attempt resolves the default of its own repository's team. A campaign
launches in `STARTING` (uniform) or `PLANNING` (planned).

### Who may launch

A campaign pushes branches and opens pull requests in every repository it names, so it takes the
strictest launch decision the platform has. All of these hold, in this order:

1. The caller is signed in. The platform role does not matter.
2. The owning team exists and is active, and the caller is `LEAD` or `ADMIN` on it
   (`team.launch.multi-repo`), or a platform `ADMIN`. The owning team decides the campaign's
   organization and who may control it.
3. Every repository exists, is active and is a git repository.
4. The caller is `LEAD` or `ADMIN` on the team that owns **each** repository, or a platform ADMIN
   (membership through a share does not count). This is decided before anything is said about a
   repository's organization or settings, so a caller cannot use the next refusals to learn which
   repositories of other teams are in another organization or have campaigns turned off. The refusal
   (`403 FORBIDDEN`, reason `team-lead-required`) names the repositories whose team the caller belongs
   to and counts the rest.
5. A `UNIFORM` campaign's repositories all belong to the owning team's organization
   (`CAMPAIGN_CROSS_ORG` otherwise). A `PLANNED` campaign may name repositories of more than one
   organization, as an epic can (§12). Every repository is served by GitHub
   (`409 SCM_PROVIDER_UNSUPPORTED` otherwise, naming the repositories and their provider): the
   recipe's push, the draft pull request and per-user credentials all go through the GitHub
   integration.
6. `workflow.campaignsEnabled` is on for the owning team **and** for the team that owns each target
   repository. One team with it off refuses the whole launch (`CAMPAIGNS_DISABLED`), naming the owning
   team and the repositories the caller belongs to.
7. The number of repositories does not exceed `workflow.campaignMaxTargets` for the owning team.
8. The inputs only the reconciler can honour (a `PLANNED` plan, `gate`, `scope`,
   `maxOpenPullRequests`, `staleAfterDays`, `rescanIntervalHours`, `budgetUsd`, `lifetimeDays`, an `@2`
   recipe) are refused with `CAMPAIGN_RECONCILER_REQUIRED` when the owning team launches legacy
   campaigns, naming each one, rather than being dropped. A planned campaign takes no recipe
   (`CAMPAIGN_PLAN_INVALID`) and no scope (`CAMPAIGN_SCOPE_INVALID`). A scope needs an `@2` recipe,
   and a `TEAM` scope names a team of the campaign's organization that the caller belongs to (an
   administrator may name any); an `ORG` scope is the campaign's own organization and needs the
   caller's membership of it.
9. The recipe, when given, passes the strict parameter check in §3.
10. The template is present, and a payload for one target satisfies its input schema.
11. The standard launch authorization for a fan-out: repository access for every repository, team
    `LEAD` or `ADMIN` on the team that owns **each** repository (membership through a share does not
    count), membership of the organization, and the organization's and teams' monthly budgets.

The gateway resolves the limits and defaults and **freezes them into the campaign**: `maxParallel`
(clamped to `workflow.campaignMaxParallelChildren`), `maxOpenPullRequests` (clamped to
`workflow.campaignMaxOpenPullRequests`), `staleAfterDays`, `rescanIntervalHours`, `budgetUsd`,
`expiresAt` (the launch time plus `lifetimeDays`), the gate, the scope and the launcher
(`launchedById`). A later change to a setting moves none of them. The number of times a satisfied
target may regress before it needs a person is fixed at 3.

Every child is launched as the launcher, so a child may use the launcher's own saved token where
per-user credentials are enabled ([user-github-credentials.md](./user-github-credentials.md)).

The in-app assistant cannot launch a campaign: the route is refused to it outright, because one call
can open a draft pull request in up to `workflow.campaignMaxTargets` repositories of other teams. It
can read campaigns and, after the person confirms, cancel, pause or resume one. It never confirms,
adds targets, retries, removes, or takes over (§8). The orchestrator can **propose** a campaign, which
the launcher reviews in the Start form before anything exists
([orchestrations.md §5.1](./orchestrations.md#51-proposing-a-campaign)).

### Re-decided at every start

A campaign starts its children over days or weeks, each as the launcher, so the launch decision is
made again, by the gateway, on every attempt (§11.3): the setting for both teams, the launcher's
account, organization membership and lead of the owning team, the repository, the gate and limits,
the organization's and teams' budgets, the campaign's own budget, and the launcher's **live GitHub
push permission** on the repository. The repository-access gate that judges a request's own token stays
a launch-time check, since a worker holds no request token. A refusal for one repository ends that
target `SKIPPED` with the reason, prefixed `not started:`; a refusal that concerns the whole campaign
pauses it.

## 3. Recipes

A recipe is a pair `{ ref, params }` where `params` is exactly `{ packageName, targetVersion }`.
The catalogue is code, versioned in the ref (`@1`, `@2`); there are no admin- or bundle-defined
recipes.

| Ref | Handles | Image | Parameters | Check |
|---|---|---|---|---|
| `npm-dependency@1` | a root `package.json` with a `package-lock.json` | `node:24-alpine` | an npm package name; an exact version such as `4.17.21` | none |
| `npm-dependency@2` | the same | `node:24-alpine` | the same | yes |
| `go-module@1` | a root `go.mod` | `golang:1.26-alpine` | a Go module path; an exact version such as `v1.9.0` | none |
| `go-module@2` | the same | `golang:1.26-alpine` | the same | yes |

An `@1` ref only makes the change, so a campaign launched with one has no check, no discovery and no
confirmation that a merge satisfied the goal. An `@2` ref makes the same change and also runs read-only
as the check (§3.1). Both entry points of an `@2` ref embed one decision text, so a repository `apply`
would change is exactly one the check calls not satisfied.

Parameters are validated by one shared schema in two places, the gateway at launch and the worker
before any command is built. They are strict: an npm name is a registry name (optionally scoped), a
version is an exact semantic version, and anything else is refused with `CAMPAIGN_RECIPE_INVALID`:
Git, file and URL specifiers (`github:org/repo`), ranges and tags (`^4.17.0`, `latest`), shell
syntax (`$(…)`, `;`), a leading dash that would read as an option, spaces, and unknown keys. The
template's own input pattern is deliberately wider, because an input pattern cannot express these
shapes; the gateway's check is the strict one. Inside the script the values are only ever the
value of an environment variable written with the shell-quoting helper, never part of a command
word or of the text of the small `node` and `awk` programs the script runs.

A recipe runs through the same machinery as a `shell` workflow step: the allowlisted image above,
the repository cloned into a volume that holds no credential, the run's egress policy, a
wall-clock bound, and a commit and push only when the script exits 0. The script's exit code is its
whole interface:

| Exit | Meaning | What happens |
|---|---|---|
| 0, files changed | The recipe made the change | It is verified (§5) |
| 0, nothing changed | **Not affected**: the root manifest does not declare the package (npm) or require the module (Go), there is no root manifest, or it is already at the version. A package used only transitively counts as not affected (see Limitations) | The child ends `SUCCESS` with `changed: false`; no pull request |
| 3 | **Cannot apply**: a Yarn, pnpm or Bun lockfile, an npm shrinkwrap, no `package-lock.json`, a workspaces repository that does not list the package at its root, or a dependency declared as something other than a plain version range (npm); a module that vendors its dependencies (`vendor/modules.txt`) or a `go.work` workspace (Go) | Nothing was pushed; the agent takes over. If the agent then changes nothing, the child ends `FAILED` (never not affected) |
| 4 | The tool ran but the lockfile or `go.mod` does not end at the requested version | Nothing was pushed; the agent takes over, as for 3 |
| other non-zero | The tool failed (install error, no network) | Nothing was pushed; the agent takes over, as for 3 |

**The recipe builds only on a branch it creates.** Before the recipe runs, the step resolves the
base branch's tip on the host and records it by sha, and refuses a work branch that already exists
on the host. Both lookups read the exact branch head (`refs/heads/<name>`), so a tag or another ref
named like either branch neither refuses the recipe nor becomes its base. The clone checks again: a
work branch that appeared after that lookup is refused when it is cloned, before the script runs,
whether or not the script would have changed anything (a branch someone pushed already at the target
version would otherwise read as not affected). After the recipe pushed, its commit's parent must be
that recorded sha. Any of these refusals ends the child `FAILED` (`path: RECIPE`, `verification: NOT_RUN`) with the reason, and neither the
agent nor verification runs on that branch. Without this, anyone with push access to a target
repository could create the campaign's branch ahead of it with weakened tests, the recipe would
commit on top, and verification would restore the tests to that commit. A run of the template
started by hand with a ticket whose branch already exists is refused the same way; delete the
branch first.

`npm-dependency` runs `npm install --package-lock-only --ignore-scripts`, keeping the declared
range style (`^`, `~` or exact) and the section (`dependencies`, `devDependencies` or
`optionalDependencies`). `--ignore-scripts` is mandatory. `go-module` runs `go get` and
`go mod tidy`, and never `go mod vendor`: a vendored module would be left with a stale `vendor/`,
so it is refused as cannot apply, and so is a `go.work` workspace, whose build list spans modules
the recipe does not read. Because a failing recipe pushes nothing, the agent that follows starts cleanly from
the base branch.

A campaign without a recipe is **agent-only**: the brief is everything the agent has. That is the
shape for a framework upgrade no script covers. A planned campaign is always agent-only, with a brief
per repository.

### 3.1 The check

The check is an `@2` recipe's read-only entry point. It runs as an activity of the reconciler, not as a
child run, because it takes seconds. It uses the shell-step sandbox with three differences: the
repository's **default branch** is cloned into a volume that holds no credential, the container has
**no network** at all, and there is no commit, no push and no model. The volume is removed afterwards
whatever the script did to it. The image must be on the team's shell-image allowlist, as for an apply.

A check script ends with one evidence line,
`CAMPAIGN_CHECK evidence=<kind> detail=<token> declared=<version|-> resolved=<version|->`, whose values
are fixed tokens or versions the decision parsed as semver, never repository text, so a repository
cannot forge it. The platform reads the exit code and the evidence together and fails closed:

| Exit | Evidence kind | Result |
|---|---|---|
| 0 | `declared-at-target` (the repository declares the package at or above the target; for npm the lockfile resolves it at or above too) or `not-declared` (no root manifest, or the package or module is not a dependency of it) | **Satisfied** |
| 1 | `below-target` (declared or required below the target, or for npm locked below it or not locked) | **Not satisfied** |
| 3 | `cannot-check`: an unsupported layout (a workspaces repository that does not list the package at its root, an unsupported lockfile, a dependency declared as something other than a plain range, a vendored Go module, a `go.work` workspace, an unparseable version) | Could not run |
| 5 | The decision program itself failed | Could not run |
| anything else, a timeout, a missing or contradictory evidence line, a refused image | | Could not run |

Versions compare by semver precedence: a lower version, and a pre-release of the target, are below it.
A check that **could not run** is neither a pass nor a regression: the target stays where it is, the
reason is recorded on it, and a later pass tries again. A check never decides a repository is satisfied
or has regressed on a guess. Every answer is recorded on the target as `evidence` (`kind`, `detail`,
`declared`, `resolved`, `checkedAt`, the recipe `ref`, and `reason` when it could not run), with
`lastCheckedAt` and the sha of the default branch that was checked (`lastCheckedSha`), so a reader can
tell a repository that was fixed (`declared-at-target`) from one that was never affected
(`not-declared`). A target that finished with no change, and one a migration carried over as satisfied
(`kind: initial`), has no check evidence until the next check.

The check inherits the recipes' known limits (see Limitations).

## 4. What each child runs

Every child of a uniform campaign is a run of the `dependency-upgrade-campaign` template, pinned at
launch to the version that was active then. The same template is a complete workflow on its own
([maintenance-workflows.md §3](./maintenance-workflows.md#3-dependency-upgrade-campaign)). A planned
campaign's children run the default template of their repository's team, with the target's own brief.

```
 recipe given?
   yes ──> apply the recipe ──┬─ work branch not cut by this step ────────> run ends FAILED
                              ├─ applied, no files changed ───────────────> done: not affected
                              ├─ applied, files changed ──┐
                              └─ not applied ─┐           │ path RECIPE
   no ───────────────────────────────────────┐│           │
                                              v v           │
                                  agent makes the change     │
                                    │            │           │
                          nothing changed   changed (path AGENT)
                                    │            │           │
                                    v            └─────┬─────┘
            no recipe: done: not affected              │
            after a recipe: run ends FAILED            v
                                           verify with the original tests
                                              │                │
                                            passed           failed
                                              │                v
                                              │     agent fixes it, once
                                              │     (RECIPE becomes RECIPE_THEN_AGENT)
                                              │                v
                                              │     verify again
                                              │        │             │
                                              │      passed        failed
                                              v        v             v
                                         open a DRAFT pull request   run ends FAILED,
                                         done: SUCCESS               verification FAILED,
                                                                     no pull request
```

There is no review network and no CI-fix loop in a child: a campaign adds no pushes after the
draft opens, and the host's CI on the draft is what the reviewing person reads.

The first attempt of a target works on `<BRANCH_PREFIX>/CAMPAIGN-<id12>` (the first 12 hex digits of
the campaign id); attempt `n` after the first works on `<BRANCH_PREFIX>/CAMPAIGN-<id12>-<n>`, because
the first branch exists on the host. The child's workflow ID is `campaign-<campaignId>-<connectionId>`,
with `-<n>` appended after the first attempt.

## 5. Verification the agent's test edits do not count in

The risk in letting an agent upgrade a dependency is that it makes the tests pass by changing
them. Two mechanisms close it, both described in
[ci-failure-triggers.md §2.4](./ci-failure-triggers.md#24-the-test-integrity-guard):

- **Protected verification.** The `runTests` gate of the template runs with `protectTests: true`.
  In its own workspace, right after the clone and before the repository's setup and the tests run,
  it restores every protected file the change touched to its content at the change's recorded
  base, and removes protected files the change added. Protected, by file-name convention:
  - test files (`*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*Test.java`, scripts under
    `__tests__/`, …);
  - test support files: anything under `test/`, `tests/`, `spec/`, `__tests__/`, `__snapshots__/`,
    `__mocks__/`, `fixtures/`, `__fixtures__/`, Mock Service Worker's `src/mocks/`, Go's
    `testdata/`, and helper directories named `testutil(s)`, `testhelper(s)`, `test-utils` or
    `test_helpers`, plus a `test-utils.*` module and `conftest.py`;
  - runner setup files, which run inside every test: `jest.setup.*`, `vitest.setup.*`,
    `setupTests.*`, `test-setup.*`, `setup-jest.*`, `setup.*` under `jest/` or `.jest/`, anything
    under `cypress/support/`, Angular's `src/test.ts`, `karma.conf.*`, `.rspec`;
  - pure test-runner configuration: `jest`, `vitest`, `playwright`, `cypress`, `karma`, `mocha` and
    `ava` config files, `.mocharc`, `pytest.ini`, `phpunit.xml`, `.nycrc`.

  Babel and Vite configuration are deliberately not protected: they configure the production build
  as well as the tests, and an upgrade can legitimately need them changed, like a manifest.
  Nothing inside a package manager's copy of third-party code is protected, whatever its name:
  `vendor/`, `node_modules/`, `bower_components/` and `.yarn/`, at any depth. Their test files and
  helpers are the dependency's, and an upgrade rewrites them (`go mod vendor`), so restoring them
  would revert part of the upgrade.
  The recorded base is the one the change's code result carries, read before any agent or recipe
  ran: the base branch's tip when the agent's workspace was created, or, for a recipe, the base
  branch's tip resolved on the host before the recipe's clone, which the commit the recipe pushed
  must have as its parent (§3). It is never a merge base computed at verification time, which an agent could move
  by rebuilding its commit on an older ancestor. The gate also refuses a branch tip that is not the
  commit the change reported. The restore is never pushed, so the branch keeps the change as made
  and only the verdict ignores any test edit. Manifests such as `package.json` and `go.mod` are
  never restored, because they carry the change. If the original tests cannot be restored, the gate
  fails closed as `PROTECTED_TESTS_UNAVAILABLE` rather than passing.
- **The test-integrity guard at the `block` floor.** Both agent steps set `testIntegrity: 'block'`,
  so a change that deletes, skips or weakens tests, loosens the test command, or weakens CI
  configuration fails before it is pushed, whatever `github.ciFixTestIntegrityGuard` says. This
  covers what restoring files cannot: edits to `package.json` scripts and test settings inside a
  manifest. It also reports an edit to a runner setup file as `test_setup_changed` (high, so the
  floor refuses it) and an edit to a mock, golden file or test helper as `test_double_changed`
  (low, recorded only).

Together they mean an edit to a protected file does not count towards a passing verification. They
do not mean a change cannot reach green through its tests: a test outside the naming conventions,
a test setting inside a manifest the guard's heuristics miss, the gate command, and the change's
own code (which the restored tests import and the setup runs) are not restored, as the Limitations
below state.

Both agent steps also refuse a change to a GitHub Actions workflow or action, a symlink or a
submodule, and the campaign prompt tells the agent its test edits will not count and that nobody is
available to answer a question.

## 6. States

### Targets

One enum with two kinds of value: run states the reconciler writes, and delivery states derived from
the target's pull request. Delivery detail (draft, CI, review, merge time) is **read from
`PullRequest`** through the target's latest attempt's run, never copied onto the target, so it cannot
drift from the pull-request views.

| State | Meaning | Final |
|---|---|---|
| `PENDING` | Not started | no |
| `BLOCKED` | Waiting for an upstream target (the gate has not opened), for the parallelism limit or for the open-pull-request limit. The reason is on the target (`blockedReason` in the API) | no |
| `RUNNING` | An attempt is in flight | no |
| `PR_OPENED` | A draft exists and is `OPEN` on the host | no |
| `MERGED` | The pull request is `MERGED`. With a check, the check has not confirmed it yet | no with a check; **yes for a campaign with no check**, where the merge is as far as the goal can be confirmed |
| `SATISFIED` | The goal holds for this repository: the check passed on the default branch, or the attempt found nothing to change. Evidence and the checked sha are recorded | yes (re-checked, see below) |
| `NEEDS_ATTENTION` | A person must act: the attempt failed or its run was cancelled outside the campaign, the pull request was closed unmerged, the merge did not satisfy the check, or the target regressed more than 3 times | no |
| `SKIPPED` | Not started because the launch no longer held for it (`not started: …`), the launcher could not reach it on a take-over, or a person removed it | yes |
| `CANCELLED` | The campaign was cancelled before the target delivered anything | yes |

A **stale** pull request is a flag, not a state: `staleSince` is set when a draft has been `OPEN`
for `staleAfterDays`, kept at the moment it crossed the line, and cleared when the draft stops being
`OPEN`. It changes no state and starts nothing; the first time it is set, the owning team's Slack
notification channel is told once.

How a target moves:

| From | Event | To |
|---|---|---|
| `PENDING`, `BLOCKED` | The gate or a limit holds it, or releases it | `BLOCKED`, `PENDING` |
| `PENDING`, `BLOCKED` | The gateway starts an attempt | `RUNNING` |
| `RUNNING` | The attempt opened a draft | `PR_OPENED` |
| `RUNNING` | The attempt found nothing to change | `SATISFIED` |
| `RUNNING` | The attempt failed, or its run was cancelled while the campaign was not | `NEEDS_ATTENTION` |
| `PR_OPENED` | The pull request merged | `MERGED` |
| `PR_OPENED` | The pull request was closed without merging | `NEEDS_ATTENTION` |
| `MERGED` | The check passed | `SATISFIED` |
| `MERGED` | The check failed (the merge was only part of the change, or the base moved) | `NEEDS_ATTENTION` |
| `MERGED`, in a campaign with no check | Nothing: it is final | `MERGED` |
| `SATISFIED` | The check, run on the rescan interval, fails | `PENDING` with `regressions + 1`, or `NEEDS_ATTENTION` once the count passes 3 |
| `NEEDS_ATTENTION` | A person retries it | `PENDING` |
| `NEEDS_ATTENTION` | Its pull request is `OPEN` again, or `MERGED` | `PR_OPENED`, `MERGED` |
| any state except `RUNNING`, `SKIPPED` and `CANCELLED` | A person removes it | `SKIPPED` |

A `RUNNING` target is only finished by its attempt. The retired target values `NOT_AFFECTED` and `FAILED` are read as `SATISFIED`
and `NEEDS_ATTENTION`.

In a campaign with a check, a `MERGED` target is checked on every pass until the check answers, and
again every 15 minutes when it could not run. A `SATISFIED` target is re-checked on the campaign's
`rescanIntervalHours` (never shorter than `workflow.campaignRescanFloorHours`, §7) while the campaign is
`ACTIVE` or `MONITORING`.

A campaign with **no check** (no recipe, an `@1` recipe, or a planned campaign) never checks. For it
`MERGED` is a final state: a target whose pull request merged counts as done and is given its
`finishedAt` when the merge is recorded, the dashboard says
"Merged (no check to confirm)", and the campaign completes once every target is `MERGED`, `SATISFIED`,
`SKIPPED` or `CANCELLED`. Nothing confirms that the merge satisfied the goal and nothing notices a
later regression (see Limitations).

### Campaigns

| State | Meaning |
|---|---|
| `STARTING` | A uniform campaign launched; the reconciler moves it to `ACTIVE` on its first pass |
| `PLANNING` | A planned campaign's briefs and order are written (or being written), and the campaign waits for its launcher to confirm. Nothing is checked, discovered or started |
| `ACTIVE` | Targets are being started, awaited or re-checked. A target that needs a person keeps the campaign here |
| `PAUSED` | No attempt starts and nothing is re-checked or discovered. Running attempts finish, and the campaign still follows their pull requests. `pausedReason` says why: `manual`, `launcher-unavailable`, `disabled` or `budget` |
| `MONITORING` | Every known target is final, a scope is set and the campaign has not expired. It wakes on `rescanIntervalHours` (at least the floor of §7) to re-check and to discover, until `expiresAt`. A regression returns it to `ACTIVE`, and so does adding a target (§11.5). A scope needs a check, so a campaign with no check never monitors |
| `COMPLETED` | Every target is final and there is no scope, or `expiresAt` has passed. The workflow ends. A campaign with no check is final at `MERGED` as well as at `SATISFIED`, `SKIPPED` and `CANCELLED`, so it completes when its pull requests have merged |
| `CANCELLING`, `CANCELLED` | §9 |

`COMPLETED_WITH_FAILURES` does not exist for a reconciled campaign: a target that needs a person
keeps it `ACTIVE`, so the page shows work waiting. A campaign with no targets is vacuously complete.
`expiresAt` ends a **monitoring** campaign; it does not stop one that still has a target that is not
final. `MONITORING` and `COMPLETED` are written under the campaign row lock, after the targets that
are not final are counted again in the same transaction: a campaign that gained such a target since
the pass read its rows stays as it was, and the next pass reads the new one.

`COMPLETED`, `COMPLETED_WITH_FAILURES`, `CANCELLED` and `FAILED_TO_START` are final.
`FAILED_TO_START` is a value of the enum that a launch never leaves behind: a workflow that cannot
start is rolled back with its rows.

## 7. Limits and settings

All nine settings are in the `workflow` group, overridable at the team and organization scope and
changeable by an ADMIN. None is pinned to a run. The gateway resolves the size limits and the campaign
defaults at launch and freezes them into the campaign; `workflow.campaignsEnabled` is checked at
launch, by every attempt start (§11.3) and by every reconciler pass, which pauses a campaign whose
owning team, or a team that owns a target still to be worked, has it off (§11.6).

| Setting | Default | Effect |
|---|---|---|
| `workflow.campaignsEnabled` | off | Whether a campaign may include a team's repositories. Checked for the owning team and for each distinct target team, at launch and before each child starts |
| `workflow.campaignMaxTargets` | 25 | The most repositories one campaign may name (1 to 200), resolved for the owning team. A longer list is refused, not truncated. It also bounds targets added later and discovered ones |
| `workflow.campaignMaxParallelChildren` | 3 | The most children in flight at once (1 to 10). A launch may ask for fewer with `maxParallel`, never more |
| `workflow.campaignReconciler` | off | Whether a campaign launches on the reconciler workflow (on) or the campaign workflow (off). Recorded at launch; a campaign runs to the end on the workflow it launched on. An epic launches as a planned campaign only while it is on (§12) |
| `workflow.campaignMaxOpenPullRequests` | 10 | The default for a campaign's `maxOpenPullRequests`, and its ceiling (1 to 100) |
| `workflow.campaignStaleAfterDays` | 14 | The default age, in days, after which a campaign's draft pull request is flagged stale (1 to 365). A stale flag changes no state and starts nothing |
| `workflow.campaignRescanIntervalHours` | 24 | The default hours between re-checks of a satisfied target (1 to 720). A launch may set its own interval within the same range, never below `workflow.campaignRescanFloorHours`, and an epic launched as a campaign takes this default or the floor, whichever is longer |
| `workflow.campaignRescanFloorHours` | 1 | The shortest interval a campaign may re-check at (1 to 720). A launch below it is refused, and the reconciler re-checks a running campaign at the longer of its own interval and the floor, so a change reaches campaigns already running |
| `workflow.campaignLifetimeDays` | 90 | The default days a campaign runs before it expires (1 to 365). The expiry is fixed at launch |

A legacy campaign's Temporal history is bounded by what each child's start event carries: the brief,
the recipe payload and the identifiers, never the launch request, which is stored once on the
campaign's work request. The brief's 8,000-character bound and its character rules keep one child's
start input under 32 KiB, so the child starts of a campaign at the 200-target ceiling stay under
7 MiB, below Temporal's 10 MiB history warning; a unit test measures the worst case. A reconciler's
history holds no child starts (a child is a run of its own) and is bounded by `continueAsNew` after 200
passes.

Pull-request volume is bounded at six points: the target limit, the parallelism limit, the open
pull-request limit, the fact that a repository the change does not affect opens nothing, drafts only,
and no CI loop. Each child is a full run with its own agent, workspace and budget; the optional
`budget` tier of the launch applies to each child.

## 8. API

All routes are under `/api/v1/campaigns`. A campaign the caller may not see answers `404
CAMPAIGN_NOT_FOUND`, never `403`. Every route that changes a reconciled campaign answers
`409 CAMPAIGN_NOT_RECONCILED` for a legacy campaign.

| Route | Who | Answers |
|---|---|---|
| `POST /` | Team `LEAD` or `ADMIN` on the owning team and on every repository's team | `201` (below) |
| `GET /` | Any signed-in user | `200`, the campaigns the caller can see |
| `GET /:id` | Any signed-in user who can see the campaign | `200`, the campaign with its targets |
| `POST /:id/cancel` | The campaign's creator, a `LEAD` or `ADMIN` of its owning team, or a platform ADMIN | `202`, or `200` when it closed the rows (§9). `409 CAMPAIGN_NOT_ACTIVE` once final, `503 CAMPAIGN_SIGNAL_FAILED` |
| `POST /:id/confirm` | The launcher only (an administrator who is not the launcher is refused) | `200 { id, pausedReason: null, state: "ACTIVE" }`. `409 CAMPAIGN_NOT_PLANNING`; `409 CAMPAIGN_PLAN_NOT_READY` until every target has a brief (§11.4) |
| `POST /:id/pause` | Creator, owning-team `LEAD`, or ADMIN | `200` with `pausedReason: "manual"`; an optional `{ note }` is audited. Pausing a paused campaign answers `200`. `409 CAMPAIGN_NOT_PAUSABLE` unless `ACTIVE`, `STARTING` or `MONITORING` |
| `POST /:id/resume` | Creator, owning-team `LEAD`, or ADMIN | `200`, `ACTIVE`. `409 CAMPAIGN_NOT_PAUSED`; `409 CAMPAIGNS_DISABLED` while the setting is off for the owning team and, for a campaign paused as `disabled`, for any team that owns a target (the answer names no other team); `409 LAUNCHER_UNAVAILABLE` unless the launcher's account is active, they still belong to the campaign's organization and they still lead the owning team (the check the attempt route makes) |
| `POST /:id/takeover` | Owning-team `LEAD` or ADMIN (the creator has no right of its own here), never the current launcher | `200 { id, launchedById, pausedReason, skippedTargetIds, state }`. `409 ALREADY_LAUNCHER`, `409 CAMPAIGN_NOT_ACTIVE` (final or `CANCELLING`), `409 CAMPAIGN_CHANGED` when another take-over landed first |
| `POST /:id/targets` | Creator, owning-team `LEAD`, or ADMIN; the caller must also pass the launch decision for each repository | `200 { added, refused }`; each refused repository carries a reason (§11.5), including one that discovery added first. `409 CAMPAIGN_NOT_ACTIVE`; `409 CAMPAIGN_PLANNING` while the plan waits to be confirmed (edit the plan instead). |
| `PATCH /:id/targets/:targetId` | The launcher only, while the campaign is `PLANNING` | `200 { data: { id, brief, dependsOn } }` (§11.4). `409 CAMPAIGN_NOT_PLANNING`; `422 CAMPAIGN_PLAN_INVALID` for a self edge, a target that is unknown or that the launcher cannot reach, or a cycle; `403` for anyone else; `404 TARGET_NOT_FOUND` |
| `POST /:id/targets/:targetId/retry` | Creator, owning-team `LEAD`, or ADMIN | `200 { id, state: "PENDING" }`. `404 TARGET_NOT_FOUND`, `409 TARGET_NOT_RETRYABLE` unless the target needs attention |
| `DELETE /:id/targets/:targetId` | Creator, owning-team `LEAD`, or ADMIN | `200 { id, state: "SKIPPED" }`; an optional `{ reason }` is recorded on the target. `409 TARGET_NOT_REMOVABLE` for a running, skipped or cancelled target |
| `DELETE /:id/targets/:targetId/dependencies/:upstreamId` | Creator, owning-team `LEAD`, or ADMIN; campaign `ACTIVE`, `PAUSED` or `MONITORING` | `200 { data: { id, dependsOn } }`, the edges that remain; the reconciler is woken so a `BLOCKED` target is read again. `404 EDGE_NOT_FOUND` when the target does not depend on that target; `409 CAMPAIGN_NOT_ACTIVE` |
| `POST /:id/targets/:targetId/attempts` | The worker's campaign token only (§11.3) | `201`, or `200` for a retried call |

Visibility for the first three rows: a platform ADMIN sees every campaign; anyone else sees a campaign
when they belong to its owning team or can reach at least one of its target repositories (owning team
or a team the repository is shared with, plus the GitHub permission gate when it is enforced).

The in-app assistant's policy for each route is `read` for the two GETs, `confirm` for cancel, pause
and resume, and `never` for launch, confirm, take over, add targets, edit a target, retry, remove, remove a
dependency and the attempt call.

**`POST /`** body:

| Field | Meaning |
|---|---|
| `name` | 1 to 120 characters, with the same character rules as the brief; shown in lists |
| `description` | The brief: the agent's instructions for the fallback path and the pull request text. At most 8,000 characters, with no control characters other than tab and line breaks and no lone surrogates |
| `ownerTeamId` | The owning team (§2) |
| `repoIds` | One to 200 distinct repository IDs |
| `plan` | Optional: `UNIFORM` (default) or `PLANNED` |
| `recipe` | Optional `{ ref, params: { packageName, targetVersion } }` (§3); absent means agent-only. A planned campaign takes none |
| `gate` | Optional: `OPENED` (default) or `MERGED` |
| `scope` | Optional `{ kind: "TEAM", id }` or `{ kind: "ORG" }`; needs an `@2` recipe |
| `maxParallel` | Optional; clamped to `workflow.campaignMaxParallelChildren` |
| `maxOpenPullRequests` | Optional; clamped to `workflow.campaignMaxOpenPullRequests` |
| `staleAfterDays`, `rescanIntervalHours`, `lifetimeDays` | Optional; the setting's default applies when absent. `staleAfterDays` takes 1 to 365, `rescanIntervalHours` 1 to 720 (the range of `workflow.campaignRescanIntervalHours`) and `lifetimeDays` 1 to 365; a value outside its range is refused. A `rescanIntervalHours` below `workflow.campaignRescanFloorHours` for the owning team is refused with `400 CAMPAIGN_RESCAN_TOO_FREQUENT`, and the default is never below that floor |
| `budgetUsd` | Optional: dollars the campaign's attempts may spend in a calendar month (§11.7) |
| `budget` | Optional budget tier for each child |

It answers `201` with `{ campaignId, temporalWorkflowId, workflowId, workRequestId, targetCount, state, detailPath }`;
a planned campaign answers in `PLANNING`.

An optional `Idempotency-Key` header (1 to 255 characters) makes a retried launch safe. The
campaign's id, and so its workflow ID, is then derived from the key, scoped to the caller and the
owning team (a version-8 UUID of a SHA-256 digest), instead of being random. A request whose key
already launched a campaign answers `200` with the same body plus `deduplicated: true` when the
request is the same (compared with object keys sorted at every depth, so a client that serialises
`recipe.params` in another order is retrying, and every field of the body counts), and
`422 IDEMPOTENCY_KEY_MISMATCH` when it differs; it is answered right after
the owning-team check, before anything the first launch passed is checked again. Two concurrent
requests with one key launch once: the second collides on the ledger's unique workflow ID and is
answered with the first. Without the header every launch is a new campaign.
The refusals, in the order they are checked:

| Status | Code | Cause |
|---|---|---|
| 404 | `TEAM_NOT_FOUND` | The owning team does not exist or is inactive |
| 403 | `FORBIDDEN` | Not `LEAD` or `ADMIN` on the owning team |
| 404 | `REPOS_NOT_FOUND` | A named repository does not exist or is inactive |
| 403 | `FORBIDDEN` | No `LEAD`/`ADMIN` on a target's owning team (reason `team-lead-required`; repositories of teams the caller is not in are counted, not named) |
| 400 | `CAMPAIGN_CROSS_ORG` | A uniform campaign names a repository outside the owning team's organization |
| 409 | `SCM_PROVIDER_UNSUPPORTED` | A repository is served by a source-control provider other than GitHub |
| 403 | `CAMPAIGNS_DISABLED` | The setting is off for the owning team or a target's team |
| 400 | `CAMPAIGN_TOO_MANY_TARGETS` | More repositories than `workflow.campaignMaxTargets` |
| 400 | `CAMPAIGN_RECONCILER_REQUIRED` | An input only the reconciler honours, while the owning team launches legacy campaigns |
| 400 | `CAMPAIGN_PLAN_INVALID`, `CAMPAIGN_SCOPE_INVALID` | A planned campaign with a recipe or a scope; a scope with no `@2` recipe, naming another organization, or a team the caller does not belong to |
| 403 | `FORBIDDEN` | An organization scope without membership of the organization |
| 400 | `CAMPAIGN_RECIPE_INVALID` | Unknown recipe, or parameters that fail the strict check |
| 503 | `CAMPAIGN_TEMPLATE_MISSING` | The built-in template, or the owning team's default template, is not available |
| 400 | `CAMPAIGN_INPUT_INVALID` | The payload fails the template's input schema |
| 403 | `FORBIDDEN`, `REPO_ACCESS_DENIED`, … | From the launch decision: no repository access, or no organization membership |
| 402 | `ORG_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED` | A monthly budget is spent |
| 422 | `IDEMPOTENCY_KEY_MISMATCH` | The `Idempotency-Key` already launched a different request |
| 409 | `CAMPAIGN_ALREADY_EXISTS` | The workflow ID is taken by a campaign this caller cannot be answered with (an ID collision) |

**`GET /`** takes `limit` (default 50, at most 100), `offset`, `ownerTeamId`, `plan` and `state`. Each row
carries `id`, `name`, `description`, `state`, `plan`, `gate`, `workflowKind`, `pausedReason`, `ownerTeam`,
`recipeRef`, `recipeParams`, `createdBy`, `launchedById`, `createdAt`, `updatedAt`, `completedAt`,
`expiresAt` and `counts`: the number of targets in each state over **all** targets, as
`{ total, pending, blocked, running, prOpened, merged, satisfied, needsAttention, skipped, cancelled }`.
The retired values are folded in (`NOT_AFFECTED` counts as `satisfied`, `FAILED` as `needsAttention`).
Counts are numbers only: a viewer learns that other repositories exist and how they fared, not which
they are.

**`GET /:id`** returns the summary with `hiddenTargetCount`, `targets` ordered by launch position, the
frozen settings (`maxParallel`, `maxOpenPullRequests`, `staleAfterDays`, `rescanIntervalHours`,
`budgetUsd`, `scopeKind`, `scopeId`), `launcherChangedAt`, `cancelledAt`, `cancelledById`, the template
and the workflow ids, `planFailure` and `proposals`. A non-admin sees only targets whose repository they can reach;
the rest are counted in `hiddenTargetCount` and never named, so their labels, pull request URLs and
failure reasons do not cross, and a `blockedReason` or `dependsOn` that points at one does not name
it. `proposals` (repositories discovery found and the launcher could not start work in) are shown to
the owning team and ADMINs only, and of those only for repositories the viewer can reach, as targets
are; the others are counted in `hiddenProposalCount` and never named. `planFailure` is `{ at, reason }`
when planning produced no plan (§11.4) and null otherwise; the reason is fixed wording, never raw error
text. Each target carries its state, `brief`, `dependsOn`,
`blockedReason`, `evidence`, `lastCheckedAt`, `lastCheckedSha`, `regressions`, `staleSince`,
`failureReason`, `liveStatus` for a running one, the latest attempt's `path`, `verification` and
`childWorkflowId`, every `attempts` entry (`n`, `runId`, `outcome`, `path`, `verification`,
`failureReason`, times), and `delivery` (the pull request's status, draft flag, CI status, opened and
merged times and URL), read from `PullRequest`. `GET /` and `GET /:id` answer legacy campaigns in
the same shapes, with the reconciler's fields at their defaults.

### 8.1 Dashboard

The dashboard has a **Campaigns** list at `/campaigns` and a detail page at `/campaigns/<id>`.

- **List.** One row per campaign, newest first: name with its kind and recipe, state (a paused campaign
  names why), progress as "N of M satisfied" with the number that need attention and a short
  breakdown of the rest (in review, running, blocked), owning team, who started it and when. It can be
  filtered by state, by kind (uniform or planned) and by team. It refreshes every ten seconds while any
  campaign on the page can still change.
- **Detail.** The brief; banners for a cancelling, paused (with the reason), monitoring or awaiting-
  confirmation campaign; a **Found, not started** card with the repositories discovery proposed (owning
  team and ADMINs only; it names the ones the viewer can reach and counts the rest); and the repositories grouped by what the reader needs: **Needs attention**,
  **In review**, **Running or blocked**, **Satisfied**, **Skipped or cancelled**, under a satisfied
  over total bar. For a campaign with no check the bar reads "N of M done", a merged repository counts
  as done and is labelled "Merged (no check to confirm)". Each row shows its state, the live status of a running one, a link to its latest run
  when the viewer can read it, and its pull request (the platform's review page, or the host's when it
  is not found) with status, draft or ready, CI status and age, and a **Stale** mark. A blocked row
  names what it waits for and links to that upstream. A failed or skipped row shows the reason; a
  satisfied row shows what the check found and when; a regressed one says how often. Expanding a row
  lists every attempt with its outcome, path and verification, and the brief of a planned target.
  Repositories the viewer cannot reach are not listed; a note gives how many there are, and they
  count in the totals. A side panel gives the state, the plan, owning team, who started it, parallelism,
  gate, open pull-request limit, stale limit, scope, re-check interval, monthly budget, expiry and any
  take-over. The page refreshes every ten seconds until the campaign is in a final state.
- **Start.** A **Start a campaign** form (a platform `ADMIN`, or anyone who leads a team; the button is not
  shown to anyone else) takes the fields of `POST /` in §8: name, owning team, brief, the plan
  (uniform or planned) and, for a planned one, the gate; for a uniform one an optional recipe (the
  `@2` refs first, the `@1` refs marked change-only) with its package and exact version; the
  repositories; an optional parallelism and budget tier; and under **Limits and schedule** the scope
  (offered only when the recipe has a check), the open pull-request limit, the stale age, the re-check
  interval, a monthly budget and the lifetime. It offers only the teams the caller leads and, for a
  non-ADMIN, only repositories of teams they lead in the owning team's organization. The gateway makes
  the decision; its refusal is shown in the form. The form sends one `Idempotency-Key` for as long as
  the request is unchanged, so a submit repeated after a lost response answers with the campaign the
  first one launched, and a changed request gets a new key. An orchestration's proposal card opens
  this form pre-filled.
- **Plan review.** A `PLANNING` campaign shows each repository's brief and what it starts after,
  with **Confirm and start** for the launcher; anyone else is told only the launcher can confirm and
  sees the plan read-only. The launcher has an **Edit** button on each repository that opens a form with
  the brief in a text area (1 to 8,000 characters, with a counter) and a checkbox for every other
  repository of the campaign under **Starts after**; **Save** sends only what changed, and the gateway's
  refusal (a cycle, an unknown repository, a campaign no longer `PLANNING`) shows beside the buttons with
  the form left open. **Confirm and start** is disabled, with the reason beside it, while there is no
  planned work or a repository has no brief. A failed plan shows a **Planning failed** alert with the
  recorded reason in place of the awaiting-confirmation banner; it does not disable the button once
  every repository has a brief, so the launcher can write the briefs with **Edit** and confirm.
- **Pause, resume, take over.** The header shows **Pause** (an `ACTIVE` or `MONITORING` campaign),
  **Resume** (a `PAUSED` one) and **Take over** (an unfinished campaign, to a lead of the owning team
  or an administrator who is not the launcher), each behind a confirmation that says what it does. Each
  repository row offers **Retry** (when it needs attention) and **Remove** (any state that can still
  be removed), behind a confirmation, while the campaign is `ACTIVE`, `MONITORING` or `PAUSED`. A
  `BLOCKED` row that waits for upstream repositories also offers **Remove dependency on \<upstream\>**
  for each of them, behind a confirmation that says the repository then starts without waiting for it.
- **Cancel.** The detail page shows **Cancel campaign**, behind a confirmation, to the campaign's
  creator, a `LEAD` or `ADMIN` of its owning team and a platform ADMIN, while the campaign is not in
  a final state. A campaign already `CANCELLING` offers **Send cancel again**, which re-sends the
  cancel (§9).

The dashboard has no control for adding targets to a running campaign or accepting or dismissing a
discovery proposal (see Limitations).

## 9. Cancel semantics

Cancelling stops what has not delivered anything and leaves what has. The route
(`POST /:id/cancel`) records `CANCELLING`, `cancelledAt` and `cancelledById` first, and answers `202`.
A cancel that cannot be delivered answers `503 CAMPAIGN_SIGNAL_FAILED` with the campaign left
`CANCELLING`; cancelling again re-sends it.

**A reconciled campaign.**

- The route cancels the run of every attempt in flight through the run cancel path (a child is a run
  of its own, not a Temporal child of the campaign, so closing the campaign's workflow would not stop
  it), then signals the reconciler. The reconciler reads `CANCELLING` on its next pass, and also when
  its own workflow is cancelled from Temporal: it cancels any attempt still open, closes the campaign
  `CANCELLED` and sets `completedAt`.
- Targets that delivered nothing (`PENDING`, `BLOCKED`, `RUNNING`, `NEEDS_ATTENTION`) become
  `CANCELLED` and are never started. A target with an open or merged draft (`PR_OPENED`, `MERGED`), a
  `SATISFIED` target and a `SKIPPED` one keep their state. Draft pull requests already opened stay
  open, listed in the detail view for people to close; a cancel does not touch the host.
- A single child run cancelled on its own (through the run's cancel route or the Temporal UI) is that
  target's outcome: `NEEDS_ATTENTION` with the reason "the run was cancelled outside the campaign; the
  campaign itself was not cancelled", and the campaign goes on. `CANCELLED` records that the
  campaign's permission-checked, audited cancel stopped the target.
- A cancel recorded on the campaign row stops it even if its signal never reached the workflow: the
  next pass reads `CANCELLING`. That covers a cancel sent before the workflow started.
- A `STARTING` campaign with no workflow to signal is one whose launch has committed its rows and not
  yet started the workflow (or never will). The route does not close it: it stays `CANCELLING`, the
  route writes the `UPDATE` audit row and answers `202`, and when the workflow starts, its first pass
  reads `CANCELLING` and stops as a cancel, so no child starts. Closing the rows instead would let that
  workflow start into a campaign that is already final, which no later cancel could stop. A launch
  whose workflow never starts leaves the campaign `CANCELLING` with no execution; cancelling it again
  closes it as below.
- When Temporal has no running workflow to signal (it closed, was terminated, or is no longer known)
  while the campaign is not `STARTING`, nothing else will ever close the row. The same call then closes
  it in one transaction: the campaign becomes `CANCELLED` with `completedAt`, every target still
  `PENDING`, `BLOCKED`, `RUNNING` or `NEEDS_ATTENTION` becomes `CANCELLED`, every open attempt is
  closed `CANCELLED`, and the other targets keep their outcome. It writes a `Campaign` `UPDATE` audit
  row with the state before, `CANCELLED` after, the number of targets closed and the reason, and
  answers `200` with `state: CANCELLED`. A campaign a late finalizer closed meanwhile keeps the state
  the finalizer wrote.

**A legacy campaign** behaves as follows.

- Targets not yet started become `CANCELLED` and are never started. In-flight children are cancelled;
  each is finalized by its own workflow and its target becomes `CANCELLED`. A child that still ends
  `SUCCESS` (its draft was opened before the cancel reached it) keeps `PR_OPENED` or `NOT_AFFECTED`.
  Targets that already finished keep their outcome.
- Only the campaign's own cancel cancels the campaign: the cancel route's signal, or a cancel of the
  campaign's workflow itself. A single child run cancelled on its own is that target's outcome,
  `FAILED` with the reason "the child run was cancelled outside the campaign", and the campaign goes
  on and finishes `COMPLETED_WITH_FAILURES`. It is `FAILED` rather than `CANCELLED` because
  `CANCELLED` records that the campaign's permission-checked, audited cancel stopped the target.
- A cancel recorded on the campaign row stops it even if its signal never reached the workflow: the
  re-check before the next batch reads `CANCELLING` or `CANCELLED` and stops the same way (§13). That
  covers a cancel sent before the workflow started. Cancelling the campaign's workflow directly (from
  Temporal) behaves the same as the cancel route's signal: the finalizer still runs, also when the
  cancel lands before the first child has started (every target then ends `CANCELLED`).
- When Temporal has no running workflow while the row is `RUNNING` or `CANCELLING`, the route closes
  the rows as above, with only `PENDING` and `RUNNING` targets becoming `CANCELLED`. `CANCELLED` there
  records that the campaign stopped waiting for the target, not that its child stopped: a closed
  campaign workflow asks its children to cancel (Temporal's request-cancel parent-close policy), and a
  child that does not honour the request in time can still open its draft pull request. No workflow is
  left to record that, so the row stays `CANCELLED` with no `prUrl`; the child's own run and the
  repository's pull requests show it.

## 10. Audit

A launch writes the usual `WorkRequest` `CREATE` row with source `campaign` (`epic` for an epic
launched as a campaign), and one `Campaign` `CREATE` row whose `afterJson` holds the name, recipe
reference and parameters, owning team, target count, parallelism, the pinned template and version,
the workflow kind and, for a reconciled campaign, the plan, gate, scope, limits, budget, expiry,
launcher and initial state.

Every route that acts on a campaign writes one `Campaign` `UPDATE` row with the state before and
after and the actor: cancel (`CANCELLING`, or `CANCELLED` when it closed the rows), confirm, pause (with
the note), resume, take over (the previous and new launcher, `takenOverById` and the targets skipped),
add targets (the ids added), edit a planned target (the target, its upstreams before and after, and
whether and how long its brief was edited, never its text), remove a dependency (the target, its upstreams
before and after and the one removed), retry and remove (the target and the reason). Each action that wakes the
reconciler (every one but the plan edit) records whether the wake-up was `signalled`, `not-running` or
`failed`. The gateway's start of an attempt
writes an `UPDATE` row with no actor (the attempt number, branch, workflow ID and the target's state
change), and so does a pause for the campaign's budget.

The reconciler's own state changes (`STARTING` to `ACTIVE`, `MONITORING`, `COMPLETED`, a pause for the
kill switch or an unavailable launcher) and target changes it makes (delivery, checks, blocks,
discovery) write no audit row; they follow from rows and events that are themselves recorded. See
[audit-log.md](./audit-log.md).

## 11. The reconciler

### 11.1 A pass

`CampaignReconcilerWorkflow` runs passes. Each reads the database through one activity (the campaign,
every target with its latest attempt and that attempt's pull request, the discovery proposals, the kill
switch for the owning team and every team that owns a target still to be worked, each resolved under
that team's own organization, the launcher's account
and organization membership, and the campaign's month spend), decides with pure functions, and acts:

1. **Planning.** A `PLANNING` campaign runs the planner once (§11.4) and then waits for its launcher,
   who may edit the plan and confirms it, or for a cancel. A failed plan is not run again, including
   after the workflow continues as new. Nothing else happens in `PLANNING`.
2. **Delivery.** Attempts that ended and pull requests that merged, closed or reopened become target
   transitions (§6), and the stale flag is set or cleared. This runs for a paused campaign too, so it
   keeps following drafts.
3. **Pause.** A paused campaign sleeps. Otherwise a pass pauses the campaign when the kill switch is off
   for any team involved (`disabled`), the launcher's account is inactive or no longer belongs to the
   organization (`launcher-unavailable`), or the budget is spent (`budget`) (§11.6, §11.7).
4. **Re-check.** `MERGED` targets, and `SATISFIED` ones whose rescan is due, run the check (§3.1), at
   most 10 per pass and 3 at a time.
5. **Discover.** When a scope is set, the campaign has a check, it has not expired and the interval has
   passed, the check runs over the scope's repositories the launcher can reach, in chunks of 25, up to
   500 candidates and 1000 repositories a walk (§11.9). A repository that is not a target and not
   satisfied is **added at the end**, up to `workflow.campaignMaxTargets`, when the launcher may start
   work in it (`workflow.campaignsEnabled` for its team and `team.launch.multi-repo` on it). One the
   launcher may not start work in is recorded as a **proposal** with the reason and never started; a
   repository whose check could not run is neither added nor proposed.
6. **Decide and schedule.** The campaign's own state is decided (`ACTIVE`, `MONITORING` or `COMPLETED`;
   the last two are settled as §6 describes),
   targets that must wait are marked `BLOCKED` with the reason and released when it no longer holds, and
   the targets to start are chosen (§11.2).
7. **Start.** The attempts are started one at a time, in order (§11.3).
8. **Sleep** until a signal, or until the earliest of the next due check, discovery, stale threshold,
   expiry and retry, never longer than the backstop.

A pass that fails ends, is logged, and is tried again five minutes later; a failed activity never fails
the workflow. A pass that changed what the next one should see reads again at once, at most five times
in a row.

### 11.2 Ordering and backpressure

Targets start in `position` order while three conditions hold:

- **The gate is open** for every upstream the target depends on (§1). A target that waits for an
  upstream is `BLOCKED` with the upstream's name. When the upstream that is not ready is itself held by
  a target that needs attention, was skipped or was cancelled, the reason names that one, so a person
  sees the cause rather than the nearest link, and a person can retry it (§11.5). A dependency cycle
  blocks the target with its own reason.
- **Children in flight** (`RUNNING` targets) are under `maxParallel`.
- **Open drafts** of this campaign are under `maxOpenPullRequests`. The count is the targets in
  `PR_OPENED` **plus** the targets in `RUNNING` (an attempt in flight becomes a draft) **plus** the
  starts this decision has already chosen, so a burst of starts cannot overshoot the limit. A merged
  pull request no longer counts, so review keeps pace with starts.

A target blocked by a limit is `BLOCKED` until a slot frees. Order alone, without waiting, would be
cosmetic: with gate `MERGED` a downstream target does not start until its upstream's pull request
merged and the check passed.

### 11.3 Starting an attempt

The worker's `startCampaignAttempt` activity calls
`POST /api/v1/campaigns/:id/targets/:targetId/attempts` with a **campaign token**. The worker mints a
fresh token for every call (`camp_` followed by a signed payload, valid for two minutes, keyed from
`CONFIG_ENCRYPTION_KEY` under its own derived key, so an orchestration token never verifies as one),
naming one campaign, one target and one call. It carries no user: the acting identity is the
launcher, read from the campaign row at every call. No token is placed in workflow input, activity
results or Temporal history. The route accepts only that token (a person's session answers
`403 CAMPAIGN_TOKEN_REQUIRED`), and the worker must reach the gateway at `API_INTERNAL_URL`.

The gateway validates in this order and stops at the first refusal. Each is `409` with a code from this
list unless noted:

1. `CAMPAIGN_NOT_ACTIVE`: the campaign is not reconciled, or is not `ACTIVE` or `STARTING`.
   `CAMPAIGNS_DISABLED`: `workflow.campaignsEnabled` is off for the owning team or the target's team.
2. `LAUNCHER_UNAVAILABLE`: the launcher's account is inactive, they left the organization, or they no
   longer lead the owning team.
3. `TARGET_UNAVAILABLE`: the repository no longer exists, is inactive, is not a git repository or has
   changed owner (`404` when the target is not part of the campaign). `TARGET_NOT_STARTABLE`: the target
   is not `PENDING` or `BLOCKED`.
4. `GATE_CLOSED`, `MAX_PARALLEL`, `MAX_OPEN_PULL_REQUESTS`: the gate and limits of §11.2, decided once
   without a lock and **again under a row lock on the campaign**, so two concurrent starts cannot pass
   the same limit.
5. `LAUNCH_REFUSED`: the standard launch decision for one repository as the launcher (repository
   access, organization and team checks, lead on the repository's team, both budgets).
   `PUSH_PERMISSION_REQUIRED`: the launcher's GitHub push permission, asked live through their saved
   credential or verified GitHub login, fails closed. `BUDGET_EXCEEDED`: the campaign's own budget is
   spent, and the campaign is paused with reason `budget`.
6. Under the same lock the gateway reads the campaign and the target again. A take-over that landed
   since the checks ran refuses with `LAUNCHER_UNAVAILABLE` (they ran for another launcher), and a
   target that was removed, cancelled or started by another call refuses with `TARGET_NOT_STARTABLE`.
   A transaction then writes the target's `RUNNING` state first, and the run's ledger rows and the
   attempt (`n` is one more than the target's last) after it; if the target is no longer `PENDING` or
   `BLOCKED` the whole transaction rolls back, so no attempt or run row outlives a removed target.
   The child run is started after the commit, under the attempt's workflow ID with the
   `REJECT_DUPLICATE` reuse policy: that ID names one attempt for good, so a closed execution under it is
   refused like a running one and is never read as room for a second run. The outcome of the start decides
   what happens to the rows:

   - **The start landed**, or Temporal reports that this very workflow ID has already started (a start
     whose reply was lost): the attempt is **adopted**. The rows stay and the call answers as a success,
     because rolling back would reuse the same `n` and meet the same execution on every retry.
   - **The start definitely did not happen** (the client refused the call before any request, the
     connection was refused, or the server answered with a status that rejects the request outright, such
     as an invalid argument or a missing namespace): the attempt and the target's state are put back and
     the ledger is compensated, so the worker's retry starts a clean one.
   - **The start is ambiguous** (a timeout, a reset, an unavailable server, an error nobody recognises):
     the execution may exist, so nothing is undone. The rows stay, the call fails, and the retry with the
     same idempotency key (below) asks Temporal whether the execution exists, adopts it when it does and
     starts it with the same work request when it does not.
   - **A cancel landed in between.** After the start, and again when a retry finds the execution, the
     gateway reads the campaign; when it is `CANCELLING` or `CANCELLED` it cancels this attempt's run
     through the run cancel path, closes the attempt and its target as `CANCELLED` and refuses the call
     with `CAMPAIGN_NOT_ACTIVE`, so no child outlives a cancelled campaign. A retry that finds no
     execution and a campaign already closing starts nothing, closes the unstarted attempt the same way
     and refuses likewise.

The answer is `{ attemptId, branch, n, runId, workflowId }` with `201`. A call with an idempotency key
that was already answered (the worker sends `<campaignId>:<targetId>:<n>`) is answered again with `200`
and the first call's attempt, before any check, so a retried or duplicated call starts one attempt. The
retry first asks Temporal for the attempt's execution (as above), so a call that died after the ledger
commit and before the start still ends with exactly one run.

The worker treats a refusal as an answer, never as an error to retry. `CAMPAIGNS_DISABLED`,
`LAUNCHER_UNAVAILABLE` and `BUDGET_EXCEEDED` pause the campaign with that reason and stop the pass;
`TARGET_UNAVAILABLE`, `LAUNCH_REFUSED` and `PUSH_PERMISSION_REQUIRED` end that target `SKIPPED` with
`not started: <reason>` and the pass goes on; `GATE_CLOSED` and `TARGET_NOT_STARTABLE` (a race with a
person or a webhook) read again after a minute; anything else stops the pass and tries again after a
minute. A transport failure or a `5xx` is retried by Temporal, and so is a `404` that carries no
refusal code: that is a route that does not exist yet (a gateway on the previous release during a
rolling deploy) or an ingress that lost its upstream, and it never skips the target. Only the
gateway's own coded `404` (`TARGET_UNAVAILABLE`, or `CAMPAIGN_NOT_FOUND`, which stops the pass) is an
answer.

### 11.4 Planning

A planned campaign launches into `PLANNING`. The `planner` agent runs once, as the epic planner does,
and writes each repository's `brief` and the `dependsOn` edges between targets. An edge survives only
where the repository dependency graph ([repo-dependency-graph.md](./repo-dependency-graph.md)) holds an
`active` edge between the same two repositories, and an edge that would close a cycle is dropped; a
graph that cannot be read leaves no edges, and targets then start in `position` order as the limits
allow. The planner's cost is attributed to the owning team.

The briefs and the edges are written in **one transaction** that applies only while the campaign is
still `PLANNING` (a cancel or a confirm that got in first leaves nothing to write), and it gives every
target a brief: the planner's, or the campaign's own for a repository the planner left out. A plan is
therefore complete or absent, never partly written. The launcher reviews the briefs and order in the
dashboard and confirms with `POST /:id/confirm`, which moves the campaign to `ACTIVE`. Confirm answers
`409 CAMPAIGN_PLAN_NOT_READY` until every target has a brief, and the update that confirms repeats that
condition, so a target added meanwhile cannot be confirmed past. Targets are therefore not added while the
campaign is `PLANNING` (`409 CAMPAIGN_PLANNING`).

**Editing the plan before confirming.** While the campaign is `PLANNING` the launcher, and only the
launcher, may rewrite one target's brief (1 to 8,000 characters, the text rules of a campaign
description), its upstream edges (at most 50 other targets of the campaign, each one the launcher can
reach, no self edge, no cycle), or both with `PATCH /:id/targets/:targetId`. The write takes the campaign
row lock and repeats the `PLANNING` condition, so a confirm that got in first leaves nothing written.
The audit row records that the brief was edited and its length, not its text. After a failed plan the
launcher can write every brief by hand and confirm: confirm checks only that every target has a brief,
not the plan-failure record. The reconciler is not signalled by a plan edit: nothing is scheduled while the
campaign is `PLANNING`, and the confirm that follows wakes it.

**A planner that fails or returns no plan** is recorded on the campaign: `planFailedAt` and
`planFailureReason`, one of three fixed wordings (the campaign has no repository the planner can plan
against, the planner could not produce a plan, the planner returned no plan), never raw error text.
Every failed attempt records, and the plan write clears the record. The detail page shows it as
**Planning failed** (`planFailure` in the API). The campaign stays in `PLANNING` with no briefs, and the
planner is not run again: the launcher writes each brief with the plan edit above and confirms, or
cancels the campaign and starts another. Once every target has a brief, the recorded failure no longer
blocks the confirm. The workflow remembers that the planner failed across `continueAsNew` (`planFailed`
in its input, carried only when set), so a campaign left waiting in `PLANNING` does not run the planner,
and spend its tokens, again after 200 passes. The plan cannot be edited after the confirm.

### 11.5 Retry, remove, add, pause, resume and take over

(Editing a plan before it is confirmed is §11.4.)

| Action | Who | Effect |
|---|---|---|
| Retry a target | Creator, owning-team `LEAD`, ADMIN | A `NEEDS_ATTENTION` target returns to `PENDING`; the reconciler starts a new attempt as the campaign's launcher on `<prefix>/CAMPAIGN-<id12>-<n>`. Earlier attempts and their branches stay. A retry on a paused campaign waits for the resume |
| Remove a target | Same | `SKIPPED` with the reason recorded; nothing on the host is touched. A running target cannot be removed |
| Remove a dependency | Same, while the campaign is `ACTIVE`, `PAUSED` or `MONITORING` | Deletes one upstream from a target's `dependsOn` (`DELETE /:id/targets/:targetId/dependencies/:upstreamId`) and wakes the reconciler, so a `BLOCKED` target that waited only for that upstream is read again and starts as soon as the gate and the limits allow, whatever the upstream's state. The upstream target itself is untouched. A target that does not depend on it answers `404 EDGE_NOT_FOUND` |
| Add targets | Same, and the person must pass the launch decision for each repository | Appended as `PENDING`, counting against `workflow.campaignMaxTargets`, under the campaign row lock and at the next free position. A `MONITORING` campaign returns to `ACTIVE`; a campaign that is final or `CANCELLING` answers `409 CAMPAIGN_NOT_ACTIVE`, and one still `PLANNING` answers `409 CAMPAIGN_PLANNING`. The caller's authorization is decided for every repository **before** any other refusal: an id that does not exist, and one the caller may not start work in, are refused with the same single reason ("not found, or you may not start work in it"), so an id cannot be probed for its provider, organization or settings. Only then are the other refusals given, each with a reason: already a target in any state (including one that discovery added while the request was being decided), not on GitHub, outside a uniform campaign's organization, over the target limit, campaigns off for its team, or the launch decision. A target added to a planned campaign has no brief of its own and no upstream: it runs the campaign's brief |
| Pause, resume | Same | `PAUSED` with reason `manual` and back to `ACTIVE`. A resume that the next start would refuse again says why (`CAMPAIGNS_DISABLED`, `LAUNCHER_UNAVAILABLE`: the launcher's account is inactive, they left the organization or they no longer lead the owning team) |
| Take over | Owning-team `LEAD` or ADMIN, never the current launcher | The launch decision is re-run as the new person for every target not yet started (`PENDING` or `BLOCKED`); targets they cannot reach become `SKIPPED` with the reason, and the rest continue as them. A running attempt and a draft already awaiting review continue as they were. A campaign paused for `launcher-unavailable` resumes. Audited with both identities |

A campaign whose launcher's account is deactivated, or who leaves the organization, is not cancelled:
it moves to `PAUSED` with reason `launcher-unavailable`, and a lead of the owning team takes it over.
Identity never follows whoever clicks retry: the launcher is fixed until a take-over, because a user's
saved credential is keyed on the person a run acts as
([user-github-credentials.md](./user-github-credentials.md)).

### 11.6 The kill switch pauses

When `workflow.campaignsEnabled` turns off for the campaign's owning team, or for a team that owns a
target that is not final, the next pass moves the campaign to `PAUSED` with reason `disabled`: a
running attempt finishes, nothing starts and rescans stop. Each team's setting is resolved under that
team's own organization, so a cross-organization target's team answers for its organization's value.
Turning the setting back on resumes nothing by itself: an owning-team `LEAD` or ADMIN resumes it. A
resume of a campaign paused as `disabled` checks the setting for the owning team and for every team
that owns a target, and answers `409 CAMPAIGNS_DISABLED` while any is off (it names no other team).
The attempt route re-checks the setting at every start, so a resume that races a switch-off is
refused.

### 11.7 Budget

A campaign may carry its own `budgetUsd`, frozen at launch. The gateway's start guard and the reconciler's
pass read one shared calculation (`campaignSpendUsd`), so they cannot disagree about whether the cap is
reached. It sums, for the attempts started in the current calendar month (UTC), each attempt's cost
once: the run's settled figure when its run has ended, otherwise the live figure accrued on its workflow
while it runs (which also covers an attempt that has cost something but has no run row yet), and zero
for an attempt with neither. Before each start the gateway refuses with `BUDGET_EXCEEDED` when that sum
is at or above the cap, which pauses the campaign with reason `budget`; a pass pauses it too when the same
sum is at or above the cap. The limit is advisory for runs already in flight, which finish. The
organization and team caps still apply first, per run.

### 11.8 Signals, completion and the backstop

The reconciler's wake-ups are signals, never state: whatever a route or a webhook wanted done was
written to the rows first, and the signal only ends the sleep early.

| Signal | Sent by |
|---|---|
| `attemptFinished` | Run finalization, when it records an attempt's outcome |
| `pullRequestChanged` | The pull-request webhook handler, when a `PullRequest` row opened by a target's latest attempt is merged, closed or reopened |
| `control` | The routes: confirm, pause, resume, cancel, retry, add or remove a target, remove a dependency, take over |

**On completion of a run**, the worker names the run on its attempt when the run row is created, and
when the run is finalized records the attempt's outcome conditionally (`PR_OPENED` when a draft was
opened, `NO_CHANGE` for a run with nothing to change, `FAILED` with a masked reason, `CANCELLED`),
with the path and verification the run reported, and sends `attemptFinished`. Both hooks are
best-effort and never fail the run. The reconciler's read also settles an attempt whose run ended
unrecorded, and fails one whose run row never appeared after ten minutes once its ledger rows are all
terminal. An attempt whose child never produced a run row, and whose ledger says nothing, is closed
`FAILED` with the reason "the run never started" once 30 minutes have passed and Temporal reports the
child workflow gone or closed; one Temporal still reports running is left alone, and an unreadable
answer decides nothing. **On a pull-request event** the gateway signals every reconciler whose target's latest
attempt opened the pull request; an earlier attempt's pull request says nothing about the target.

**A reconciler that is not running is started again by the signal.** A control action (every route above
except cancel) and a pull-request event deliver their signal with signal-with-start: when no execution
of the campaign's workflow ID is running (it was terminated, or Temporal lost it), the gateway starts the
reconciler under the same ID with the signal, and it recovers from the rows. The gateway reads the
campaign row at that moment, and starts nothing for a campaign that is final or `CANCELLING`, or a legacy
one. Cancel never starts a workflow: it signals, and closes the rows itself when none is running (§9).
Two things are not recovered. Nothing sweeps for stopped reconcilers: a campaign that nobody touches
and that no pull-request webhook reaches stays stopped, whatever its state, until something does. And the
worker's own signal on a finished run (`attemptFinished`) does not start a workflow, so it is lost while
the reconciler is stopped; the next signal that starts it reads that outcome from the rows.

**The backstop.** A reconciler reads the database at least daily whether or not a signal arrived, and
every five minutes while an attempt is in flight. State is therefore recoverable from rows alone: a
reconciler that restarted resumes at the next signal or pass (one that is stopped resumes at the next
restarting signal, above), a lost signal costs a delay (a merge whose
webhook was lost is found at the next daily pass), and cancelling a campaign whose workflow is gone
closes the rows (§9). The workflow `continueAsNew`s after 200 passes. A change to its scheduling goes
behind `patched`, and its replay fixtures are never re-recorded to make a test pass.

### 11.9 Discovery walks

Discovery walks the scope's repositories (a team's, or the campaign's organization's, that the launcher
can reach, in a stable order) in **chunks of 25**, one activity call per chunk, and the findings of each
chunk are written (targets added, proposals recorded) before the next chunk is read. A walk is bounded
at **500 candidates** (repositories that are not targets and not satisfied) and **1000 repositories**.
It carries a cursor, the offset of the next repository, in the workflow input, so it survives
`continueAsNew`:

- A walk that is interrupted or fails (a chunk errors, the worker restarts) resumes at its cursor on
  the next pass, and loses nothing already written. A failure is retried after five minutes.
- A walk ends when the scope ends (the next walk starts at the beginning) or at a cap (the next walk
  resumes at the cursor, so a scope larger than the caps is covered over successive intervals).
  `lastDiscoveryAt`, and so the rescan interval, is recorded only when a walk ends, never when it merely
  pauses.
- Each chunk budgets its own activity time: a repository is started only while the worst case of one
  check (the recipe's timeout plus a clone allowance) still fits inside the activity's 30-minute
  timeout less a margin, so a chunk of slow repositories returns a short answer and the cursor where it
  stopped, rather than timing out and losing the chunk. The first repository of a chunk is always
  checked, so a walk makes progress.
- A repository that is not a target and is checked **satisfied** is recorded in
  `campaign_discovery_checks` (campaign, repository, base sha). While the repository's base branch
  still points at that sha, a later walk skips it without cloning it. The tip is resolved through the
  host without a clone; when it cannot be resolved the repository is checked normally. The record is
  dropped when the repository becomes a target or a proposal, or when a later check finds it not
  satisfied, and it goes with the campaign.

## 12. Epics

An epic is a **`PLANNED` campaign**: a brief that spans several repositories, decomposed by the planner
into one brief per repository and the order between them, then run through the same reconciler. While
`workflow.campaignReconciler` is on for the team that will own the campaign, `workflow.campaignsEnabled`
holds for it and for every repository's team, and the repositories fit `workflow.campaignMaxTargets`,
`POST /api/v1/epics` launches an epic as a planned campaign with gate `OPENED` (a downstream repository
starts once its upstream's draft is open), no recipe and no scope. Otherwise, and whenever a setting
cannot be read, it launches the epic on `EpicOrchestratorWorkflow` exactly as with the setting off.

- **The owning team** of an epic campaign is the team that owns the **first repository listed** in the
  request. The caller must lead every repository's team, as for any epic, so they lead it too.
- **The campaign's id** is derived from the epic's ticket id, so a second launch for the same ticket
  answers `409 EPIC_ALREADY_EXISTS`, as an epic always has. Its name is the ticket id, and the epic is
  also visible, and controllable, under `/campaigns`.
- The answer keeps the epic's shape: `epicWorkflowId` is the campaign's workflow ID
  (`campaign-<campaignId>`), `detailPath` is `/epics/<that id>` and the state is `PLANNING`. The launcher
  confirms the plan on the campaign page before anything starts.
- **The epic surface** reads the campaign rows beside the legacy epics so existing links keep working.
  `GET /api/v1/epics` lists both kinds newest first; `GET /api/v1/epics/:workflowId` answers a
  `campaign-<uuid>` ID in the epic detail's shape (one child per target, its status the target state)
  and an `epic-<ticket>` ID as before. A campaign's state appears as the epic status words
  (`PLANNING`, `FANNING_OUT` while active, paused or monitoring, `COMPLETED`, `CANCELLED`, `FAILED`).
  A non-admin sees an epic campaign they created, that their team owns, or that has a target they can
  reach; a target they cannot reach is not listed. Pause, resume, retry, take over and cancel are
  campaign routes (§8), not epic routes.
- A **planned campaign may span organizations**, as an epic can: each attempt is billed to its
  repository's team and organization, and the launcher must lead every repository's team. A uniform
  campaign stays within one organization.
- Epics already running when `workflow.campaignReconciler` is turned on finish on
  `EpicOrchestratorWorkflow`, which stays registered. With the setting off, `POST /api/v1/epics` is the
  epic path described in [architecture.md](./architecture.md).

## 13. Legacy campaigns

A campaign launched while `workflow.campaignReconciler` is off runs on `CampaignWorkflow`. It fans its
fixed list out once, with the parallelism frozen at launch, as Temporal child workflows named
`campaign-<campaignId>-<connectionId>`, and ends when every target has an outcome. It has a 30-day
execution limit. Its states are `STARTING`, `RUNNING`, `CANCELLING`, `COMPLETED`,
`COMPLETED_WITH_FAILURES` (when any target ended `FAILED` or `SKIPPED`), `CANCELLED` and
`FAILED_TO_START`. Its targets are `PENDING`, `RUNNING`, `PR_OPENED`, `NOT_AFFECTED`, `FAILED`,
`SKIPPED` and `CANCELLED`, and every one but `PENDING` and `RUNNING` is final: `PR_OPENED` means a
draft was opened, not that it merged. It has no check, no discovery, no ordering, no backpressure,
no budget of its own, and no pause, resume, retry, add, remove or take-over; those routes answer
`409 CAMPAIGN_NOT_RECONCILED`. The API reads it in the same shapes, with the retired states folded into
`counts`.

Because the workflow acts for hours or days, the worker re-checks part of the launch decision right
before each batch of children, for the batch of targets about to start. A check that fails stops either
the campaign or that target:

- Stops the campaign (every target still queued ends `SKIPPED` with the campaign-wide reason, and
  children already running finish): the campaign row no longer exists; it is `CANCELLING` or
  `CANCELLED` (it then stops as a cancel, §9) or otherwise final; the launcher's account is not
  active; the owning team or the campaign's organization is not active; a launcher who is not a platform
  ADMIN is no longer a member of the organization; the launcher is no longer `LEAD` or `ADMIN` on the
  owning team (or a platform ADMIN); `workflow.campaignsEnabled` is off for the owning team.
- Skips that target (`SKIPPED`, `not started: <reason>`): the repository no longer exists, is not
  active or is not a git repository; it is no longer owned by the team it had at launch, in the
  campaign's organization; its owning team or organization is not active; `workflow.campaignsEnabled` is
  off for its team; the launcher is no longer `LEAD` or `ADMIN` on its owning team.

A re-check that cannot be made (the database is still unreachable after ten attempts with backoff over
about eight minutes) fails closed the same way: the batch and the rest of the queue end `SKIPPED`
rather than starting unchecked. Checked **only at launch**: the owning team's role at the time of
launch, the GitHub permission gate (it judges the token of a request, and the worker has none), the
organization and team budgets (each child is metered as it runs), the size limits and parallelism
(frozen into the campaign), the recipe and the template version (pinned), and the repository's
source-control provider.

Target rows are written by the workflow's activities as each child starts and ends. Each write is keyed
on the target row's own id (with its team), never on the repository, and is conditional on the row still
being `PENDING` or `RUNNING`, so a retried or late write never moves a final row. When the fan-out ends,
a finalizer re-applies every result the workflow holds, which repairs a row whose own write failed. The
campaign's own ledger row ends `COMPLETED`, `FAILED` (for `COMPLETED_WITH_FAILURES`) or `CANCELLED`.

A legacy campaign is never converted: it finishes on the workflow it started on. A campaign that
reached a final state before the reconciler existed keeps it, and its targets are not reconciled.
Operators can see which campaigns are still legacy and unfinished with the query in
[upgrade-notes.md](./upgrade-notes.md).

## Limitations

- **No event source starts or feeds a campaign.** A Dependabot alert, a code-scanning finding or an
  `inbound.event` automation cannot create a campaign or add a target. Discovery is the scope plus
  the check, on a timer.
- **A check exists only for `@2` recipes.** A campaign with no recipe, an `@1` recipe or a planned
  campaign cannot discover targets or confirm a merge satisfied the goal. It ends when its pull
  requests merge (`MERGED` is final for it), so a merge that did not achieve the goal, or a repository
  that regresses later, is not noticed, and the dashboard says only "Merged (no check to confirm)". It
  has no scope, so it never monitors. A deterministic check for a framework change has no natural
  form; an agent-written check is out of scope.
- **A target whose check cannot run is never settled.** A `MERGED` target in a layout the check does not
  handle (a workspaces repository that does not list the package at its root, a Yarn or pnpm lockfile)
  is tried again every 15 minutes and stays `MERGED`. Discovery skips such repositories, neither
  adding nor proposing them. The check has no network and reads only the default branch.
- **The check inherits the recipe limits.** `npm-dependency@2` reads only the root `package.json`'s
  `dependencies`, `devDependencies` and `optionalDependencies` and `package-lock.json`, so a package
  the repository gets only transitively is satisfied here (`not-declared`), even when the lockfile pins
  an older version, and npm `overrides` are not read. `go-module@2` reads only the `require` lines of
  `go.mod`: a module the build gets only through another module is satisfied, and a `replace`
  directive is neither read nor changed, so the check can pass while the `replace` keeps the build on
  another version or a local path. Python and JVM projects have no recipe.
- **Discovery clones a repository of the scope unless it is known to be unchanged.** A walk checks up
  to 1000 repositories and collects up to 500 candidates, 25 at a time, so a scope larger than that is
  covered over several intervals. A non-target repository found satisfied is skipped without a clone
  only while its base branch tip equals the sha recorded for it; every other repository (a candidate, a
  repository whose check could not run, one whose tip cannot be resolved, one that changed) is cloned
  in a sandbox at each walk, so a scope of many changing repositories still costs sandbox time at each
  interval. A repository that is a target is never re-walked for discovery.
- **The regression limit is fixed.** A satisfied target may regress three times before it needs a
  person; it is not a setting or a campaign field.
- **Stale is a flag with one nudge.** Nothing closes or pings a stale draft. The first time a
  target's `staleSince` is set, the owning team's Slack notification channel (`Team.slackNotifyChannel`)
  gets one message naming the campaign and repository; it is not repeated while the target stays stale,
  and a target that stops being stale and goes stale again may notify again. A team with no channel, or
  an instance with no Slack bot token, gets the dashboard mark only, and a failed post is logged and
  never fails the pass.
- **A pull request's CI result is shown, not used.** A draft with failing CI stays `PR_OPENED`; the
  state follows the pull request's open, merged and closed status only.
- **Merge conflicts between the platform's pull requests and a moving base are not repaired.** A
  conflicting draft is left for its reviewer, as for any pull request. A `MERGED` target whose check
  fails because the base moved needs a person.
- **A pull request the platform did not open is not followed.** If a person closes the draft and
  opens their own, the target reads `NEEDS_ATTENTION` until a retry or the next check finds the
  repository satisfied.
- **A plan is editable only until it is confirmed, and an order only ever loosens afterwards.** The
  launcher rewrites briefs and edges while the campaign is `PLANNING` (§11.4). After the confirm no route
  changes a brief, and a person can remove an edge (§11.5) but never add one, so a target downstream of
  an upstream that was removed, cancelled or needs attention stays `BLOCKED` until that upstream is
  retried and delivers, or until its edge is removed and it then starts without waiting.
- **A planner's order is only what the dependency graph already holds.** An edge the planner infers
  that is not an `active` edge in the repository dependency graph is dropped, so a planned campaign
  may start repositories in parallel that an epic on the epic workflow would order.
- **A failed plan cannot be retried.** A planner that fails or returns no plan is recorded on the
  campaign and shown as **Planning failed**, in fixed wording that says nothing of the cause; the
  cause is in the planner trace and the worker log. The campaign stays in `PLANNING` and no route runs
  the planner again. It cannot be confirmed (`CAMPAIGN_PLAN_NOT_READY`) until every target has a brief,
  so the launcher writes them by hand with the plan edit and confirms, or cancels it and starts
  another. A plan written that way has no edges unless the launcher adds them.
- **Some changes have no dashboard control.** Targets are added only through `POST /:id/targets`;
  a removed (`SKIPPED`) target cannot be brought back or re-added, and a discovery proposal cannot be
  accepted or dismissed (`decidedAt` is never set). The Start form lists the first 100 repositories
  the repositories list returns, only those of the owning team's organization, so a cross-organization
  planned campaign is started through the API or as an epic.
- **There is no CLI command** for campaigns; the dashboard and the API are the interfaces.
- **A terminated reconciler is restarted by the next control action or pull-request event, not by
  itself.** Those signals start the workflow again from the rows under the same id when none is running
  (§11.8), unless the campaign is final, `CANCELLING` or legacy. Nothing else looks for a stopped
  reconciler: no periodic sweep exists, so a campaign that nobody touches and no pull-request webhook
  reaches does not move until something does, and a cancel never restarts it. Cancelling it closes the
  rows (§9), and a child that was still running may yet open a draft pull request that its target row
  then does not list.
- **A rewritten brief can be overwritten by a planner still running.** The plan edit does not check that
  the planner has finished; an edit made before the planner's last write is replaced by that write.
  Edit after the plan has appeared in the dashboard.
- **A failure reason can name a repository.** The reason a target or an attempt records is masked for
  credential shapes and bounded in length, not scrubbed of names. The text of a failed run's error
  (`worker/src/lib/campaignAttempts.ts`) and of a check's error, a failed clone included
  (`worker/src/activities/campaignCheck.ts`), can contain a repository's name or path. A start the
  gateway refuses with `LAUNCH_REFUSED` is stored as `not started: <reason>`, and that reason names
  `organization/repository` when it says the launcher no longer leads the repository's team (a case
  the earlier capability check usually answers first, with a fixed wording that names nothing). The
  other start refusals, `PUSH_PERMISSION_REQUIRED` included, name no repository. A failure reason is
  returned by `GET /:id` only to people who can reach the target's repository (the rest are counted in
  `hiddenTargetCount`), so it is not shown to anyone else, but it is stored as plain text in
  `campaign_targets` and `campaign_attempts`, and a platform ADMIN sees all of it.
- **A pull-request change is noticed by its webhook.** A merge or close whose webhook was lost is found
  at the next daily pass, not sooner; a running attempt is read every five minutes.
- **Take-over re-runs the launch decision once.** A later loss of access to a repository skips only the
  targets not yet started, as the next start refuses it; running attempts finish.
- **The launcher's identity is fixed.** Every child acts as the launcher until a take-over; a launcher
  who leaves pauses the campaign until a lead takes it over. An epic campaign is owned by the first
  repository's team, so a lead of another repository's team reaches the campaign through its targets
  and cannot pause, retry or cancel it.
- **Cross-organization planned campaigns widen the blast radius of one launch.** The launcher must
  lead the team of every repository, as for an epic, and each organization's budget is checked per
  attempt, not at launch. The campaign's own budget and visibility are the owning team's.
- **The budget is a monthly, advisory cap.** `budgetUsd` counts the cost accrued by attempts started in
  the current calendar month (UTC); runs in flight finish; a resume while the cap is still spent pauses
  the campaign again.
- **The recipes are narrow.** `npm-dependency` handles a root `package.json` and `package-lock.json`
  only: Yarn, pnpm and Bun lockfiles, npm shrinkwrap and workspaces fall to the agent. `go-module`
  handles a root `go.mod` without a `vendor/` directory or a `go.work` workspace; those fall to the
  agent. Python and JVM projects, and OpenRewrite-style recipes, have no deterministic path. A recipe
  sets an exact version, so it can also lower one. The egress policy of the run can make a recipe's
  install fail, which sends the repository to the agent.
- **"Not affected" means "not declared at the root".** An `@1` recipe, and the apply entry of an `@2`
  recipe, read only the root manifest, so a package the repository gets only transitively (through
  another dependency, present in `package-lock.json`) is reported not affected and nothing is changed,
  even when the lockfile pins the version the campaign is raising it from; npm `overrides` are not
  written. The same holds for a Go module required only through another module, and a `replace`
  directive for the module is neither read nor changed. Verification runs the build as the `replace`
  makes it.
- **Verification fails breaking upgrades by design.** A change that legitimately needs a test
  updated fails protected verification and ends `FAILED` with `verification: FAILED` and no pull
  request, which the campaign records as `NEEDS_ATTENTION`. Campaigns suit behaviour-preserving
  changes. When the original tests cannot be restored the gate fails with
  `PROTECTED_TESTS_UNAVAILABLE`, which appears as a child that errored.
- **Protection is by file-name convention.** Inline tests (Rust `#[cfg(test)]`, doctests), tests
  outside the conventions, test settings inside a dependency manifest, helpers under `src/` that
  are not named as test utilities, setup files named some other way (a `setupFiles` entry pointing
  at `src/polyfills.ts`), Babel and Vite configuration (`babel.config.js`, `.babelrc`,
  `vite.config.*`), test settings in shared Python configuration (`tox.ini`, `setup.cfg`), a mock,
  fixture or golden directory with another name (`__stubs__/`, `golden/`, `src/testing/`), and
  anything under a dependency directory (`vendor/`, `node_modules/`, `bower_components/`,
  `.yarn/`), including a repository's own code kept in a directory named `vendor/`, are not
  restored; only the guard's heuristics read manifests. A legitimate upgrade
  that has to change a mock, a golden file or a setup file fails verification, like one that has to
  change a test. The guard is heuristic, so a clean result is not a proof.
- **The gate command is not protected.** It comes from the step configuration, the repository's
  gate commands or the default, and a default such as `yarn test` reads `package.json` scripts,
  which only the guard inspects. The quality-gates step `runQualityGates` ignores `protectTests`.
- **GitHub CI still runs the branch's own tests.** Protection covers the platform's verification,
  not the host's checks on the draft pull request.
- **A failed child can leave a pushed branch.** A recipe commits and pushes before verification,
  and so does the agent, so a child that then fails verification (or errors) can leave its branch
  on the remote with no pull request, and each retry works on a branch of its own. Nothing deletes
  them.
- **A recipe that pushed but could not report its change costs an extra agent attempt.** The recipe
  step runs once, with no retry, because a retry would find the branch already at the version and
  report the repository as not affected. When the shell step's commit and push succeed but its
  result cannot be confirmed, or the pushed commit cannot be read back, the template hands the
  repository to the agent. The agent's first attempt starts from the base branch, and its push to
  the branch that already holds the recipe's commit is not a fast-forward and is refused; the
  step's retry syncs to the pushed branch and builds on the recipe's commit. The paid session runs
  twice, and the target reports `path: AGENT` for a change that is partly the recipe's.
- **Setup and the tests run the change's own code.** Protected verification restores test files
  before any repository code runs, but the repository's setup and the test command then run the
  branch as changed (a lifecycle script in a changed `package.json`, source a test imports), and
  that code can alter a restored file before the tests read it. The restore bounds what an edited
  test file can do, not what the change's code can do; the test-integrity guard's heuristics and
  the person reviewing the draft are what read the code.
- **A recipe's change is not security-scanned or reviewed by agents before the draft opens.** The
  post-diff security gate and the review network run on agent steps; a recipe's change goes from
  verification straight to the draft pull request, where a person reviews it. Its lockfile content
  comes from the package registry the recipe reached.
- **Agent steps can be paused.** The agent is a pausable step like any other; a question holds the
  child, and so a running attempt and its parallelism slot, until it is answered or
  `workflow.needsInputTimeoutSeconds` passes.
- **Opened drafts are never closed** by a cancel or by removing a target. They are listed for people to
  close.
- **Deleting a team or a repository changes campaigns it is part of.** A target row belongs to the
  team that owned its repository at launch, and deleting that team deletes those rows, and their
  attempts, from every campaign, including campaigns another team owns: their counts shrink and those
  repositories' outcomes (pull request links included) are gone from the campaign. Deleting a
  campaign's owning team deletes the campaign. Deleting a repository keeps its row with its
  `org/repo` label and outcome, but the row no longer names a repository, so the next start refuses it
  if it had not started, and to anyone but an ADMIN it counts in `hiddenTargetCount` rather than being
  listed.
- **A launch tells a caller whether a repository id exists.** `REPOS_NOT_FOUND` is decided before
  the team-lead check, so any signed-in caller can learn whether an id they hold names an active git
  repository (`404` against `403`). Nothing else about a repository of a team they do not lead
  (its name, organization or settings) is disclosed.
- **The detail page matches runs and review pages in bulk.** It looks up the campaign's child runs
  and its pull requests in one page of at most 100 each, so for a campaign with more repositories
  than that, a repository beyond the first 100 shows without a run link, and the review-page lookup
  uses the viewer's team scope, so a draft the viewer cannot find there links to the host instead.
- **Legacy campaigns have none of the tracking.** One launched while the reconciler setting was off
  does not follow its pull requests past opening, is not ordered or limited by open drafts, has no
  budget of its own, and cannot be paused, retried or taken over; a failed target needs a new campaign
  naming that repository. Its targets can stay `RUNNING` if the workflow is terminated by hand, or its
  finalizer exhausts its retries, until someone cancels it (§9), and its activities have no
  database-backed test, unlike the reconciler's. Its budgets and the GitHub permission gate are
  checked at launch, and the re-check before each child covers the kill switch, the repository, team
  and organization activation and the launcher's team roles and organization membership, not the
  permission gate, so a launcher whose GitHub access to a repository was revoked after the launch
  still has children started there until their team role or the repository changes.
