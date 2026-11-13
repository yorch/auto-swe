# Campaigns

A campaign applies one planned change to many repositories of one organization: a dependency
raised to a patched version, or a framework change described in a brief. The platform starts one
child run per repository, at most a few at a time, and records for each repository what happened:
a draft pull request opened, nothing to change, a failure with its reason, or a cancellation.
Humans review and merge every pull request. Nothing in a campaign merges, waits for a merge or
closes a pull request.

A campaign is deterministic first. When the launch names a **recipe**, a script the platform owns
and versions makes the change in a sandbox, with no model involved. The agent runs only when there
is no recipe or the recipe cannot apply, and once more to fix a change that fails verification.
Every change, whoever made it, is verified by the repository's **original** tests.

Campaigns are off by default (`workflow.campaignsEnabled`). The API is described in §8; there is no
dashboard page yet, but every child appears in the existing run and pull-request views.

## 1. What a launch creates

One `POST /api/v1/campaigns` writes, in one database transaction with the launch ledger:

- a `Campaign` row: the name, the brief, the owning team and its organization, the recipe and its
  parameters, the pinned template and version, the frozen parallelism and the Temporal workflow ID
  `campaign-<campaignId>`;
- one `CampaignTarget` row per repository, in the order the request listed them, each carrying the
  repository's owning team at launch and a `org/repo` label;
- a work request and a spend-ledger row for the campaign as a whole, marked cross-repository and
  pinned to the `dependency-upgrade-campaign` template, which is what keeps a campaign out of the
  epics list.

The campaign workflow is started after those rows commit. If it cannot be started, the ledger
rows are removed and the campaign and its targets go with them, so a failed launch leaves nothing
behind. Everything the workflow needs (the limits, the template version, the target order, the
recipe payload) is resolved by the gateway and frozen into the workflow's input, because a
workflow cannot read settings or the database.

## 2. Who may launch

A campaign pushes branches and opens pull requests in every repository it names, so it takes the
strictest launch decision the platform has. All of these hold, in this order:

1. The caller has the platform `LEAD` role.
2. The caller is `LEAD` or `ADMIN` on the **owning team** named in the request, or a platform
   `ADMIN`. The owning team decides the campaign's organization and who may cancel it.
3. Every repository exists, is active and is a git repository.
4. The caller is `LEAD` or `ADMIN` on the team that owns **each** repository, or a platform ADMIN
   (membership through a share does not count). This is decided before anything is said about a
   repository's organization or settings, so a caller cannot use the next two refusals to learn
   which repositories of other teams are in another organization or have campaigns turned off. The
   refusal (`403 FORBIDDEN`, reason `team-lead-required`) names the repositories whose team the
   caller belongs to and counts the rest.
5. Every repository belongs to the owning team's organization (`CAMPAIGN_CROSS_ORG` otherwise).
   A campaign never spans organizations. Every repository is served by GitHub
   (`409 SCM_PROVIDER_UNSUPPORTED` otherwise, naming the repositories and their provider): the
   recipe's push, the draft pull request and per-user credentials all go through the GitHub
   integration.
6. `workflow.campaignsEnabled` is on for the owning team **and** for the team that owns each target
   repository. One team with it off refuses the whole launch (`CAMPAIGNS_DISABLED`), naming the
   owning team and the repositories (step 4 means the caller leads every one of them).
7. The number of repositories does not exceed `workflow.campaignMaxTargets` for the owning team.
8. The recipe, when given, passes the strict parameter check in §3.
9. The `dependency-upgrade-campaign` template is present, and a payload for one target satisfies
   its input schema.
10. The standard launch authorization for a fan-out: repository access for every repository, team
   `LEAD` or `ADMIN` on the team that owns **each** repository (membership through a share does not
   count), membership of the organization, and the organization's and teams' monthly budgets.
   Every child run is launched as the caller, so a child may use the caller's own saved token
   where per-user credentials are enabled
   ([user-github-credentials.md](./user-github-credentials.md)).

### Re-checked before each child starts

A campaign starts its children over hours or days (its workflow may run for 30 days), each as the
launcher, so part of the launch decision is made again by the worker right before each child
exists, for the batch of targets about to start:

| Check | On failure |
|---|---|
| The campaign row still exists | Nothing more starts |
| The launcher's account is still active | Nothing more starts |
| The launcher is still `LEAD` or `ADMIN` on the owning team, or a platform ADMIN | Nothing more starts |
| `workflow.campaignsEnabled` is still on for the owning team | Nothing more starts |
| The repository still exists, is active and is a git repository | That target does not start |
| The repository is still owned by the team it had at launch, in the campaign's organization | That target does not start |
| `workflow.campaignsEnabled` is still on for the repository's team | That target does not start |
| The launcher is still `LEAD` or `ADMIN` on the repository's owning team, or a platform ADMIN | That target does not start |

