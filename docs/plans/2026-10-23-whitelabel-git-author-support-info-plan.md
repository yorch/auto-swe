# Whitelabel-lite: configurable git author and support info — Implementation Plan

Spec: docs/specs/2026-10-23-whitelabel-git-author-support-info.md
Workspace: worktree: .claude/worktrees/whitelabel-git-author-support-info
Jira: N/A

## Notes for the implementer

- The worktree has no `node_modules`. Run `yarn install --immutable` before Task 1.
- Inside `.claude/worktrees/`, `yarn lint` checks zero files. Use the explicit `yarn biome check …`
  command from `AGENTS.md` §5 instead.
- Every task commit runs the gates in `AGENTS.md` §5 Quality Gates. Docker image builds run only if a
  Docker daemon is available. If it is not, say so in the hand-off.
- Ask the user before each commit. Do not push without being asked.
- The git track (Tasks 1–7) and the support track (Tasks 8–11) share no files. They can run in
  parallel lanes. Task 12 needs both.

## Progress

- [ ] Task 1: Define the `git.*` settings and the `git` group
- [ ] Task 2: Resolve a git identity for a run
- [ ] Task 3: Give each workspace its resolved identity
- [ ] Task 4: Use the workspace identity and trailer in `commitStaged`
- [ ] Task 5: Use the workspace identity and trailer in shell steps
- [ ] Task 6: Add the trailer to decomposition and trusted-finalize commits
- [ ] Task 7: Prove every attribution mode with real commits in Docker
- [ ] Task 8: Validate support info and pass it to the browser
- [ ] Task 9: Show support info on the login page
- [ ] Task 10: Show support info on the error screens
- [ ] Task 11: Show support info in the sidebar footer
- [ ] Task 12: Wire the deployment files and update the docs

## Tasks

### Task 1: Define the `git.*` settings and the `git` group

**What**: Add `'git'` to `SETTING_GROUPS`. Add `git.authorName`, `git.authorEmail` and
`git.launcherAttribution` to `SETTING_DEFINITIONS` as in the spec table. Use
`overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION']`, `requiredRole: 'LEAD'`,
`runPinned: false` and `restartRequired: false`. Write the email schema as a custom pattern, not
`z.email()`, so the default `auto-swe@localhost` passes. Reuse the existing registry tests as the
model. Confirm that no web file lists the groups by name.
**Files**: `packages/shared/src/config/types.ts`, `packages/shared/src/config/registry.ts`,
`packages/shared/src/config/registry.test.ts`
**Depends on**: none
**Verify**: `yarn vitest run packages/shared/src/config` passes with new tests for spec criteria 1–5.
The settings integrity test passes for the `git.` prefix. `yarn typecheck` passes. `node
scripts/check-doc-drift.mjs` passes.
**Parallelizable**: yes — does not share files with Task 8

### Task 2: Resolve a git identity for a run

**What**: Create `lib/gitIdentity.ts` in the worker. Export `GitIdentity`, `DEFAULT_GIT_IDENTITY`,
`resolveGitIdentity(scope)`, `gitIdentityFlags(identity)` and `withCoAuthorTrailer(message,
identity)`. `resolveGitIdentity` builds the setting context from `teamId`, `Team.orgId`, and the
current run's template and launcher. Add a sibling of `currentRunLauncherId()` in `runLauncher.ts`
that returns `workflowTemplateId` and `launchedById` and applies the same `temporalRunId` check.
Apply the attribution rules from the spec: use the launcher only when `User.emailVerified` is true,
strip control characters and angle brackets from the launcher name, fall back to the configured
identity otherwise, and let a database error throw. `gitIdentityFlags` shell-quotes every value and
emits `user.*`, `author.*` and `committer.*` keys. `withCoAuthorTrailer` appends a blank line and the
trailer to the message text and does nothing when there is no trailer.
**Files**: `packages/worker/src/lib/gitIdentity.ts`, `packages/worker/src/lib/gitIdentity.test.ts`,
`packages/worker/src/lib/runLauncher.ts`, `packages/worker/src/lib/runLauncher.test.ts`
**Depends on**: Task 1
**Verify**: `yarn vitest run packages/worker/src/lib/gitIdentity.test.ts
packages/worker/src/lib/runLauncher.test.ts` passes. The tests cover spec criteria 6–15 and the
`O'Brien` quoting case from criterion 18 at flag level.

### Task 3: Give each workspace its resolved identity

