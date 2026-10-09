# CI failure triage and fix

When a GitHub Actions workflow fails on a repository with a matching **CI-failure trigger** (an
[event automation](./automations.md) of the `github.workflow_run.failed` source), the
platform starts the `ci-triage-and-fix` template. It diagnoses the failure from its
logs and, when the diagnosis says a code change can fix it, opens a **draft** pull request into the
branch that failed — or, for a failing pull request where an admin allows it and its trigger asks,
pushes the fix onto that pull request's own branch (§2.1). It never pushes to the default branch, a
protected branch or one an admin lists, never changes workflow files, and never merges.

This is separate from the CI loop inside the engineering templates, which fixes CI on a pull
request the platform itself opened. The triage template covers failures on branches and pull
requests the platform did not open: `main`, release branches, and people's pull requests.

---

## 1. The `github.workflow_run.failed` automation

A CI-failure trigger is an [event automation](./automations.md) with the source
`github.workflow_run.failed`. When a GitHub Actions run on its repository fails and its filters
select the run, the platform starts the triage template. Creating, managing, limits, the options
builder and the decision ledger are shared by every event source and described in
[automations.md](./automations.md). This section covers what is specific to CI failures.

| Filter | Meaning | Dashboard default |
|---|---|---|
| `events` | Any of `push`, `pull_request` and `schedule`. A scheduled run (a nightly build) tests the head of a branch already in the repository, so it is handled like a push to that branch | `push` |
| `branchPatterns` | Globs over the failing branch (`main`, `release/*`, `!release/legacy`). At least one pattern that is not a `!` exclusion | `main, release/*` |
| `workflowPatterns` | Globs over the workflow **file path** (`.github/workflows/ci.yml`), never its display name, which a pull request can change | `.github/workflows/**` |

In globs, `*` matches within one path segment, `**` matches across them, and `?` matches one
character. A later pattern overrides an earlier one, so `!` exclusions go after what they exclude.
An empty list never means "everything".

The default template is the built-in `ci-triage-and-fix`. It declares these options:

| Option | Meaning | Default |
|---|---|---|
| `mode` | `triage` (diagnose and report) or `fix` (also attempt a draft fix) | `triage` |
| `commentOnPullRequest` | Post the diagnosis, and any fix, on the failing pull request | `true` |
| `minFixConfidence` | A fix is attempted only when the diagnosis' confidence is at least this (0.3–1) | 0.6 |
| `fixCategories` | Which diagnoses are fixed: any of `regression`, `test_bug`, `configuration`, `dependency` (at least one) | all four |
| `maxCiFixAttempts` | How many times a draft is revised while its own CI fails (0–5) | 2 |
| `pullRequestDelivery` | For a failing pull request: `draft_pr` (a draft into its branch) or `push` (a commit pushed onto its branch, §2.1). A request, not a grant; a push failure always gets a draft. Gated: refused at save while `github.ciFixPushToPullRequestEnabled` is off, and with any template but the default | `draft_pr` |

The occurrence fills `baseBranch`, `githubRunId`, `runAttempt` and, for a pull request,
`pullRequestNumber`. A CI-aware team template must declare `githubRunId`, and every option it
shares a name with keeps the built-in's meaning and bounds: the source's payload contract
(`CiTriagePayloadSchema`) is checked on every CI payload.

### From webhook to run

GitHub sends a `workflow_run` event when a run completes. It is accepted at `/api/v1/webhooks/git`
and at `/api/v1/webhooks/ci`, because a GitHub App has a single webhook URL. The delivery is
verified and bound to its host exactly like the other GitHub deliveries
([repositories.md](./repositories.md)). Then, without calling GitHub, the source **ignores**, with
nothing recorded:

- a run that is not `completed` with `failure` or `timed_out`;
- an event other than `push` or `pull_request`;
- a run whose head repository is not this repository (compared by id, so a fork renamed to the same
  name is still a fork);
- a branch name that is not a valid branch;
- one of the platform's own `<branchPrefix>/…` branches, which have their own CI loop. This also
  stops a draft fix whose CI fails from triggering a fix of the fix.

