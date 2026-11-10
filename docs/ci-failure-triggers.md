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
   typed verdict: a category, whether code can fix it, a confidence, a summary, the root cause, a
   suggested fix, and the failing step's own `run:` command when running it alone would reproduce
   the failure.
2. **Code decides**, from the verdict and the facts around it, whether the run goes on to `fix`,
   `report` or `skip` (§4). The model can rule a fix out, but it cannot start one the rules refuse.
3. **`report`** posts the diagnosis on the pull request (when asked) and ends the run `SUCCESS`.
   **`skip`** ends it `SKIPPED` with the reason. Both results carry the diagnosis.
4. **`fix`** runs the implementer on the failing branch's current tip. The diagnosis reaches it
   fenced as untrusted data (§5). Lint, typecheck and tests run, the fix is **verified** (§2.3), and
   a draft pull request is opened into the failing branch. A fix that changed no files opens
   nothing and is reported instead.
   The draft's own CI is then watched by the usual CI loop, which revises the draft up to
   `maxCiFixAttempts` times while it keeps failing and then ends the run `FAILED`. It can poll
   instead of waiting for the webhook when the CI wait strategy at `/admin/workflow-defaults` says
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
commit and reports it pushed. A failure of that commit is suppressed as `SUPPRESSED_OWN_OUTPUT`, so a
fix is never fixed again by another run. A commit a pull-request feedback round pushed
([pr-feedback.md](./pr-feedback.md)) counts as the platform's own output the same way.

The run then **watches the pull request's CI on the pushed commit** itself, by polling (a webhook for
an author's branch does not reach it), within the CI wait strategy's poll deadline:

- CI passes, or never reports, or the poll cannot say: the run ends `SUCCESS` with the commit.
- CI fails: unless the trigger's `maxCiFixAttempts` is `0`, the run makes **one** follow-up. It
  fetches the logs, has the CI fixer (refusing workflow changes, with the logs fenced as untrusted
  data) fix the fix on the run's work branch, and pushes it through the same checks as the first
  push. Its CI is watched the same way.
- CI fails again, or the follow-up changes nothing or cannot be pushed: the pull request comment
  says so (when the trigger comments), and the run ends `FAILED`, leaving the branch to a person.

The run's work branch carries the fix commits and is deleted when the run ends, unless it holds a
follow-up that could not be pushed.

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

### 2.3 Verifying a fix

Before a fix is delivered, `verifyCiFix` runs the triager's reproduction command in a fresh
workspace: first on the failing branch, then on the fix. The result goes into the draft's body, the
pull request comment when the trigger comments, and the run's result as `verification`:

| Status | Meaning |
|---|---|
| `verified` | The command failed on the failing branch and passes on the fix |
| `not_reproduced` | It passed on the failing branch too: the failure could not be reproduced outside CI |
| `still_failing` | It fails before and after: the fix may be incomplete, or the command needs setup only the workflow provides |
| `unverified` | Nothing was run: no command, or one that was refused |

The command is model output read from untrusted logs, so it runs only when it is, **whole**, the
`run:` of a step GitHub reports as failed (matched by job and step name in the workflow file on the
branch, indentation aside), and the shell command scanner clears it. A fragment of a step, another
job's step or text in a comment is refused. That makes it the repository's own command, as trusted
as the code its tests already run. The fix branch is fetched before anything runs, so no credential
is used after the branch's code has run, and the tree is cleaned (`git clean -ffdx`) between the two
runs so the first one's output cannot make the second pass. A
command with `${{ }}` expressions is never run. Verification labels a fix; it never stops one from
being delivered, since a command that needs the workflow's setup steps fails both times for reasons
that say nothing about the fix. Both runs' output is kept as a `ci.verify` artifact.

### 2.4 The test-integrity guard

A fix can go green by deleting the failing test, skipping it, or loosening what it asserts. The
**test-integrity guard** reads the change a fix session made and records, or refuses, one that
looks like that.

**What it covers.** It runs in the fix sessions whose goal is to make a failing check pass:

