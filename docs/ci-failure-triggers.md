# CI failure triage and fix

When a GitHub Actions workflow fails on a repository with a matching **CI-failure trigger**, the
platform starts the `ci-triage-and-fix` template. It diagnoses the failure from its
logs and, when the diagnosis says a code change can fix it, opens a **draft** pull request into the
branch that failed. It never pushes to an existing branch, never changes workflow files, and never
merges.

This is separate from the CI loop inside the engineering templates, which fixes CI on a pull
request the platform itself opened. The triage template covers failures on branches and pull
requests the platform did not open: `main`, release branches, and people's pull requests.

---

## 1. Triggers

A **CI-failure trigger** is a rule on one repository (`CiFailureTrigger`). When a GitHub Actions
run on that repository fails and a trigger matches it, the platform starts the triage template.
Triggers are opt-in per repository; there are none until someone creates one.

A trigger has three parts: **when** it fires, the **limits** on how often, and **what** it starts —
a template and that template's own options.

| Field | Part | Meaning | Default |
|---|---|---|---|
| `name` | — | A label | — |
| `events` | when | `push` and/or `pull_request` | `push` |
| `branchPatterns` | when | Globs over the failing branch (`main`, `release/*`, `!release/legacy`). Required, with at least one pattern that is not a `!` exclusion | — |
| `workflowPatterns` | when | Globs over the workflow **file path** (`.github/workflows/ci.yml`), never its display name, which a pull request can change | `.github/workflows/**` |
| `cooldownMinutes` | limits | No new run for the same branch within this many minutes of the last one started (0–10080) | 30 |
| `maxRunsPerDay` | limits | Most runs the trigger starts in any 24 hours (1–500) | 10 |
| `templateId` | what | A template to start instead of the built-in `ci-triage-and-fix`: active, and global or the repository team's own, and CI-aware (its input schema names `githubRunId`) | the built-in |
| `inputs` | what | The template's options this trigger sets (below). An option left out takes the template's default | `{}` |
| `enabled` | — | — | `true` |

**Options** are not fixed by the trigger: they are whatever the chosen template declares in its
input schema, minus the fields the failing run fills (`baseBranch`, `connectionId`, `description`,
`githubRunId`, `pullRequestNumber`, `runAttempt`, `ticketId`), which a trigger can never set. The
dashboard renders the form from that declaration, so a team template that declares its own options
gets a form for them. The built-in template declares these:

| Option | Meaning | Default |
|---|---|---|
| `mode` | `triage` (diagnose and report) or `fix` (also attempt a draft fix) | `triage` |
| `commentOnPullRequest` | Post the diagnosis, and any fix, on the failing pull request | `true` |
| `minFixConfidence` | A fix is attempted only when the diagnosis' confidence is at least this (0.3–1) | 0.6 |
| `fixCategories` | Which diagnoses are fixed: any of `regression`, `test_bug`, `configuration`, `dependency` (at least one) | all four |
| `maxCiFixAttempts` | How many times a draft is revised while its own CI fails (0–5) | 2 |

A trigger stores only the options it changes from the default, so a template whose default moves
carries its triggers along.

In globs, `*` matches within one path segment, `**` matches across them, and `?` matches one
character. A later pattern overrides an earlier one, so `!` exclusions go after what they exclude.
An empty list never means "everything".

### Managing triggers

On the dashboard, **Connections** (`/connections`) has a **CI-failure triggers** action for each git
repository. It lists the repository's triggers and their recent decisions to its members, and lets
those who may manage them add, edit, enable, disable and remove one. The form has a tester: given an
event, a branch and a workflow file, it says whether the trigger would react and, if not, which
part rules it out. It uses the same matcher (`ciTriggerMismatch`) the webhook does, and says nothing
about the cooldown, cap and in-flight checks, which depend on earlier runs. The same operations are
available through the API:

