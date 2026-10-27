# Jira filter polling automation — Implementation Plan

Spec: docs/specs/2026-10-27-jira-filter-polling.md
Workspace: worktree: /Users/jorge.barnaby/orca/workspaces/auto-swe/poll-jira (branch jorge-barnaby/poll-jira)
Jira: N/A

Every commit passes the full gate list in `CLAUDE.md` §5 Quality Gates. In this worktree, run `yarn biome check` with explicit directories, because `yarn lint` checks zero files here. The worktree has no `node_modules` yet, so Task 1 starts with `yarn install --immutable`.

## Progress

- [ ] Task 1: Add `searchIssues` to the Jira provider
- [ ] Task 2: Add the `jira.filter.new_issue` source and its settings
- [ ] Task 3: Add the migration and poll-state models
- [ ] Task 4: Poll a filter and record the baseline
- [ ] Task 5: Start a run for each new matching issue
- [ ] Task 6: Run the poller on a schedule in the gateway
- [ ] Task 7: Apply the save-time rules
- [ ] Task 8: Show the JQL and poll status in the dashboard
- [ ] Task 9: Document the source

## Tasks

### Task 1: Add `searchIssues` to the Jira provider

**What**: Add `searchIssues(jql, opts)` to `IssueTrackerProvider`. Implement it in `JiraProvider` with `POST /rest/api/3/search/jql` through `AtlassianClient.post`. Request only `summary` and `project`. Page with `nextPageToken` and stop at a caller-given match cap. Return `{ issues: { key, summary, projectKey }[], truncated: boolean }`. The GitHub Issues and Linear providers throw a fixed `not supported` error. First check the real response shape against a live Jira, because the Atlassian MCP did not connect during design. If the shape differs from the spec's assumption, fix the spec's Risks section in the same commit.
**Files**: `packages/shared/src/lib/integrations/issueTracker.ts`, `packages/shared/src/lib/integrations/types.ts`, `packages/shared/src/lib/integrations/providers/jira.ts` (plus its test, and the other providers' stubs)
**Depends on**: none
**Verify**: `yarn test packages/shared/src/lib/integrations` passes, with new cases for paging, the match cap, a `400`, a `429` and a redirect refusal. A manual `curl` or script run against your real Jira shows the response includes the key and `project.key` for the requested fields. Record the result in the commit body.
**Parallelizable**: yes — does not share files with Task 2

### Task 2: Add the `jira.filter.new_issue` source and its settings

**What**: Create `jiraFilterNewIssueSource` as specified in the spec's Source descriptor table. Register it in `EVENT_SOURCES`. Add `kind: 'text'` to `FilterField`. Add the three registry settings: `workflow.jiraPollAutomationsEnabled`, `workflow.jiraPollProjectKeys` and `workflow.jiraPollIntervalSeconds`. The kill-switch setting is the source's `killSwitch`. Build the description from the issue's plain text, capped at 4,000 characters.
**Files**: `packages/shared/src/automation/sources/jiraFilter.ts` (new, with test), `packages/shared/src/automation/index.ts`, `packages/shared/src/automation/types.ts`, `packages/shared/src/config/registry.ts`
**Depends on**: none
**Verify**: `yarn test packages/shared/src/automation packages/shared/src/config` passes. New tests show the filter schema bounds (1–2000 characters), the subject, scope and dedupe keys, `run()` giving the real Jira key with `ticketIsSynthetic: false`, a `jirapoll-` workflow id, and `templateCompatible` for the `ticket-to-merge` input schema. `yarn typecheck` passes.
**Parallelizable**: yes — does not share files with Task 1

### Task 3: Add the migration and poll-state models

**What**: Read the `prisma-pgvector-hnsw` skill first. Add the Prisma models `AutomationPollState` and `AutomationSeenIssue` as in the spec's Data model section. Write one migration that replaces `automations_source_known` with the new source, adds the `automations_jira_filter_filters` check using `COALESCE(..., false)`, and creates both tables with cascade deletes. Extend `engine.pg.test.ts` for the constraints.
**Files**: `packages/shared/src/prisma/schema.prisma`, `packages/shared/src/prisma/migrations/<timestamp>_jira_filter_source/migration.sql`, `packages/gateway/src/lib/automations/engine.pg.test.ts`
**Depends on**: Task 2
**Verify**: With Postgres up, `yarn db:deploy && yarn db:generate` succeeds on a fresh database, and `prisma migrate diff` shows no drift. `yarn test packages/gateway/src/lib/automations/engine.pg.test.ts` with its CI flag set passes new cases: a row with a missing or empty `jql` is refused, a valid row is accepted, and deleting the automation removes its poll state and seen keys.

### Task 4: Poll a filter and record the baseline

**What**: Create `jiraPoller.ts` with `pollAutomation()`. It claims the lease with `updateMany` and a null-or-expired `leaseUntil` condition, skips an inactive repository, a retired installation or a team whose kill switch is off, resolves the allowlist, searches with the wrapped JQL, drops results outside the allowlist, and enforces the 1,000-match cap. When `baselinedAt` is empty it stores every key as seen, sets `baselinedAt`, and starts nothing. It always releases the lease and stores `lastPolledAt` and a fixed-code `lastError`. Add `jiraPoller.pg.test.ts` for the lease and add it to the `ci.yml` step that runs `engine.pg.test.ts`'s flag.
**Files**: `packages/gateway/src/lib/automations/jiraPoller.ts` (new, with test), `packages/gateway/src/lib/automations/jiraPoller.pg.test.ts` (new), `.github/workflows/ci.yml`
**Depends on**: Task 1, Task 3
**Verify**: `yarn test packages/gateway/src/lib/automations/jiraPoller.test.ts` passes cases for the baseline, the allowlist result filter, an empty allowlist, `FILTER_TOO_BROAD`, the kill switch making no Jira call, and `lastError` holding only fixed codes. The `.pg` suite passes with two concurrent claimers and only one winning. `yarn invariants:check` passes, which proves the new `.pg` suite is wired into CI.

### Task 5: Start a run for each new matching issue

**What**: Extend `pollAutomation()` for a baselined automation. Compute the unseen keys and take at most 50, oldest first. For each, fetch the issue text through `fetchIssue`, build the facts, and call `decideAndStart` with `retry: { kind: 'redelivery' }`, the repository's connection and the repository owner key. Store the key as seen after any outcome except `FAILED_TO_START`. A `duplicate` answer also stores the key as seen.
**Files**: `packages/gateway/src/lib/automations/jiraPoller.ts`, `packages/gateway/src/lib/automations/jiraPoller.test.ts`, `packages/gateway/src/lib/automations/jiraPoller.pg.test.ts`
**Depends on**: Task 4, Task 2
**Verify**: Unit tests show one `decideAndStart` call per unseen key, no call for a seen key, the 50-key bound, a failed start leaving the key unseen, and limit-suppressed decisions storing the key as seen. The `.pg` suite shows a second poll over the same keys starts no second run, using the real engine and a fake Temporal client.

### Task 6: Run the poller on a schedule in the gateway

**What**: Add a gateway plugin that runs a self-rescheduling `setTimeout` chain. Each tick reads `workflow.jiraPollIntervalSeconds`, lists enabled `jira.filter.new_issue` automations, and calls `pollAutomation()` for each in turn. It starts only when the tracker provider is Jira and fully configured. It stops on server close and logs failures without throwing. Register it in `index.ts`.
**Files**: `packages/gateway/src/plugins/jiraPoller.ts` (new, with test), `packages/gateway/src/index.ts`
**Depends on**: Task 5
**Verify**: `yarn test packages/gateway/src/plugins/jiraPoller.test.ts` passes with fake timers. It shows the next tick about one interval after the last one ends, no start for a non-Jira provider, one automation's failure not stopping the others, and the chain stopping on close. Boot the gateway locally with a configured Jira and an enabled automation, and confirm one poll log line per interval.

### Task 7: Apply the save-time rules

**What**: In the create and update routes, for this source only: refuse a save when the allowlist is empty or the tracker is not configured. When the automation is saved enabled, validate the JQL with a one-result search through the same wrapper. Return `400 JQL_REJECTED` for a Jira `400` and `502 TRACKER_UNAVAILABLE` for a network or auth failure, and store nothing. Clear `baselinedAt` when the JQL changes or the automation goes from off to on.
**Files**: `packages/gateway/src/routes/automations.ts`, `packages/gateway/src/routes/automations.test.ts`
**Depends on**: Task 1, Task 2, Task 3
**Verify**: `yarn test packages/gateway/src/routes/automations` passes new route tests for the empty allowlist, `JQL_REJECTED`, `TRACKER_UNAVAILABLE`, nothing stored on either failure, and `baselinedAt` cleared on a JQL change and on re-enable but not on an unrelated edit.

### Task 8: Show the JQL and poll status in the dashboard

**What**: Add `lastPolledAt` and `lastError` for this source to the existing automation list response, with no new route. Render `kind: 'text'` fields as a textarea in the event-automation editor. Show the poll status and its error code in the automation panel.
**Files**: `packages/gateway/src/routes/automations.ts`, `packages/web/src/components/automations/EventAutomationEditor.tsx`, `packages/web/src/components/automations/EventAutomationsPanel.tsx` (plus their tests)
**Depends on**: Task 3, Task 7
**Verify**: `yarn test packages/gateway/src/routes/automations packages/web/src/components/automations` passes. A gateway test shows the status fields on the list response for this source only. A web test shows the textarea, the saved JQL round trip, and the status line. Start `yarn dev:web`, create an automation in the dashboard, and see the status update after one poll.

### Task 9: Document the source

**What**: In `docs/automations.md`, add the source to the event-sources table, add a `§3.2 Jira filter` section, fix the source count in Limitations, and add this source's limitations. Name the three settings in `docs/configuration.md` where settings are listed. Add the allowlist and the double-start warning with the Jira transition webhook. Write in the present tense with no status prose.
**Files**: `docs/automations.md`, `docs/configuration.md`
**Depends on**: Task 8
**Verify**: `yarn docs:check` passes, including the setting-key and countable-claim checks. `yarn workspace @auto-swe/site build` passes. Then run the full gate list from `CLAUDE.md` §5, including the three Docker image builds, and record each result.
