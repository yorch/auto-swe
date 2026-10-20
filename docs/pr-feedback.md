# Pull-request feedback

> How an automation acts on review feedback and explicit `/auto-swe fix` commands on a pull
> request. For event automations in general see [automations.md](./automations.md); for the CI
> side of the same GitHub App see [ci-failure-triggers.md](./ci-failure-triggers.md).

---

## 1. What it is

The `github.pull_request.feedback` event source starts a run of the built-in
`address-pr-feedback` template when a pull request gets:

- a **review that requests changes** on a pull request the platform opened (a tracked
  workflow's or an agent run's), or
- an **`/auto-swe fix` command** in a pull-request discussion comment, an inline review
  comment, or a review body.

A feedback round **gathers** the open member review threads on the pull request, **fixes**
them on a work branch, **pushes** the fix onto the pull request's own branch as a fast-forward,
**reports** the round on the pull request (one marked summary comment plus a reply on each
answered thread), **watches** the pull request's CI on the pushed commit, and runs **at most
one CI follow-up** on the same fixer path.

Two filters shape what a trigger selects:

- `triggers` — `changes_requested` and/or `command` (default both).
- `pullRequests` — `platform` and/or `others` (default `platform`). `others` is gated on an
  admin setting, and on those pull requests only the explicit command acts — a drive-by
  `changes_requested` review on a stranger's pull request does not spend model budget.

## 2. Eligibility, checked at gather time, not trigger time

`gatherPrFeedback` re-reads everything from the host and the database — the webhook only named
a delivery. A round is skipped, without spending a fix, when:

- the pull request is closed, from a fork, or its head moved off the recorded branch;
- the triggering review/comment no longer exists (or no longer requests changes / carries the
  command);
- the trigger's author does not match the requester's linked GitHub account on the
  repository's host, or is not an active repository member with **write** permission —
  checked against the host, not only the membership ledger;
- the pull request's origin re-derived from the database disagrees with the delivery (the
  payload's origin is never trusted);
- the run that opened the pull request is still working on it (any status but
  `AWAITING_HUMAN_MERGE`);
- the round would exceed `maxRounds` (each pushed round counts once, default 5, max 20);
- a `changes_requested` trigger lands on a pull request the platform did not open, or the
  other-pull-requests admin setting is off;
- the threads hold nothing a trusted author wrote that survives the injection screen.

Silent skips post nothing (a closed pull request, a fork, a moved head, a comment from a
stranger, an origin mismatch). Skips a reviewer would wonder about — the round limit, an
in-flight original run, a refused push, a work branch left by a previous attempt, a pull
request this automation may not act on — update the summary comment with a generic reason
that names no setting or number.

## 3. The two fixer paths

- **Other origins** — a tracked workflow's pull request or another repository's — run the
  `reviewFixer` implementer persona in `PR_FEEDBACK` mode on the work branch, then the local
  lint / typecheck / test gates. The brief is a fenced, labelled block of reviewer text marked
  as data, never instructions; every comment is bounded and screened for injection in one
  batch over all bodies. A comment is kept only when its own author is a linked, active
  repository member with write permission on the host; the thread the trigger comment lives
  in is kept even when its opener fails that check, still filtered comment by comment.
- **`agent_run` origin** — the pull request an agent run opened is followed up by *the same
  agent* (`runAgentPrFeedbackTask`): the original task plus a short instruction and the fenced
  brief as the prompt, resolved at GLOBAL and ORGANIZATION scope, run in a container it cannot
  push from, committed and gated in a fresh trusted container, and pushed to the work branch.
  The agent-run ceilings and kill switch apply; the concurrency admission does not — a
  follow-up takes no new slot.

## 4. What reaches the model, and what reaches the pull request