| Route | Who |
|---|---|
| `GET /api/v1/repositories/:id/ci-triggers` | A member of the owning team or of a team the repository is shared with, or ADMIN; under an enforcing [access gate](./repo-access-gating.md) a member also needs a current GitHub permission on the repository. The response says whether the caller may manage them (`canManage`) |
| `POST /api/v1/repositories/:id/ci-triggers` | ADMIN, or a LEAD of the repository's **owning** team |
| `PATCH` / `DELETE /api/v1/repositories/:id/ci-triggers/:triggerId` | The same |
| `GET /api/v1/repositories/:id/ci-triggers/:triggerId/fires?limit=` | A member, as for the list |
| `GET /api/v1/repositories/:id/ci-triggers/templates` | A member, as for the list: the templates a trigger here may start, each with the options it declares |

A trigger in fix mode opens pull requests on the repository with the platform credential. That
is why managing triggers stays with the owning team, like every other repository setting, and a
shared team can read them but not create one.

Saving a trigger that can start runs is a **launch decision**, made as it is for a schedule. This
covers creating an enabled trigger, and any change other than switching one off. The repository
must be active. The access gate judges the caller's own GitHub login (the runs use the platform
credential), and the caller must belong to the repository's organization, which must be under its
monthly cap. Otherwise a lead whose GitHub access was revoked could keep a trigger acting on the
repository. Switching a trigger off is never refused.

A trigger's `templateId` must name a template that is active, not a system template, global or the
repository team's own, and whose input schema names `githubRunId`. Its `inputs` must be options that
template declares, and the payload they build (`buildCiTriggerPayload`: every declared default,
then the trigger's options, then the failing run's fields) must pass both the template's input
schema and the CI payload contract the worker parses (`CiTriagePayloadSchema`) — so a value the
worker would refuse is refused at save, not after a run has started. Changing the template checks
the options the trigger keeps against it. Every create, update and delete is written to the audit
log.

### From webhook to run

GitHub sends a `workflow_run` event when a run completes. It is accepted at `/api/v1/webhooks/git`
and at `/api/v1/webhooks/ci`, because a GitHub App has a single webhook URL. The delivery is
verified and bound to its host exactly like the other GitHub deliveries
([repositories.md](./repositories.md)). Then, without calling GitHub:

1. **Ignored outright**, with nothing recorded:
   - a run that is not `completed` with `failure` or `timed_out`;
   - an event other than `push` or `pull_request`;
   - a run whose head repository is not this repository (compared by id, so a fork renamed to
     the same name is still a fork);
   - a branch name that is not a valid branch;
   - one of the platform's own `<branchPrefix>/…` branches, which have their own CI loop. This
     also stops a draft fix whose CI fails from triggering a fix of the fix;
   - a failure no enabled trigger matches;
   - a deployment, organization or team with `github.ciFailureTriggersEnabled` off.
2. **The first matching trigger acts.** Repository rows are taken oldest first, and triggers
   oldest first within each. One failed run attempt starts at most one run, however many triggers
   or repository rows match it.
3. **The decision is recorded** as a `CiFailureTriggerFire`, keyed by the run attempt on its host.
   A redelivered webhook therefore answers `duplicate` and starts nothing. The decision is taken
   under a transaction lock on the **repository**, so concurrent deliveries see each other. A run
   is **suppressed** when:

   | Outcome | When |
   |---|---|
   | `SUPPRESSED_SAME_COMMIT` | Any trigger of the repository already started a run for this commit: another workflow failing on it, or a re-run. Two triggers on two failing workflows of one push open one fix, not two |
   | `SUPPRESSED_COOLDOWN` | Any trigger of the repository started one for this branch within this trigger's `cooldownMinutes` |
   | `SUPPRESSED_IN_FLIGHT` | A run started for this branch in the last 24 hours is still in progress: its ledger row is open **and** Temporal does not report the execution over (a Temporal that cannot answer counts as running) |
   | `SUPPRESSED_DAILY_CAP` | This trigger started `maxRunsPerDay` runs in the last 24 hours |
   | `SUPPRESSED_NO_PULL_REQUEST` | A `pull_request` failure with no open pull request from this branch of this repository |
   | `SUPPRESSED_BUDGET` | The repository's organization is over its monthly budget |
   | `FAILED_TO_START` | The trigger's template is missing, inactive, a system template, or not CI-aware; or the trigger's options no longer fit it (the payload is built and checked again at every fire, since the template can change after the trigger was saved) |

