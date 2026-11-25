# Campaigns as tracked goals

Jira: N/A
Date: 2026-11-25
Status: Draft
Last reviewed: 2026-11-25

## Problem

A campaign today is a one-shot launch. It fans one pinned template out to a fixed list of
repositories, opens a draft pull request in each, and ends. The shape is wrong for the work it is
used for, which is a migration: "no repository declares `lodash` below 4.17.21". A migration is
finished when the goal is true everywhere, not when the pull requests were opened. Six gaps follow.

1. **The campaign ends where the work starts.** `PR_OPENED` is final. Nothing records that a pull
   request merged, was closed unmerged, or went stale, so the long tail of a migration is invisible.
2. **No retry, pause or ordering.** A failed target needs a new campaign. Ordering was left out
   because "order without waiting for merges is cosmetic". A campaign cannot stop starting children
   while earlier pull requests wait for review.
3. **The target set is frozen at launch.** A repository that starts declaring the package a week
   later is never seen. A repository that regresses after merge is never seen either.
4. **Two machines do one job.** `EpicOrchestratorWorkflow` and `CampaignWorkflow` both start a
   `RunnableWorkflow` child per repository from a scheduler. They differ in what the work is
   (planned per repository, or the same everywhere) and in order (dependency graph, or none). Each has
   its own routes, pages, cancel semantics and, for campaigns, a hand-maintained re-check table that
   re-implements part of the launch decision.
5. **The recipe is the only deterministic seam, and it is closed.** It runs only as an apply step. It
   cannot answer "is this repository already satisfied?", which is the question tracking needs.
6. **A campaign has an owner but no continuity.** Every child acts as the launcher, frozen at launch.
   Over weeks the launcher changes teams or leaves, and nothing hands the campaign over.

## Approach

A **campaign is a goal over a set of repositories, reconciled until the goal holds.** It owns
three things the current campaign does not: a **check** that says whether one repository satisfies
the goal, a **target set** that can grow, and a **delivery state** per target that follows its pull
request to merge. Epics become a launch mode of the same concept. Orchestration keeps its own
conversation and tables, but shares the child-launch and completion machinery with campaigns.

Decisions taken, with the alternatives discarded:

| Decision | Chosen | Discarded |
|---|---|---|
| Unit of the concept | One `Campaign`: goal, check, target set, work definition, order, completion condition. An epic is a campaign whose work is planned; the current campaign is one whose work is uniform | Keeping epics and campaigns separate and adding tracking to campaigns only. Folding campaigns into orchestrations (an orchestration is a conversation about one repository; a campaign is a durable set) |
| Source of truth | Database rows, reconciled by a workflow that sleeps between events and `continueAsNew`s | A workflow that holds the queue in memory for up to 30 days, as `CampaignWorkflow` does |
| Delivery state | Read from `PullRequest` (already updated by webhooks), never copied onto the target | A second copy of merged and closed on `CampaignTarget`, which would drift from the pull-request views |
| What "done" means for a target | The check passes on the base branch: `SATISFIED`, whether the platform's pull request merged or not | `MERGED` as the only finish (a person may fix a repository by hand, and a repository can be satisfied before the campaign starts) |
| The check | A recipe gains a read-only mode: the same script, run without commit or push, answering satisfied or not | Parsing manifests in the gateway; a model judging satisfaction |
| Target discovery | A **scope** (a team, or the organization) plus the recipe's check, re-evaluated on a schedule. A newly matching repository is added only if the launcher is still authorized for it | Discovery that starts work by itself. Dependabot and code-scanning alert sources (deferred, see Limitations) |
| Ordering | Optional `dependsOn` edges between targets, taken from the repository dependency graph for a planned campaign, with a gate of `OPENED` (an upstream draft exists) or `MERGED` | Ordering by position only. Ordering that never waits for a merge |
| Backpressure | `maxOpenPullRequests`: no new child starts while that many drafts of this campaign await review | Only the parallelism limit, which bounds children in flight and says nothing about review load |
| How a child starts | The worker calls the gateway as the launcher with a per-call campaign token, and the gateway runs the standard launch decision, exactly as orchestration spawns a child | A Temporal `startChild` plus a re-check activity that mirrors the launch decision by hand |
| Table sharing with orchestration | A shared library (token, launch call, completion signal plus reconcile poll, fenced result). Separate tables | One polymorphic children table. Orchestration children carry roles, path scopes and steering; campaign attempts carry path and verification |
| Launcher identity | Frozen at launch. An owning-team `LEAD` or platform ADMIN may **take over** a campaign, which re-runs the launch decision for every unfinished target as the new launcher | Identity following whoever clicks retry (see the credential rule in `CLAUDE.md` §6) |
| Model-started campaigns | None. The orchestrator may record a `proposeCampaign` intent, shown as a card the launcher confirms, as `requestRepo` is. The assistant still cannot launch | Letting an agent create a campaign |

