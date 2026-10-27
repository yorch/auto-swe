# Qodo follow-ups — Implementation Plan

Spec: docs/specs/2026-10-27-qodo-follow-ups.md
Workspace: worktree: .claude/worktrees/qodo-follow-ups
Jira: N/A

## Progress

- [ ] Task 1: Set the Qodo fields from the /mcp page
- [ ] Task 2: Include Qodo findings in an /auto-swe fix round
- [ ] Task 3: Extract the ticket-to-merge builder and define the Qodo template
- [ ] Task 4: Register the Qodo template everywhere a built-in must appear
- [ ] Task 5: Refresh the explorer for the Qodo work

Commits: Task 1 is commit 1. Task 2 is commit 2. Tasks 3 and 4 together are commit 3, because the golden and site checks only pass once both are done. Task 5 is commit 4. Run every quality gate before each commit. Docker builds stay with CI.

## Tasks

### Task 1: Set the Qodo fields from the /mcp page

**What**: Extend `McpConnectionRow.config`, `McpTestResult`, `CreateMcpConnectionBody` and `UpdateMcpConnectionBody` with the Qodo fields. Add the "Qodo integration" and "Screen tool results" checkboxes to the create and edit modals. The Qodo box forces the screen box on and disabled. On edit, send a field only when it differs from the stored value (`'qodo'` or `null`, `true` or `null`). Show the guard-removal warning when the Qodo box is cleared. Show a read-only note when a custom `allowedTools` list is stored. Add a "Qodo" badge to the list. Show the test result's Qodo section (matched count, findings-tool flag, warning) only when the `qodo` object exists. Replace the `docs/qodo.md` statement that the web form hides these fields.
**Files**: `packages/web/src/hooks/useMcpConnections.ts`, `packages/web/src/app/mcp/page.tsx`, `packages/web/src/app/mcp/page.test.tsx`, `docs/qodo.md`
**Depends on**: none
**Verify**: New `page.test.tsx` cases fail first, then pass, for acceptance criteria 1 to 6 of the spec (create body, untouched edit sends nothing, unticking sends `integration: null` with the warning, forced screening box, test-result section present and absent, 400 `QODO_WRITE_TOOLS` in the alert). `yarn vitest run packages/web/src/app/mcp` passes. Then run all quality gates.

### Task 2: Include Qodo findings in an /auto-swe fix round

**What**: Add the setting `qodo.prFeedbackIncludeOnCommand` (boolean, default `false`, group `qodo`, ADMIN, TEAM and ORGANIZATION overrides, not run-pinned). In `prFeedback.ts`, move the brief building of `gatherQodoRound` into one function that both the Qodo path and the command path call. Make that refactor first and keep the existing Qodo tests unchanged. Then add the command step. It runs after the human threads are built, only for the `command` trigger, when `qodo.enabled` and the new setting are on and the PR origin is the platform's. It reads Qodo once with no wait, appends the findings after the last human label, adds the dropped counters, and rechecks the head. Any other outcome keeps the human threads and records one `pr_feedback.qodo_command_skipped` event with a fixed reason. Update `docs/pr-feedback.md` (§8 and Limitations) and `docs/qodo.md`, and remove the statement that `/auto-swe fix` does not consult Qodo.
**Files**: `packages/shared/src/config/registry.ts`, `packages/shared/src/config/registry.test.ts`, `packages/worker/src/activities/prFeedback.ts`, `packages/worker/src/activities/prFeedback.gather.test.ts`, `docs/pr-feedback.md`, `docs/qodo.md`
**Depends on**: Task 1 (shared edits to `docs/qodo.md`)
**Verify**: `prFeedback.qodo.gather.test.ts` passes with no edits. New command-path tests cover acceptance criteria 7 to 11 and 9 (default off makes no Qodo call). `registry.test.ts` covers criterion 12. Remove each guard in a scratch copy (setting check, origin check, head recheck) and confirm a test fails. Run all quality gates, including `yarn docs:check`.

### Task 3: Extract the ticket-to-merge builder and define the Qodo template

**What**: In `ticketToMerge.ts`, move the node construction into one exported builder. The builder takes the node that the CI loop hands off to when CI passes. `TICKET_TO_MERGE_SPEC` calls it with `setAwaitingHumanMerge`, so its output does not change. Add `ticketToMergeQodo.ts` with `TICKET_TO_MERGE_QODO_SPEC`. It calls the builder with `qodoReview`, adds the `qodoReview()` helper nodes (next: `setAwaitingHumanMerge`, blocked: a `humanDecision` node) and the decision's terminate nodes. Its description states the wait cost when Qodo is on and no bot is installed. Do not register it yet.
**Files**: `packages/shared/src/workflow/templates/ticketToMerge.ts`, `packages/shared/src/workflow/templates/ticketToMergeQodo.ts`, `packages/shared/src/workflow/templates/ticketToMergeQodo.test.ts`
**Depends on**: none
**Verify**: The existing `golden.test.ts` and `ticketToMerge.ciwait.test.ts` pass unchanged (the old spec is byte-identical). The new test fails first, then passes: the spec passes `validateSpec`, the CI loop's pass edge reaches `qodoReview`, the gate routes `blocking == true` to the decision, and a non-blocking result reaches the merge wait (acceptance criterion 14). `yarn vitest run packages/shared/src/workflow/templates` passes.
**Parallelizable**: yes — shares no files with Tasks 1 and 2

### Task 4: Register the Qodo template everywhere a built-in must appear

**What**: Add the template to `BUILTIN_TEMPLATES` and to the `builtinTemplates.ts` export barrel. Add `__golden__/ticket-to-merge-qodo.json` (the built spec without presentation fields, as `golden.test.ts` defines it). Add the `useCases.mjs` entry (group `engineering`, maturity `composed`, source path, title, summary). Regenerate `docs/workflow-inventory.md` with `yarn docs:inventory`. Add one paragraph to `docs/qodo.md` and one line to `docs/workflow-nodes.md` that name the template.
**Files**: `packages/shared/src/workflow/templates/index.ts`, `packages/shared/src/workflow/builtinTemplates.ts`, `packages/shared/src/workflow/templates/__golden__/ticket-to-merge-qodo.json`, `site/scripts/useCases.mjs`, `docs/workflow-inventory.md`, `docs/qodo.md`, `docs/workflow-nodes.md`
**Depends on**: Task 3
**Verify**: `golden.test.ts`, `inventory.test.ts` and `validateSpec.test.ts` pass with the new template listed. `yarn workspace @auto-swe/site build` passes (acceptance criterion 15). Run all quality gates. The commit for Tasks 3 and 4 is made only now.

### Task 5: Refresh the explorer for the Qodo work

**What**: Read the Qodo source (the read-only connection and screening, the `qodo_findings` trigger and the command inclusion, the `awaitQodoReview` step, the new template). Update the matching cards and shell prose in `analysis.json` and `platform-explorer.html`, with unique source anchors as evidence and no copied documentation claims. Do not run `explorer:review`. Do not change `reviewedCommit`.
**Files**: `site/src/explorer/analysis.json`, `site/src/explorer/platform-explorer.html`
**Depends on**: Tasks 1 to 4 (the cards describe committed behaviour)
**Verify**: `yarn workspace @auto-swe/site sync` and `yarn vitest run site/scripts` pass. `yarn workspace @auto-swe/site build` passes. The explorer still shows the "narrative needs review" warning, and `git diff` shows `reviewedCommit` unchanged (acceptance criterion 16). Run all quality gates.
