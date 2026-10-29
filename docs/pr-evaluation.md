# Pull-request evaluation

> How the platform judges the risk of a pull request it opened, tells reviewers where to look,
> publishes a commit status, and, only where an admin opted a repository in, asks GitHub to
> auto-merge a provably low-risk change. For the run that opens the pull request see
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

By default nothing merges. The platform never calls an immediate-merge API. The one merge-capable
call it makes is GitHub's `enablePullRequestAutoMerge`, which asks GitHub to merge later, when the
branch rules it already enforces are met, and only for the head commit that was evaluated
(`expectedHeadOid`). That call is reachable only from `auto` mode, which is per repository, set by a
platform admin, and refused until the preconditions in §8 and §10 hold.

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
- **Focus your review here**: at most ten files, the ones named by a reason first, then by churn,
  each with why it is listed and what to verify.
- **Verify**: the claims that name no path (a reviewer finding, a failed scan, an invalid policy file).
- **Safe to skim**: files with a deterministic proof, at most 50 shown.

The brief is also stored on the evaluation row and returned by the routes in §13.

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

For `enforce` the description reads `enforce: <class> risk: waiting for <n>/<required> approvals` (or
`enforce: <class> risk: <n>/<required> approvals` once met); for `auto` it has no mode prefix.

Approvals are counted by `approvalState`: distinct people whose **latest** review is an approval of
the **exact head commit**. A later comment or change request withdraws an approval, an approval of
an older commit is stale, the pull request's author never counts, and accounts ending in `[bot]`
never count. One person with two logins cannot be detected.

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
  approvals the class needs are already given on this head.
- The commit status for this evaluation was accepted by GitHub.
- The pull request is not a draft.
- The deployment's evidence gate is met (§9).

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

## 9. The evidence gate

`auto` needs a track record before it can be chosen and before it arms. The gate is
`prEvaluationEvidence` in `packages/shared/src/lib/prEvaluationEvidence.ts`:

- count the evaluation rows with class `LOW` whose pull request merged in the last **90 days**, and
- count those that were marked a **bad merge**;
- the gate is met when the first is at least `prEvaluation.autoMinEvidence` (default 150) and the
  second is **zero**.

A merge is recorded on the single evaluation row of the head that was merged. A merge is marked bad
when a later merged pull request in the same repository reverts it within **14 days** of the merge,
recognised from GitHub's default revert text only: a body starting `Reverts owner/repo#N`, or a title
starting `Revert` that names `(#N)`.

What it counts is evaluation rows merged under `LOW`. It does **not** check who approved, whether the
merge was by a person or by auto-merge, which repository it was in, or whether the repository was
in `advisory`, `enforce` or `auto` mode; the count is the whole deployment's. What it shows is that the
classifier's `LOW` was not followed by a revert recognised by that text in the weeks after. It does
not show that unattended merging is safe; see Limitations.

## 10. Who may do what

| Action | Role |
|---|---|
| Read a repository's evaluation state and the evaluations of repositories you can reach | ENGINEER and above, for a repository you can reach |
| Set a repository to `off`, `advisory`, `enforce` or `inherit` | Lead of the owning team, or platform admin |
| Set a repository to `auto` | Platform admin only, and only while the preconditions below hold |
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
delivery starts a workflow only for a pull request an earlier row recorded as armed, so the platform
can disarm it. Evaluations are also started by the disarm sweeps (§8).

Each evaluation, in order: loads the connection and settings (at the repository's team and
organization scope); checks the pull request is the platform's and open; reads the policy file from
the base branch; lists the changed files and scans the diff; reads the review network's verdict for
this head; classifies; reads the branch rules; **re-reads the pull request's head and reviews
immediately before publishing** (a moved head is `superseded`: the newer head has its own
evaluation); publishes the status; posts the brief; stores the row; and applies the arming decision.

## 12. Settings

All are ADMIN-only registry settings in the `prEvaluation` group; see
[configuration.md](./configuration.md). Changes take effect within the settings cache window.