4. Otherwise the run starts (`STARTED`) as a synthetic ticket `ci-<runId>-<attempt>`. Its branch is
   `<branchPrefix>/ci-<runId>-<attempt>`. It has no requesting user, so it uses the platform
   credential and never a person's saved token. Starting the workflow is tried three times. A
   retry that finds the execution already started counts as started, because an earlier attempt
   whose reply was lost did start it. If every attempt fails, the recorded decision is removed and
   the delivery answers `503`. GitHub does not redeliver by itself: someone has to redeliver it
   from the webhook's delivery log, or start the template by hand with the run id.

The payload carries every option explicitly, defaults included. For a push the base branch is the pushed branch. For a pull request it is the pull request's head branch, so a
fix is a draft **into the author's branch**, which they can merge into their own pull request. Nothing
is ever pushed to their branch.

## 2. The template

`ci-triage-and-fix` is a built-in template. Its run payload names the failing run **by id**:

| Field | Meaning |
|---|---|
| `connectionId` | The repository (a `git_repo` connection) |
| `githubRunId`, `runAttempt` | The failed workflow run and its attempt |
| `baseBranch` | The branch that failed: the pushed branch, or the pull request's head branch. A fix is cut from it and opened into it |
| `pullRequestNumber` | The pull request, for a `pull_request` failure |
| `mode`, `commentOnPullRequest`, `minFixConfidence`, `fixCategories`, `maxCiFixAttempts` | The options in §1. Each is optional and takes the same default there, so a run started by hand with only a run id diagnoses without fixing |

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
5. When the failure came from a pull request, the diagnosis comment links the draft.
6. **A fix attempt that fails** (a refused change, the security gate, the budget) still posts the
   diagnosis, then ends the run `FAILED` with the error. Nothing is opened.

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

See [github-app-setup.md](./github-app-setup.md).

## Limitations

- **Only `push` and `pull_request` runs.** A nightly `schedule` failure on `main`, a
  `workflow_dispatch` run, a merge-queue run and anything a fork's code produced are never acted on.
  Neither is a `startup_failure` (an invalid workflow file), which has no logs.
- **One run per commit per repository.** When several workflows fail on one commit, only the
  first to finish is diagnosed, whichever trigger it matched. A re-run that fails again on the same
  commit is not diagnosed again.
- **A failed start is not retried by itself.** After three attempts the delivery answers `503` and
  nothing more happens until someone redelivers it. Failures that arrived meanwhile were suppressed
  against the run that did not start (as the same commit, the cooldown or in flight) and stay
  suppressed. A decision that fails in the database answers `500` with nothing recorded.
- **The fire history is kept.** Suppressed decisions are recorded too, and nothing prunes them;
  deleting a trigger deletes its history.
- **A template that is missing when a failure arrives is recorded as `FAILED_TO_START`** under
  that run's key. A redelivery after the template is installed does not retry it; start the
  template by hand with the run id.

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
  instruction can do; neither is a secrets boundary (§2).
- **Comment search is bounded.** The platform's marked comment is looked for in the first 3,000
  comments of the pull request. On a longer thread, a second comment can appear rather than an
  edit.
- **A failed draft is not reported on.** If opening the draft pull request fails (a repository
  that cannot hold drafts), the run fails without posting the diagnosis.
- **A fix is always a draft pull request.** A fix for a pull request's failure is a draft into
  that pull request's branch, never a commit pushed to it; the author merges it into their branch.
- **Some decisions are not options.** Changing workflow files, acting on forks, tags and the
  platform's own branches, and the set of events are fixed, because each would widen what an agent
  can do with the platform credential rather than tune how it decides.
- **Options follow the template, not a version of it.** A trigger stores the options it changed;
  the rest are read from the template's input schema at each fire. A built-in template's input
  schema on an existing database is not replaced by a newer release (only a missing one is filled),
  so a new built-in option appears once that schema is updated.
- **Nothing proves the fix.** The draft's own CI loop is the check. The template does not re-run the
  originally failing workflow on the fix before opening the draft.