| Path | Covered |
|---|---|
| The CI loop's fix (`executeCIFixImplementation`), in this template and the engineering templates | yes |
| The first fix of this template (`implement`, `executeImplementation`) | yes: a step that carries `refuseWorkflowChanges` is a fix from untrusted CI text, and the guard rides on that marker |
| The quality-gate fix (`executeGateFixImplementation`) | yes |
| The pull-request feedback fix (`executePrFeedbackImplementation`) and its CI follow-up | yes |
| **The agent-run follow-up (`runAgentPrFeedbackTask`), which resumes the agent that opened the pull request, including the `retryAgentFix` step ("Fix CI with the same agent") of `address-pr-feedback`** | **NO: a CI-fix path that reaches a push with no guard** |
| A review fix (`executeReviewFixImplementation`), which answers a reviewer's comments | no: removing a test can be what the reviewer asked for |
| The initial implementation of a ticket, and anything a person pushes | no |

**What it reads.** The fix is committed first, with hooks disabled (`--no-verify` and
`core.hooksPath=/dev/null`, so a hook the agent planted cannot change the commit afterwards), and the
guard reads `git diff-tree -p <commit the session started at> <the commit>`. That commit's sha is the
one pushed (`<sha>:refs/heads/<branch>`), so what is analysed is what is pushed, whatever the agent
did to the index or to `HEAD`. A block throws before the push; the commit exists only in the
discarded workspace.

The read does not depend on the work tree. `diff-tree` is plumbing that compares two commits' trees
with no relative pathspec, and every git call of the guard (the starting commit, the commit, the
diff, the path guard) runs with `GIT_DIR` and `GIT_WORK_TREE` set to the checkout, which beat a
`core.worktree` the agent wrote into `.git/config`. (A porcelain `git diff -- .` printed an empty
diff, with exit 0, once `core.worktree` named an ancestor of the checkout.) The diff is read with
`--text`, one line of context (`-U1`), explicit `a/` and `b/` prefixes and `--find-renames`, with
attribute files, external diff drivers and text conversion off, so a `-diff` or `binary` attribute
(even in `.git/info/attributes`) or a `diff.mnemonicPrefix` setting cannot blind it. Lockfiles and
minified files (`yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`,
`poetry.lock`, `*.min.js`, …) are left out of the diff by top-anchored pathspecs, so a fix that
regenerates one is not too large to read. The starting commit is read before the agent runs.

An empty diff is believed only when the two commits hold the same files. When the diff reads as empty
but the committed tree differs from the starting tree at any path that is not a lockfile or minified
file, the change is treated as unreadable: `block` fails it as `TEST_INTEGRITY_GUARD_UNAVAILABLE`, and
`warn` records a `degraded` event. Nothing reads as clean by being unreadable.

A pure analyser (`@auto-swe/shared/lib/testIntegrity`) compares counts across the **whole diff**, so
a renamed file, a test moved to another file, or a split or merge nets to zero. It reads comments in
two ways. What a line is **credited** with (an assertion, a test case) has every comment removed, so
a comment never counts as a test. What a line is **charged** with (a skip marker, a trivial or weak
assertion, an exclusion) has only the comments that cannot be code removed: a line that starts with
`//` or `#`, and a block comment that starts a line. A comment after code is kept as code, so
`it.skip(…) // note` reads as a skip and so does a trailing comment that merely mentions one.
`#` is a comment only outside JavaScript and TypeScript, an unquoted backslash escapes the next
character (so `/a\//` is not a comment), a lone CR, U+2028 and U+2029 end a line, and block-comment
state is carried only across lines that are consecutive in the file, never from one hunk to the
next. What holds for commenting a test out:

- commenting it out line by line with `//` or `#` reads as removing it (`test_case_removed`,
  `assertions_reduced`);
- wrapping unchanged tests in added delimiters (`/*` … `*/`, a Python triple-quote line, Ruby
  `=begin` … `=end`) removes no line, so a block comment that opens among the added lines and is
  not closed among the same consecutive added lines is `test_commented_out`. A comment added whole
  is not, and neither is one opener edited into another (`/** old` to `/** new`);
- an added bare `return` as the first statement of a test, when the diff shows the opening line
  next to it, is `early_return_added`. `return` written on the opening line itself
  (`it('x', () => { return;`) is a `skip_marker_added`. A `return` that is not the first statement,
  an early return written through a condition, or a test whose opening line spans several lines is
  not seen.