## Concepts

- **Campaign.** A goal, its check, and the targets reconciled toward it. Workflow id
  `campaign-<campaignId>`, as today.
- **Check.** A recipe run in `check` mode against a repository's base branch. Exit 0 means satisfied,
  exit 1 means not satisfied, any other code means the check could not run (not satisfied, with the
  reason). A campaign with no recipe has no automatic check: its targets finish by merge only, and the
  campaign cannot discover new ones.
- **Target.** One repository in the campaign. It has a `state` (below) and a list of attempts.
- **Attempt.** One child run for one target. Retrying a target adds an attempt; it never rewrites one.
- **Plan.** How the per-target work is decided. `UNIFORM`: the campaign's brief and recipe apply to
  every target. `PLANNED`: the `planner` agent decomposes the brief into one brief per repository and
  the `dependsOn` edges, as `planEpic` does today.
- **Scope.** The set the check may discover targets in: a team's repositories or the campaign's
  organization. Absent means the target list is fixed.

## 1. Target states

The target state is one enum with two kinds of value: run states the workflow writes, and delivery
states derived from the pull request.

| State | Meaning | Final |
|---|---|---|
| `PENDING` | Not started | no |
| `BLOCKED` | Waiting for an upstream target (the gate has not opened) or for backpressure | no |
| `RUNNING` | An attempt is in flight | no |
| `PR_OPENED` | A draft exists and is `OPEN` on the host. Delivery detail (draft, CI, review) is read from `PullRequest` | no |
| `MERGED` | The pull request is `MERGED`. The check has not been re-run yet | no |
| `SATISFIED` | The check passed on the base branch. Evidence: when, and the base sha | yes |
| `NEEDS_ATTENTION` | A person must act: the pull request was closed unmerged, the attempt failed and retries are spent, the check regressed after `SATISFIED` more than `regressionLimit` times | no |
| `SKIPPED` | Not started because the launch no longer held, an upstream target did not finish, or a person removed it | yes |
| `CANCELLED` | The campaign was cancelled first | yes |

`NOT_AFFECTED` and `FAILED` are retired as states: the first is `SATISFIED` with `evidence: initial`,
the second is `NEEDS_ATTENTION` with `failureReason`. A **stale** pull request is a flag on the target
(`staleSince`), set when a draft has been `OPEN` longer than the campaign's `staleAfterDays`; it
changes no state and starts nothing. The platform nudges the owning team through the existing
notification path and nothing more.

`MERGED` is transient: the reconciler re-runs the check on the next pass, and the target becomes
`SATISFIED`, or `NEEDS_ATTENTION` when the merge did not satisfy the check (the pull request was only
part of the change, or the base moved).

A `SATISFIED` target is re-checked on the campaign's `rescanIntervalHours` while the campaign is
`ACTIVE` or `MONITORING`. A regression returns it to `PENDING` with `regressions + 1`.

## 2. Campaign states

`STARTING` → `ACTIVE` → `COMPLETED`, with `PAUSED`, `MONITORING`, `CANCELLING` and `CANCELLED` beside it.

| State | Meaning |
|---|---|
| `ACTIVE` | Targets are being started, awaited or re-checked |
| `PAUSED` | No attempt starts. Running attempts finish. Set by an owning-team `LEAD`, an ADMIN or the creator; any of them resumes |
| `MONITORING` | Every known target is `SATISFIED` and a scope is set. The campaign wakes on `rescanIntervalHours`, up to `expiresAt` |
| `COMPLETED` | Every target is final and `SATISFIED`, `SKIPPED` or `CANCELLED`, and there is no scope or `expiresAt` has passed |
| `CANCELLING`, `CANCELLED` | As today (`docs/campaigns.md` §9). Open drafts stay open |

`COMPLETED_WITH_FAILURES` goes away: a target needing a person keeps the campaign `ACTIVE`, so the
page shows work that is waiting, not a verdict that nobody reads. `expiresAt` is `createdAt` plus the
campaign lifetime setting and is frozen at launch.