The rest goes to the engine ([automations.md §2](./automations.md#2-from-occurrence-to-run)). For CI:

- **Decision keys.** The *subject* is the commit, so one run per commit, whichever workflow failed
  or was re-run. The *scope* is the branch, for the cooldown and the in-flight check. The look-back
  for in-flight runs is 36 hours (an implementation, then up to six CI waits of four hours). The
  dedupe key is the run attempt on its repository.
- **Suppressions.** A `pull_request` failure with no open pull request from this branch of this
  repository is `SUPPRESSED_PRECONDITION`. A commit the platform pushed as a fix (§2.1) is
  `SUPPRESSED_OWN_OUTPUT`.
- **The run.** It starts as a synthetic ticket `ci-<runId>-<attempt>`, on the branch
  `<branchPrefix>/ci-<runId>-<attempt>`, with the workflow id `ci-<automation8>-<runId12>-<attempt>`.
  GitHub does not redeliver a webhook by itself: when the start fails and the delivery answers
  `503`, redeliver it from the webhook's delivery log, or use **Decide again** in the automation's
  history ([automations.md](./automations.md#2-from-occurrence-to-run)).

The payload carries every option explicitly, defaults included. For a push the base branch is the
pushed branch. For a pull request it is the pull request's head branch. A fix is then a draft
**into the author's branch**, which they can merge into their own pull request — or, with
`pullRequestDelivery: push` where allowed, a commit on that branch (§2.1).

## 2. The template

`ci-triage-and-fix` is a built-in template. Its run payload names the failing run **by id**:

| Field | Meaning |
|---|---|
| `connectionId` | The repository (a `git_repo` connection) |
| `githubRunId`, `runAttempt` | The failed workflow run and its attempt |
| `baseBranch` | The branch that failed: the pushed branch, or the pull request's head branch. A fix is cut from it and opened into it |
| `pullRequestNumber` | The pull request, for a `pull_request` failure |
| `mode`, `commentOnPullRequest`, `minFixConfidence`, `fixCategories`, `maxCiFixAttempts`, `pullRequestDelivery` | The options in §1. Each is optional and takes the same default there, so a run started by hand with only a run id diagnoses without fixing |

The payload carries no URL. The worker reads the run, its jobs and their logs from the
repository's own API (`fetchWorkflowRunFailure` in the SCM provider), so a payload cannot point the
platform's credential at another repository.

The run goes through these nodes:

1. **`triage`** (`triageCiFailure`) reads the run from GitHub and decides whether it may act on it
   at all (§3). It then gives the failed jobs' log tails to the `ciTriager` agent, which returns a
   typed verdict: a category, whether code can fix it, a confidence, a summary, the root cause and
   a suggested fix.
2. **Code decides**, from the verdict and the facts around it, whether the run goes on to `fix`,
   `report` or `skip` (§4). The model can rule a fix out, but it cannot start one the rules refuse.
3. **`report`** posts the diagnosis on the pull request (when asked) and ends the run `SUCCESS`.
   **`skip`** ends it `SKIPPED` with the reason. Both results carry the diagnosis.
4. **`fix`** runs the implementer on the failing branch's current tip. The diagnosis reaches it
   fenced as untrusted data (§5). Lint, typecheck and tests run, and a draft pull request is opened
   into the failing branch. A fix that changed no files opens nothing and is reported instead.
   The draft's own CI is then watched by the usual CI loop, which revises the draft up to
   `maxCiFixAttempts` times while it keeps failing and then ends the run `FAILED`. It can poll
   instead of waiting for the webhook when the CI wait strategy at `/govern/workflow-defaults` says
   so, which matters here: a draft into a feature branch often runs no CI at all.
5. When the failure came from a pull request, the diagnosis comment links the draft, and says why
   when a push was asked for and refused.
6. **A fix attempt that fails** (a refused change, the security gate, the budget) still posts the
   diagnosis, then ends the run `FAILED` with the error. Nothing is opened.

### 2.1 Pushing a fix onto a pull request's branch

With `pullRequestDelivery: push`, after the quality gates the run tries
`pushCiFixToPullRequest` before opening a draft. It moves the pull request's branch to the fix
commit — which the implementation already pushed to the run's own work branch — through the refs
API with `force: false`, so GitHub accepts only a fast-forward. It pushes only when, at that
moment, every one of these holds; otherwise it answers with the reason and the run opens the draft
instead, and the comment says why:

- the run is the very execution an automation started: its decision row names the run's request
  **and** its workflow id, so a run started by hand, and a re-run of a triggered run (which keeps
  the request), never pushes;
- the template the run executes — recorded when the trigger started it — is the built-in one, the
  trigger still uses it, and the **trigger's stored options** ask for `push`. The payload alone is
  not enough;
- the commit is the tip of the run's own work branch (`<branchPrefix>/ci-<runId>-<attempt>`), where
  the built-in implementer wrote it under the workflow-file refusal (§2.2);
- `github.ciFixPushToPullRequestEnabled` is on for the repository's team (off by default, ADMIN);
- the failure is a `pull_request` run whose pull request is still open, from this repository, with
  the failing branch as its head;
- the branch is not the repository's default branch, not protected (GitHub's branch protection
  flag), and not matched by `github.ciFixNeverPushBranches`, compared without case (by default
  `main`, `master`, `develop`, `trunk`, `release/**`, `releases/**` and `hotfix/**`; the list
  needs at least one pattern, so it cannot be emptied);
- the fix commit is ahead of the branch's current tip with nothing behind it, and no path in the
  range is under `.github/workflows` or `.github/actions`. This is a second, path-only check; the
  implementer's refusal (§2.2), which also covers symlinks and submodules, is the full one.

The fix commit is written to the decision row (`producedKey`) **before** the push, and cleared again
if GitHub refuses it. A retry after a push whose reply was lost finds the branch at the recorded
commit and reports it pushed. The pull request's
own CI then runs on it; a failure of that commit is suppressed as `SUPPRESSED_OWN_OUTPUT`, so a fix is
never fixed again by another run. The run's work branch is deleted after a successful push, and the
run ends `SUCCESS` with the commit in its result. There is no CI loop on this path.

A trigger asking for `push` is refused at save (`OPTION_DISABLED`) while the setting is
off, and (`INVALID_INPUTS`) with a template other than the built-in; the run decides again from the
setting and the branch as they are when it pushes.

### 2.2 Workflow files

Every implementer step in the template, including the CI loop's fix, sets
`refuseWorkflowChanges`. Before the push, the step fails (`DIFF_TOUCHES_WORKFLOWS`) on:

- a change under `.github/workflows` or `.github/actions`, or to either path itself, in any case;
- any added or changed symlink or submodule, either of which can point a checked path at content
  the check never read.

This refusal stops the agent editing workflow and action YAML. **It is not a secrets boundary.**
The draft's branch is pushed to the repository, so `on: push` and `on: pull_request` workflows run
on it with whatever secrets they are given. They run the repository's own code, which the fix may
change: package scripts, test files, build scripts, a local action referenced from outside
`.github/actions`. Restrict what secrets workflows expose to branches the platform pushes
(`<branchPrefix>/…`), as for any automated contributor.

The CI loop's fix also sets `untrustedCiLogs`. The draft's CI output is redacted, screened as in
§4, and fenced before the fixer sees it. Logs that fail the screen stop the fix with
`CI_LOGS_REFUSED` instead of being used.

### The base branch

The template is the main user of a run's **base branch** (`payload.baseBranch`). Every step that
clones uses it: the implementation, the three fix sessions, the quality gates, shell steps and agent
nodes. They clone it, diff against it, and open the pull request into it. See
[product-overview.md](./product-overview.md) for how a launch sets it.

## 3. When a run is not acted on

`triageCiFailure` skips the run (`decision: skip`), without calling the model, when GitHub's record
of the run says any of these:

- it belongs to another repository than the run's connection;
- it has not completed with `failure` or `timed_out`;
- it was triggered by anything other than `push` or `pull_request`;
- its head commit came from a fork, or from a fork since deleted;
- it names no branch, or a branch other than the payload's `baseBranch`;
- the branch no longer exists, or the name is a tag (`branchHeadSha` finds no branch);
- for a `pull_request` failure, that pull request is closed, or its head is no longer this branch
  in this repository.

## 4. Fix or report

A run goes on to a fix only when all of these hold. Otherwise it reports the diagnosis with the
reason:

- the payload's `mode` is `fix`;
- at least one failed job's log could be read;
- the logs passed the prompt-injection screen (`ciLogIsUsable`, over the whole text). It uses the
  active `INJECTION` scanner patterns except `template-injection`, which matches every `{{ }}` a
  build prints. The `EXFILTRATION` set is not used: it is written for prose and matches nearly
  every log (`https://…`, `curl `). A scan that matches, or cannot complete, means the logs are
  never used to fix from;
- for a pull request, the branch has not moved since the failure. A pushed branch that moved is
  still fixed, on its current tip;
- the category is `regression`, `test_bug`, `configuration` or `dependency`, and the verdict says
  `fixable`. `flaky`, `infrastructure` and `unknown` are never fixed, whatever a trigger says;
- the category is one of the trigger's `fixCategories`;
- the confidence is at least the trigger's `minFixConfidence`.

## 5. What reaches the model, and what reaches the PR

- **Logs are redacted** before the triager, the CI loop's fixer, the trace or the brief sees them.
  This applies `redactString`, plus GitHub, AWS, Slack, OpenAI-style, JWT and private-key token
  shapes. GitHub masks only the secrets it was given.
- **Logs are downloaded through the guarded fetch** the CI loop uses (`downloadCiLogs`). Every
  redirect hop passes the SSRF guard and is pinned, the credential goes only to the repository's
  API origin, and each download times out after 15 s.
- **The implementer gets the diagnosis as untrusted data.** It arrives through the step's
  `ciDiagnosis` input, not `guidance`, and is fenced and labelled as derived from CI logs, never as
  the requester's instructions.
- **The pull request comment is rendered from the verdict's fields**, not posted as model text.
  Each field is flattened to one line and bounded, and mentions, autolinks, HTML and markdown
  structure are neutralised. The only link is the draft's URL as GitHub returned it.
- **The platform edits one comment per pull request** rather than adding one per failure. It is
  found by a hidden marker, but only among comments **the platform wrote**: the login a PAT
  authenticates as, or, for a GitHub App, the App id GitHub stamps on its comments. Anyone can
  paste the marker, and a write credential can edit other people's comments, so the marker alone
  is never enough. When the platform cannot tell which comments are its own, it posts a new one.
  A comment that cannot be posted is reported in the step output and does not fail the run.

## 6. The `ciTriager` agent

A sub-role persona on the `planner` model ([agents.md](./agents.md)). It has no tools and returns a
structured verdict. It cannot be launched as an agent run: its output routes a workflow, so it is on
the non-launchable list. A step `systemPrompt` override applies to it like any agent step.

## 7. GitHub permissions

- **Workflow run** must be among the App's subscribed events (or the repository webhook's), or no
  failure ever reaches the platform.
- **Actions: Read** lets the worker read a run's jobs and logs. An installation created before the
  App asked for it must accept the new permission; until then `triageCiFailure` fails
  non-retryably with `CI_RUN_FORBIDDEN`.
- Commenting on a pull request uses the existing **Pull requests: Read and write**.
- Pushing a fix onto a pull request's branch (§2.1) uses the existing **Contents: Read and write**.
  A ruleset that the platform's credential cannot satisfy (signed commits, a required linear
  history, a bypass list it is not on) makes GitHub refuse the push, and the run opens a draft.

See [github-app-setup.md](./github-app-setup.md).

## Limitations

- **Only `push`, `pull_request` and `schedule` runs.** A `workflow_dispatch` run, a merge-queue run
  and anything a fork's code produced are never acted on. Neither is a `startup_failure` (an invalid
  workflow file), which has no logs.
