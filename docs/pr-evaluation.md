# Pull-request evaluation

[Code reviews of finished runs](./code-review.md) add successful, verified evidence at the current
PR head. Linked findings are worst-of and never lower an existing original review classification.
When the original run has no review result at that head, eligible linked reviews supply the review
signal, so a clean result avoids the missing-review risk bump. Publication requests reevaluation
after the review finishes.

> How the platform judges the risk of a pull request it opened, tells reviewers where to look,
> publishes a commit status, and, only where an admin opted a repository in, asks GitHub to
> auto-merge a provably low-risk change, which a second GitHub App can approve with no human
> approval (§16). For the run that opens the pull request see
> [concepts.md](./concepts.md); for what happens on review feedback see
> [pr-feedback.md](./pr-feedback.md); for the GitHub App that carries the credentials see
> [github-app-setup.md](./github-app-setup.md).

---

## 1. What it does

For every pull request the platform opened, on a repository that has evaluation on, the platform:

1. **Classifies** the change as `LOW`, `STANDARD` or `HIGH` risk, from signals alone. No model
   decides the class (§2).
2. **Posts a reviewer brief**: one marked comment on the pull request that says why it got its
   class, which files to read closely, what to verify, and which files are provably safe to skim (§4).
3. **Publishes the commit status** `auto-swe/pr-evaluation` on the head commit, which a branch rule
   can require (§5).
4. **In `auto` mode only**, and only when every condition in §8 holds, asks GitHub to merge the pull
   request once GitHub's own branch rules are satisfied (§8).
5. **With bot approval on**, a second GitHub App, the approver App, submits an approving review for
   a `LOW` change that is within strict size and path limits, so it can merge with no human
   approval (§16).

By default nothing merges, and the platform submits no review. The platform never calls an
immediate-merge API. The one merge-capable call it makes is GitHub's `enablePullRequestAutoMerge`,
which asks GitHub to merge later, when the branch rules it already enforces are met, and only for the
head commit that was evaluated (`expectedHeadOid`). That call is reachable only from `auto` mode,
which is per repository, set by a platform admin, and refused until the preconditions in §8 and §10
hold. The one case in which a pull request can then merge with no human approval at all is bot
approval (§16), which is off by default and needs four admin-controlled switches.

The feature is off until an admin sets `prEvaluation.enabled`. Evaluation is re-run on every push
and review (§11), so the class, the status and the arming always describe the current head.

## 2. The three classes

A pull request's class is a pure function of signals the platform reads from GitHub, from its own
database and from the repository policy file (§6). The code is `classify` in
`packages/shared/src/lib/prEvaluation/classify.ts`; the thresholds are the registry settings in §12.

| Class | Meaning | Approvals required (default) |
|---|---|---|
| `LOW` | Small, covered by a test change, touching nothing sensitive, reviewed without a warning | 1 |
| `STANDARD` | Not provably low risk, and nothing that forces `HIGH` | 1 |
| `HIGH` | A hard exclusion, a high-risk path, or a very large change | 2 |

### How each class is decided

**`HIGH`** when any of these holds. The first group are *hard exclusions*: they also make the change
ineligible for auto-merge whatever the thresholds say.

- The evaluation itself failed or could not see the whole change: an unexpected error, a file list
  that was cut off (GitHub lists at most 3000 files), a patch too large to read, or a code-security
  scan that did not complete.
- The repository policy file is invalid, or the pull request changes it (§6).
- A changed path is longer than 1024 characters, or a file reports an impossible line count.
- It touches a **sensitive path**: the built-in list plus `prEvaluation.sensitivePaths` plus the
  policy file's `sensitivePaths`. A rename counts when either its old or its new path matches. The
  built-in categories are migrations and schema files, authentication and permission code, CI and
  workflow definitions, container, Terraform, Helm and Kubernetes files, dependency manifests and
  lockfiles, secrets-adjacent files, API contracts, the platform's own policy and guard files,
  agent-instruction files, and test-runner configuration. `DEFAULT_SENSITIVE_PATHS` in
  `packages/shared/src/lib/prEvaluation/paths.ts` is the authoritative list.
- It **removes a test file** (or renames one to a name that is no longer a test file).
- It **adds a skip or only marker** to a test (the scan reads added lines of test patches).
- A changed file has no patch to inspect, or a changed test file has a patch too large to scan.
- The code-security scanner (the post-diff scanner the implementer runs; see
  [agents.md](./agents.md)) reports any finding on the pull request's diff.
- **No review result is available for this exact head**, or the review network gave a `WARNING` or
  `CRITICAL` verdict. The review result is the recorded verdict of the `runReviewNetwork` step of
  the run that opened the pull request, and it counts only when the commit it reviewed is the pull
  request's current head. A pull request opened by a template with no review-network step has no
  review result and is always `HIGH`.

**`HIGH`, without being a hard exclusion**, when it touches a path the repository marked in
`highRiskPaths`, or when the counted changed lines exceed `prEvaluation.highLines` (default 1000).

**`LOW`** when none of the above holds and the change is small and covered. **`STANDARD`** is a `LOW`
candidate that fails any of these:

- more changed lines than `prEvaluation.maxLowLines` (400), more files than `prEvaluation.maxLowFiles`
  (15), or more directories (top two path levels) than `prEvaluation.maxLowDirs` (5);
- source files changed and no test file did (documentation, images and licence files are not source);
- there is nothing left to evaluate once provably skimmable files are removed.

"Counted" lines and files exclude files with a skim proof (§4), so a large rename does not push a
small change over a limit.

A test file is recognised by name or directory: `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`,
`*Test.java`, a `test/`, `tests/`, `spec/`, `e2e/` or `__tests__/` directory, and similar
(`TEST_FILE_GLOBS` in `paths.ts`).

### Fail-closed behaviour

Every uncertainty resolves upward. A missing signal, an error, an unreadable file, a parse failure
and an unknown value all make the class `HIGH` and the change ineligible for arming. An error raised
while evaluating publishes class `HIGH` with a `failure` status and cancels any auto-merge the
platform armed, and the activity is retried only when the failure was transient (the host or the database
unreachable or busy), up to four attempts. An approver count is never below 1, and a higher class never needs fewer approvals than
a lower one.

## 3. Modes

A repository's mode is `connections.pr_evaluation_mode`; null inherits `prEvaluation.defaultMode`.

| Mode | Effect |
|---|---|
| `off` | No evaluation, no status, no brief. A pull request the platform armed earlier is disarmed. |
| `advisory` | Classifies, posts the brief, publishes the status. The status is `success` whatever the class and the approval count (§5), except `failure` when the evaluation itself fails, so it enforces nothing about approvals. The exception is an error raised while evaluating, which posts `failure` in every mode, `advisory` included (§2, fail-closed behaviour). Never arms auto-merge. |
| `enforce` | As `advisory`, but the status follows the approval count (§5), so marking the context required enforces the approver counts. Never arms auto-merge, and cancels any auto-merge GitHub shows enabled on the pull request, including one armed earlier in `auto`. |
| `auto` | As `enforce`, and a `LOW` change that meets every condition in §8 is armed. |

`prEvaluation.defaultMode` accepts `off`, `advisory` or `enforce`; `auto` is never a default. `auto`
is chosen per repository, by a platform admin only (§10). An unrecognised mode value fails closed:
the database rejects an unknown mode string, so the evaluation fails with status `failure` and no
stored row, nothing is armed, and any auto-merge the platform armed is disarmed.

Only the pull requests the platform opened are evaluated (§11). A repository that has the feature on
sees no status on a person's pull request.

## 4. The reviewer brief

The brief is a single comment, updated in place on every evaluation. Its first line is the hidden
marker `<!-- auto-swe:pr-evaluation -->`. It carries:

- **Why this class**: each reason with up to five of its paths.
- **What was asked** and **Open questions in the ticket**: the criteria the run extracted from the
  ticket when it validated the request, and the ones it marked ambiguous (below).
- **Evidence**: what the run that opened the pull request recorded: its test result at this head,
  the browser checks it captured, the head's CI verdict and a link to the run's page (below).
- **Review findings**: what the review network raised on this head, worst first, at most ten (below).
- **Read in this order**: every file that is not provably skimmable, in the order to read it (below).
  A file a reason names carries a **Check** note saying what to verify; the order does not depend on
  risk.
- **Verify**: the claims that name no path (a reviewer finding, a failed scan, an invalid policy file).
- **Safe to skim**: files with a deterministic proof, at most 50 shown.

The brief is also stored on the evaluation row and returned by the routes in §13. The row keeps the
first 50 entries of the reading path. Beside the comment text it keeps the criteria and open
questions (with how the run settled each), the evidence numbers and verdicts, and the findings as
structured fields, each bounded to what the comment would show. They are model and ticket text, so a
reader renders them as plain text. An evaluation written before they were stored has none of the
three, and a reader falls back to the reading path and the skim list.

### What was asked

The first two sections ahead of the reading path say what the change was meant to do. They read the
`successCriteria` the run's validation step stored for the pull request's work request
(`ContextSnapshot`) and split it with the same function the implementer's prompt uses
(`splitSuccessCriteria`): concrete criteria go under **What was asked**, entries marked `AMBIGUOUS:`
under **Open questions in the ticket**. At most 20 criteria and 10 questions are shown, each on one
line and cut to 500 characters, with a `+N more` line for the rest. Both lists derive from ticket
text, so they go through the same escaping as every other prose in the brief: no markup, mentions or
autolinks.

Beside an open question the brief adds what the run says it did about it ("left this unchanged" or
"implemented this", with the implementer's one-line note), from the `openQuestionNotes` of the
`CodeResult` the review of this exact head covered (the same step and rule as the evidence). It is
matched to the question by its exact text, so a ticket whose criteria were extracted again since the
run shows no account; it is the implementer's own words, escaped like all model text, and it is
labelled as unchecked.

They are advisory and decide nothing: neither the class, the status nor the arming reads them. The
criteria are model output and were never checked against the diff, which the heading says. A section
is left out when the run recorded nothing, and so is the whole of it when the read fails, with a
warning logged: the evaluation never fails, and never turns `HIGH`, because they could not be read.

### Evidence

The **Evidence** section repeats what the run already recorded and runs nothing itself. Its lines
are fixed sentences filled with numbers and verdicts, so nothing a model, a command or a page wrote
reaches it:

- **Tests**: the counts in the test result of the run's `runReviewNetwork` step, taken only when
  that step reviewed exactly this head (the same rule as the review severity in §2). "None ran" and
  "no result recorded for this head" are told apart from a failing count.
- **Browser checks**: how many screenshots, videos and traces the run stored.
- **CI**: the host's verdict on this head at the moment of the evaluation (`passed`, `failed`,
  `still running`, `no checks reported`).
- **Run page**: a link to `/runs/<id>` on the dashboard's address (`WEB_URL`), written only when the
  address contains nothing that could break out of a link.