**What**: Add `gitIdentity: GitIdentity` to the `Workspace` interface. In `createWorkspace`, call
`resolveGitIdentity` with `options.teamId` and replace the two literal `git config --global` lines
with `shellQuote`d writes of the six keys. Return the identity on the workspace. Keep the default
identity when no override exists, so existing behavior does not change.
**Files**: `packages/worker/src/activities/workspace.ts`,
`packages/worker/src/activities/workspace.test.ts`
**Depends on**: Task 2
**Verify**: `yarn vitest run packages/worker/src/activities/workspace.test.ts` passes with new tests.
One test checks that the default identity produces the same git config commands as before. One test
checks that a team override and an apostrophe name reach the config commands correctly (criteria 6,
7 and 18). `yarn typecheck` passes for every caller of `createWorkspace`.

### Task 4: Use the workspace identity and trailer in `commitStaged`

**What**: Remove the literal `IDENTITY` constant. Change `commitStaged` so the guarded branch builds
its `-c` flags from `workspace.gitIdentity` through `gitIdentityFlags`, and so both branches pass the
message through `withCoAuthorTrailer`. Widen the `Exec` type to accept an optional `gitIdentity` and
fall back to `DEFAULT_GIT_IDENTITY` for fakes that omit it. The two callers,
`executeImplementation.ts` and `implementerSession.ts`, pass a real workspace and need no change.
**Files**: `packages/worker/src/activities/allowedPaths.ts`,
`packages/worker/src/activities/allowedPaths.test.ts`
**Depends on**: Task 3
**Verify**: `yarn vitest run packages/worker/src/activities/allowedPaths.test.ts` passes. New tests
cover criteria 12, 13 and 17 and the fallback for a fake without an identity.
**Parallelizable**: yes — does not share files with Tasks 5 and 6

### Task 5: Use the workspace identity and trailer in shell steps

**What**: Add an `identity` option to `finalizeScript` and build its `-c` flags and message from it.
Replace the literal at `shellStep.ts:312`. Pass the workspace identity at the call site near line 359.
**Files**: `packages/worker/src/activities/shellStep.ts`,
`packages/worker/src/activities/shellStep.test.ts`
**Depends on**: Task 3
**Verify**: `yarn vitest run packages/worker/src/activities/shellStep.test.ts` passes. A new test
checks that a non-default identity appears in the script and that `user.name='auto-swe'` does not
(criterion 16). Another test checks the trailer in the commit message.
**Parallelizable**: yes — does not share files with Tasks 4 and 6

### Task 6: Add the trailer to decomposition and trusted-finalize commits

**What**: Pass the merge-resolution commit message in `decomposition.ts` through
`withCoAuthorTrailer`. Do the same for the message that `commitTrustedTree` commits in
`agentRunFinalize.ts`. Both sites read the identity from the global git config that Task 3 writes, so
they need only the trailer.
**Files**: `packages/worker/src/activities/decomposition.ts`,
`packages/worker/src/activities/decomposition.test.ts`,
`packages/worker/src/activities/agentRunFinalize.ts`,
`packages/worker/src/activities/agentRunFinalize.test.ts`
**Depends on**: Task 3
**Verify**: `yarn vitest run packages/worker/src/activities/decomposition.test.ts
packages/worker/src/activities/agentRunFinalize.test.ts` passes. New tests check that the trailer
reaches the commit message in `co-author-trailer` mode and is absent in `none` mode.
**Parallelizable**: yes — does not share files with Tasks 4 and 5

### Task 7: Prove every attribution mode with real commits in Docker

**What**: Add `gitIdentity.docker.test.ts` gated on `GIT_IDENTITY_DOCKER_TEST=1`. It creates a real
workspace container on the default executor image, makes one commit in each mode (`none`,
`co-author-trailer`, `author`), and reads author, committer and message back with `git log --format`.
Use the pattern in `agentRunFinalize.docker.test.ts`. Add a step to the `docker-tests` job in
`ci.yml` that sets the flag and names the file on a `yarn test` line, with no `if:` and no
`continue-on-error:`. Also add a repository test that fails when the literal `auto-swe@localhost`
appears in worker source outside `DEFAULT_GIT_IDENTITY` and test files. It proves that no commit site
kept its own copy of the identity.
**Files**: `packages/worker/src/activities/gitIdentity.docker.test.ts`,
`packages/worker/src/lib/gitIdentity.test.ts`, `.github/workflows/ci.yml`
**Depends on**: Task 4, Task 5, Task 6
**Verify**: `GIT_IDENTITY_DOCKER_TEST=1 yarn test packages/worker/src/activities/gitIdentity.docker.test.ts`
passes with a Docker daemon. This also confirms that the `author.name` keys work on the image
(criterion 13). `yarn vitest run packages/worker/src/lib/gitIdentity.test.ts` passes, including the
literal-search test. `node scripts/check-invariants.mjs` passes.

### Task 8: Validate support info and pass it to the browser