A target that does not start ends `SKIPPED` with the reason, prefixed `not started:`; when nothing
more may start, every target still queued ends that way with the campaign-wide reason, and children
already running are left to finish. A re-check that cannot be made (the database is unreachable
after the activity's retries) fails closed the same way: the batch and the rest of the queue end
`SKIPPED` rather than starting unchecked. The campaign then finishes `COMPLETED_WITH_FAILURES`.

Checked **only at launch**: the platform `LEAD` role, the GitHub permission gate (it judges the
token of a request, and the worker has none), organization membership, the organization and team
budgets (each child is metered as it runs), the size limits and parallelism (frozen into the
campaign), the recipe and the template version (pinned), and the repository's source-control
provider.

The in-app assistant cannot launch a campaign: the route is refused to it outright, because one call
can open a draft pull request in up to `workflow.campaignMaxTargets` repositories of other teams.
It can read campaigns and, after the person confirms, cancel one.

## 3. Recipes

A recipe is a pair `{ ref, params }` where `params` is exactly `{ packageName, targetVersion }`.
The catalogue is code, versioned in the ref (`@1`); there are no admin- or bundle-defined recipes.

| Ref | Handles | Image | Parameters |
|---|---|---|---|
| `npm-dependency@1` | a root `package.json` with a `package-lock.json` | `node:24-alpine` | an npm package name; an exact version such as `4.17.21` |
| `go-module@1` | a root `go.mod` | `golang:1.26-alpine` | a Go module path; an exact version such as `v1.9.0` |

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
| 0, nothing changed | **Not affected**: the repository does not use the package or module, has no root manifest, or is already at the version | The child ends `SUCCESS` with `changed: false`; no pull request |
| 3 | **Cannot apply**: a Yarn, pnpm or Bun lockfile, an npm shrinkwrap, no `package-lock.json`, a workspaces repository that does not list the package at its root, or a dependency declared as something other than a plain version range | Nothing was pushed; the agent takes over |
| 4 | The tool ran but the lockfile or `go.mod` does not end at the requested version | Nothing was pushed; the agent takes over |
| other non-zero | The tool failed (install error, no network) | Nothing was pushed; the agent takes over |

**The recipe builds only on a branch it creates.** Before the recipe runs, the step resolves the
base branch's tip on the host and records it by sha, and refuses a work branch that already exists
on the host. After the recipe pushed, its commit's parent must be that recorded sha. Either refusal
ends the child `FAILED` (`path: RECIPE`, `verification: NOT_RUN`) with the reason, and neither the
agent nor verification runs on that branch. Without this, anyone with push access to a target
repository could create the campaign's branch ahead of it with weakened tests, the recipe would
commit on top, and verification would restore the tests to that commit. A run of the template
started by hand with a ticket whose branch already exists is refused the same way; delete the
branch first.

`npm-dependency@1` runs `npm install --package-lock-only --ignore-scripts`, keeping the declared
range style (`^`, `~` or exact) and the section (`dependencies`, `devDependencies` or
`optionalDependencies`). `--ignore-scripts` is mandatory. `go-module@1` runs `go get` and
`go mod tidy`. Because a failing recipe pushes nothing, the agent that follows starts cleanly from
the base branch.

A campaign without a recipe is **agent-only**: the brief is everything the agent has. That is the
shape for a framework upgrade no script covers.

## 4. What each child runs

Every child is a run of the `dependency-upgrade-campaign` template, pinned at launch to the version
that was active then, so editing the template later does not change a campaign in flight. The same
template is a complete workflow on its own
([maintenance-workflows.md §3](./maintenance-workflows.md#3-dependency-upgrade-campaign)).

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
                       done: not affected              v
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
    `__mocks__/`, Go's `testdata/`, and helper directories named `testutil(s)`, `testhelper(s)`,
    `test-utils` or `test_helpers`, plus a `test-utils.*` module and `conftest.py`;
  - runner setup files, which run inside every test: `jest.setup.*`, `vitest.setup.*`,
    `setupTests.*`, `test-setup.*`, `karma.conf.*`, `.rspec`;
  - pure test-runner configuration: `jest`, `vitest`, `playwright`, `cypress`, `karma`, `mocha` and
    `ava` config files, `.mocharc`, `pytest.ini`, `phpunit.xml`, `.nycrc`.

  Babel and Vite configuration are deliberately not protected: they configure the production build
  as well as the tests, and an upgrade can legitimately need them changed, like a manifest.
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

## 6. Target states and paths

Each `CampaignTarget` records one repository's outcome.

| State | Meaning |
|---|---|
| `PENDING` | Not started yet |
| `RUNNING` | Its child run is in flight; the detail view adds a `liveStatus` from the child's ledger row |
| `PR_OPENED` | A draft pull request was opened (`prUrl`, `prNumber`) |
| `NOT_AFFECTED` | The child finished with nothing to change |
| `FAILED` | The child failed, timed out, could not be started, was cancelled on its own (outside the campaign), or succeeded without opening a pull request or reporting `changed: false`; `failureReason` says why (at most 500 characters, control characters removed, credential-shaped text masked) |
| `SKIPPED` | The target was not started because the launch no longer held when its turn came (§2, `failureReason` starts `not started:`), or its child run ended `SKIPPED` |
| `CANCELLED` | The campaign was cancelled before the target started, or before its child finished successfully |

`PR_OPENED`, `NOT_AFFECTED`, `FAILED`, `SKIPPED` and `CANCELLED` are final. A target also records:

- `path`: `RECIPE`, `AGENT`, `RECIPE_THEN_AGENT` (a recipe's change the agent fixed) or `NONE`
  (nothing was changed);
- `verification`: `PASSED`, `FAILED` or `NOT_RUN`;
- `childWorkflowId`: `campaign-<campaignId>-<connectionId>`.

Target rows are written by the campaign workflow's activities as each child starts and ends, and
every write is conditional on the row still being `PENDING` or `RUNNING`, so a retried or late write
never moves a final row. When the fan-out ends, a finalizer re-applies every result the workflow
holds, which repairs a row whose own write failed.

The campaign itself moves `STARTING` → `RUNNING` → `COMPLETED`, or `COMPLETED_WITH_FAILURES` when
any target ended `FAILED` or `SKIPPED`. A cancel moves it to `CANCELLING` and then `CANCELLED`; a
campaign whose cancel was requested after every child had finished keeps the state its finalizer
wrote. The campaign's own ledger row ends `COMPLETED`, `FAILED` (for `COMPLETED_WITH_FAILURES`) or
`CANCELLED`.
`FAILED_TO_START` is a value of the enum that a launch never leaves behind: a workflow that cannot
start is rolled back with its rows. `COMPLETED`, `COMPLETED_WITH_FAILURES`, `CANCELLED` and
`FAILED_TO_START` are final.

## 7. Limits and settings

All three settings are in the `workflow` group, overridable at the team and organization scope and
changeable by an ADMIN. None is pinned to a run: the gateway resolves them at launch and freezes
the result into the campaign.

| Setting | Default | Effect |
|---|---|---|
| `workflow.campaignsEnabled` | off | Whether a campaign may include a team's repositories. Checked for the owning team and for each distinct target team |
| `workflow.campaignMaxTargets` | 25 | The most repositories one campaign may name (1 to 200), resolved for the owning team. A longer list is refused, not truncated |
| `workflow.campaignMaxParallelChildren` | 3 | The most children in flight at once (1 to 10). A launch may ask for fewer with `maxParallel`, never more |

A campaign's Temporal history is bounded by what each child's start event carries: the brief, the
recipe payload and the identifiers, never the launch request, which is stored once on the
campaign's work request. The brief's 8,000-character bound and its character rules keep one child's
start input under 32 KiB, so the child starts of a campaign at the 200-target ceiling stay under
7 MiB, below Temporal's 10 MiB history warning; a unit test measures the worst case.

Pull-request volume is bounded at five points: the target limit, the parallelism limit, the fact
that a repository the change does not affect opens nothing, drafts only, and no CI loop. Each child
is a full run with its own agent, workspace and budget; the optional `budget` tier of the launch
applies to each child.

## 8. API

All routes are under `/api/v1/campaigns`.

**`POST /`** (platform `LEAD`). Body:

| Field | Meaning |
|---|---|
| `name` | 1 to 120 characters, with the same character rules as the brief; shown in lists |
| `description` | The brief: the agent's instructions for the fallback path and the pull request text. At most 8,000 characters, with no control characters other than tab and line breaks and no lone surrogates (§7) |
| `ownerTeamId` | The owning team (§2) |
| `repoIds` | One to 200 distinct repository IDs |
| `recipe` | Optional `{ ref, params: { packageName, targetVersion } }` (§3); absent means agent-only |
| `maxParallel` | Optional; clamped to `workflow.campaignMaxParallelChildren` |
| `budget` | Optional budget tier for each child |

It answers `201` with `{ campaignId, temporalWorkflowId, workRequestId, targetCount, detailPath }`.
The refusals, in the order they are checked:

| Status | Code | Cause |
|---|---|---|
| 403 | `FORBIDDEN` | Not `LEAD` or `ADMIN` on the owning team |
| 404 | `TEAM_NOT_FOUND`, `REPOS_NOT_FOUND` | The owner team, or a named repository, does not exist or is inactive |
| 403 | `FORBIDDEN` | No `LEAD`/`ADMIN` on a target's owning team (reason `team-lead-required`; repositories of teams the caller is not in are counted, not named) |
| 400 | `CAMPAIGN_CROSS_ORG` | A repository is outside the owning team's organization |
| 409 | `SCM_PROVIDER_UNSUPPORTED` | A repository is served by a source-control provider other than GitHub |
| 403 | `CAMPAIGNS_DISABLED` | The setting is off for the owning team or a target's team |
| 400 | `CAMPAIGN_TOO_MANY_TARGETS` | More repositories than `workflow.campaignMaxTargets` |
| 400 | `CAMPAIGN_RECIPE_INVALID` | Unknown recipe, or parameters that fail the strict check |
| 503 | `CAMPAIGN_TEMPLATE_MISSING` | The built-in template is not seeded |
| 400 | `CAMPAIGN_INPUT_INVALID` | The payload fails the template's input schema |
| 403 | `FORBIDDEN`, `REPO_ACCESS_DENIED`, … | From the launch decision: no repository access, or no organization membership |
| 402 | `ORG_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED` | A monthly budget is spent |
| 409 | `CAMPAIGN_ALREADY_EXISTS` | The workflow ID is taken (reachable only on an ID collision) |

**`GET /`** (any signed-in user). Query `limit`, `offset`, `ownerTeamId`, `state`. An ADMIN sees every
campaign. Anyone else sees a campaign when they belong to its owning team or can reach at least one
of its target repositories (owning team or a team the repository is shared with, plus the GitHub
permission gate when it is enforced). Each row carries `id`, `name`, `state`, `ownerTeam`,
`recipeRef`, `recipeParams`, `createdBy`, `createdAt`, `completedAt` and `counts`, the number of
targets in each state over **all** targets. Counts are numbers only: a viewer learns that
other repositories exist and how they fared, not which they are.

**`GET /:id`** (any signed-in user). The campaign with its `counts`, `hiddenTargetCount` and
`targets`, ordered by launch position. A non-admin sees only targets whose repository they can
reach; the rest are counted in `hiddenTargetCount` and never named, so their labels, pull request
URLs and failure reasons do not cross. A campaign the caller may not see answers `404
CAMPAIGN_NOT_FOUND`, never `403`. A `RUNNING` target carries `liveStatus` from the child's ledger row.

**`POST /:id/cancel`** (any signed-in user who can see the campaign). Allowed to the campaign's
creator, a `LEAD` or `ADMIN` of its owning team, or a platform ADMIN; anyone else who can see it
gets `403`. A campaign already in a final state answers `409 CAMPAIGN_NOT_ACTIVE`. Otherwise the
campaign becomes `CANCELLING` with `cancelledById` and `cancelledAt`, the workflow is signalled,
and the route answers `202`. A signal to a workflow that has already closed counts as delivered,
since its finalizer has written the final state. A signal that cannot be delivered answers
`503 CAMPAIGN_SIGNAL_FAILED` with the campaign left `CANCELLING`; cancelling again re-sends it.

## 9. Cancel semantics

Cancelling stops what has not finished and leaves what has:

- Targets not yet started become `CANCELLED` and are never started.
- In-flight children are cancelled; each is finalized by its own workflow and its target becomes
  `CANCELLED`. A child that still ends `SUCCESS` (its draft was opened before the cancel reached
  it) keeps `PR_OPENED` or `NOT_AFFECTED`.
- Targets that already finished keep their outcome.
- Only the campaign's own cancel cancels the campaign: the cancel route's signal, or a cancel of
  the campaign's workflow itself. A single child run cancelled on its own (through the run's cancel
  route or the Temporal UI) is that target's outcome, `FAILED` with the reason "the child run was
  cancelled outside the campaign", and the campaign goes on starting the rest. It is `FAILED`
  rather than `CANCELLED` because `CANCELLED` records that the campaign's permission-checked,
  audited cancel stopped the target; a run cancelled through its own route has that route's audit
  row, and to the campaign it is a target that ended without a verdict, so the campaign finishes
  `COMPLETED_WITH_FAILURES`.
- Cancelling the campaign's workflow directly (from Temporal) behaves the same as the cancel
  route's signal: the finalizer still runs, also when the cancel lands before the first child has
  started (every target then ends `CANCELLED`).
- Draft pull requests already opened stay open. They are listed in the detail view for people to
  close; a cancel does not touch the host.

## 10. Audit

A launch writes the usual `WorkRequest` `CREATE` row with source `campaign`, and one `Campaign`
`CREATE` row whose `afterJson` holds the name, recipe reference and parameters, owning team, target
count, parallelism and the pinned template and version. A cancel writes a `Campaign` `UPDATE` row
with the state before and after (`CANCELLING`) and the actor. See [audit-log.md](./audit-log.md).

## Limitations

- **No merge waiting, ordering or backpressure.** `PR_OPENED` means a draft was opened, not that it
  was merged or released. Targets are not ordered by the repository dependency graph, because order
  without waiting for merges would be cosmetic, and a campaign does not stop starting children while
  earlier pull requests are unmerged.
- **No per-target retry, pause or resume.** A failed target is not re-run through the generic retry,
  which refuses cross-repository requests; the fix is a new campaign naming that repository.
- **One organization.** A campaign cannot span organizations.
- **The recipes are narrow.** `npm-dependency@1` handles a root `package.json` and
  `package-lock.json` only: Yarn, pnpm and Bun lockfiles, npm shrinkwrap and workspaces fall to the
  agent. `go-module@1` handles a root `go.mod`. Python and JVM projects, and OpenRewrite-style
  recipes, have no deterministic path. A recipe sets an exact version, so it can also lower one.
  The egress policy of the run can make a recipe's install fail, which sends the repository to the
  agent.
- **Verification fails breaking upgrades by design.** A change that legitimately needs a test
  updated fails protected verification and ends `FAILED` with `verification: FAILED` and no pull
  request. Campaigns suit behaviour-preserving changes. When the original tests cannot be restored
  the gate fails with `PROTECTED_TESTS_UNAVAILABLE`, which appears as a child that errored.
- **Protection is by file-name convention.** Inline tests (Rust `#[cfg(test)]`, doctests), tests
  outside the conventions, test settings inside a dependency manifest, helpers under `src/` that
  are not named as test utilities, setup files named some other way (a `setupFiles` entry pointing
  at `src/polyfills.ts`), Babel and Vite configuration, and a mock or fixture directory with
  another name are not restored; only the guard's heuristics read manifests. A legitimate upgrade
  that has to change a mock, a golden file or a setup file fails verification, like one that has to
  change a test. The guard is heuristic, so a clean result is not a proof.
- **The gate command is not protected.** It comes from the step configuration, the repository's
  gate commands or the default, and a default such as `yarn test` reads `package.json` scripts,
  which only the guard inspects. The quality-gates step `runQualityGates` ignores `protectTests`.
- **GitHub CI still runs the branch's own tests.** Protection covers the platform's verification,
  not the host's checks on the draft pull request.
- **A failed child can leave a pushed branch.** A recipe commits and pushes before verification,
  and so does the agent, so a child that then fails verification (or errors) can leave its branch
  on the remote with no pull request. Nothing deletes it.
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
  child until it is answered or `workflow.needsInputTimeoutSeconds` passes.
- **Opened drafts are not closed on cancel,** and a campaign does not track what happens to a pull
  request after it opens.
- **Targets can stay `RUNNING` if the campaign workflow is terminated by hand.** No reaper
  reconciles campaign rows; a termination from the Temporal UI skips the finalizer.
- **Budgets and the GitHub permission gate are checked at launch only.** Children are metered per
  run against their own organization and team budgets; a campaign has no budget of its own. The
  re-check before each child (§2) covers the kill switch, the repository and the launcher's team
  roles, not the permission gate, so a launcher whose GitHub access to a repository was revoked
  after the launch still has children started there until their team role or the repository
  changes.
- **A launch tells a caller whether a repository id exists.** `REPOS_NOT_FOUND` is decided before
  the team-lead check, so a platform `LEAD` can learn whether an id they hold names an active git
  repository (`404` against `403`). Nothing else about a repository of a team they do not lead
  (its name, organization or settings) is disclosed.
- **No dashboard page or CLI command.** The API is the interface.
- **The assistant cannot launch a campaign,** and no event source (Dependabot, code-scanning
  alerts) starts one.