- **A nightly that keeps failing is diagnosed once per commit.** A scheduled run's subject is the
  commit it tested, so when the branch has not moved, the next night's failure is
  `SUPPRESSED_SAME_SUBJECT`. Its cooldown and in-flight checks are shared with pushes to the same
  branch.
- **One run per commit per repository.** When several workflows fail on one commit, only the
  first to finish is diagnosed, whichever trigger it matched. A re-run that fails again on the same
  commit is not diagnosed again.
- **A failed start is not retried by itself.** After three attempts the delivery answers `503`, the
  decision is recorded as `FAILED_TO_START`, and nothing more happens until someone redelivers it or
  decides again. Failures that arrived while the start was being attempted were suppressed against
  it (as the same commit, the cooldown or in flight) and stay suppressed until each is decided
  again by hand. A decision that fails in the database answers `500` with nothing recorded.
- **The decision history is kept for a while.** Suppressed decisions are recorded too and kept for
  `workflow.automationDecisionRetentionDays` (90 days by default); decisions that started a run are
  kept for good. Deleting a trigger keeps its decisions in the repository's ledger
  ([automations.md](./automations.md#the-ledger)).

- **Only GitHub Actions.** A failure reported by another CI system (commit statuses, third-party
  check runs) is not read. The run is looked up through the Actions API.
- **Only the end of each log.** The triager sees the tail of at most five failed jobs: 12,000
  characters each, 40,000 in all. A failure whose cause is printed early in a long log can be
  misdiagnosed.
- **Pull-request runs test a merge commit.** GitHub tests the branch merged with its base, so a
  failure the base caused does not reproduce on the head branch. The triager is told to say so;
  the fix is still attempted on the head branch.
- **Workflow files are never changed.** A failure that only a workflow change can fix is diagnosed
  and reported, not fixed.
- **Injection screening is pattern-based.** It is only as good as the active `INJECTION` patterns:
  it catches known phrasing, not every instruction a log could carry, and finds nothing when an
  admin has deactivated them. The fenced brief and the workflow-file refusal narrow what a planted
  instruction can do; neither is a secrets boundary (§2.2).
- **Comment search is bounded.** The platform's marked comment is looked for in the first 3,000
  comments of the pull request. On a longer thread, a second comment can appear rather than an
  edit.
- **A failed draft is not reported on.** If opening the draft pull request fails (a repository
  that cannot hold drafts), the run fails without posting the diagnosis.
- **A pushed fix skips the draft's review.** With push delivery the agent's commit lands on the
  author's pull request, and is reviewed only as part of it; an approval given before the push stays
  unless the repository dismisses stale approvals. The push also re-runs that pull request's
  workflows (`synchronize`).
- **A pushed fix is not revised.** There is no CI loop after a push: if the pull request's CI
  fails on the fix, the failure is suppressed as the platform's own and nothing more happens. An
  author's later commit is triaged as usual.
- **Protection is read from GitHub's branch flag.** A branch guarded only by a repository ruleset
  that the platform's credential bypasses is not seen as protected; list such branches in
  `github.ciFixNeverPushBranches`.
- **Push delivery is the built-in template's only.** A team template cannot use it.
- **A run started by hand is checked less.** A launch from the template page is checked against
  the template's input schema only, not the CI payload contract a trigger's options pass through, so
  a value the worker refuses (a `null` option, say) ends the run at the triage step.
- **Some decisions are not options.** Changing workflow files, acting on forks, tags and the
  platform's own branches, and the set of events are fixed, because each would widen what an agent
  can do with the platform credential rather than tune how it decides.
- **Options follow the template, not a version of it.** A trigger stores the options it changed;
  the rest are read from the template's input schema at each fire. A release that changes the
  built-in schema moves an untouched stored schema forward, but a schema an admin edited is kept,
  and then a new built-in option does not appear until the admin adds it.
- **Nothing proves the fix.** The draft's own CI loop is the check. The template does not re-run the
  originally failing workflow on the fix before opening the draft.