The fixer sees: the fenced brief (trigger notes plus each open trusted thread, labelled `T1`,
`T2`, …, per-comment bounded, HTML comments stripped, injection-screened, ~40k characters
total) — and, on the CI follow-up, the redacted, screened, fenced CI logs (a log the screen
refuses ends the round rather than reaching the model). It never sees the webhook payload or
the run's request description.

The pull request sees: the summary comment (rendered from the responder's fields only, with
mentions, autolinks, HTML and markdown neutralised — the same sanitiser the CI-triage comment
uses), and a one-line reply on each answered thread, marked so a retried respond never posts
it twice. The CI update does not re-run the model: the first verdict is re-rendered with the
push and CI lines. Nothing the model wrote is posted raw.

## 5. The push

`pushPrFeedbackToPullRequest` fast-forwards the pull request's branch to the fix commit only
when, at the moment of the push: the run is the one the automation started with the built-in
template; the pull request is still open from the recorded head of this repository (never a
fork); the branch is not the default, not protected, and not in
`github.ciFixNeverPushBranches`; the commit is a fast-forward of its tip and touches no
`.github/workflows` or `.github/actions` file; and — for a pull request the platform did not
open — the trigger is the command and the admin setting is on. The commit is recorded on the
automation's fire row **before** the push so its own CI failure is recognised as the
platform's own output. A refused push is reported and the round ends FAILED.

## 6. Settings

| Setting | Scope | Default | Effect |
|---|---|---|---|
| `github.prFeedbackAutomationsEnabled` | ADMIN, TEAM / ORGANIZATION override | off | The kill switch: off, the source starts nothing |
| `github.prFeedbackOtherPullRequestsEnabled` | ADMIN, TEAM / ORGANIZATION override | off | Allow `pullRequests: others` on saved automations, and pushes to those pull requests |
| `github.ciFixNeverPushBranches` | same as the CI push | — | Branches a fix is never pushed to (shared with the CI-fix push) |

Every feedback run uses the platform credential of the repository's host — automation runs
have no launcher.

## 7. GitHub App wiring

The App needs the **Pull request review**, **Pull request review comment** and **Issue
comment** events subscribed, beside the permissions the other sources already use (the
reply-to-thread writes go through `pulls.createReplyForReviewComment` and issue comments, so
**Pull requests: Read & write** and **Issues: Read & write** cover them). See
[github-app-setup.md](./github-app-setup.md).

## Limitations

- GitHub only. Review threads are read through the GraphQL API; a GHES host resolves its own
  `…/api/graphql` endpoint from the repository's API base.
- At most 100 threads and 50 comments each are read; a non-member-authored thread is dropped
  and counted, a screened comment is dropped and counted.
- Rounds count pushes, not fires: a round that never pushes does not consume `maxRounds`.
- The CI follow-up is a single retry (`maxCiFixAttempts` 0–1, default 1); a poll that cannot
  reach a verdict reports CI as unknown and ends the round SUCCESS.
- Thread replies happen on the first report call of a round only and carry a hidden marker,
  so a retried respond skips threads it already answered; the CI update edits the summary
  comment instead.
- A pull request another platform run is still working on is skipped rather than queued —
  comment `/auto-swe fix` after it parks to start a round.
- The responder's verdicts are advisory: a thread's outcome is written by the persona, and an
  overclaimed "addressed" is a wording problem, not a safety boundary — the code gate is the
  push, not the reply.
- `pullRequests: others` exists only for the command, and the platform credential does the
  pushing, so the App's installation must have write access to that pull request's repository.
- The gateway reads the pull request's head from the host only when a round could actually
  start: the kill switch is on and an enabled automation on a matched connection selects
  `others` with `command`. Otherwise the delivery proceeds with no head and the run fails to
  start, without ever minting a token.
- A `pullRequests: others` round whose pull request disappeared between webhook and read is
  ignored (the host answering 404/410 is a state, not a failure to retry).
- The "feedback that arrived after this round started" line appears only when a second
  delivery on the same pull request was actually suppressed in-flight while the round ran.