Findings:

| Finding | What it matches |
|---|---|
| `test_file_deleted` | a test source file removed, or renamed to a name no runner collects, when the change as a whole loses test cases or assertions. Test source files are those named by convention (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, `*Test.java`, `*_spec.rb`, `.feature`, scripts under `__tests__/`); fixtures and helpers are not |
| `test_case_removed` | more test-case declarations removed than added across the diff (`it(`/`test(`, `def test_`, `func Test`, `@Test`, `#[test]` including inline in Rust sources, `[Fact]`, RSpec `it '…'`, `Scenario:`) |
| `skip_marker_added` | more skip, focus, disabling or expected-failure markers added than removed: `.skip`, `.todo`, `xit`, `.only`, `skipIf(true)`, `runIf(false)`, `pytest.mark.skip`/`skipif`/`xfail` (also as `pytestmark = …`), `pytest.skip(`, `unittest.skip`, `raise SkipTest`, `@Ignore`, `@Disabled`, `t.Skip(`, `#[ignore]`, RSpec `skip`/`pending`, `if (false)`, `return` written on the same line as the opening of a test body, `try { expect(…) } catch {}` |
| `test_commented_out` | a block comment opened in a test file (`/*`, a Python triple-quote line, Ruby `=begin`) and not closed among the same consecutive added lines, which comments out code the diff does not show |
| `early_return_added` | a bare `return` added as the first statement of a test whose opening line the diff shows (high) |
| `assertions_reduced` | a net drop in assertion counts across the diff's test files (`expect(`, `assert…(`, a Python `assert`, `require.…(`, `t.Error`/`t.Fatal`, `.should`, `verify(`); a line removed and added unchanged elsewhere cancels |
| `assertion_trivialized` | an added assertion that holds whatever the code does (`expect(true).toBe(true)`, `expect(x).toBe(x)`, `assert True`, `assert 1 == 1`, `assertEquals(1, 1)`) |
| `assertion_loosened` | specific assertions lost on net while the same number of weak matchers (`toBeDefined`, `toBeTruthy`, `expect.anything()`, `assertNotNull`, `is not None`, `toThrow()`) were gained |
| `test_config_excludes` | in a test configuration file, more exclusions added than removed: `testPathIgnorePatterns`, `testIgnore`, `norecursedirs`, `--ignore`, `--deselect`, `-k "not …"`, `skipTests`, and `exclude`-style settings. In a file that configures only a test runner (`jest`/`vitest`/`playwright` config, `pytest.ini`, `.mocharc`) any exclusion counts; in `pyproject.toml`, `pom.xml`, `build.gradle`, `package.json`, `tsconfig*.json` an exclusion counts only when its line names a test, so a `[tool.ruff] exclude` or a shade `<exclude>` does not |
| `test_config_narrowed` | `testMatch`, `testRegex`, `include`, `roots` or `testpaths` in a test configuration file with fewer entries (high), or entirely replaced entries (low) |
| `coverage_threshold_lowered` | a coverage threshold (`branches`, `lines`, `fail_under`, `--cov-fail-under`, …) lowered or removed, compared across all test-configuration files, so a threshold moved from `package.json` to `jest.config.js` is not lowered |
| `test_run_bypassed` | a test command changed so that it cannot fail or runs nothing: `--passWithNoTests`, `jest \|\| true`, `go test … ; true`, a `test` script replaced by `echo`/`true`, `go test -run XXX`, or the `test` script narrowed to named files |
| `test_command_changed` | the `test` script in `package.json` changed in any other way (low) |
| `ci_config_weakened` | in a CI definition (GitHub Actions workflow, `.gitlab-ci.yml`, CircleCI, Jenkinsfile, …) `continue-on-error: true`, `allow_failure: true` or `\|\| true` added, or a test step removed |
| `test_file_unreadable` | git reports a test source file or a test-configuration file as binary, so its change cannot be read |
| `gitattributes_changed` | any change to a `.gitattributes` file, which can change how a diff renders |
| `test_support_deleted` | a fixture, helper or mock under a `test/`, `tests/`, `spec/` or `__tests__/` directory deleted (low) |
| `snapshot_updated` | a `.snap` snapshot changed or removed (low) |