It ends with what it does not check, that the tests cover what was asked. Each source is read on its
own: one that cannot be read shows as unknown, and none of them can change the class, the status or
the arming.

### Review findings

The three reviewers of the review network ([agents.md](./agents.md)) return findings with a file and
often a line. The brief lists the ones worth a person's time, chosen by `selectReviewFindings`
(`packages/shared/src/lib/prEvaluation/findings.ts`) from the verdicts of the review of exactly this
head (the same step and rule as the evidence's test counts):

- only findings of a `WARNING` or `CRITICAL` verdict; a reviewer that crashed leaves a synthetic
  `REVIEWER_CRASH` entry, which is dropped;
- only files that are in the change;
- when CI failed on this head, a finding whose category names lint, style, formatting or a type
  error is dropped, because the failing check already says it (a rule on the category's words, not on
  the description);
- a line number is kept only when it falls inside the file's patch, since a reviewer's line is a
  guess; otherwise the finding is shown against the file alone.

They are ranked critical first, then by reading position, then by line, and shown with their
category, place, description and suggested fix, each escaped like all model text and on one line.
A suggested fix is prose and never a suggestion block. The section is advisory: a finding is never
verified here and decides neither the class nor the status.

**Inline comments (off by default).** With `prEvaluation.postReviewFindings` on, the findings that
have a line inside the diff (at most ten) are also posted as inline comments, in one review on the
evaluated head:

- The review is created through `ScmProvider.createReview`, whose event is fixed to `COMMENT`: there
  is no path through it to approve a pull request or to request changes, so it can neither merge nor
  block one, and a `COMMENTED` review withdraws no approval.
- Each comment ends with `<!-- auto-swe:finding <key> -->`, a key made from the reviewer, file, line
  and category. The review threads are read first and a finding already carrying its key is not
  posted again, so a retry or a re-evaluation of the same head adds nothing.
- The head is read again just before posting; a head that moved posts nothing, and a host that
  refuses the review (a line no longer in the diff) is logged and leaves the brief to carry the
  findings. A failure here never fails the evaluation.
- The text is escaped like the brief's, and `/auto-swe` is broken in it so a comment can never read
  as the feedback command. The PR-feedback automation skips comments that carry the finding marker
  ([pr-feedback.md](./pr-feedback.md)), and the engagement counts skip them too.

### Whether reviewers act on the brief

Each evaluation row counts how people met the brief at its head: when a person first reviewed it,
how many reviews asked for changes, and where their inline comments landed (on a file the brief
flagged, on one it listed as safe to skim, anywhere else). The gateway adds them from the review and
review-comment deliveries it already receives, with no extra subscription, and never starts an
evaluation for them. A review or comment by a bot, by the pull request's author, or carrying a
platform marker (`<!-- auto-swe:`) is not counted, and a dismissed review or an edited comment is
not a new one. The row keeps numbers only: never a login, a path or text.
`GET /api/v1/pr-evaluations/engagement` (§13) summarises them, and **Reviewer engagement** on
**Admin → Analytics** shows that summary for the page's date range (the route reads at most 365 days,
and the card says when the range was longer). The summary also says how long a pull request waited
before anyone opened it on the platform's review page: from its opening to the earliest first visit
by anyone who can reach it, as a median over the pull requests opened in the window that were
visited at all. A review sent from that page is posted to the host as the reviewer and is then
an ordinary review delivery, counted like any other human review.

### The reading path

GitHub's Files tab lists files alphabetically, which splits a change from its tests and shows a
reader the use of something before its definition. The brief gives an order instead, a pure function
of the paths and line counts (`readingOrder` in `packages/shared/src/lib/prEvaluation/brief.ts`), so
the same change always reads the same way:

1. **Contracts and structure first**: manifests and lockfiles, schema and migrations, API contracts
   (`CONTRACT_GLOBS` in `paths.ts`), by path.
2. **Source, one directory at a time**, the directory with the most changed lines first and the
   busiest file first inside it. A test follows the source file it covers: the same name once the
   test marker is dropped (`foo.test.ts`, `foo.spec.ts`, `foo_test.go`, `test_foo.py`, `FooTest.java`),
   in the same directory or, for a test inside a `test`, `tests`, `__tests__`, `spec` or `e2e`
   directory, in its parent. A test in a tree of its own (`test/foo/bar.test.ts` for
   `src/foo/bar.ts`) pairs with the one changed source of that name whose directory ends with the
   path below the test directory; two candidates mean no pairing.
3. **Tests with no source in the change**, then documentation and other files, by path.

The first ten files are listed in full, with their position. A flagged file past the tenth (up to 30
of them) is listed too, at its real position, so a risky file is never folded away. Everything else
is folded into a `<details>` block of at most 100 names, still in reading order.

A file is listed as safe to skim only when one of two proofs holds, and nothing else qualifies:

- **`exact-rename`**: a rename with 100% similarity, no added or removed lines, and the same
  directory before and after (only the file name changed).
- **`whitespace-only`**: a modified file where, for every contiguous run of changed lines, the
  removed lines equal the added lines in order once trailing whitespace is ignored. Leading and
  interior whitespace must be identical, and blank lines may come or go. It is never given for a file
  whose whitespace is meaningful: Python, YAML, shell, Ruby, Makefiles, Dockerfiles, a file with no
  extension, and the other extensions listed in `WHITESPACE_SIGNIFICANT_EXTENSIONS` in `brief.ts`. A
  patch whose line counts disagree with the file's counts is treated as truncated and proves nothing.

A path that a reason names is never skimmable, and a repository can list globs in `ignoredFromSkim`
to withhold the proof from files it cares about. A file moved to another directory, a rename with any
edit, and a change that only reorders code are all outside the proof.

## 5. The commit status

The status context is `prEvaluation.requiredStatusContext` (default `auto-swe/pr-evaluation`). The
description is at most 140 characters. It is set on the pull request's current head commit by the
platform's GitHub credential. `statusFor` in `packages/shared/src/lib/prEvaluation/status.ts`
decides it:

| Mode | State | When |
|---|---|---|
| `off` | none | Nothing is published. |
| `advisory` | `success` | Whatever the class and the approval count. The description reads `advisory: <class> risk, <n>/<required> approvals`. |
| `enforce`, `auto` | `failure` | The evaluation failed (a reason with code `evaluation-error`). |
| `enforce`, `auto` | `pending` | The approval count the class requires is not yet met on this head. |
| `enforce`, `auto` | `success` | The required number of approvals is met on this head. |
| `auto` | `success` | A `LOW` change only: the approver App's approval stands on this head (§16). The description reads `LOW risk: approved by the evaluator, no human approval required`. |

For `enforce` the description reads `enforce: <class> risk: waiting for <n>/<required> approvals` (or
`enforce: <class> risk: <n>/<required> approvals` once met); for `auto` it has no mode prefix.

Approvals are counted by `approvalState`: distinct people whose **latest** review is an approval of
the **exact head commit**. A later comment or change request withdraws an approval, an approval of
an older commit is stale, the pull request's author never counts, and accounts ending in `[bot]`
never count. One person with two logins cannot be detected.

**An approval by the approver App (§16) is never a human approval.** It is an account ending in
`[bot]`, so it is not counted here, it does not satisfy the trusted-approver count the evidence gate
reads (§9), and a pull request that merges on a bot approval alone adds nothing to that gate. The
bot's approval stands in for the approver count on a `LOW` change only, in the status of an `auto`
repository, and never lifts any other class.

**Whoever launched or requested the work never counts.** The platform's pull requests are authored
by its own GitHub credential, so excluding the author alone would let the person who launched the
run, if they hold write access, approve the pull request their own run opened. `PullRequest.runId`
cannot name that person on its own: a retry, re-run or scheduled fire that adopts the open pull
request overwrites it with its own run. The excluded set is therefore the union of the
`WorkflowRun.launchedById` of **every run of the same work** (the stamped run, the run of the
opening workflow, and every run of the same work request on this repository, at most 50) and the
work request's requester (`requestedById`, which for webhook-created work is the mapped GitHub
sender). Each member is resolved through the user's linked GitHub account, and a review is theirs
when **either** check matches:

- the reviewer's numeric GitHub user id equals the id of the member's linked account **and that
  account is on the repository's host** (stable across a rename, so this is the primary check), or
- the reviewer's login equals the member's linked login, ignoring case (the fallback, and the only
  check available for an account linked before its id was recorded or on another host).

A member is **resolved** only when the match by id is available: a numeric account id recorded on
the repository's host (a bare id is github.com's, `{host}:{id}` is that Enterprise Server's). A run
with no launcher (a webhook automation, a schedule without an acting user), a service-principal
requester, a user who never linked GitHub or whose login was cleared, a login linked without an
account id, an account on another host than the repository, an empty set, and a set larger than the
cap are all unresolved. Approvals keep counting against every member that did resolve, and by login
for the rest, but the evaluation records `launcher-unresolved` and the pull request is never armed
(§8). When an approval is set aside the evaluation records an info reason `launcher-excluded` with
the number of distinct approvers set aside. Logins and ids are used only for the comparison: they
are never stored on the evaluation, logged, or written into the brief, the comment or the status.

The host consequence: on a repository that lives on one host, a person whose linked GitHub account
is on another (a github.com account against an Enterprise Server repository, or the reverse) is
excluded by login only. They are not matched by id, because the same number on another host is
another person, and since they cannot be resolved the pull request is never armed. A reviewer who
renames their account after launching work is excluded only while that launcher is matched by id.

Two consequences an operator must know:

- **`advisory` reports `success` whatever the class and the approval count** (an error raised while evaluating still posts `failure`, in every mode). Marking the context required in branch protection for a
  repository in `advisory` mode therefore enforces nothing. The approver counts reach GitHub's
  merge button **only in `enforce` and `auto` mode**; `enforce` does so without ever arming
  auto-merge.
- **An `auto` repository keeps auto's status rules while `prEvaluation.autoMergeAllowed` is off.**
  The repository's status stays `pending` until approved (so a required context still enforces the
  count), but nothing is armed. The row records the reason `auto-merge-globally-disabled`.

The status is published again on every evaluation, so a push, a review, a dismissed review and a
change of the base branch each move it.

## 6. The in-repo policy: `.auto-swe/pr-policy.yml`

A repository can make evaluation stricter, never looser. The file is read from the **base branch**
of the pull request, not from the head, so the pull request being judged cannot change the rules it
is judged by. A pull request that edits the file is `HIGH` (hard exclusion `policy-file-changed`).
A missing file means the platform's settings apply as they are.

