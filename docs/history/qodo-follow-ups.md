# Qodo follow-ups — decision log

> Frozen decision log for finished work. The code and the living docs in [`docs/`](../README.md) are authoritative wherever they diverge.

The spec and plan for this work were removed before merge. The pull request description carries the design and the task breakdown, and the decisions below are the lasting record.

## D1 — 2026-10-27 — Task 1: Set the Qodo fields from the /mcp page

**Status**: Accepted
**Decision**: The form edits the Qodo marker and result screening only. It never edits `allowedTools`, and it shows a stored custom list as a read-only count.
**Reason**: A marked connection with no stored list uses the worker's current read list. A list copied by the form would go stale when that list changes.
**Alternatives considered**: Pre-filling the read list in the form. Rejected for the staleness above.

## D2 — 2026-10-27 — Task 2: Include Qodo findings in an /auto-swe fix round

**Status**: Accepted
**Decision**: A command round reads Qodo once and never waits. Any outcome that adds nothing, including a host error, leaves the round on the human threads and records one fixed-reason event. The round counts toward `maxRounds` only, and the human threads and the findings share one brief bound.
**Reason**: A person asked for the round, so a missing or unfinished review must not lose their threads. A wait would need the 30-minute single-attempt activity group chosen from workflow input, a larger change with a replay-determinism burden for little gain, because the Qodo-triggered path still converges later.
**Alternatives considered**: Waiting up to `qodo.prFeedbackWaitSeconds`. Counting command rounds toward the Qodo round cap. Both rejected.

## D3 — 2026-10-27 — Task 3: The Qodo template

**Status**: Accepted
**Decision**: In `ticket-to-merge-qodo`, a person's Stop ends the run FAILED, and no answer within 24 hours ends it TIMED_OUT. Neither end stores a lesson. Node construction is shared with `ticket-to-merge` through `ticketToMergeNodes(passed)`.
**Reason**: FAILED for an explicit stop follows `security-triage`; TIMED_OUT for silence follows the merge wait. A lesson needs a new `LessonOutcome` in shared types and the lesson builder, a cross-package change that is out of scope, and the existing outcomes describe the run's own review or CI. Sharing the builder keeps the two templates from drifting, and the unchanged golden proves `ticket-to-merge` did not move.
**Alternatives considered**: Ending a timeout FAILED. Adding a `QODO_STOPPED` lesson outcome. Copying about 100 lines of nodes.
**Left as it is**: The compatibility barrel `builtinTemplates.ts` is not extended, because it already omits newer specs and nothing imports the new one through it. If `SWE_INPUT_SCHEMA` ever changes, `PREVIOUS_BUILTIN_INPUT_SCHEMAS` in `syncBuiltins.ts` needs an entry for `ticket-to-merge-qodo` beside `ticket-to-merge`, or only the old template migrates.

## D4 — 2026-10-27 — Task 4: What guards the new template

**Status**: Accepted
**Decision**: The new template's golden is generated from its code, so it records the wiring and does not prove it. The guards are explicit routing assertions, `validateSpec`, and tests that run the template's Qodo-to-merge tail through the interpreter with fake step results.
**Reason**: `golden.test.ts` requires a golden for every built-in. For a new template it can only detect later change.

## D5 — 2026-10-27 — Task 5: The explorer

**Status**: Accepted
**Decision**: The Qodo cards are added without running the review attestation, and `reviewedCommit` is unchanged. The "narrative needs review" warning stays.
**Reason**: The warning covers every platform commit since the last real review, not only the Qodo work, and the attestation vouches for all of it. Only the Qodo cards were reviewed here.

## D6 — 2026-10-27 — Review: Qodo text is one line, and clearing the marker keeps screening

**Status**: Accepted
**Decision**: A Qodo finding's text is joined onto one line before it is briefed. On the `/mcp` page, clearing the Qodo marker on a marked connection leaves "Screen tool results" ticked and editable, so dropping screening takes a second, deliberate click.
**Reason**: A command round puts Qodo findings and people's thread blocks in one fence. A finding that echoes diff text with line breaks could start a line that looks like a person's `[Tn] path:line` and `— @login:` block. A marked connection is always screened, so an unmarked-but-screened result is the least surprising default.
**Alternatives considered**: Labelling the Qodo section separately in the fence. Rejected as a larger change to the brief's shape. Leaving the screening box to fall back to its stored value, which dropped both guards in one click.