## 3. The reconciler

`CampaignReconcilerWorkflow` replaces `CampaignWorkflow` for new campaigns. It holds no queue. Each
pass reads the database through activities, decides, and acts:

1. **Re-authorize.** The launch decision runs as the launcher in the gateway on every child start
   (§4), so the worker keeps no copy of it. The table in `docs/campaigns.md` §2 is replaced by that
   one call.
2. **Discover.** When a scope is set and the discovery interval has passed, run the check over the
   scope's repositories the launcher may reach. Each repository not yet a target and not satisfied is
   added at the end, up to `campaignMaxTargets`. One the launcher is not authorized for is recorded as a
   `proposal` row with the reason and is never started.
3. **Re-check.** `MERGED` and due `SATISFIED` targets run the check (§5).
4. **Schedule.** Pick `PENDING` targets whose gate is open, in `position` order, while children in flight
   are under `maxParallel` and open drafts are under `maxOpenPullRequests`. Others are `BLOCKED` with a
   reason.
5. **Sleep** until a signal or the next due time, then `continueAsNew` every 200 passes.

The wake-ups are signals, with a daily backstop that reads the database for any the signal missed:

| Signal | Sent by |
|---|---|
| `attemptFinished` | Run finalization, as orchestration's child-finished signal |
| `pullRequestChanged` | The pull-request webhook handler, when a `PullRequest` row a target points to is merged, closed or reopened |
| `control` | The routes: pause, resume, cancel, retry, add or remove a target, take over |

State is therefore recoverable from rows alone. A reconciler that crashed and restarted, or a campaign
whose workflow was terminated by hand, resumes at the next signal or backstop, and cancelling a campaign
whose workflow is gone closes the rows as `docs/campaigns.md` §8 does. The Limitation about targets
staying `RUNNING` after a termination narrows to "until the next backstop pass".

A child is no longer a Temporal child of the campaign. Its workflow is the run's own, started by the
gateway launch path, so closing the campaign's workflow no longer asks it to cancel. Cancel therefore
calls the run cancel path for each running attempt, which is what orchestration already does.

## 4. Starting an attempt

The worker's `startAttempt` activity calls `POST /api/v1/campaigns/:id/targets/:targetId/attempts` with
a campaign token scoped to that one call, the same mechanism as the orchestration token
(`docs/orchestrations.md` §8). The gateway validates in this order and stops at the first refusal:

1. The campaign is `ACTIVE` or `STARTING`, and the campaign setting is still on for the owning team and
   the target's team.
2. The launcher's account, organization membership and team roles still hold (the checks the worker
   re-checks today).
3. The target's repository still exists, is active, is a git repository and is owned by the team it had
   at launch.
4. The gate and backpressure conditions hold now, under a row lock on the campaign, so two concurrent
   starts cannot pass the same limit.
5. The standard launch decision for one repository, as the launcher: repository access, the GitHub
   permission gate, the organization and team budgets, the campaign's own budget (§8).
6. A transaction under that lock writes the attempt and the target's `RUNNING` state.

The GitHub permission gate judges a request's token and the worker has none. Orchestration checks push
permission live at each spawn through the gateway, so the same route can close the "checked at launch
only" limitation. That needs confirming against the code before it is promised.

An attempt retried with the same key is answered with the attempt its first call started.

## 5. The check

`CampaignRecipe` gains a second entry point. A recipe is `{ ref, params }` as today; each ref
now defines `apply` (today's script) and `check` (read-only: the same decision without installing
anything, committing or pushing).

| Ref | `check` answers |
|---|---|
| `npm-dependency@2` | The root `package.json` declares the package at or above the target version, or does not declare it |
| `go-module@2` | The root `go.mod` requires the module at or above the target version, or does not require it |

`@1` recipes keep working as `apply`-only, so a campaign launched with one has no check and no
discovery. The check runs in the same sandboxed `shell` step machinery as `apply`, with the base
branch cloned into a volume that holds no credential, and no model. It takes seconds, so the
reconciler runs it as an activity, not a child run.

The check inherits the known limit of the recipes: "not declared at the root" counts as satisfied, so a
package reached only transitively is satisfied here. The target's `evidence` records which branch of
the check passed (`declared-at-target`, `not-declared`), so a reader can tell a repository that was
fixed from one that was never affected.

A recipe's `check` and `apply` share one decision function, so a repository `apply` would change is
exactly one `check` calls not satisfied. A unit test asserts that, over the same fixtures, for every
recipe.

