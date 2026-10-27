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