| Setting | Default | Overridable at | Effect |
|---|---|---|---|
| `prEvaluation.enabled` | off | GLOBAL only | The kill switch. Off, nothing is evaluated and nothing is posted. |
| `prEvaluation.defaultMode` | `advisory` | team, organization | Mode of a repository that has not chosen one: `off`, `advisory` or `enforce`. |
| `prEvaluation.autoMergeAllowed` | off | GLOBAL only | Whether any repository may arm GitHub auto-merge. Off, `auto` keeps its status rules and arms nothing. |
| `prEvaluation.autoMinEvidence` | 150 | GLOBAL only | Low-risk merges in 90 days, with no bad merge, that `auto` needs (§9). |
| `prEvaluation.requiredStatusContext` | `auto-swe/pr-evaluation` | GLOBAL only | The status context name. |
| `prEvaluation.maxLowLines` | 400 | team, organization | Changed lines a `LOW` change may carry. |
| `prEvaluation.maxLowFiles` | 15 | team, organization | Files a `LOW` change may touch. |
| `prEvaluation.maxLowDirs` | 5 | team, organization | Directories (top two path levels) a `LOW` change may touch. |
| `prEvaluation.highLines` | 1000 | team, organization | Changed lines above which a change is `HIGH`. |
| `prEvaluation.lowApprovers` | 1 | team, organization | Approvals a `LOW` change needs. |
| `prEvaluation.standardApprovers` | 1 | team, organization | Approvals a `STANDARD` change needs. |
| `prEvaluation.highApprovers` | 2 | team, organization | Approvals a `HIGH` change needs. |
| `prEvaluation.sensitivePaths` | empty | team, organization | Globs added to the built-in sensitive list. |

## 13. REST routes

| Route | Role | Purpose |
|---|---|---|
| `GET /api/v1/repositories/:id/pr-evaluation` | ENGINEER | Enabled flag, mode and where it came from, whether auto-merge is allowed, the status context, the thresholds in force, the evidence figures, and the repository's last evaluation |
| `PUT /api/v1/repositories/:id/pr-evaluation` | LEAD of the owning team, or ADMIN | Body `{ "mode": "off" \| "advisory" \| "enforce" \| "auto" \| null }`; `null` inherits. `auto` is ADMIN-only and may answer `400 AUTO_NOT_READY`. The response carries `data.warnings`, non-empty for `enforce` when the status context is not shown to be a required check |
| `GET /api/v1/pr-evaluations` | ENGINEER | Evaluations, newest first, for repositories you can reach. Filters `repoId`, `riskClass`, `merged`; `limit` (default 50, at most 100) and `offset`. Each row reports whether a brief exists and its length, not the brief |
| `GET /api/v1/pr-evaluations/:id` | ENGINEER | One evaluation in full: reasons, the brief, and the branch rules it read |

A repository you cannot reach answers `404`. The CLI wraps the first two (§14).

## 14. CLI

`auto-swe pr-policy` is documented in [the CLI README](../packages/cli/README.md). `init` and
`validate` run offline with no token; `status` and `mode` call the gateway.

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

## Limitations

- **The platform never submits an approving review.** It has no second App identity, so on a
  repository whose branch rules require reviews, `auto` waits for a human approval before anything
  merges. Where reviews are not required, the approvals the class needs must already be given.
- **The evidence gate is deployment-wide and weak evidence.** It counts `LOW` evaluation rows merged
  in 90 days, with no recorded bad merge, whoever approved and however they merged. A bad merge is
  recognised only from GitHub's default revert text, within 14 days; a revert written in other
  words is not seen. Anyone who can launch runs can contribute to the count. Meeting it does not by
  itself show that unattended merging is safe.
- **Deleting a repository deletes its evaluations**, and with them its merge counts and bad-merge
  marks, which lowers the evidence figure.
- **A run's launcher can approve the pull request their run opened**, if they have write access on
  GitHub. The count excludes only the pull request's own author.
- **Concurrent evaluations of one pull request are not serialised.** Each re-reads the head and the
  reviews just before publishing, which narrows the window; two evaluations that read the same head
  can still both publish.
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
- **There is no dashboard page.** The brief lives on the pull request, and the routes in §13 expose
  the state; the CLI reads it.