## 6. Work and order

**Uniform.** As today: the template `dependency-upgrade-campaign` (or any template that declares the
campaign input contract), the brief and the recipe, per target.

**Planned.** The `planner` runs once, at launch, as `planEpic` does, and writes one `CampaignTarget`
per repository with its own `brief` and the `dependsOn` edges it chose (restricted to
`RepoDependency` edges of status `active`). Targets start in dependency order, each when the
gate for every upstream target is open. `gate: MERGED` makes the order real: a downstream target does
not start until the upstream pull request merged and its check passed. The planner's output is data
the launcher reviews before the campaign leaves `STARTING`: a planned campaign launches into
`PLANNING`, whose card shows the briefs and edges, and `POST /:id/confirm` starts it. A uniform
campaign skips that state.

A failed or `SKIPPED` upstream target blocks its transitive dependents as `epicOrchestrator` does
today (`computeTransitiveDependents`), reported as `BLOCKED` with the upstream's name. A person can
retry the upstream target, which unblocks the rest, or remove the edge.

## 7. Retry and hand-over

| Action | Who | Effect |
|---|---|---|
| Retry a target | Creator, owning-team `LEAD`, ADMIN | A new attempt for a `NEEDS_ATTENTION` target, on branch `<prefix>/CAMPAIGN-<id12>-<n>` for attempt `n > 1`, since the first branch exists. Acts as the campaign's launcher |
| Remove a target | Same | `SKIPPED`, reason recorded, nothing on the host touched |
| Add targets | Same, and the person must pass the launch decision for each | Appended; counts against the target limit |
| Pause, resume | Same | `PAUSED` and back |
| Take over | Owning-team `LEAD` or ADMIN, never the current launcher | The launch decision is re-run as the new person for every unfinished target. Targets they cannot reach become `SKIPPED` with the reason; the rest continue as them. Audited with both identities |

A launcher whose account is deactivated, or who leaves the organization, does not cancel the campaign.
It moves to `PAUSED` with `pausedReason: launcher-unavailable`, and an owning-team `LEAD` takes over.

## 8. Budget

A campaign gets a budget of its own: `budgetUsd`, optional, frozen at launch. Children are metered per
run as today. Before an attempt starts, the gateway sums the campaign's attempts for the current month
and refuses at the cap, which pauses the campaign with `pausedReason: budget`. The limit is advisory
for runs already in flight, which finish. The organization and team caps still apply first.

## 9. Sharing with orchestration and epics

**Orchestration.** The shared library is the call from a worker activity to a gateway route with a
scoped per-call token, the finish signal with a reconcile poll, and the fenced, screened rendering of a
child's result (`docs/orchestrations.md` §3). Campaign attempt results reach a person, not a model, so
the fencing matters only for `proposeCampaign` and for any future agent that reads campaign state. The
orchestrator gains one intent, `proposeCampaign`, which records a card. A launcher's confirmation is
the launch; nothing starts without one.

**Epics.** `POST /api/v1/epics` becomes a launch of a `PLANNED` campaign with `scope` unset,
`gate: OPENED` (today's meaning: a downstream repository starts once upstream's run succeeded) and
`recipe` unset. The `/epics` pages, the CLI epic commands and `GET /api/v1/epics` read the same rows
filtered by `plan = PLANNED`, so existing links keep working. Epics already running finish on
`EpicOrchestratorWorkflow`.

**Cross-organization.** Epics can span organizations today, spending against each. A campaign is
one organization. The first release keeps epics' behaviour by allowing a `PLANNED` campaign to name
repositories of more than one organization, with each attempt billed to its repository's team and
organization, as epic children are. A `UNIFORM` campaign stays single-organization. This is open
(see below), because it sets a different authorization shape for the two modes.

## 10. Data model

All additive. No existing column is dropped.

