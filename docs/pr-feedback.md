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
  comment, or a review body, or
- **Qodo's review bot reviewing** a pull request the platform opened, when an automation opts in
  to the `qodo_findings` trigger ([§8](#8-qodo-findings)).

A feedback round **gathers** the open member review threads on the pull request, **fixes**
them on a work branch, **pushes** the fix onto the pull request's own branch as a fast-forward,
**reports** the round on the pull request (one marked summary comment plus a reply on each
answered thread), **watches** the pull request's CI on the pushed commit, and runs **at most
one CI follow-up** on the same fixer path.

Two filters shape what a trigger selects:

- `triggers` — `changes_requested`, `command` and/or `qodo_findings` (default the first two;
  Qodo is opt-in, so an automation that never listed it keeps reacting to people only).
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
  `AWAITING_HUMAN_MERGE`); a Qodo-triggered round waits for it first, as described in
  [§8](#8-qodo-findings);
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
| `qodo.enabled` | ADMIN, TEAM / ORGANIZATION override | off | Whether Qodo's review may be read at all; off, a Qodo nudge is ignored |
| `qodo.prFeedbackBotAccountIds` | ADMIN, platform-wide | empty | Numeric GitHub account ids of Qodo's review bot on this host (at most 10); empty keeps the Qodo trigger inert |
| `qodo.prFeedbackMinActionLevel` | ADMIN, TEAM / ORGANIZATION override | `remediation_recommended` | Lowest Qodo action level that is addressed: `action_required`, `remediation_recommended` or `informational` |
| `qodo.prFeedbackIncludeOnCommand` | ADMIN, TEAM / ORGANIZATION override | off | Whether an `/auto-swe fix` round also reads Qodo once and addresses its open findings (needs `qodo.enabled`) |
| `qodo.prFeedbackMaxRounds` | ADMIN, TEAM / ORGANIZATION override | 2 | Pushed rounds Qodo's findings alone may cause on one pull request (1–10), on top of `maxRounds` |
| `qodo.prFeedbackRunWaitSeconds` | ADMIN, platform-wide | 900 | How long a Qodo round waits for the run that opened the pull request to finish its CI wait and park (0–900 s); 0 skips at once |
| `qodo.prFeedbackWaitSeconds` | ADMIN, platform-wide | 120 | How long a Qodo round waits for Qodo to finish reviewing the head commit (0–600 s) |

Every feedback run uses the platform credential of the repository's host — automation runs
have no launcher.

## 7. GitHub App wiring

The App needs the **Pull request review**, **Pull request review comment** and **Issue
comment** events subscribed, beside the permissions the other sources already use (the
reply-to-thread writes go through `pulls.createReplyForReviewComment` and issue comments, so
**Pull requests: Read & write** and **Issues: Read & write** cover them). See
[github-app-setup.md](./github-app-setup.md).

## 8. Qodo findings

Qodo's review bot comments on a pull request as a GitHub App. That comment is **only a trigger**:
the gateway never copies the bot's text, never reads a command from it (`/auto-swe fix` inside a
bot comment is nothing), and the worker **pulls** the findings from Qodo itself through the shared
client in [qodo.md](./qodo.md#4-the-shared-client-and-qodoenabled), with the repository team's Qodo
connection.

**The nudge.** A `pull_request_review` `submitted`, a `pull_request_review_comment` `created` or an
`issue_comment` `created` from a sender of type `Bot` whose numeric account id is in
`qodo.prFeedbackBotAccountIds` — the id, never the login, which can be renamed — on a pull request
that is open, not from a fork, and one the platform opened. A later `edited` of Qodo's summary is
not a nudge. The webhook's `installation` object is the receiving App's own, so it says nothing
about the sender and is not used to identify it. Any other bot is answered as bots always were.

**One decision per head SHA.** Qodo posts several comments for one review, each a delivery. A Qodo
nudge's decision subject is the pull request at its head commit (`pr-N@qodo-<head>`), so the ledger
decides every delivery for one head once, before any run starts. A fix push moves the head, so
Qodo's review of that push is a new subject. The subject is never a bare commit sha, so the
platform's own pushed commit does not mark Qodo's review of it as the platform's output. A
`review_comment` nudge takes its head from the payload; an `issue_comment` (the discussion summary)
carries none and takes it from a fresh read of the pull request. The head can move between two
deliveries of one review, so one review can yield two decisions, one per head.

**The round.** `gatherPrFeedback` skips the human-author steps and instead:

1. requires the pull request open, not a fork, on the recorded branch, and — derived from the
   database — opened by the platform (never a pull request the platform did not open, and
   `pullRequests: others` does not apply to this trigger). If the run that opened it is still
   working (it holds `AWAITING_CI` from before the pull request opens until CI passes), the round
   waits for it to park or end rather than skipping, re-reading the pull request about every ten
   seconds for at most `qodo.prFeedbackRunWaitSeconds`. A pull request that is no longer open, or a
   wait that runs out, is a silent skip, and so is a pull request that is no longer open, is on
   another branch or is from a fork once the wait ends. If a CI fix moved the head while the round
   waited, the round follows the head the run left: Qodo's comments on that head arrived while this
   round was in flight and were suppressed as in flight, so no later nudge would come for it, and
   the Qodo read below then needs a completed review of that commit. `0` skips at once. A person's
   round never waits;
2. stops at the round limits: the automation's own `maxRounds` and `qodo.prFeedbackMaxRounds`
   (pushed Qodo-triggered rounds on this pull request);
3. asks Qodo about the pull request, whose URL is built from the repository record, for the
   repository's team — polling for up to `qodo.prFeedbackWaitSeconds` while the review is still
   running or describes another commit — and requires a **completed** session whose `commitSha`
   equals the pull request's current head, because the fix is cut from that commit. The head is
   read again just before the brief is built, whether or not the round waited, and a head that moved
   is a silent skip;
4. keeps the findings that are **open** (`pending` only — implemented, dismissed and unrecognised
   statuses are not) and at or above `qodo.prFeedbackMinActionLevel`, most severe first, and
   records how many had an unrecognised status;
5. briefs each as `T1`, `T2`, … authored by the literal `Qodo`: title and description only, no code
   snippets and no paths, HTML comments stripped, joined onto one line (so a finding that echoes
   text from the diff cannot start a line that looks like a person's `[Tn]` block, which matters
   most in an `/auto-swe fix` round where both kinds of block are present), bounded, screened for
   injection in **one batch** with the human feedback screen, and fenced exactly like human review
   text. A finding whose title
   or description Qodo's result screen already withheld (see
   [qodo.md §3](./qodo.md#3-output-screening)) is dropped and counted as screened, so the
   placeholder never stands in for Qodo's words; the round records only how many strings were
   withheld.

Every way a Qodo round cannot proceed — no review, Qodo unreadable, a stale or failed review, no
open finding, everything screened, a limit reached — is a silent skip that posts nothing and writes
a fixed-string activity event. A finding is not a GitHub thread, so the round posts only its summary
comment and replies on no thread. The rest of the round — fixer, gates, push, CI watch, respond —
is the same as for people. The gather runs under its own activity group with a single attempt and a
timeout well beyond the longest wait, so a long wait is not retried; push and respond keep the
shared bounds.

**In an `/auto-swe fix` round.** A person's command can also address Qodo's findings. It does so
only when `qodo.enabled` and `qodo.prFeedbackIncludeOnCommand` are both on for the repository's
team, the trigger is the command (not a review that requests changes), and the pull request is one
the platform opened. The human threads are gathered and trusted exactly as before. Then Qodo is read
**once, without waiting**, under the same conditions as a Qodo round: a completed review of the
pull request's current head commit, only `pending` findings at or above
`qodo.prFeedbackMinActionLevel`, the same single screening batch and fencing, and the head read
again before the brief is final. The findings follow the human threads and their labels continue
from the last human label. Anything that stops Qodo adding to the round — it is unreadable, has no
review, has not finished or reviewed another commit, has nothing qualifying, or the head moved —
leaves the round on the human threads alone and writes one `pr_feedback.qodo_command_skipped`
activity event with a fixed reason. A host error while Qodo is read counts the same way, and the
human threads and the findings share the brief's thread and character bounds, so a full brief asks
Qodo nothing. The round counts toward the automation's `maxRounds` only;
`qodo.prFeedbackMaxRounds` caps rounds Qodo triggers, and the decision subject is the command's own.

**No person.** A Qodo-triggered run has no requester: the engine makes no per-actor access decision
and the run records no `requestedById`. The organization budget is still checked.

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
- A pull request another platform run is still working on is skipped rather than queued for a
  person's round — comment `/auto-swe fix` after it parks to start one. Only a Qodo-triggered
  round waits (§8).
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
- **A Qodo round has no per-actor access check and no human-author trust gate.** Nobody is behind
  the trigger, so the checks the human path runs (the author is a linked, active repository member
  with write access) do not exist for it, and it is not equivalent to the human path. Its safety
  rests on: the allowlisted bot account id, the pull request being one the platform opened and not
  a fork, the head commit matching the one Qodo reviewed, the injection screen (a tripwire, not a
  boundary), fencing, and the push gates that are unchanged — never the default or a protected
  branch, fast-forward only, no `.github/workflows` or `.github/actions` edits,
  `github.ciFixNeverPushBranches`.
- Qodo's finding prose derives from the diff Qodo read, so it can carry text an attacker influenced.
  The responder that summarises the round feeds fenced finding text to a model whose output is
  posted on the pull request; the sanitiser on that output is unchanged, and it is the control, not
  the screen.
- Qodo's findings carry no GitHub thread, so a Qodo round never replies on a thread and never
  resolves one; only the summary comment reports it. Qodo marks a finding implemented only after
  it re-reviews, so a finding the round fixed can read as open until then.
- One decision per head: if the nudge arrives before Qodo finishes and Qodo is still working when
  `qodo.prFeedbackWaitSeconds` runs out, that head's decision is spent without a fix and later
  comments of the same review are suppressed as the same subject. A later review of a new head is
  unaffected; `qodo.prFeedbackWaitSeconds` is the lever. The Qodo gather is a single attempt, so a
  transient host or Qodo error also ends that head's decision without a retry.
- The Qodo round's wait for the run that opened the pull request is capped at 15 minutes
  (`qodo.prFeedbackRunWaitSeconds`) and holds one activity slot per head while it lasts. A CI that
  runs longer than the cap still spends that head's one decision. With `ticket-to-merge-qodo`, a
  person who takes longer than the cap to decide on Qodo's findings means the round has already
  given up. The cap plus `qodo.prFeedbackWaitSeconds` and the Qodo reads must fit the gather
  activity's 30-minute limit, which a test enforces on the two maxima.
- A Qodo nudge arriving while a round on the same pull request runs (including its CI watch, up to
  four hours) is suppressed in flight. Qodo's re-review of the platform's own push usually lands
  then, so convergence may need a later Qodo event or an `/auto-swe fix` comment. That command
  reads Qodo only when `qodo.prFeedbackIncludeOnCommand` is on.
- An `/auto-swe fix` round reads Qodo once and never waits, so a review that is still running or
  covers an older commit adds nothing, and the person may need to run the command again. When Qodo
  re-reviews the platform's push, that review can start a Qodo-triggered round, which
  `qodo.prFeedbackMaxRounds` bounds. Qodo's text enters a brief a person triggered, but it passes
  only the injection screen and the fence, which are a tripwire and not a boundary.
- Qodo has no outbound webhooks and is not an inbound-event sender: the GitHub App's deliveries are
  the only trigger, so Qodo's bot must be installed on the repository and its comments must reach
  this App's webhook.
- The bot's numeric id is specific to a GitHub host and is set by an admin; it is not discovered.
  An empty `qodo.prFeedbackBotAccountIds` keeps the trigger inert.