```yaml
# .auto-swe/pr-policy.yml
version: 1

# Added to the platform's sensitive paths: a change here is HIGH and never auto-merged.
sensitivePaths:
  - '**/payments/**'
  - 'deploy/**'

# A change here is HIGH (but is not a hard exclusion).
highRiskPaths:
  - 'services/ledger/**'

# Lower is stricter. Each may only be at or below the platform's value.
maxLowLines: 200
maxLowFiles: 8
maxLowDirs: 3
highLines: 600

# Higher is stricter. Each may only be at or above the platform's value (1 to 10).
lowApprovers: 1
standardApprovers: 2
highApprovers: 3

# Files that never get a skim proof, even when the change is only a rename or whitespace.
ignoredFromSkim:
  - 'src/generated/**'
```

What the platform does with each key:

| Key | Effect |
|---|---|
| `version` | Required, and must be `1`. |
| `sensitivePaths`, `highRiskPaths` | Added to the platform's lists. |
| `maxLowLines`, `maxLowFiles`, `maxLowDirs`, `highLines` | Applied only when lower than or equal to the platform's value. A higher value is ignored with a warning. |
| `lowApprovers`, `standardApprovers`, `highApprovers` | Applied only when at least the platform's value. A lower value is ignored with a warning. The three are then normalised so none is below 1 and none is below the class beneath it. |
| `ignoredFromSkim` | Files matching these globs never get a skim proof. |
| `mode`, `autoMerge`, `autoMergeAllowed`, `exclusions`, `disableExclusions`, `disabledExclusions`, `allowPaths`, `allowedPaths` | Accepted so they can be reported, never applied. Each is named in a warning. |

A `requiredReviewers` field is not supported: it is an unknown key, so a file that still has it
is a parse error. A file with any other key, a wrong type, a YAML alias, a duplicate key, a reserved key
(`__proto__`, `constructor`, `prototype`), a file over 64 KiB, or a glob that is malformed or too
costly to match is a parse error. **A parse error fails closed**: the pull request is `HIGH`, the
file's values are not applied, and the brief says the file was invalid. The bounds are 200 globs in
the file, 400 in force after the platform's lists are added (more rejects the whole file), a glob of
at most 200 characters with at most 16 brace alternatives and no nesting, and at most 8 `*` tokens.

Globs support `**`, `*`, `?` and `{a,b}`. Matching is **case-insensitive** and anchored to the
repository-relative path. `auto-swe pr-policy validate` (§14) runs this same parser and merge offline.
Warnings are also recorded as `policy-warning` reasons on the evaluation.

## 7. Onboarding a repository

1. **Settings.** A platform admin sets `prEvaluation.enabled`. Optionally set thresholds, extra
   sensitive paths and `prEvaluation.defaultMode` at `/admin/platform-settings`.
2. **The webhook.** The GitHub App (or the repository's webhook) must deliver `pull_request` and
   `pull_request_review` events to the gateway. The credential needs to write commit statuses and
   pull-request comments, and to read the repository's contents and its branch rules.
3. **Policy file (optional).**
   ```bash
   auto-swe pr-policy init               # writes .auto-swe/pr-policy.yml, pre-filling sensitive dirs
   auto-swe pr-policy validate           # errors exit 1; warnings print and exit 0
   ```
   Commit it to the base branch.
4. **Choose a mode.** `advisory` is the default once enabled. Mode changes need an owning-team lead
   or a platform admin: `auto-swe pr-policy mode <repoId> <off|advisory|enforce|auto|inherit>`. `auto-swe
   pr-policy status <repoId>` shows the mode, the last evaluation and the evidence (§9).
5. **Make the status count (GitHub side, done by a repository admin).** In branch protection or a
   ruleset for the base branch, add `auto-swe/pr-evaluation` as a **required status check**. This
   has an effect only for a repository in `enforce` or `auto` mode (§5). `PUT` answers `enforce`
   with a warning while the latest evaluation shows the context is not a required check (or could
   not read it), since nothing is enforced until it is. Set `advisory` first and let one evaluation
   run if the repository has none yet.
6. **For `auto` mode, also:**
   - **Pin the required check to the GitHub App.** When adding it, choose the platform's GitHub App
     as the source of the check. An unpinned requirement can be satisfied by any token that can write
     statuses under that name. **A personal access token cannot be pinned**, so `auto` needs GitHub
     App credentials.
   - **Allow auto-merge** on the repository (Settings, General, "Allow auto-merge").
   - Satisfy the evidence gate (§9) and let one evaluation run, so the platform has read the rules.

The platform reads the branch rules from both classic branch protection and rulesets; a field it
cannot read is `unknown`, and unknown is never read as permission.

## 8. When auto-merge is armed

In `auto` mode the platform asks GitHub to auto-merge a pull request only when **all** of these hold
for the head commit it just evaluated. `autoArmingRefusals` in
`packages/shared/src/lib/prEvaluation/arming.ts` enforces the rules about GitHub's side, and each
refusal is named in the evaluation's `auto-merge-blocked` reason.

- The change is class `LOW` and has no hard exclusion.
- `prEvaluation.autoMergeAllowed` is on, and the repository's mode is `auto`.
- The repository allows auto-merge, and that is known (not `unknown`).
- The status context is a required check on the base branch, and that requirement is **pinned to the
  platform's own GitHub App**.
- Either the branch requires reviews (GitHub then holds the merge until they are given), or the
  approvals the class needs are already given on this head, or the approver App's approval stands on
  it (§16).
- The commit status for this evaluation was accepted by GitHub.
- The pull request is not a draft.
- Everyone who launched a run of the work, and whoever requested it, is resolved to a linked GitHub
  account by numeric id on the repository's host (§5), so their own approval was excluded from the
  count. The check on choosing `auto` (§10) does not
  ask this, because it belongs to one pull request.
- The evidence gate is met, for the deployment and for this repository (§9).

The call carries `expectedHeadOid` and uses the **squash** merge method. If the head moves between
the evaluation and the call, GitHub refuses, so an approval of one commit can never arm the merge of
another.

- **Drafts.** A draft is never armed, and the platform never marks a draft ready for review.
- **A person's choice stands.** If the platform armed a pull request and auto-merge was later turned
  off by a person, the platform records `auto-suppressed-human` and does not turn it on again.
- **Re-arming per head.** An arming for an older head is cancelled and made again for the new one
  when the new head still qualifies.
- **Any other state is disarmed.** On every evaluation of a pull request that policy does not want
  armed, an auto-merge that GitHub shows is cancelled, whoever turned it on, and the cancellation
  must be shown to have worked or the activity retries.

### Disarming

The platform cancels what it armed when:

- the repository's mode is changed away from `auto`, `enforce` included (`PUT` on the route in §13 starts a re-evaluation
  of every armed open pull request of that repository);
- `prEvaluation.autoMergeAllowed` or `prEvaluation.enabled` is set to false, or a stored GLOBAL
  override of either is cleared (the same, deployment-wide);
- a repository is set to `off` or the feature is disabled and an evaluation or webhook arrives for a
  pull request an earlier row recorded as armed;
- a repository is deactivated (the update starts the same sweep, and a later webhook for an armed
  pull request of an inactive repository still starts an evaluation, which disarms it);
- an evaluation fails, or the head moves and the new head no longer qualifies.

The sweeps only start re-evaluations; the worker's evaluation does the disarming (see Limitations).
Bot approvals are withdrawn by the same evaluations (§16.5).

Bot approval has its own section (§16): a repository with it on can have a `LOW` change approved by the
approver App, and every disarming trigger above also withdraws that approval.

## 9. The evidence gate

`auto` needs a track record before it can be chosen and before it arms. The gate is
`prEvaluationEvidence` with `autoEvidenceAssessment` in
`packages/shared/src/lib/prEvaluationEvidence.ts`.

**What counts.** An evaluation row counts as evidence only when all of these hold:

- its class is `LOW`;
- its pull request merged in the last **90 days**;
- it is not marked a **bad merge**;
- it recorded a **requester**: the platform user who requested the work (`requesterId`), one
  stable identity per piece of work, null when the work has no user requester;
- it recorded at least `prEvaluation.autoEvidenceMinChangedLines` (default 10) **changed lines**,
  additions plus deletions over the files listed for the evaluation;
- it recorded at least **one trusted approval** (`trustedApprovers`): a distinct approver with write
  access, counted at the evaluated head after the requester and everyone who launched a run of the
  work are set aside. The set aside only works when every one of them is matched to a linked GitHub
  account on the repository's host (§5); a row whose launcher set is **unresolved** records **0**,
  so it never counts.

The activity writes these three facts when it evaluates a head, so they describe that head. The
merge webhook later marks the row of the head that was merged and starts a **merge-time recount**
(trigger `merged`): the activity lists the reviews again at the merged head, applies the same
trust filter and launcher exclusion, and rewrites `trustedApprovers` on that one row (0 when the
launcher set is unresolved or anything fails). An approval dismissed before an admin bypass-merge
therefore does not stay counted. The recount publishes no status or comment and never arms or
disarms anything. Rows written before the facts existed hold NULL in them and so no longer count; a
deployment whose repositories were already in `auto` must accumulate new evidence (see UN-9 in
[upgrade-notes.md](./upgrade-notes.md)).

**Two scopes, both must pass.** To choose `auto` for a repository (`PUT`, refused with
`400 AUTO_NOT_READY`) and for the platform to arm one of its pull requests:

1. Deployment-wide: counted `LOW` merges are at least `prEvaluation.autoMinEvidence` (default 150),
   there are **no** bad merges, and the counted merges came from at least
   `prEvaluation.autoMinDistinctRequesters` (default 3) different requesters.
2. This repository: counted `LOW` merges in it are at least `prEvaluation.autoMinRepoEvidence`
   (default 20), and it has **no** bad merge of its own.

Every unmet condition is named, in the refusal, in the arming note on the evaluation, and in
`auto-swe pr-policy status`. The figures are counts: no requester is named in an API response, a
log line, a status or a comment. The deployment-wide history is shared by every organization and
team on the instance (organization B's merges count toward organization A's thresholds), and the
aggregate counts, never ids, are visible to any ENGINEER who can reach one repository
(`GET /repositories/:id/pr-evaluation`, `evidence.deployment`).

A merge is recorded on the single evaluation row of the head that was merged. A merge is marked bad
when a later merged pull request in the same repository reverts it within **14 days** of the merge,
recognised from GitHub's default revert text only: a body starting `Reverts owner/repo#N`, or a title
starting `Revert` that names `(#N)`.

**What it shows:** reviewed, merged and unreverted small-to-medium changes, in this repository and
across the deployment, by several people who asked for the work. **What it does not show:** that
unattended merging is safe. It does not check how the merge happened (by a person or by
auto-merge), which mode the repository was in, or that the approver read the change; revert
detection is a title heuristic; and the rows of a repository are deleted with it. See Limitations.

## 10. Who may do what

| Action | Role |
|---|---|
| Read a repository's evaluation state and the evaluations of repositories you can reach | ENGINEER and above, for a repository you can reach |
| Set a repository to `off`, `advisory`, `enforce` or `inherit` | Lead of the owning team, or platform admin |
| Set a repository to `auto` | Platform admin only, and only while the preconditions below hold |
| Turn bot approval on for a repository | Platform admin only, and only while the preconditions in §16 hold |
| Turn bot approval off for a repository | Lead of the owning team, or platform admin |
| Read, set, test or delete the approver App's credentials (the Approver App card on the GitHub tab of `/admin/integrations`, or the API) | Platform admin (§16.2) |
| Change any `prEvaluation.*` setting | Platform admin |