| Change | Detail |
|---|---|
| `campaigns` | `plan` (`UNIFORM`, `PLANNED`), `gate` (`OPENED`, `MERGED`), `scopeKind` and `scopeId` (null, `TEAM`, `ORG`), `maxOpenPullRequests`, `staleAfterDays`, `rescanIntervalHours`, `budgetUsd`, `expiresAt`, `launchedById` (replaces reading `createdById` as the acting identity), `pausedReason`, `launcherChangedAt`. New state values `PLANNING`, `PAUSED`, `MONITORING` |
| `campaign_targets` | `brief` (planned work), `dependsOn` (uuid array of target ids), `evidence` (JSON), `regressions`, `staleSince`, `lastCheckedAt`, `lastCheckedSha`, `pullRequestId` (nullable FK to `pull_requests`, `SetNull`). New state values `BLOCKED`, `MERGED`, `SATISFIED`, `NEEDS_ATTENTION` |
| `campaign_attempts` | `targetId`, `n`, `runId`, `childWorkflowId` (unique), `path`, `verification`, `outcome`, `failureReason`, `startedAt`, `finishedAt`. Unique on `(targetId, n)` |
| `campaign_proposals` | A repository found by discovery and not started: `campaignId`, `connectionId`, `reason`, `decidedAt`. Unique on `(campaignId, connectionId)` |

`CampaignTarget.childWorkflowId`, `path` and `verification` move to the attempt; the target keeps the
last attempt's values as read-time fields on the API, not as columns. The migration copies each
existing target with a child into attempt 1 and maps states: `PR_OPENED` stays; `NOT_AFFECTED` becomes
`SATISFIED` with `evidence: { kind: 'initial' }`; `FAILED` becomes `NEEDS_ATTENTION`. Because `PR_OPENED`
stops being final, a campaign that finished before the migration is not re-opened: it keeps its
`COMPLETED*` state and its targets are not reconciled.

Per `prisma-pgvector-hnsw`, the migration is read before it runs: the partial unique indexes and the
HNSW index are hand-written and `migrate dev` would drop them.

## 11. API

Existing routes keep their paths. Changes:

| Route | Change |
|---|---|
| `POST /api/v1/campaigns` | Body adds `plan`, `gate`, `scope`, `maxOpenPullRequests`, `staleAfterDays`, `rescanIntervalHours`, `budgetUsd`, `lifetimeDays`. A recipe's `ref` may be `@2`. A planned campaign answers `201` in `PLANNING` |
| `GET /api/v1/campaigns`, `GET /:id` | `counts` over the new states; each target adds its delivery detail (pull-request status, draft, CI), `dependsOn`, `staleSince`, attempts |
| `POST /:id/confirm` | Launcher only; `PLANNING` → `ACTIVE` |
| `POST /:id/pause`, `/resume` | As §7 |
| `POST /:id/takeover` | As §7 |
| `POST /:id/targets` | Add targets |
| `POST /:id/targets/:targetId/retry`, `DELETE /:id/targets/:targetId` | Retry, remove |
| `POST /:id/targets/:targetId/attempts` | Worker only, campaign token (§4) |

Every route needs an `assistantPolicy.ts` entry. The assistant may read campaigns and, after the
person confirms, cancel, pause or resume one. It never launches, adds targets, retries or takes over,
since each opens or authorizes pull requests in repositories of other teams. The routes for
`confirm`, `takeover` and `attempts` are `never`.

## 12. Settings

New registry definitions in the `workflow` group, all overridable at team and organization scope,
none pinned to a run (the gateway freezes the values it resolves into the campaign): the default and
ceiling of `maxOpenPullRequests`, the default `staleAfterDays`, the default `rescanIntervalHours` and its
floor (so a campaign cannot recheck every minute), and the campaign lifetime in days. The existing
`workflow.campaignsEnabled`, `workflow.campaignMaxTargets` and `workflow.campaignMaxParallelChildren`
are unchanged. Key names are decided when the definitions are written, so `yarn docs:check` binds the
spelling in the living docs then.

## 13. Dashboard

The campaign list shows progress as satisfied over total, with a count that needs attention, replacing
the per-state breakdown of "finished". The detail page groups targets by the question a reader has:
needs attention, in review, running or blocked, satisfied. A blocked target names what it waits for. A
stale pull request shows its age. A `PLANNING` campaign shows the briefs and edges with **Confirm** and
**Edit before confirming**. **Pause**, **Resume**, **Take over** and per-target **Retry** and **Remove** sit
beside the existing cancel, behind the confirmations cancel has.

## 14. Rollout and compatibility

1. **Schema and routes first**, with the old workflow still the one new campaigns start. Nothing
   behaves differently.
2. **The reconciler**, behind a campaign setting that is off by default. New campaigns pick the
   workflow at launch and record it on the row. A campaign runs to the end on the workflow it started
   on.
3. **The old workflows stay registered** while any can still be running: `CampaignWorkflow` for its
   30-day maximum, `EpicOrchestratorWorkflow` until no epic row is non-final. Their replay fixtures are
   kept and never re-recorded. They are removed in a later change once the check below is empty.
