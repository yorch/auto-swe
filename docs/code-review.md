# Code review after a run

A code review is a separate workflow run linked to a finished source run. It reviews that run's
change without re-running implementation, records a verdict, and, for a pull request, publishes a
comment and requests PR evaluation. Both workflow runs and agent runs use this path.

## Templates and presets

A review template has `WorkflowTemplate.kind = 'review'`. The workflow library's metadata editor
exposes **Review template (requires a source run)**. The built-in choices are:

| Template | Review |
|---|---|
| `code-review` | The review network evaluates the diff; a preset's optional reviewer system prompt reaches the network. |
| `code-review-qodo` | The network plus Qodo, awaited only in PR mode; action-required Qodo findings at the reviewed head reject approval. |
| `human-review-of-run` | A person reviews the diff and chooses approve or request changes; the human note accompanies the result. |

A preset selects a review template and supplies a name, description, optional reviewer system
prompt, enabled flag, and `onBlocking: report | fix`. Platform administrators manage presets at
`/admin/review-presets`. `report` publishes the result without starting a fix.

An attachment associates one preset with either a source workflow template (`templateId`) or a
repository (`connectionId`), not both. Enabled presets attached through either source are selected
when a non-review source run finalizes with effective status `SUCCESS`. The finalization transaction
inserts durable launch intents, deduplicated by source run and preset. Dispatch claims those intents,
starts reviews as the source launcher, and records started, skipped, or failed outcomes. The existing
run reaper also sweeps stale pending intents. Review runs do not recursively launch reviews.

## Launch and scope

On `/runs/<id>`, **Run review** selects a preset by default. **Advanced** selects an active review
template directly. The button explains why a run is not reviewable or the caller cannot control it.
The same run viewer serves agent runs. Successful submission opens the new review run.

Manual launches require ENGINEER access, control of the source run, repository launch authorization,
and launch budget. Send an `Idempotency-Key` to retry a submission without creating another run.
Review workflow IDs use `review-<repo8>-<hex8>`; the review creates no work branch of its own.

`review.enabled` defaults to `true`. It resolves at the source repository's team/organization scope
and gates manual and automatic launch preparation as well as automatic intent creation. Disabling
the setting prevents new reviews; it is not cancellation of a review already running.

## What gets reviewed

Source selection takes the first available mode in this order:

1. **PR:** an open tracked pull request from the source run. The worker re-reads the host's head and
   base, refuses closed or fork PRs, clones the head, and verifies the checkout matches that SHA.
2. **Branch:** the source's recorded branch and head SHA. The checkout must still equal that SHA;
   a moved branch fails with `REVIEW_HEAD_CHANGED` rather than reviewing a different commit.
3. **Stored:** an agent run with `deliver: none` and a nonempty stored diff. The worker checks out
   the source's recorded base commit, checks and applies the patch, and creates a local review
   commit that is never pushed. The run page shows verified/unverified status and a failure reason.

PR and branch diffs use the merge base of the base branch with hardened git-diff options. A diff
larger than 300,000 characters is reviewed in file-aligned chunks (oversized files split by hunk,
and oversized hunks by lines). At most two chunks run concurrently; each names its position and
the full file list. Verdicts merge worst-of with deduplicated findings in the single
`runReviewNetwork` output. The hard limits are 900,000 diff characters and 1.2 MB of serialized
change data; exceeding either fails with `REVIEW_DIFF_TOO_LARGE`, without truncation.
Workspaces are destroyed after loading. Presets default `runTests` to false. Enabling it runs the
repository test gate on the reviewed checkout and feeds its actual output into the review.
Without it, tests are explicitly **not run**. A finished source with no eligible change
returns `REVIEW_NOTHING_TO_REVIEW`. A review run cannot itself be a review source.

## Results and PR evaluation

The source run's **Reviews** panel lists linked reviews with status, preset/template, approved state,
worst severity, and links. A review run links back to its source and displays the publication verdict,
bounded findings, and fix status or skipped reason.

In PR mode, publication upserts one sanitized comment marked
`<!-- auto-swe:code-review:<runId> -->`. It includes the verdict, findings, human note when supplied,
a run-page link based on `WEB_URL`, and fix outcome. Branch and stored reviews retain
their results on the run without posting a PR comment.

Publication requests a fresh [PR evaluation](./pr-evaluation.md). Evaluation and the reviewer brief
also read successful linked reviews of the current PR head. Severity is **worst-of**, with strict
**never-lower** behavior: a linked WARNING/CRITICAL or rejected approval raises risk to HIGH; a
clean linked review cannot lower an original WARNING. When the original run has no review result
at that head, eligible linked reviews supply the review signal: a clean result removes the missing-review
risk bump. Findings are bounded, deduplicated, and labelled with the review run. Different-head,
unsuccessful, stored, and unverified reviews do not contribute linked evidence.

## Fix mode