Each finding has a **severity**. `high` findings are the ones `block` mode refuses a change for.
`low` findings are recorded and reported but never block: they have many legitimate causes. A
reduction in cases or assertions in a file that also gains a parameterised test (`it.each`,
`@pytest.mark.parametrize`, `t.Run`, …) is reported as `low`, because that is how a legitimate
consolidation looks.

`github.ciFixTestIntegrityGuard` sets what a finding does. It is a registry setting that can be
overridden at team and organization scope; there is no per-repository value, so a repository whose
fixes legitimately rewrite tests is covered by setting its team to `warn` or `off`. The default is
`warn`.

| Value | Effect |
|---|---|
| `warn` (default) | The change goes through; the findings are recorded on the run and counted in the report. |
| `block` | The change is not pushed. The step fails non-retryably with `TEST_INTEGRITY_GUARD` and the findings in its message, when any finding is `high`. Like `SECURITY_GATE_FAILURE` it is not retried, because a retry would re-run the whole paid session and the fixer is likely to repeat itself. |
| `off` | Not checked, and the commit is the unchanged `git commit`. |

**Where a blocked fix goes.** The fixer is never told why it failed, and the findings are not
passed on to a person by a template: the step fails with the typed error, and the template's
failure route runs.

- In the CI loop of an engineering template the fix node has no failure route, so the run ends
  FAILED at that step with the findings in its error.
- In this template, a block on the first fix (`implement`) goes to `implementFailed`, which posts
  the diagnosis with the fixed text "a fix was attempted but failed before a pull request was
  opened"; a block on the follow-up fix (`pushRetryFix`) goes to `reportPushFailed`. Neither text
  carries the findings. The findings are on the step's recorded error and in the
  `ci_fix.test_integrity_guard` event on the run's trace.
- In `address-pr-feedback`, a block on the CI follow-up goes to `respondCiFailed` with the same
  loss of the reason.

In `block` mode a diff that cannot be read, or is too large to read in full with no high finding
in the part that was read, fails as `TEST_INTEGRITY_GUARD_UNAVAILABLE` instead: a guard that cannot
say the tests are intact does not say so. A starting commit that cannot be read fails the same way
before the agent runs. When the diff is longer than the analysis cap (4,000,000 characters after
lockfiles are excluded) the file list is read as well, so a deleted test file is still seen. A value
the setting does not recognise is the default, `warn`. The setting is read before the agent session
starts.

Every trip is recorded as a `ci_fix.test_integrity_guard` activity event on the run's trace
(`blocked: true` or `false`, the findings, `mode`), which makes it queryable like
`code_security.scan`. A guard that could not read the whole change records the same event marked
`degraded: true`, which the report does not count as a trip. The [outcome report](./outcome-metrics.md)
counts trips once per workflow attempt at a node and the CI-heal rate per repository side by side,
so a repository whose heal rate is high because fixes delete tests shows trips next to it.

The guard is a heuristic over diff text and is not a proof. Its false positives and the evasions it
cannot see are under Limitations; a trip is a prompt for a person to look, not a verdict.

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
  check runs) is not read. The run is looked up through the Actions API. Buildkite, CircleCI and
  GitLab CI are not supported sources.
- **The test-integrity guard is a heuristic.** It matches patterns in diff text and compares counts.
  It does not parse any language, run the tests, or know what a test is for, and a clean result means
  only that it recognised nothing. It is complete for nothing: every list in §2.4 is a list of
  spellings, not of meanings.
- **The guard misses evasions.** Still invisible to it: an assertion moved into a helper outside a
  recognised test file, a test emptied but left in place (an empty body keeps its `it(`), a failing
  test rewritten to assert the new, wrong behaviour (`toBe(3)` changed to `toBe(4)`), an assertion
  made vacuous by a conditional that is not a literal `false`, a skip written through a framework,
  environment variable or marker the patterns do not name, a test deleted in one file and replaced
  by trivial new tests in another (the whole-diff counts net to zero when the cases balance), a
  parameterised construct added to explain away a large removal (the reduction is then low
  severity), a mock that makes the code under test irrelevant, a workflow, hook or script outside
  the recognised CI file names that stops running tests, and a fix that changes the code under test
  to special-case the test input.
