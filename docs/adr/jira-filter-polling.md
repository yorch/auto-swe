# Jira filter polling — decision log

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
