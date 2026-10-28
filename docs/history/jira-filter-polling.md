# Jira filter polling — decision log

> Frozen decision log for finished work. The code and the living docs in [`docs/`](../README.md) are authoritative wherever they diverge.

## D1 — 2026-10-27 — Task 1: Add `searchIssues` to the Jira provider

**Status**: Accepted
**Decision**: `searchIssues` reports `truncated: true` when it stops early because of a page limit (100 pages) or a repeated page token, as well as when more than `maxResults` issues matched.
**Reason**: Pages whose rows are all unusable never grow the result, so the match cap alone cannot end a search against a Jira that keeps returning tokens. The caller treats `truncated` as "filter too broad" and acts on nothing, so an unknown result fails closed.
**Alternatives considered**: Throwing on a repeated token. Rejected: a caller would then need a second failure path for what is, to it, the same outcome.

## D2 — 2026-10-27 — Task 2: Add the `jira.filter.new_issue` source and its settings

**Status**: Accepted
**Decision**: The source's `defaultFilters` holds an empty `jql`, which its own schema refuses.
**Reason**: The dashboard prefills a new automation from `defaultFilters`. A realistic placeholder saved by mistake would poll a query nobody chose. An empty value forces the author to write one, and the save is refused with a 400 until they do.
**Alternatives considered**: An example query such as `project = PROJ`. Rejected for the reason above.

## D3 — 2026-10-27 — Task 4: Poll a filter and record the baseline

**Status**: Accepted
**Decision**: A poll releases its lease with a compare-and-set on the lease value it took, and the search has no deadline of its own.
**Reason**: A poll that outlives its five-minute lease must not erase the replica that took over. Once Task 5 starts runs, a second replica polling the same automation is still safe, because the ledger's unique dedupe key answers `duplicate`. The Jira client already bounds each request, so a deadline would add a second timeout that cannot cancel the request it races.
**Alternatives considered**: `Promise.race` against a deadline. Rejected: it leaves the request running. Renewing the lease while polling. Rejected as more machinery than the risk justifies.

## D4 — 2026-10-27 — Task 4: Poll a filter and record the baseline

**Status**: Accepted
**Decision**: JQL whose parentheses are unbalanced outside string literals is refused as `INVALID_FILTERS`, and a trailing `ORDER BY` is dropped before the query is wrapped.
**Reason**: The wrapper `project in (…) AND (<jql>)` narrows the search only if the JQL cannot close its parenthesis early. Unbalanced JQL could read outside the allowed projects, and its error code would tell its author what exists there. A trailing `ORDER BY` is common in copied and saved filters and Jira refuses it inside parentheses.
**Alternatives considered**: Relying only on the result filter. Rejected: it hides the content but not the error-code signal.

## D5 — 2026-10-27 — Task 5: Start a run for each new matching issue

**Status**: Accepted
**Decision**: An issue that cannot be read, or whose start failed or was ignored, ends the poll with a fixed error code and stays unseen. It is not skipped.
**Reason**: Issues are taken in key order and a skipped issue stays first in line, so skipping 50 unreadable issues would starve every newer one without a trace. Stopping makes the stall visible in `lastError` on every poll.
**Alternatives considered**: Skipping and counting skips against the cap, which still stalls once enough are stuck. Marking an unreadable issue seen, which loses an issue when the cause was a passing Jira error.

## D6 — 2026-10-27 — Task 5: Start a run for each new matching issue

**Status**: Accepted
**Decision**: The run's description puts the key and the link first and the ticket text inside an untrusted `<ticket>` block, escaping any closing tag in the text.
**Reason**: Anyone with write access to an allowed Jira project can change what the agent reads. The sibling GitHub issue source does not fence its text, but the people who can write to a Jira project are a wider group than those who can write to a repository.
**Alternatives considered**: No fence, as for issue labels. Rejected as the exposure is larger here.