4. **The reconciler needs its own replay fixtures**, one per control-flow shape: reconcile with a
   gate, a pause, a signal-driven wake, a regression, `continueAsNew`. A change to its scheduling later
   goes behind `patched('campaign-…')`.
5. **Upgrade note.** Operators must add `docs/upgrade-notes.md` entries for the enum additions, the
   new settings, and the fact that `PR_OPENED` is no longer final, keyed by the condition that makes a
   deployment affected, plus a one-line check an operator runs before removing the old workflows:
   `SELECT count(*) FROM campaigns WHERE state IN ('STARTING','RUNNING','CANCELLING') AND workflow_kind = 'LEGACY'`
   (the column to record at launch).

## Tests

- **Unit.** Target-state transitions as a pure function over (state, event); the gate and backpressure
  decision; the discovery diff; the `check`/`apply` agreement test (§5); the take-over reachability
  rule.
- **Workflow.** `TestWorkflowEnvironment` with fakes: a campaign reaching `COMPLETED`; a merged signal
  turning `PR_OPENED` into `SATISFIED`; a regression returning a target to `PENDING`; pause during
  flight; a missed signal recovered by the backstop; `continueAsNew` carrying counters.
- **Replay.** The new fixtures of §14, and the existing campaign and epic fixtures unchanged.
- **Postgres.** A `*.pg.test.ts` suite for the lock in §4 step 4 and the migration's state mapping,
  named in `ci.yml` with its gate flag. This closes the Limitation that the campaign activities have
  no database-backed test.
- **Gateway.** `app.inject()` over every route in §11, including the `never` policies.

## Limitations

- **No event source starts or feeds a campaign.** A Dependabot alert, a code-scanning finding or an
  `inbound.event` automation cannot create a campaign or add a target. Discovery is the scope plus the
  check, on a timer. An automation that adds targets would be a later extension of the same
  `POST /:id/targets` route, run as a service principal.
- **A check exists only for recipes.** A campaign with no recipe cannot discover targets or confirm a
  merge satisfied the goal. Its targets finish by merge, and the state is read as `MERGED` and stays so
  until a person removes the target. A deterministic check for a framework change has no natural
  form; an agent-written check is out of scope.
- **The check inherits the recipe limits.** A transitive-only dependency counts as satisfied, an npm
  `overrides` entry and a Go `replace` are not read, and Python and JVM projects have no recipe.
- **Merge conflicts between the platform's pull requests and a moving base are not repaired.** A
  conflicting draft is left for its reviewer, as for any pull request. A `MERGED` target whose check
  fails because the base moved needs a person.
- **A pull request the platform did not open is not followed.** If a person closes the draft and opens
  their own, the target reads `NEEDS_ATTENTION` until a retry or the next check finds the repository
  satisfied.
- **Stale is a flag, not an action.** Nothing closes or pings a stale draft beyond the owning-team
  notice.
- **Take-over re-runs the launch decision once.** A later loss of access to a repository skips only
  the targets not yet started, as before; running attempts finish.
- **Cross-organization planned campaigns widen the blast radius of one launch.** The launcher must lead
  the team of every repository, as for an epic today, and each organization's budget is checked per
  attempt, not at launch.
- **Draft pull requests already opened are never closed by a cancel or a removal.**
- **No CLI command** for the new routes until the CLI package adds them.

## Open questions

1. **Cross-organization.** Keep the §9 split (planned campaigns may span organizations, uniform ones may
   not), or make every campaign one organization and tell epic users to split? The split preserves
   today's epics; one organization halves the authorization cases.
2. **Is `MERGED` as a gate worth its latency?** Gate `MERGED` makes ordering real and makes a chain of
   five repositories take as long as five reviews. Default it to `OPENED` and let a launcher opt in?
3. **Can the GitHub permission gate run on the gateway at every child start with no request token?**
   Orchestration does it for push permission; confirm that the same mechanism covers the full gate
   before §4 relies on it.
4. **Does `PullRequest` carry every pull request a campaign opens?** Targets point at it by id. A
   recipe's pull request is opened by the template, not an agent run; confirm both paths write the row
   before the delivery state is read from it.
5. **Should the existing `campaignsEnabled` kill switch pause running campaigns, not only refuse
   starts?** Today it stops the remaining targets of a running campaign. With a monitoring state,
   turning it off should plausibly move every campaign to `PAUSED`.
