# Qodo loose ends — decision log

The pull request description carries the design. The decisions below are the lasting record.

## D1 — 2026-10-28 — The run trace records what the agent saw

**Status**: Accepted
**Decision**: On a connection that screens results, the trace row holds the screened result, or the withheld message, and not the server's raw answer. A connection that does not screen keeps recording the raw answer.
**Reason**: The raw answer holds the text the injection screen withheld. Persisting it put that text in the run viewer, which defeated the screen for anyone reading a run.
**Alternatives considered**: Truncating the raw answer, which still persists withheld text. Leaving it as a documented limitation.

## D2 — 2026-10-28 — A Qodo round waits for the run to park

**Status**: Accepted
**Decision**: A Qodo-triggered round waits, up to `qodo.prFeedbackRunWaitSeconds` (default and maximum 900 s, GLOBAL only), for the run that opened the pull request to reach `AWAITING_HUMAN_MERGE` or end. A round a person triggers never waits.
**Reason**: The round refuses to act while the run is working, because a CI fix may push to the same branch. The status stays `AWAITING_CI` from before the pull request opens until CI passes, and Qodo often comments before then. The nudge's fire row is already `STARTED` and nothing updates it, so the engine suppresses every later nudge for that head: a refusal spent the head's one decision. The 15-minute cap lets the wait, Qodo's own wait (up to 10 minutes) and its reads fit the existing 30-minute single-attempt activity, so no activity timeout and no replay behaviour changed.
**Alternatives considered**: Running the round during CI, which lets a CI fix and a Qodo fix push to the same branch at once. A distinct status while `awaitQodoReview` waits, which covers only the template's wait and not the CI wait. Documenting the limitation only. Raising the activity timeout, which needs a replay proof and holds a worker slot for longer.
**Known limits**: A CI that runs longer than the cap still spends the head's decision. With `ticket-to-merge-qodo`, a person who takes longer than the cap on the Qodo decision means the round has already given up.

## D3 — 2026-10-28 — A waiting round follows the head the run left

**Status**: Accepted
**Decision**: After the run parks, the round re-reads the pull request, checks it is still open, on the recorded branch and not from a fork, adopts its current head, and goes on. The existing Qodo read then requires a completed review of that commit.
**Reason**: When CI fails and a fix is pushed, Qodo reviews the new head while the first round is still waiting. Its comments are suppressed as in flight and no later nudge comes, so skipping on a moved head left the new head without any round.
**Alternatives considered**: Skipping when the head moved, which was simpler and lost the new head's findings.

## D4 — 2026-10-28 — The shared input schema is guarded by a test

**Status**: Accepted
**Decision**: A test pins `SWE_INPUT_SCHEMA` to a literal and fails, naming both templates that share it, when it changes. No entry was added to `PREVIOUS_BUILTIN_INPUT_SCHEMAS`.
**Reason**: That map holds historical snapshots, so `ticket-to-merge-qodo`, created with the current schema, has nothing to add today. A test that demanded an entry for every template sharing the schema would force a bogus one. The pin makes the later change loud instead.