`onBlocking: fix` requests a fix only for an unapproved PR-mode review. The worker reuses the
[address-pr-feedback path](./pr-feedback.md) through a trusted `review_findings` automation fire.
Findings come from the review run's stored database verdicts, not host comment/review IDs. The
worker does not synthesize a GitHub review ID or post an `/auto-swe fix` command.

An administrator configures all of the following:

1. Keep `review.enabled` true for the source repository's team/organization.
2. Select or attach an enabled review preset with `onBlocking: "fix"`.
3. Enable `github.prFeedbackAutomationsEnabled` for the repository's team/organization.
4. Create an enabled **repository-scoped** automation with source
   `github.pull_request.feedback`, the default template (`templateId: null`, resolving the active
   global `address-pr-feedback` template), and filters that include:

   ```json
   {
     "pullRequests": ["platform"],
     "triggers": ["review_findings"]
   }
   ```

The PR must remain open, platform-opened, in the same repository rather than a fork, and at the
reviewed head. Existing budget, cooldown, daily cap, concurrency, per-PR round limit, branch
protection, default/never-push branch rules, and push permissions still apply. An agent-origin PR
uses the original agent for the fix. The review run ID deduplicates the fix decision to one round.

Missing configuration or failed eligibility records a skipped reason in the publication summary
and an activity event instead of failing the review. The PR comment includes
`fix not started: <reason>`.

For a verified stored review, fix policy launches the original agent through the built-in Agent Run
template with `deliver: none`, without a PR automation. The follow-up checks the completed review,
reapplies the exact reviewed diff on its recorded base, and supplies stored, screened findings to
the same agent with its original launch parameters. Agent enablement, concurrency, tool permissions,
budget and runtime ceilings still apply. The review run and attempt deduplicate the ledger and
workflow; transient skips and launch failures use the run's **Retry fix** action.

## API

All paths below have the `/api/v1` prefix. Preset administration requires ADMIN; launch and picker
routes require ENGINEER, with source control and repository checks on launch.

| Method and path | Request / result |
|---|---|
| `POST /workflow-runs/:id/reviews` | Exactly `{ "presetId": "<uuid>" }` or `{ "templateId": "<uuid>" }`; optional `Idempotency-Key`; returns 201 with `data: { runId, workflowId }`. |
| `POST /workflow-runs/:id/reviews/fix-retry` | ENGINEER with review-run control and repository authorization; queues a guarded fix retry and returns 202 with `data: { workflowId }`. |
| `GET /review-presets` | Enabled presets and active review templates for the picker. |
| `GET /workflow-runs/:id` | The `review` field describes eligibility, control, source linkage, and linked review summaries. Step outputs carry the publication summary. |
| `GET /platform/review-presets` | Presets with template metadata and attachments. |
| `POST /platform/review-presets` | Create with `name`, `templateId`, optional `description`, `systemPrompt`, `onBlocking`, `runTests`, and `enabled`. |
| `PATCH /platform/review-presets/:id` | Update supplied preset fields. |
| `DELETE /platform/review-presets/:id` | Delete the preset and its attachments; existing review runs remain. |
| `POST /platform/review-presets/:id/attachments` | Exactly `{ "templateId": "<uuid>" }` or `{ "connectionId": "<uuid>" }`. |
| `DELETE /platform/review-presets/:id/attachments` | The same target body removes the attachment. |

Template create/update accepts `kind: "review"` or `null` under the existing template permissions.
Preset and attachment writes produce audit entries. The ordinary template-run endpoint rejects a
review template with `REVIEW_TEMPLATE_NEEDS_SOURCE`.

## Limitations

- Review templates cannot launch standalone: they require a finished source run and an eligible
  change. Automatic review applies only to successful non-review sources.
- Stored verification refuses binary patches, symlinks, submodules, traversal, renames, and
  quoted/unsupported paths. Missing base commits or patches that cannot be safely applied remain
  unverified with a reason and cannot start a fix. Even verified stored reviews never count toward
  PR evaluation because they have no PR target. Their local commits are never pushed.
- Test execution is opt-in. Unverified stored diffs skip tests. Changes above the hard limits fail
  rather than receive partial review. Chunk-local review cannot guarantee whole-change reasoning.
  Findings displayed/published by the summary are bounded.
- Fix retries apply only to successful blocking PR or verified stored reviews with fix policy and a
  transient failed, suppressed, or skipped decision (for example cooldown, budget, unavailable configuration,
  or a failed start). The run's **Retry fix** action and the generic automation-fire retry endpoint
  create a new attempt, reread stored findings, and recheck all guards and limits. The generic
  endpoint applies to PR automation fires; stored reviews use the run action. A moved head,
  closed/fork PR, protected/never-push branch, or exhausted round limit is not retryable.
- PR reevaluation waits up to five minutes for the publishing review run to reach SUCCESS.
  Unsuccessful or unfinished reviews are skipped; scheduling reevaluation is best-effort and a
  scheduling failure records an activity event rather than failing publication.
- A different-head review does not replace review evidence for the current head. Missing review
  evidence raises risk unless an eligible linked review supplies a result at that head.