- **The guard has false positives.** A deleted test for removed code, removing a single flaky
  timing assertion, a deduplication the line matcher does not recognise, tightening a test's
  `toThrow('message')` to `toThrow()`, excluding `tests` from a linter in `pyproject.toml`, and
  an assertion style the counter reads as fewer assertions all trip it. In `block` mode they stop
  a fix a person would have accepted, which is why the default is `warn`.
- **The guard reads the fix, not the branch.** It looks at what the fix session changed. A test
  already skipped or weakened before the session, or a change made outside a fix session, is not
  seen. The review fix, a person's edit and **the agent-run pull-request follow-up (the
  `retryAgentFix` step, "Fix CI with the same agent", of `address-pr-feedback`) are not checked: that
  CI-fix path reaches a push with no guard** (§2.4).
- **A replaced `git` binary defeats every git-based check.** The guard, the path guard and the push
  all trust the `git` the workspace image provides, and the agent runs as root in that container.
  Replacing `git` (or `sh`) hands the guard whatever diff the agent wants it to read. Pinning the
  repository, hooks off and plumbing reads close every configuration route, not tampering below git.
  The same limit is stated for authenticated git in
  [architecture.md](./architecture.md#10-limitations).
- **Block-comment and early-return detection read what the diff shows.** A block comment is seen
  only when its opener is among the added lines; one that extends an opener already in the file, by
  adding only a closer earlier, is not. A bare `return` is seen only as the first statement of a
  test whose opening line is one line the diff shows as context or as an added line. Strings,
  template literals and regular expression literals are not parsed, so a comment delimiter inside
  one can read either way; the credit reading removes comments aggressively and the charge reading
  keeps them, so these errors fall toward a finding.
- **It reads what git reports.** The diff is rendered by git with attributes and drivers off. A
  change git does not show (an ignored file, a path the exclusion list leaves out, a file the agent
  committed under a lockfile or `*.min.js` name) is not read. A change over the analysis cap is
  judged on its head and its file list.
- **A trip is not retried, and the fixer is not told why.** A blocked fix fails the step; the fixer
  is not given a second attempt with the findings, so a run that trips ends with no fix pushed. The
  template's failure report does not carry the findings either (§2.4, "Where a blocked fix goes").
- **Trips are counted per workflow attempt.** Several events from one attempt at a node (a Temporal
  retry of the same dispatch) are one trip in the outcome report; a run's own raw events are all on
  its trace.
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
- **A pushed fix gets one follow-up, not a loop.** If the follow-up fails the pull request's CI
  too, the run stops and says so; that failure is suppressed as the platform's own, and so is a
  later failure of the first fix (it keeps a decision row of its own, which retention keeps). A
  follow-up the author's own new commits get in the way of is refused (the branch moved) rather than
  rebased, and stays on the run's work branch for a person. An author's later commit is triaged as
  usual.
- **A work branch can outlive its run.** It is deleted when the run ends through its push path
  and its head is the commit last pushed. A run cancelled, terminated or failing elsewhere while it
  watches the pushed commit leaves `<branchPrefix>/ci-<runId>-<attempt>` behind.
- **The run stays open while it watches.** Polling the pushed commit holds the run, and so
  suppresses other failures on that branch as in flight, for up to the CI wait strategy's poll
  deadline.
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
  built-in schema moves a stored schema forward only while it is still one an earlier release
  shipped and the template is active on its built-in version with no A/B experiment running
  ([architecture](./architecture.md#versioning-and-reproducibility)). A schema an admin edited is
  kept, and then a new built-in option does not appear until the admin adds it.
- **Verification is local and partial.** The workspace installs nothing and has none of the
  workflow's services, secrets or matrix, so many commands cannot reproduce the failure and the fix
  is labelled `not_reproduced` or `still_failing` rather than verified. Only the failing step's own
  command is tried, never the steps before it. The draft's own CI loop remains the real check.
