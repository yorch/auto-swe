# CI failure triage and fix

When a GitHub Actions workflow fails, the `ci-triage-and-fix` template diagnoses the failure from its
logs and, when the diagnosis says a code change can fix it, opens a **draft** pull request into the
branch that failed. It never pushes to an existing branch, never changes workflow files, and never
merges.

This is separate from the CI loop inside the engineering templates, which fixes CI on a pull
request the platform itself opened. The triage template covers failures on branches and pull
requests the platform did not open: `main`, release branches, and people's pull requests.

---

## 1. The template

`ci-triage-and-fix` is a built-in template. Its run payload names the failing run **by id**:

| Field | Meaning |
|---|---|
| `connectionId` | The repository (a `git_repo` connection) |
| `githubRunId`, `runAttempt` | The failed workflow run and its attempt |
| `baseBranch` | The branch that failed: the pushed branch, or the pull request's head branch. A fix is cut from it and opened into it |
| `mode` | `triage` (diagnose only) or `fix` |
| `pullRequestNumber` | The pull request, for a `pull_request` failure |
| `commentOnPullRequest` | Post the diagnosis on that pull request |

The payload carries no URL. The worker reads the run, its jobs and their logs from the
repository's own API (`fetchWorkflowRunFailure` in the SCM provider), so a payload cannot point the
platform's credential at another repository.

The run goes through these nodes:

1. **`triage`** (`triageCiFailure`) reads the run from GitHub and decides whether it may act on it
   at all (§2). It then gives the failed jobs' log tails to the `ciTriager` agent, which returns a
   typed verdict: a category, whether code can fix it, a confidence, a summary, the root cause and
   a suggested fix.
2. **Code decides**, from the verdict and the facts around it, whether the run goes on to `fix`,
   `report` or `skip` (§3). The model can rule a fix out, but it cannot start one the rules refuse.
3. **`report`** posts the diagnosis on the pull request (when asked) and ends the run `SUCCESS`.
   **`skip`** ends it `SKIPPED` with the reason. Both results carry the diagnosis.
4. **`fix`** runs the implementer on the failing branch's current tip. The diagnosis reaches it
   fenced as untrusted data (§4). Lint, typecheck and tests run, and a draft pull request is opened
   into the failing branch. A fix that changed no files opens nothing and is reported instead.
   The draft's own CI is then watched, and fixed up to twice, by the usual CI loop. It can poll
   instead of waiting for the webhook when the CI wait strategy at `/govern/workflow-defaults` says
   so, which matters here: a draft into a feature branch often runs no CI at all.
5. When the failure came from a pull request, the diagnosis comment links the draft.

Every implementer step in the template, including the CI loop's fix, sets
`refuseWorkflowChanges`: a change under `.github/workflows/` or `.github/actions/` fails the step
before the push (`DIFF_TOUCHES_WORKFLOWS`), because a pushed workflow runs with the repository's
secrets.

### The base branch

The template is the main user of a run's **base branch** (`payload.baseBranch`). Every step that
clones uses it: the implementation, the three fix sessions, the quality gates, shell steps and agent
nodes. They clone it, diff against it, and open the pull request into it. See
[product-overview.md](./product-overview.md) for how a launch sets it.

## 2. When a run is not acted on

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

## 3. Fix or report

A run goes on to a fix only when all of these hold. Otherwise it reports the diagnosis with the
reason:

- the payload's `mode` is `fix`;
- at least one failed job's log could be read;
- the logs passed the `INJECTION` / `EXFILTRATION` scanner patterns (`scanSkillContent`, over the
  whole text). A scan that matches, or cannot complete, means the logs are never used to fix from;
- for a pull request, the branch has not moved since the failure. A pushed branch that moved is
  still fixed, on its current tip;
- the category is `regression`, `test_bug`, `configuration` or `dependency`, and the verdict says
  `fixable`. `flaky`, `infrastructure` and `unknown` are never fixed;
- the confidence is at least 0.6.

## 4. What reaches the model, and what reaches the PR

- **Logs are redacted** before the triager, the trace or the brief sees them. `redactString`, plus
  GitHub, AWS, Slack, OpenAI-style, JWT and private-key token shapes. GitHub masks only the secrets
  it was given.
- **The implementer gets the diagnosis as untrusted data.** It arrives through the step's
  `ciDiagnosis` input, not `guidance`, and is fenced and labelled as derived from CI logs, never as
  the requester's instructions.
- **The pull request comment is rendered from the verdict's fields**, not posted as model text.
  Each field is flattened to one line and bounded, and mentions, autolinks, HTML and markdown
  structure are neutralised. The only link is the draft's URL as GitHub returned it. The platform
  edits one comment per pull request, found by a hidden marker, rather than adding one per
  failure. A comment that cannot be posted is reported in the step output and does not fail the run.

## 5. The `ciTriager` agent

A sub-role persona on the `planner` model ([agents.md](./agents.md)). It has no tools and returns a
structured verdict. It cannot be launched as an agent run: its output routes a workflow, so it is on
the non-launchable list. A step `systemPrompt` override applies to it like any agent step.

## 6. GitHub permissions

Reading a run's jobs and logs needs **Actions: Read**, which the GitHub App setup does not request
by default ([github-app-setup.md](./github-app-setup.md)). Without it, `triageCiFailure` fails
non-retryably with `CI_RUN_FORBIDDEN`. Commenting on a pull request uses the existing
**Pull requests: Read and write**.

## Limitations

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
- **Injection screening is pattern-based.** The scanner patterns catch known injection phrasing,
  not every instruction a log could carry. The fenced brief and the workflow-file refusal are the
  backstop, not the scan.
- **Comment search is one page.** The marker comment is looked for in the 100 most recent comments
  of the pull request. On a longer thread a second comment can appear rather than an edit.
- **Nothing proves the fix.** The draft's own CI loop is the check. The template does not re-run the
  originally failing workflow on the fix before opening the draft.