Choosing `auto` is refused with `400 AUTO_NOT_READY` and the list of reasons unless the feature and
`prEvaluation.autoMergeAllowed` are on, the evidence gate is met, the repository has at least one
evaluation, and that evaluation's recorded branch rules satisfy the arming rules in §8 (the per-pull-request
conditions, approvals and draft state, are treated as met here and enforced when arming). Every mode
change is written to the audit log.

## 11. What starts an evaluation

The gateway's GitHub webhook handler starts one evaluation workflow per delivery, only for a pull
request the platform opened. The triggering events are:

| Event | Actions |
|---|---|
| `pull_request` | `opened`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, and `edited` only when the base branch changed |
| `pull_request_review` | `submitted`, `dismissed`, `edited` |
| `pull_request` | `closed`: records the close, or the merge, on the evaluation row of the head that was merged, and, for a merged revert, marks the reverted pull request (§9) |

A pull request is **the platform's** when its pull-request row links the run that opened it. The
branch name is not evidence, since anyone can name a branch `auto/...`. The gateway's pre-filter and
the worker use the same lookup, `findPlatformPullRequest`.

The workflow ID is derived from the delivery, so a redelivered webhook starts nothing a second time,
while every new push or review is a new evaluation. With the feature off or the repository `off`, a
delivery starts a workflow only for a pull request an earlier row recorded as armed or as holding a
bot approval, so the platform can disarm it and withdraw the approval. Evaluations are also started by the disarm sweeps (§8).

Each evaluation, in order: loads the connection and settings (at the repository's team and
organization scope); checks the pull request is the platform's and open; reads the policy file from
the base branch; lists the changed files and scans the diff; reads the review network's verdict for
this head; classifies; reads the branch rules; **re-reads the pull request's head and reviews
immediately before publishing** (a moved head is `superseded`: the newer head has its own
evaluation); decides bot approval and submits it when it qualifies (§16); publishes the status,
withdrawing any approval that must not stand first (§16.5); posts the brief; stores the row; and
applies the arming decision.

## 12. Settings

All are ADMIN-only registry settings in the `prEvaluation` group; see
[configuration.md](./configuration.md). Changes take effect within the settings cache window.