## D7 — 2026-10-27 — Task 6: Run the poller on a schedule in the gateway

**Status**: Accepted
**Decision**: A tick abandons one automation's poll after four minutes, stops starting automations after ten, and lists them least recently polled first. A closing server waits for the running tick for up to thirty seconds.
**Reason**: The tick is serial and every tenant shares one Jira credential, so one slow tenant could hold the loop and leave late-created tenants behind it every time. Each Jira request is already bounded, which makes a hang unlikely, but a loop with no bound of its own would fail silently. Fastify closes the database and Temporal plugins after this plugin's hook, so a tick left running would use them closed.
**Alternatives considered**: Polling in parallel. Rejected: it multiplies the load on the shared Jira credential. Cancelling the abandoned poll. Rejected: the Jira client cannot be cancelled mid-request, and the lease's compare-and-set already protects what the left-behind poll does later.

## D8 — 2026-10-27 — Task 7: Check a Jira filter automation when it is saved

**Status**: Accepted (its baseline rule is superseded by D10)
**Decision**: A poll baseline is bound to the JQL it was taken for (`baseline_jql`). A poll whose JQL differs takes a new baseline. The route resets the baseline only when an automation is switched back on.
**Reason**: Resetting `baselinedAt` in the route, before or after the write, races with a poll: one that lands between the two writes, or one already running, baselines the old query and leaves the new query marked as baselined, which starts a run for everything the new query already matched. Comparing the stored JQL makes the order of the writes irrelevant. A reset on switch-on is safe because an automation that is off is not polled.
**Alternatives considered**: Doing the write and the reset in one transaction. Rejected: it closes the gap between them but not a poll already running.

## D9 — 2026-10-27 — Task 7: Check a Jira filter automation when it is saved

**Status**: Accepted
**Decision**: The save-time Jira check runs without retries, is skipped while the team's polling switch is off, and sits behind a 20 a minute per-user limit on the create and change routes.
**Reason**: The check spends the platform's single Jira credential on a request from one tenant's lead, so it must fail fast, honour the operator's switch, and not be loopable.
**Alternatives considered**: Limiting only Jira sources. Rejected: the limit is per route, and 20 saves a minute is far above what a person makes.

## D10 — 2026-10-27 — Branch review: what a baseline is bound to

**Status**: Accepted (supersedes the baseline rule of D8)
**Decision**: A baseline is bound to the query as Jira is asked it: the JQL narrowed to the allowed projects, with the projects sorted. A poll whose narrowed query differs takes a new baseline. An automation that is skipped because polling is switched off, or its repository is inactive or retired, records the reason and forgets its baseline, and so does one whose allowlist is empty.
**Reason**: D8 bound the baseline to the JQL alone. An admin adding a project to the allowlist changes what the query returns without changing the JQL, so every old issue in the added project would start a run. A period in which an automation is not polled has the same effect on resume. Binding the baseline to the narrowed query, and dropping it while not polling, keeps the rule that a broad filter never launches a backlog. A trailing `ORDER BY` and the order of the allowlist do not change the narrowed query, so they do not re-baseline.
**Alternatives considered**: Clearing every baseline when an admin changes a setting. Rejected: there is no hook on a registry write, and the poller already reads both settings each poll.

## D11 — 2026-10-27 — Branch review: a poll acts on the automation as it is now

**Status**: Accepted
**Decision**: Before polling an automation, the tick reads it again and skips it if it is gone or off. A poll that fails or is abandoned notes an attempt, so it does not stay first in line. An issue found to have moved is marked seen.
**Reason**: A tick can run for ten minutes after it listed its automations, so an automation disabled meanwhile would still start up to 50 runs. A failing automation never updated its place in the order, so it came first every tick. A moved issue left unseen held a place in the window of 50 on every poll and hid newer issues without a trace.
**Alternatives considered**: Checking `enabled` inside the engine. Rejected: only the poller reads an automation long after it listed it.