**What**: Add `supportInfo()` to `lib/env.ts`. It reads `NEXT_PUBLIC_SUPPORT_URL`,
`NEXT_PUBLIC_SUPPORT_EMAIL` and `NEXT_PUBLIC_SUPPORT_SLACK` and applies the spec rules: `https:` only
for URLs, a plain address for email, up to 80 characters for Slack text. It drops invalid values and
logs one warning. Add the `support` field to the app config type in `lib/config.ts`. Merge it into the
object that `layout.tsx` serializes into `__APP_CONFIG__`. Keep the layout `force-dynamic`.
**Files**: `packages/web/src/lib/env.ts`, `packages/web/src/lib/env.test.ts`,
`packages/web/src/lib/config.ts`, `packages/web/src/app/layout.tsx`
**Depends on**: none
**Verify**: `yarn vitest run packages/web/src/lib/env.test.ts` passes with tests for criteria 20–22
(including `javascript:`, `http:` and an 81-character Slack value). `yarn typecheck` passes.
`node scripts/check-invariants.mjs` passes.
**Parallelizable**: yes — does not share files with Task 1

### Task 9: Show support info on the login page

**What**: Add `hooks/useSupportInfo.ts` and `components/SupportContact.tsx`. The component renders a
link for the URL, a `mailto:` link for the email, and text or a link for Slack. It renders nothing
when no value is set. Render it on the login page below the sign-in card.
**Files**: `packages/web/src/hooks/useSupportInfo.ts`,
`packages/web/src/components/SupportContact.tsx`,
`packages/web/src/components/SupportContact.test.tsx`, `packages/web/src/app/login/page.tsx`
**Depends on**: Task 8
**Verify**: `yarn vitest run packages/web/src/components/SupportContact.test.tsx
packages/web/src/app/login` passes. Tests cover criteria 19 (login page), 21, 22 and 23, including a
check that no element renders when nothing is set. Run the dashboard with `NEXT_PUBLIC_SUPPORT_URL`
set and check the login page in a browser.

### Task 10: Show support info on the error screens

**What**: Render `SupportContact` in `error.tsx` and `not-found.tsx`. In `global-error.tsx`, read
`window.__APP_CONFIG__.support` on a best effort basis and render the block only when it exists. That
screen replaces the root layout, so it cannot count on the config.
**Files**: `packages/web/src/app/error.tsx`, `packages/web/src/app/not-found.tsx`,
`packages/web/src/app/global-error.tsx`, `packages/web/src/app/error.test.tsx`
**Depends on**: Task 9
**Verify**: `yarn vitest run packages/web/src/app` passes with tests for criteria 19 (error and
not-found pages) and 24 (`global-error` with and without the config object, no throw).
**Parallelizable**: yes — does not share files with Task 11

### Task 11: Show support info in the sidebar footer

**What**: Render a small "Support" block at the bottom of the sidebar through `SupportContact`. The
block must not add an empty container or heading when no value is set.
**Files**: `packages/web/src/components/layout/Sidebar.tsx`,
`packages/web/src/components/layout/Sidebar.test.tsx`
**Depends on**: Task 9
**Verify**: `yarn vitest run packages/web/src/components/layout/Sidebar.test.tsx` passes with tests
for criteria 19 (sidebar) and 23. The existing sidebar tests still pass.
**Parallelizable**: yes — does not share files with Task 10

### Task 12: Wire the deployment files and update the docs

**What**: Add the three `NEXT_PUBLIC_SUPPORT_*` variables to the web service in
`docker-compose.app.yml` and `docker-compose.prod.yml`, with empty defaults. Document them as
optional in `.env.example`. Update `docs/deployment.md` where it lists what the web container
receives. In `docs/configuration.md`, document the three `git.*` settings, the scope cascade, the
attribution modes, the privacy effect of the `author` and `co-author-trailer` modes, and the support
variables. Add or extend the `## Limitations` section: no per-agent identity, no pinning, no noreply
addresses, and the best effort support block on `global-error`. Write in present tense with no status
prose.
**Files**: `docker-compose.app.yml`, `docker-compose.prod.yml`, `.env.example`, `docs/deployment.md`,
`docs/configuration.md`
**Depends on**: Task 1, Task 7, Task 10, Task 11
**Verify**: `node scripts/check-doc-drift.mjs`, `node scripts/check-invariants.mjs` and `yarn
env:setup check` pass. `docker compose -f docker-compose.infra.yml -f docker-compose.app.yml config`
shows all three variables on the web service when set in the environment (criterion 25). Then run the
full gate list from `AGENTS.md` §5, including `yarn workspace @auto-swe/site build`, and name each
result in the hand-off.