| Setting | Default | Overridable at | Effect |
|---|---|---|---|
| `prEvaluation.enabled` | off | GLOBAL only | The kill switch. Off, nothing is evaluated and nothing is posted. |
| `prEvaluation.defaultMode` | `advisory` | team, organization | Mode of a repository that has not chosen one: `off`, `advisory` or `enforce`. |
| `prEvaluation.autoMergeAllowed` | off | GLOBAL only | Whether any repository may arm GitHub auto-merge. Off, `auto` keeps its status rules and arms nothing. |
| `prEvaluation.postReviewFindings` | off | team, organization | Whether the review network's findings that fall inside the diff are also posted as inline comments, in one review that never approves or requests changes (§4). Off, they appear in the brief only. |
| `prEvaluation.botApprovalAllowed` | off | GLOBAL only | The second key for per-repository bot approval (§16): the approver App approves LOW pull requests of a repository that has it on. Needs `prEvaluation.autoMergeAllowed` and a configured approver App. Turning it off (or clearing it) starts the sweep that withdraws approvals. |
| `prEvaluation.botApprovalMaxLines` | 50 | GLOBAL only | Most changed lines (added plus deleted, over every listed file) a change may carry and still be approved by the approver App; at most 400. Any change to it, or clearing it, starts the sweep that withdraws approvals. |
| `prEvaluation.botApprovalMaxFiles` | 3 | GLOBAL only | Most files a change may touch and still be approved by the approver App; at most 15. Any change to it, or clearing it, starts the sweep that withdraws approvals. |
| `prEvaluation.botApprovalPaths` | documentation and test globs (§16.3) | GLOBAL only | Globs every changed path (and a rename's previous path) must match for the approver App to approve; at most 50. An empty list means no path qualifies, so the bot never approves. Any change to it (or clearing it) starts the sweep that withdraws approvals. |
| `prEvaluation.autoMinEvidence` | 150 | GLOBAL only | Counted low-risk merges in 90 days, deployment-wide, that `auto` needs, with no bad merge (§9). |
| `prEvaluation.autoMinRepoEvidence` | 20 | GLOBAL only | Counted low-risk merges in 90 days in the repository itself that `auto` needs, with no bad merge there (§9). |
| `prEvaluation.autoMinDistinctRequesters` | 3 | GLOBAL only | Different requesters the deployment-wide counted merges must come from (§9). |
| `prEvaluation.autoEvidenceMinChangedLines` | 10 | GLOBAL only | Changed lines a merged change needs to count as evidence (§9). |
| `prEvaluation.requiredStatusContext` | `auto-swe/pr-evaluation` | GLOBAL only | The status context name. |
| `prEvaluation.maxLowLines` | 400 | team, organization | Changed lines a `LOW` change may carry. |
| `prEvaluation.maxLowFiles` | 15 | team, organization | Files a `LOW` change may touch. |
| `prEvaluation.maxLowDirs` | 5 | team, organization | Directories (top two path levels) a `LOW` change may touch. |
| `prEvaluation.highLines` | 1000 | team, organization | Changed lines above which a change is `HIGH`. |
| `prEvaluation.lowApprovers` | 1 | team, organization | Approvals a `LOW` change needs. |
| `prEvaluation.standardApprovers` | 1 | team, organization | Approvals a `STANDARD` change needs. |
| `prEvaluation.highApprovers` | 2 | team, organization | Approvals a `HIGH` change needs. |
| `prEvaluation.sensitivePaths` | empty | team, organization | Globs added to the built-in sensitive list. |
| `prEvaluation.humanMinRisk` | `LOW` | team, organization | Review routing (§12.1): the lowest risk class that asks for a person, unless the approvals it needs already stand. A repository override can only lower it. |
| `prEvaluation.humanAboveLines` | 0 | team, organization | Review routing: a ready pull request with more changed lines than this asks for a person, unless the approvals it needs already stand; 0 turns the size rule off. A repository override can only lower it or turn it on. |
| `prEvaluation.humanPaths` | empty | team, organization | Review routing: globs (anchored, case-insensitive; syntax and examples in §12.1); a change touching a file (or a rename's previous path) that matches one always asks for a person, whatever approvals stand, so it stays on the attention queue until merged or closed. A repository override can only add globs. |
| `prEvaluation.humanSkipsBotApproved` | on | team, organization | Review routing: on, a pull request the approver App approved, with auto-merge armed, asks for no person unless the risk, size or path rule fires; off, it still asks. A repository override can only turn it off. |
| `prEvaluation.quickReviewMaxLines` | 100 | team, organization | Review routing: a `LOW` change of at most this many lines is a quick review. A repository override can only lower it. |

### 12.1 Review routing and the attention queue

Routing decides which open pull requests ask for a person's attention, and in what order a reviewer
meets them. It orders and labels a queue. It does not change the approvals a pull request needs: the
risk class and the host's branch rules still decide those, so a pull request routing leaves off the
queue can still be blocked on a required approval.

`needsHuman` is computed per open pull request from the newest evaluation of its **current head**
(`decideNeedsHuman` in `packages/shared/src/lib/prEvaluation/reviewRouting.ts`), with the first
reason that holds reported as `reason` and every one as `reasons`. The rules apply in this order:

| Reason | `needsHuman` | When |
|---|---|---|
| `not_open` | no | The pull request is merged or closed. |
| `draft` | no | It is a draft: it has not asked for review. |
| `not_evaluated` | yes | There is no evaluation; or the newest evaluation is for a different head than the one the host last reported for the pull request; or evaluation is off for the repository (the feature switch, the repository's mode or its deactivation), so a stored evaluation is a snapshot nothing keeps current. Nothing says the current head is safe, so it asks. |
| `path` | yes | A changed file, or the previous path of a renamed one, matches `humanPaths`; or the paths could not all be checked (see below). It outranks standing approvals: a path rule means always, and so a pull request that matches one stays on the attention queue until it is merged or closed, whatever approvals it collects. |
| `approvals_met` | no | No path rule fired, the evaluation's trusted human approvals reach the approvals it requires, and no person's request for changes stands. |
| `changes_requested` | yes | The approvals are met but a person's request for changes stands at the evaluated head: the evaluation recorded the objection, or a review asking for changes was counted on the row afterwards. A row written before the column existed has no recorded objection, which reads as none, so a request for changes recorded before then counts only through the changes-requested count on the row. It stands until the next evaluation of the pull request records it cleared (a later approval or a dismissal starts one). |
| `risk`, `size` | yes | The class is at or above `humanMinRisk`, or the changed lines exceed `humanAboveLines` (an evaluation that recorded no line count counts as over the limit). They apply after approvals: a change that already has the approvals it needs is not sent for another look because of its risk or size. |
| `bot_approved` | no | No rule above fired, the approver App's approval stands, auto-merge is armed, and `humanSkipsBotApproved` is on. |
| `bot_approved_review` | yes | The same, with `humanSkipsBotApproved` off: a person still looks. |
| `below_threshold` | no | No rule fired. |

The default (`humanMinRisk` `LOW`, no size rule, no paths) asks for a person on every ready,
evaluated pull request that lacks its approvals, so an unconfigured repository changes nothing but
the order. Setting `humanMinRisk` to `STANDARD` takes low-risk changes off the attention queue. With
`humanMinRisk` at `LOW` the risk rule fires on every pull request, so `humanSkipsBotApproved` only
takes effect once it is `STANDARD` or `HIGH`.

**Which evaluation counts.** The newest evaluation of the pull request counts, and only when its
head is the head the host last reported for the pull request. The pull-request row keeps two heads:
`head_sha`, the commit the platform last pushed (the CI wait is keyed on it, and a person's push
never moves it), and `host_head_sha`, the head the host reports, written from every `synchronize`
(and `reopened`) webhook the platform receives for a pull request it tracks, and from the platform's
own pushes. Routing compares the evaluation with `host_head_sha`, or with `head_sha` while nothing
has recorded one. Three writers keep `host_head_sha` current, and none lets an older value replace
a newer one: a `synchronize` delivery is taken only when the recorded value is empty or equals the
push's `before` (the branch's previous head), so a late delivery is dropped; the platform's own
push replaces it only when it is empty or still the previous platform head, so it cannot undo a
person's push recorded since; and every evaluation that stores a row sets it to the head it read
from the host, which heals a value that was lost, late or overwritten. A push that has no evaluation yet therefore reads `not_evaluated` and asks
for a person: the newest evaluation is for an older head, so its approvals and risk class are not
used. Once an evaluation of the new head lands, it is the newest and decides. When no evaluation of
the new head ever lands (evaluation is off for the repository or globally, the evaluation fails, or
the delivery is lost), the pull request keeps reading `not_evaluated`. The approvals counted are the
ones the evaluation counted at its own head. The remaining gap is a push the platform never hears
of: with no `synchronize` webhook (a deployment that waits for CI by polling and receives none, or
a delivery GitHub did not make), the row keeps the earlier head, and an evaluation of that head
still counts until the next evaluation of the pull request lands and corrects it (see
Limitations). The routing may order and label, and approvals and branch rules still decide what a
pull request needs.

**What a glob may say.** Matching is anchored at the repository root, case-insensitive, and
compares paths and globs after Unicode NFC normalisation; `/` is the only separator. `*` and `?`
stay inside one directory, `**` crosses directories, `{a,b}` is an alternative (no nesting), and a
glob is at most 200 characters with at most eight `*` runs. A bare name matches only that exact path.

| Write | Matches | Does not match |
|---|---|---|
| `infra/**` | everything under `infra/`, at any depth | `src/infra/main.tf` |
| `**/secrets/**` | a `secrets` directory anywhere, including the root | |
| `**/*.tf` | a `.tf` file at any depth | |
| `infra/*` | files directly in `infra/` | a file in a subdirectory of `infra` |
| `Makefile` | the root `Makefile` | `build/Makefile` |

A denylist that silently matches nothing is worse than none, so a spelling that can never match is
**refused** when the setting or override is written: a leading `./`, `/` or `!`, any backslash, and
a trailing `/` (write `infra/**`, not `infra/`; the value is stored as written, never rewritten).
`*.tf` and `infra` are accepted because they match something (a root file); they do not match
a file inside `infra`, so use `**/*.tf` and `infra/**`.

**Paths.** Each evaluation stores every changed path and every rename's previous path in
`pr_evaluations.routing_paths`, apart from the brief (which keeps only its first fifty files to read
and is never read by the queue). The path rule fails safe: a list the evaluation cut (more than 5000
paths, more than 100,000 characters of path text, a path over 1024 characters, or a file list the
host itself truncated), an evaluation that stored no list (a row from before it was recorded, or an
evaluation that failed), a path too long to match and a request that has used up its match budget
all read as a match, and the pull request asks for a person with no `matchedPath`. The match budget
counts glob tokens times path characters (a path shorter than a glob can match is rejected for
one unit). Each repository has its own share (100 million units) of a request's total (400 million,
about a second of work), so a repository with costly globs reads as unchecked on its own pull
requests without leaving the next repository's unchecked, and a list of pathological globs cannot
hold the gateway's event loop. `matchedPath` is shown
with control, zero-width and bidirectional-override characters replaced.

**Per-repository configuration.** Each routing value is a registry setting, so it can differ per
team and per organization (§12). A repository can add to them on its own row
(`connections.review_routing`, a JSON object with the keys `humanMinRisk`, `humanAboveLines`,
`humanPaths`, `quickReviewMaxLines`, `skipWhenBotApproved`). The override is a repository column
rather than a setting scope because a repository is not a scope of the registry: the same reason the
mode, the title format and bot approval are columns. `GET` and `PUT
/api/v1/repositories/:id/review-routing` read and write it (§13); the write is audited. A key whose
stored value no longer parses is ignored for that key alone. The dashboard edits it under **Advanced: gate commands and app preview → Review routing** in a repository's edit dialog, with the value in force shown beside each field; a blank field inherits.

**An override can only tighten.** Routing is the strictest of the setting at the repository's team
and organization scope and the override, key by key, computed when the queue is read:

| Key | Effective value |
|---|---|
| `humanPaths` | the union of both lists (compared case-insensitively) |
| `humanMinRisk` | the lower class |
| `humanAboveLines` | the lower non-zero value (0 is "no size rule": it never loosens another value) |
| `quickReviewMaxLines` | the lower value |
| `skipWhenBotApproved` | on only when both are on |

A looser value in a stored override is therefore inert, whoever wrote it and whenever the setting
changed: an override stored before an ADMIN added a path to the setting cannot hide that path, and
an ADMIN's own looser value changes nothing. Per-repository **loosening is not supported**; to loosen
routing, change the setting at the team or organization scope.

The write is refused with `403 ROUTING_LOOSER_THAN_SETTINGS`, naming the keys, so the writer learns
a value would do nothing. The check compares against what is in force now (the setting merged with the
override already stored), not the setting alone, and the `PUT` replaces the whole override, so:

- a value looser than the effective one is refused (a lead who sees `payments/**` stored cannot
  write `humanPaths: []` or `['infra/**']` alone);
- leaving out a key the stored override tightens is refused, because it would drop that strictness;
  clearing the override (`null` or `{}`) leaves out every key. A platform ADMIN may remove strictness
  this way; a team lead may not;
- a value equal to the one already stored is accepted unchanged, so a stale override can be re-saved.

**The queue.** `GET /api/v1/pull-requests?order=attention` lists the open pull requests the caller
can reach, in the same scope as the newest-first list, ordered by batch:

1. `deep`: needs a person and is `HIGH` risk, or has no evaluation at its head (an unknown risk
   reads as the highest, and so does a stored risk class that is not `LOW`, `STANDARD` or `HIGH`);
2. `standard`: needs a person, `STANDARD` risk, or `LOW` but larger than `quickReviewMaxLines`;
3. `quick`: needs a person, `LOW` and at most `quickReviewMaxLines` lines, smallest first so a run
   of them can be cleared in one sitting;
4. `none`: needs no one (drafts, approvals in place, bot-approved, below every threshold).

Inside a batch a higher risk comes first, then the longest-waiting pull request, then the id.
Each item carries `review`: `needsHuman`, `reason`, `reasons`, `matchedPath`, `batch`, `position`,
`riskClass` and `changedLines`; the list's `meta.queue` carries the open count, the count that needs a
person, the batch counts, the oldest and median wait in milliseconds, `truncated` (the open count
was cut, or the evaluation read was) and `evaluationsTruncated` (the evaluation read of at most
20,000 rows was; a pull request whose evaluation fell outside it reads `not_evaluated`). The
newest-first list carries `review` too, with a null `position`. When the queue is cut, `meta.total`
is the count of all matching open pull requests, not the number ordered. The Pull requests page offers the order as
**Needs attention first**.

## 13. REST routes

| Route | Role | Purpose |
|---|---|---|
| `GET /api/v1/repositories/:id/pr-evaluation` | ENGINEER | Enabled flag, mode and where it came from, whether auto-merge is allowed, the status context, the thresholds in force, the evidence figures, whether bot approval is on, allowed by the deployment and has an approver App to use (booleans only), and the repository's last evaluation |
| `PUT /api/v1/repositories/:id/pr-evaluation` | LEAD of the owning team, or ADMIN | Body `{ "mode"?: "off" \| "advisory" \| "enforce" \| "auto" \| null, "botApproval"?: boolean }`, at least one; `null` inherits. `auto` is ADMIN-only and may answer `400 AUTO_NOT_READY`. `botApproval: true` is ADMIN-only, needs the resulting mode to be `auto`, and may answer `400 BOT_APPROVAL_NOT_READY` with every unmet reason (§16.1); any mode other than `auto` sets it false in the same update. Two writes that race on the same repository can answer `409 PR_EVALUATION_CONFLICT`: reload and retry. The response carries the resulting `mode`, `modeSource`, `botApproval` and `warnings` under `data` (`warnings` is non-empty for `enforce` when the status context is not shown to be a required check) |
| `GET /api/v1/repositories/:id/review-routing` | ENGINEER | The repository's routing override and the routing in force (§12.1) |
| `PUT /api/v1/repositories/:id/review-routing` | LEAD of the owning team (whatever the platform role), or ADMIN | Body `{ "override": { ... } \| null }`; `null` or `{}` clears the override. Keys: `humanMinRisk`, `humanAboveLines`, `humanPaths`, `quickReviewMaxLines`, `skipWhenBotApproved`; an unknown key is a `400`. An override can only add strictness (§12.1): a value looser than what is in force, or an omitted key that carries strictness, answers `403 ROUTING_LOOSER_THAN_SETTINGS` (omitting a key is allowed to an ADMIN). Audited. The in-app assistant may not call it |
| `GET /api/v1/pull-requests?order=attention` | ENGINEER | The open pull requests as a review queue, with `needsHuman` and its reason on each (§12.1). `state` other than `OPEN` or `all` answers `400 ATTENTION_ORDER_OPEN_ONLY`. Orders at most 1000 open pull requests (the oldest kept) and says `meta.queue.truncated` when more matched or the evaluation read was cut |
| `GET /api/v1/pull-requests/review-time` | ENGINEER | Reviewer time per pull request cohort, repository and team, and the open queue now ([reporting.md](./reporting.md#reviewer-time)) |
| `GET /api/v1/pr-evaluations` | ENGINEER | Evaluations, newest first, for repositories you can reach. Filters `repoId`, `riskClass`, `merged`; `limit` (default 50, at most 100) and `offset`. Each row reports whether a brief exists and its length, not the brief |
| `GET /api/v1/pr-evaluations/engagement` | ENGINEER | Whether reviewers act on the brief, for repositories you can reach: `days` (default 30, 1 to 365) and `repoId`. Evaluations, how many a person reviewed, the median minutes to the first review, the share of reviewed ones with a request for changes, and where inline comments landed (on a flagged file, on a file the brief said to skim, elsewhere), and `pullRequestsViewed` with `medianMinutesToFirstView`, how soon a pull request opened in the window was first opened on the review page. Reads at most 5000 evaluations and 5000 first visits and says `capped` when the window held more of either |
| `GET /api/v1/pr-evaluations/:id` | ENGINEER | One evaluation in full: reasons, the brief, and the branch rules it read |
| `GET /api/v1/integrations/github-approver-app` | ADMIN | Whether the approver App is configured, its App id and slug, the last four characters of its private key, the retired slugs (`retiredAppSlugs`, oldest first), and when it changed. The key is never returned |
| `PUT /api/v1/integrations/github-approver-app` | ADMIN | Body `{ "appId"?, "appSlug"?, "privateKey"? }`. Checked against GitHub before anything is stored (§16.2). A blank `privateKey` keeps the stored one |
| `DELETE /api/v1/integrations/github-approver-app` | ADMIN | Removes the App id, slug and key (`204`); the removed slug is kept so its approvals can still be withdrawn |

Both `PUT` routes take their floor from the owning team: `canManageTeamRepos`, a LEAD or ADMIN of
the owning team, or a platform ADMIN, whatever the platform role. They differ on what they let a
team lead write. `PUT …/pr-evaluation` keeps its ADMIN-only values, because a mode change can arm
auto-merge. `PUT …/review-routing` only orders and labels a queue and can only be made stricter, so
a team lead may write it within that limit.

A repository you cannot reach answers `404`. The CLI wraps the first two (§14); the approver App
routes have no CLI command and no admin page, and the in-app assistant may not call them (they are
`never` in the assistant's route policy, because they carry a secret).

## 14. CLI

`auto-swe pr-policy` is documented in [the CLI README](../packages/cli/README.md). `init` and
`validate` run offline with no token; `status`, `mode` and `bot-approval` call the gateway.
`auto-swe pr-policy bot-approval <repoId> <on|off>` turns a repository's bot approval on or off (§16);
`on` prints every unmet reason and exits 1 when refused, and `status` shows whether bot approval is on
for the repository, allowed by the deployment, and has an approver App to use.

## 15. Security properties

- **Nothing the pull request controls is rendered raw.** The brief replaces control, zero-width and
  bidirectional-override characters; writes paths inside code spans fenced longer than any backtick
  run they contain; escapes markup in prose, defuses `@` mentions and `#123` issue references,
  shows bare URLs as code, and clips paths (200 characters), prose (500) and the whole comment
  (60,000, cut at a line boundary).
- **The policy cannot weaken itself.** It is read from the base branch, can only be stricter, and
  an invalid or edited file is `HIGH`. The parser accepts no aliases, bounds file size and glob
  work, and matches without compiling a regular expression.
- **No patch, token or policy text is logged or stored.** Logs carry counts, names and host status
  codes; an error is recorded as its class and status, never its text. Stored reasons are bounded.
- **The merge path is narrow and checked.** `yarn invariants:check` fails on any source file that
  calls an immediate-merge API (it is a source-text tripwire, not proof). Arming is bound to one head
  commit, refused unless GitHub holds the merge behind an App-pinned requirement, and disarmed by a
  fresh read of GitHub's real state, never by what a database row remembers.
- **A refusal is not trusted.** A disarm that cannot be proven fails and is retried.
- **The approver App is a separate identity with the least authority that works.** Its credentials are
  database-only with no environment fallback, its installation must be on selected repositories and
  hold nothing beyond pull requests (and metadata read), its token is minted for one repository with
  `pull_requests: write` and revoked after the one call, and the code that uses it only submits an
  approving review: it names no merge endpoint and no dismissal. An approval is withdrawn with the platform's credential, so the approver App's
  credentials are never needed to take an approval back. Reasons, logs and the review text name no
  login, id or free text (§16).

## 16. Bot approval

### 16.1 What it is, and the switches

Bot approval lets a second GitHub App, the **approver App**, submit an approving review on a `LOW`
pull request the platform opened. The review is bound to the head commit (`commit_id`), so GitHub
treats it as an approval of that commit and nothing pushed later. Combined with `auto` mode (§8), a
`LOW` change that is within the strict limits in §16.3 can therefore merge with **no human approval**:
GitHub's own rules (the required status pinned to the platform App, the required review the bot
supplies, dismissal of stale approvals) are what hold the merge until the evaluator is satisfied.

It is off by default and needs every one of these, each set by a platform admin:

| Switch | Where | Role to change |
|---|---|---|
| `prEvaluation.autoMergeAllowed` | Registry, GLOBAL | ADMIN |
| `prEvaluation.botApprovalAllowed` | Registry, GLOBAL | ADMIN |
| The repository's mode is `auto` | `PUT` on the route in §13 | ADMIN |
| The repository's `botApproval` flag | `PUT` on the route in §13, or `auto-swe pr-policy bot-approval` | ADMIN to turn on; the owning team's lead or an ADMIN to turn off |

and, as the global kill switch above them all, `prEvaluation.enabled`. An approver App must also be
configured (§16.2). The database enforces that the per-repository flag cannot be true outside `auto`
(`connections_bot_approval_requires_auto_check`): changing a repository's mode to anything but `auto`
writes the flag false in the same update.

Turning the flag on is refused with `400 BOT_APPROVAL_NOT_READY` and the full list of unmet reasons
unless the caller is an ADMIN, the mode the update leaves is `auto`, both deployment switches are on,
an approver App is configured, and that App is not the platform App. The evidence gate (§9) and the
branch rules are not checked at that moment; they are conditions of every approval (§16.3).

### 16.2 The approver App is a separate identity

GitHub does not let an App approve a pull request it authored, and the platform's pull requests are
authored by the platform's own credential. The approver App is therefore a **second, different GitHub
App**, stored in its own table (`github_approver_app`) and never interchangeable with the platform App:

- Saving an App id equal to the platform App's is refused (`400 APPROVER_APP_IS_MAIN_APP`), and at use
  an approver App that is the platform App is refused.
- It is database-only. There is no environment variable that supplies it, so an unset approver App
  means no approver, never "use the platform App".
- The private key is sealed on the way in (the same envelope as the platform App's) and never
  returned; the route reports its last four characters.
- A save that sets the id, the slug or the key is checked against GitHub once all three are set: the
  platform signs a token with the key and asks GitHub who the App is, and the id and slug must match. A mismatch is
  `400 APPROVER_APP_UNVERIFIED`; GitHub being unreachable is `502 APPROVER_APP_UNREACHABLE`; in either
  case nothing is saved.
- The check is repeated at every use: GitHub is asked for the App's slug each time, because its
  reviews are recognised by `<slug>[bot]` and a wrong slug would make every approval unrecognisable.
  The installation on the repository must exist, be on selected repositories (not `all`) and hold
  nothing beyond `pull_requests` and `metadata: read`. The installation token is requested for that
  one repository with `pull_requests: write` only, and revoked once the stage ends.
- It works only on the instance's own GitHub host. A repository on another approved host has its own
  platform credential (`GitHubHostCredential`) and never gets a bot approval.
- Changing the id, the slug or the key, or deleting the App, starts a deployment-wide sweep (§16.5).
  The slug of an App that was replaced or removed is kept (lower-case, the five newest, never a key)
  so its approvals can still be recognised and withdrawn; saving a slug again as the active one
  removes it from that list.

### 16.3 When the evaluator approves

An approval is submitted only when **every** condition holds for the head commit just evaluated; any
unmet one withholds it. The conditions are `BOT_APPROVAL_CONDITIONS` in
`packages/shared/src/lib/prEvaluation/botApproval.ts`, each failing closed (anything but the expected
value counts as unmet).

*Switches and App*

- The repository's effective mode is `auto` (a repository whose `auto` is held back because auto-merge
  is not allowed deployment-wide is `advisory` for this purpose).
- `prEvaluation.autoMergeAllowed` is on.
- `prEvaluation.botApprovalAllowed` is on.
- The repository's `botApproval` flag is on.
- An approver App is configured.
- The approver App is usable on this repository: installed on it, on the instance's host, narrow, with
  a valid key and the slug GitHub reports (§16.2).

*The change*

- The pull request is not a draft.
- The class is `LOW`, the change is eligible for auto-merge, and it carries no hard exclusion (§2, §8).
- The evidence gate is met, deployment-wide and for this repository (§9). A bot approval never adds to
  it, so the bot cannot bootstrap its own record.
- Everyone who launched or requested the work resolves to a linked GitHub account on the repository's
  host (§5).
- At most `prEvaluation.botApprovalMaxLines` changed lines (default 50, at most 400) and at most
  `prEvaluation.botApprovalMaxFiles` files (default 3, at most 15), counted over every listed file.
  These are separate from the `LOW` limits and the in-repo policy file cannot change them.
- Every changed path, and a rename's previous path, matches `prEvaluation.botApprovalPaths`. The
  default allows documentation and test files: `**/*.md`, `**/*.mdx`, `docs/**`, `**/*.test.*`,
  `**/*.spec.*`, `**/__tests__/**`, `**/test/**`, `**/tests/**`. A sensitive path still makes the
  change `HIGH` before this list is asked. Matching is case-insensitive. **An empty list means no path
  qualifies, so the bot never approves**, and so does a truncated file list or a malformed glob.
- No test file loses more lines than it gains, none is removed, and none is renamed out of the test
  globs.
- Only one approver is required for the change. A repository or deployment that asks for more than
  one (`prEvaluation.lowApprovers` above 1, in the registry or in the policy file) is never overridden
  by the bot: a bot approval stands in for the platform default of one approver and nothing stricter.

*GitHub's rules on the base branch*

- The repository provably allows auto-merge.
- `auto-swe/pr-evaluation` (the value of `prEvaluation.requiredStatusContext`) is a required check.
- That requirement is pinned to the platform's own GitHub App.
- The base branch provably **dismisses stale approvals on a push** (classic `dismiss_stale_reviews`,
  or a ruleset `pull_request` rule with `dismiss_stale_reviews_on_push`, every review rule agreeing).
  An approval is bound to one commit, but GitHub keeps counting it after a later push unless that
  rule is on.

*Identity and people*

- The approver is provably not the pull request's author.
- The head commit is known.
- No reviewer other than the author and a bot has a request for changes. The request is sticky: an
  evaluation that sees it records `human-objection-seen`, and while any earlier row of the pull request
  carries that reason the evaluator refuses, even after someone dismisses the request, until a person
  other than the author and a bot has an approval of the **current head** standing. At most 500 rows are read; past that bound a dismissed review by a person
  is taken as the request still standing.
- No person has dismissed the evaluator's approval on this pull request. A dismissal of the evaluator's
  approval on the current head beyond the withdrawals the platform itself recorded is a person's; the
  evaluation records `bot-approval-suppressed`, and the evaluator never approves that pull request
  again, on any later head.

Whenever bot approval is on for a repository (or an approval of the App stands) and a condition is
unmet, the row records `bot-approval-refused:<code>`, where the code is the first unmet condition (or
`client-<reason>` when the App could not be used) and the text names every unmet one. The code is
also `recheck-<condition>` or `recheck-changed` when the fresh reads taken just before the submit (or
once more after it) found a condition no longer holding or the pull request moved, `submit-<reason>`
when GitHub refused or failed the submit, and `not-confirmed` when the approval did not show in the
review list afterwards. A submitted
approval is recorded as `bot-approval-posted` (or `bot-approval-present` when it already stood on this
head). Reasons never carry a login, an id or free text.

The deployment switches, the repository flag and mode, the paths allowlist, and the pull request's
head, base branch and draft flag are read again, uncached, immediately before the approval is
submitted, and again once it is confirmed in the review list, before a `success` that rests on it is
posted. Any difference withholds it, and the approval is then withdrawn.

### 16.4 What the status says

For a `LOW` change in an `auto` repository whose approval stands on the head, the status is `success`
with the description `LOW risk: approved by the evaluator, no human approval required`. It is never
`success` on a bot approval for another class, and an evaluation error is still `failure`. See §5 for
why a bot approval is not a human approval and never counts as evidence.

### 16.5 Withdrawal

Whenever an approval must not stand, **every** approval of the approver App on the pull request is
dismissed, whatever commit it names. This is checked on every evaluation. A skipped one (the repository
`off`, the feature off, the repository inactive) reads the review list for the App's reviews directly,
with or without a row recording the approval, but only runs when something starts it: the webhook
starts an evaluation for such a repository only when a row of that pull request records an arming or
a bot approval, and the sweeps select from evaluation rows (at most 200 pull requests for a
repository, 500 deployment-wide). The per-repository sweep is also skipped when another sweep of that
repository started in the last 60 seconds (`SWEEP_DEBOUNCE_MS`, per gateway process), so turning bot
approval off within 60 seconds of another sweep of that repository starts no sweep of all its open
pull requests; an approval is then withdrawn when its pull request next changes. A review is the App's when its
author is the active slug or any retired slug.

**Order.** The order keeps a merge from happening on a `success` that nobody earned:

1. A status that is not `success` is posted first: the final status when it is not `success`,
   otherwise a fixed `pending` (`Evaluation changed: waiting`, or `Evaluation is switched off: this
   status is no longer maintained` when evaluation is off: nothing updates the status afterwards, even
   when a human approves).
2. Every approval is dismissed, through the **platform** credential, never the approver App's, so
   deleting or rotating the approver App never strands an approval.
3. Any auto-merge arming that must end is cancelled.
4. Only then is the final status posted, which may be `success` (an `advisory` repository, say).

**Triggers.** An approval is withdrawn when:

- the repository's `botApproval` flag is turned off, or its mode is changed away from `auto`. The
  route starts a re-evaluation of every open pull request of that repository, armed or not;
- `prEvaluation.enabled`, `prEvaluation.autoMergeAllowed` or `prEvaluation.botApprovalAllowed` is set
  to false, or its stored GLOBAL override is cleared. A deployment-wide sweep re-evaluates every open
  pull request that has an armed row, a standing approval, or a repository with the flag on;
- `prEvaluation.botApprovalPaths`, `prEvaluation.botApprovalMaxLines` or
  `prEvaluation.botApprovalMaxFiles` is changed in any way, or its stored GLOBAL override is cleared
  (the same sweep);
- a repository is deactivated or set `off` (the update starts a sweep of that repository), or the
  feature is disabled (the deployment-wide sweep above). A later webhook for a pull request with a
  recorded approval also starts an evaluation that withdraws it;
- the approver App's id, slug or key is changed, or the App is deleted (the same deployment-wide
  sweep). The removed slug is kept first, so its approvals are still recognised;
- an evaluation of a new head, or of a review, finds a condition in §16.3 no longer holds: the class,
  the caps, the changed paths, a test deletion, a request for changes, a person's dismissal, or the
  branch rules.

**When it cannot dismiss.** A dismissal that GitHub refuses, cannot find, or cannot process, a review
the host gave no id for, or a failure to read the review list, fails the activity with a retryable
error, so Temporal retries it (at most four attempts). The non-success status was already posted, so
nothing merges on the bot's account while the status context is a required check, but **the approval
itself stands** on the pull request until a retry, a later evaluation or a person dismisses it. A
status that cannot be posted fails the activity the same way, before any dismissal. With no slug known
at all (the App never configured), the App's reviews cannot be told from anyone's and nothing is
dismissed; the row records `bot-approval-credentials-missing`.

### 16.6 Operator setup

A repository cannot be a quick test bed: a fresh one reaches `auto`, and so bot approval, only after
the evidence gate (§9) is met. That needs `prEvaluation.autoMinRepoEvidence` counted, human-approved
`LOW` merges of its own, and the deployment-wide thresholds `prEvaluation.autoMinEvidence` and
`prEvaluation.autoMinDistinctRequesters`. That evidence accumulates while the repository is in
`advisory` or `enforce` mode. The thresholds are GLOBAL: lowering them for a test lowers them for
every repository. Whether an App's approving review counts toward a branch's required reviews, and
satisfies code-owner or allowed-reviewer restrictions, depends on your GitHub version and host's
rules and has **not** been verified here against every host. Confirm it on a repository that already
satisfies the gate, or with the thresholds temporarily lowered by an admin who understands that
effect, before relying on it.

1. **Create a separate GitHub App** for approving, not the platform App. Give it only the
   repository permission *Pull requests: Read and write* (GitHub always adds *Metadata: Read-only*) and
   no other permission. It needs no webhook, because the platform reads no events from it.
2. **Install it on selected repositories only**, the ones that will use bot approval. An installation
   on *All repositories*, or one holding any further permission, is refused when the platform tries to
   use it.
3. **Save its credentials** as an admin: the numeric App id, the slug (as in the App's URL, lowercase)
   and a PEM RSA private key, at `PUT /api/v1/integrations/github-approver-app`. The platform checks
   them against GitHub before storing anything.
   ```bash
   curl -X PUT "$GATEWAY/api/v1/integrations/github-approver-app" \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
     -d "{\"appId\":\"123456\",\"appSlug\":\"my-org-approver\",\"privateKey\":$(jq -Rs . < approver.pem)}"
   ```
4. **Allow the approver App's review on the base branch.** If the branch requires code-owner review or
   restricts who may approve, make the approver App an allowed reviewer (a code-owner entry, or a ruleset
   bypass or allowed actor, as your host supports).
5. **Set the repository's branch protection or ruleset** for the base branch:
   - require the status `auto-swe/pr-evaluation`, **pinned to the platform App** (not the approver App,
     and not unpinned);
   - require **at least one approving review**, so the bot's review is what satisfies it;
   - turn on **dismiss stale pull request approvals when new commits are pushed**;
   - allow auto-merge on the repository;
   - if dismissal of reviews is restricted, include the platform App among those who may dismiss.
6. **Turn it on, in this order**, as an admin, at `/admin/platform-settings` and then on the repository:
   1. `prEvaluation.enabled`
   2. `prEvaluation.autoMergeAllowed`
   3. `prEvaluation.botApprovalAllowed`
   4. the repository's mode `auto` (needs the evidence gate, §9)
   5. the repository's bot approval on: `auto-swe pr-policy bot-approval <repoId> on`

   Review `prEvaluation.botApprovalMaxLines`, `prEvaluation.botApprovalMaxFiles` and
   `prEvaluation.botApprovalPaths` before step 3, because the defaults are the limits a change must
   meet.

Verify with `auto-swe pr-policy status <repoId>`, which shows the repository's bot approval flag,
whether the deployment allows it, and whether an approver App is configured; then open a small
documentation change as a platform pull request and read the evaluation's reasons
(`GET /api/v1/pr-evaluations/:id`) for `bot-approval-posted` or `bot-approval-refused:<condition>`.

## Limitations

- **The evaluation serves GitHub repositories only.** A repository whose `scmProvider` is not
  `github` is refused with a non-retryable `SCM_PROVIDER_UNSUPPORTED`, never evaluated through the
  GitHub client. The exception is standing down: a deactivated or switched-off repository, and the
  `disarm-sweep` trigger, still cancel an auto-merge or bot approval the platform recorded while the
  row was a GitHub repository. A transient failure there is retried; a standing refusal is logged
  and left for a person ([architecture.md](./architecture.md#source-control-provider-seam)). Choosing
  `auto` mode or bot approval for such a row is refused with `409` `SCM_PROVIDER_UNSUPPORTED`.
- **What the run says about an open question is a request the model may not honour, and is not
  checked.** The implementer is asked for closing lines but may omit them, answer a question it did
  not understand, or say it left something unchanged that it changed; nothing compares the claim
  with the diff. A runtime that returns no final text records none, and only the last turn that
  gave any lines counts, so an account from before a later change can stand.
- **Inline finding comments are untested against a live host, and a thread they open is outside the
  feedback loop.** The review path is exercised against fakes only. The PR-feedback automation
  never reads a comment that carries the finding marker, and because it keeps a thread only when
  the comment that opened it is usable, a person's reply inside a finding's thread is not read
  either; they start a new thread or command to ask for a fix. One review holds at most ten
  comments, and the host's refusal of a stale line drops all of them for that evaluation.
- **Review findings are the network's opinion, and which were fixed is not tracked.** The brief shows
  what the last review of this head raised, so a head pushed after that review shows none, and the
  fix loop keeps no record of which finding it addressed. Findings carry no identifier, so the same
  concern worded differently by two reviewers appears twice. The lint and style filter reads the
  category only, and no structured lint result is read, so a finding CI already reported under another
  category stays.
- **The evidence is the run's own account, at one moment.** The test counts come from the run's
  last review of the head and say nothing about test quality or coverage; a head pushed afterwards
  (a CI fix, a feedback round, a person) shows no result. CI is the verdict when the evaluation ran,
  so `still running` is not a pass. Browser checks are counted per run, not per head, and the
  evidence behind them can be deleted by retention while the link remains. Gate and eval results are
  not recorded against a pull request, so they are not shown.
- **Routing orders a queue; it enforces nothing.** A pull request routing leaves off the attention
  queue can still be blocked by a required approval, and nothing nudges a person about it. The
  queue orders at most 1000 open pull requests (the oldest kept) and reads at most 20,000
  evaluation rows. A pull request with no evaluation at its current head, for any reason, reads as
  `not_evaluated`: the queue does not tell a pull request never evaluated from one whose newest
  evaluation is for another head, or from one whose repository stopped evaluating. Waiting time
  counts from the opening of the pull request, which overstates it for one opened as a draft.
- **The queue trusts the head the platform last recorded, and a push it never hears of leaves the
  earlier one.** The head comes from `synchronize` webhooks, the platform's own pushes and every
  landed evaluation. A deployment that receives no `synchronize` webhooks (CI wait in poll mode with
  no webhook configured), a delivery GitHub did not make, and a row that predates the column
  (`host_head_sha` empty, so the platform's own head is compared) all keep the old head. A person's
  push then goes unseen by the queue: an evaluation of the old head still counts, with its
  approvals and risk class, so the pull request can read `approvals_met` and stay off the attention
  queue until the next evaluation of it lands. This is a labelling gap only; the host's branch
  rules decide what merges, and auto-merge binds to the live head. Out-of-order deliveries cannot
  move the head back, and an unknown head is never invented: the queue cannot tell a never-written
  value from a correct one, so it trusts the platform's own head in that case.
- **A change request recorded before the column existed counts only through its count.** An
  evaluation row written before `human_objection` existed reads as no recorded objection; such a
  request for changes affects routing only through the row's changes-requested count.
- **An always-human path never leaves the queue until the pull request is merged or closed.** A
  `humanPaths` match outranks approvals, so approvals do not clear it. That is the rule's purpose, and
  the cost is a standing item on the attention queue for as long as the pull request touches the path.
- **A repository override cannot loosen routing.** It is combined with the setting by taking the
  stricter value, so a repository that needs a looser rule than its team or organization has
  must have the setting changed at that scope, which loosens it for everything beneath. A stored
  override that was valid when written and is now looser than the setting is inert, not an error.
- **A request for changes is read from the evaluation row, and clears only with a newer evaluation.**
  The count on the row only goes up, so a review asking for changes keeps the pull request on the
  queue as `changes_requested` until the next evaluation of it (started by a later review or
  a push) records the objection as cleared.
- **The engagement counts are approximate and say nothing about reading.** A delivery GitHub sends
  twice counts twice, a review that arrives before its head's evaluation row exists is not counted,
  and one person's several logins count as several. Rows written before the counts existed read as
  no engagement, and a brief stored before the reading path existed places every comment under
  "elsewhere". Whether a reviewer read the brief at all is not observable. The time to first view
  counts a visit to the review page, which is not a review: it says when someone began looking, only
  for pull requests opened there, and a visit made before the page recorded visits is not counted.
- **The ticket criteria are not checked against the change.** **What was asked** repeats what
  validation extracted, so it can be wrong, stale after the ticket was edited, or empty: a template
  with no validation step records no criteria, and its brief has neither section. The brief does not
  say whether a criterion is met.
- **The reading path orders by name and directory, not by what imports what.** It sees paths and
  patches, never file contents, so a file that depends on another in a different directory can come
  first. A test is paired with its source by name and place, never by what it imports: a test whose
  name differs from its source's, or that could belong to two changed sources, reads as a loose test.
  The brief cannot reorder GitHub's Files tab, which stays alphabetical.
- **With bot approval, a `LOW` change merges with no human, on a deterministic judgement.** A change
  within the caps and the path allowlist is approved and merged by GitHub with nobody reading it.
  The classifier works from signals, not from understanding the change, so a semantic mistake
  inside allowlisted paths is not caught by a person. A weakened or skipped test is mostly excluded
  (a removed test, a net test deletion and an added skip marker all refuse), but a documentation or
  test-only change can still be wrong. Keep `prEvaluation.botApprovalPaths` as narrow as the
  deployment can bear, and the caps low.
- **There is no quiet period.** The status turns green as soon as the evaluation ends, so a person has
  no guaranteed window to object before a bot-approved change can merge. A request for changes stops
  it only if it is posted before the merge, and it is read at the next evaluation, which a review
  starts.
- **A leaked approver App private key can approve any pull request in every repository the App is
  installed on.** The installation's scope and permissions are what bound that, and the platform
  refuses to approve through an installation on all repositories or with any permission beyond
  `pull_requests` and metadata read, but it cannot stop a key holder using the installation directly.
  Install the App only on the repositories that use bot approval, with only those permissions, and
  replace the key by saving a new one. Such an approval is a GitHub review like any other: only the
  required status, pinned to the platform App, and the branch's other rules stand between it and a
  merge.
- **On a branch that requires zero approving reviews, the pinned status is the only gate.** GitHub then
  does not need the bot's review at all, so the evaluator's `success` alone holds or releases the
  merge.
- **A person's dismissal of the bot's review is recorded only if an evaluation runs while that head is
  current.** The dismissal's own review event starts one, but a new head pushed first, or that
  evaluation exhausting its retries, loses it, and the evaluator may then approve again. The
  evaluator's reading of earlier rows is bounded at 500 (§16.3).
- **The sticky request-for-changes rule needs an evaluation to have seen the request.** If the
  request is dismissed before any evaluation observed it, it is forgotten. Once recorded, it is lifted
  only by a trusted approval, from someone other than the author and the people who launched or
  requested the work, of the current head.
- **A withdrawal that cannot be recorded can suppress bot approval for good.** Recording the platform's
  own dismissal is bookkeeping: its failure is logged, not retried. The next evaluation then counts
  that dismissal as a person's and records `bot-approval-suppressed`, so the evaluator never approves
  that pull request again. This fails towards a human.
- **A raised `prEvaluation.lowApprovers` starts no sweep.** A standing bot approval remains until that
  pull request's next evaluation, which then refuses because the change needs more than one approver.
- **Concurrent evaluations of one pull request are not serialised.** Each re-reads the head, the
  switches and the reviews just before publishing or approving, which narrows the window; two
  evaluations that read the same head can still both publish, and a switch flipped after the last
  read is withdrawn at the next evaluation, not before.
- **Withdrawal can fail while the approval stands.** Dismissal restrictions on the base branch that
  exclude the platform App make every withdrawal fail with a refusal. The status stays non-success, so
  nothing merges while the context is required, but the approval remains on the pull request until
  the restriction is lifted or a person dismisses it. After four failed attempts the evaluation ends
  in error and the next trigger tries again.
- **Bot approval cannot withdraw an approval it can no longer recognise.** Reviews are attributed by the
  approver App's slug, and only the five most recent retired slugs are kept. An approval given by an
  App replaced or removed more than five App changes ago stays on the pull request until a person
  dismisses it (a stale approval alone cannot merge without the evaluation status being `success`). With
  no slug known at all, none can be withdrawn.
- **The approver App works only on the instance's own GitHub host.** A repository on another
  approved host cannot get a bot approval, and the App has no per-host credential. The approver App has
  no admin page and no CLI command, only the routes in §13.
- **Whether an App's approval counts toward required reviews is not checked by the platform.** It
  depends on the host's branch rules (code owners, allowed reviewers). The platform proves the
  status, its pinning and stale-approval dismissal from the rules it reads; whether GitHub accepts the
  bot's review as the required one is something you confirm on a test repository (§16.6).
- **The sweeps are capped** (§8): 200 open pull requests for a repository, 500 for a deployment-wide
  switch or an approver App change. Past the cap an approval is withdrawn when its pull request next
  changes.
- **Without bot approval the platform submits no approving review.** On a repository whose branch rules
  require reviews, `auto` then waits for a human approval before anything merges. Where reviews are
  not required, the approvals the class needs must already be given.
- **The evidence gate is narrowed, not closed, against farming.** It counts only `LOW` rows with a
  recorded requester, at least `prEvaluation.autoEvidenceMinChangedLines` changed lines and a
  trusted approval, requires the repository's own merges as well as the deployment's, and wants
  several distinct requesters. Several colluding requesters, each rubber-stamped by a colleague,
  can still produce it. A bad merge is recognised only from GitHub's default revert text, within
  14 days; a revert written in other words is not seen. Meeting it does not by itself show that
  unattended merging is safe, and bot-approved merges do not add to it. Rows evaluated before the three
  facts were recorded do not count.
- **Distinct requesters are platform users, not people.** One person with several accounts counts
  several times, and a deleted requester keeps counting, because `requester_id` has no foreign key.
- **`changedLines` counts every listed file.** Generated files, lockfiles and whitespace-only
  changes count toward `prEvaluation.autoEvidenceMinChangedLines`.
- **Deleting a repository deletes its evaluations**, and with them its merge counts and bad-merge
  marks, which lowers the evidence figure, including the repository's own.
- **A pull request whose launchers cannot all be resolved by id is never armed, but its approvals
  count.** That covers work any of whose runs was started by a webhook automation, a schedule
  without an acting user, or a service principal or token, a requester who is a service principal,
  users who never linked GitHub, whose login was cleared, who linked a login with no account id, or
  whose linked account is on a different host than the repository, and work with more than 50 runs.
  Its status follows the approval count as for any other, so on a repository whose branch rules
  require the status, someone with write access who started the work through such a path can still
  approve it.
- **The launcher exclusion matches the one GitHub account each person linked.** A person who also
  holds a second GitHub account can approve with it, and a run launched through a service principal
  cannot be attributed to anyone behind it.
- **Anyone who can write commit statuses can post this context**, unless the requirement is pinned
  to the GitHub App. A personal access token cannot be pinned, so `auto` is refused without App
  credentials.
- **Turning evaluation off while the context is still required** leaves new heads at "Expected" in
  GitHub until the requirement is removed, because the platform no longer posts anything.
- **Advisory mode cannot enforce approver counts**: its status is `success` whatever the approval count (only an error raised while evaluating posts `failure`). Make the context
  required only on repositories in `enforce` or `auto` mode.
- **`enforce` is only as strong as the branch rule.** Choosing it does not require the context in
  branch protection; the platform only warns, and only from the latest recorded evaluation (a
  repository with none gets a warning that it is not known whether the context is required). An unpinned required context can be satisfied by any
  token that can write statuses under that name.
- **A person arming auto-merge on GitHub in a non-`auto` mode is undone only at the next
  evaluation trigger** (a push, a review event or a sweep), because the arming itself is not a
  delivered event.
- **Disarming is bounded and indirect.** The sweeps cover open pull requests with any evaluation row
  that recorded an arming, at most 200 per repository and 500 for a deployment-wide switch, and they
  only start re-evaluations. A repository's sweep is skipped when one started for it in the last 60
  seconds (a per-process memory, so a restart or another gateway replica forgets it). Beyond the cap a pull request is disarmed when it next changes. A pull
  request armed by a person on GitHub, not by the platform, is disarmed only when an evaluation
  that does not want it armed runs.
- **The record of what a person did to auto-merge is read from the last 500 evaluation rows** of the
  pull request. When none of them holds a marker but an earlier row did record an arming, the
  pull request is treated as turned off by a person and is not armed again.
- **An evaluation disarms any auto-merge it does not want**, including one a person turned on for a
  platform pull request in `advisory` or `enforce` mode or on a pull request that is not `LOW`.
- **Path matching is case-insensitive**, so a name such as `Contest.java` matches the `*Test.java`
  test pattern. The test detector over-detects, which can only make a change look covered.
- **Skim proof is narrow by design**: only same-directory exact renames and trailing-whitespace-only
  changes in files where whitespace is not meaningful. Everything else is read at full cost.
- **Reviewer severity needs the review network's verdict at the pull request's current head.** A
  push made later by a CI-fix or PR-feedback run, or by a person, moves the head, and the change is
  `HIGH` until a new review exists. A template with no review-network step is always `HIGH`.
- **A template's system-prompt override can weaken the review network** the classifier relies on;
  the class is only as good as that review.
- **`auto` merges use the squash method only.**
- **GitHub only.** Other source-control hosts are not evaluated.
- **The evaluations list is an admin page with narrow filters.** `/admin/pr-evaluations` (ADMIN)
  lists evaluations from `GET /api/v1/pr-evaluations` with their class, mode, commit status,
  whether auto-merge is armed and whether a brief exists, and opens the stored brief as plain text.
  It filters by repository, class and merged state only, because those are the route's filters;
  there is no filter by commit status or mode. With a repository chosen it shows the repository's
  mode and bot approval and lets an ADMIN change both through `PUT …/pr-evaluation`, so the gateway's
  refusals (`AUTO_NOT_READY`, `BOT_APPROVAL_NOT_READY`) appear with their reasons. The list row names
  its pull request by repository and number only, so the page finds the review page
  (`/pull-requests/<id>`, described in [`work-views.md`](./work-views.md)) from each visible
  repository's newest 100 pull requests: an older pull request's row shows no link. The page is
  admin-only; an ENGINEER reads the same data through the routes in §13 or the CLI.
