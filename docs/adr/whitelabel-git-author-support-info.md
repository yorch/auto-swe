# Decision log: whitelabel git author and support info

## D1 — 2026-10-23 — Task 1: Define the `git.*` settings and the `git` group

**Status**: Accepted
**Decision**: `git.authorEmail` uses a custom pattern, not `z.email()`.
**Reason**: The default `auto-swe@localhost` has no top level domain, so `z.email()` rejects the default itself.
**Alternatives considered**: `z.email()` with a relaxed default. Rejected because it changes today's commit identity.

## D2 — 2026-10-23 — Task 1: Define the `git.*` settings and the `git` group

**Status**: Accepted
**Decision**: `git.authorName` and `git.authorEmail` also reject Unicode format, separator and surrogate characters, and `git.authorName` rejects a blank value.
**Reason**: Bidirectional override characters can spoof how a commit author displays, and a blank name makes git fail every commit in that scope.
**Alternatives considered**: Follow the spec literally (newline, `<` and `>` only). Rejected after both reviewers raised it.

## D3 — 2026-10-23 — Task 1: Define the `git.*` settings and the `git` group

**Status**: Accepted
**Decision**: The web group map in `packages/web/src/lib/settingGroups.ts` is part of Task 1, not Task 8.
**Reason**: Its test iterates `SETTING_GROUPS`, so adding a group breaks the web suite until the map has an entry. The plan assumed no web file named the groups.
**Alternatives considered**: Leave the entry to a later task. Rejected because it commits a failing gate.

## D4 — 2026-10-23 — Task 8: Validate support info and pass it to the browser

**Status**: Accepted
**Decision**: `supportInfo()` trims input, normalizes URLs through `new URL().href`, logs one warning that names the dropped variables, and returns `undefined` when nothing valid is set.
**Reason**: It follows the spec rules and the style of `publicApiUrl()`, and it makes omitting `support` from the app config trivial in the layout.
**Alternatives considered**: Warn once per process, which the reviewers preferred for log noise because the root layout runs on every request. A stricter email pattern. Both are deferred as advisory.

## D5 — 2026-10-23 — Task 2: Resolve a git identity for a run

**Status**: Accepted
**Decision**: The launcher's email is used exactly as stored, or attribution is dropped. It is never sanitised.
**Reason**: Rewriting the address could credit commits to an address nobody verified. The security review rated the first draft, which stripped unsafe characters, as medium.
**Alternatives considered**: Strip unsafe characters from the email. Rejected for the reason above.

## D6 — 2026-10-23 — Task 2: Resolve a git identity for a run

**Status**: Accepted
**Decision**: `resolveGitIdentity` throws when the team row is missing.
**Reason**: A null team would silently resolve a broader scope, against the rule that the platform never commits under a fallback identity. Task 3 adds an explicit null-team path for runs that have no team.
**Alternatives considered**: Treat a missing team like a team with no organization. Rejected because it hides a bad id.

## D7 — 2026-10-23 — Task 2: Resolve a git identity for a run

**Status**: Accepted
**Decision**: `currentRunLaunchContext` is added beside `currentRunLauncherId` instead of changing it.
**Reason**: The credential path keeps its contract and tests. The cost is some duplicated lookup code.
**Alternatives considered**: Make `currentRunLauncherId` a thin wrapper over the new function.

## D8 — 2026-10-23 — Task 3: Give each workspace its resolved identity

**Status**: Accepted
**Decision**: `createWorkspace` writes the six identity keys as one `&&`-joined script, with `--` before each key.
**Reason**: The `git.*` schemas allow a name that starts with `-`, which git can read as a switch. One script also avoids a partial write and four extra container round trips. A mutation run showed that git 2.55 stores such a value even without `--`, so the `--` is defense for other git versions. Structural and mocked tests guard it. The real-git tests only check behavior.
**Alternatives considered**: Six separate `rootExec` calls. Rejected for the partial write.

## D9 — 2026-10-23 — Task 3: Give each workspace its resolved identity

**Status**: Accepted
**Decision**: `createWorkspace` resolves the identity before it creates the container.
**Reason**: A database failure then throws with nothing to clean up, and the activity retries with no fallback identity.
**Alternatives considered**: Resolve inside the `try` block after `docker run`.

## D10 — 2026-10-23 — Task 3: Give each workspace its resolved identity

**Status**: Accepted
**Decision**: `resolveGitIdentity` takes `{ teamId: string | null }`. A null team resolves from the global tier and the run template only.
**Reason**: The eval harness and the standalone gate runners can have no team.
**Alternatives considered**: A separate function for the no-team case.

## D11 — 2026-10-23 — Task 5: Use the workspace identity and trailer in shell steps

**Status**: Accepted
**Decision**: Shell steps resolve the identity with `resolveGitIdentity({ teamId })` before the author command runs, and `finalizeScript` takes a required `identity`.
**Reason**: Shell steps have no `Workspace`. Resolving early keeps a retry safe, because a database failure happens before a non-idempotent command runs. A required parameter means nothing commits under a literal fallback.
**Alternatives considered**: Resolve inside the finalize `try` block, which would turn a database failure into a step failure. An optional parameter with a default.

## D12 — 2026-10-23 — Task 5: Use the workspace identity and trailer in shell steps

**Status**: Accepted
**Decision**: `cloneIntoVolume` also writes the resolved identity into the repo-local git config, in a follow-up commit.
**Reason**: Review of the Task 5 commit missed that the clone still set a literal `auto-swe` identity, so a commit made by the author command ignored the configured author. The literal-search test in Task 7 would also have failed on it.
**Alternatives considered**: Leave the author command's own commits under the literal identity. Rejected because they are platform commits.

## D13 — 2026-10-23 — Task 6: Add the trailer to decomposition and trusted-finalize commits

**Status**: Accepted
**Decision**: The trailer is added to the two `git merge --no-ff -m` commits in `decomposition.ts` as well as the resolver commit.
**Reason**: Criterion 12 covers every platform commit message, and a merge commit is one.
**Alternatives considered**: Only the resolver commit, which leaves clean merges without a trailer.

## D14 — 2026-10-23 — Task 6: Add the trailer to decomposition and trusted-finalize commits

**Status**: Accepted
**Decision**: The Docker fixture in `agentRunFinalize.docker.test.ts` gets an explicit `gitIdentity`.
**Reason**: The fixture is cast with `as unknown as Workspace`, so typecheck cannot see the new required field. The suite is opt-in, so the unit run never executes it. Without the field, `commitTrustedTree` throws a `TypeError` and the `docker-tests` job in CI fails. This was found by reading, and the fixed suite was not run because no Docker daemon was available here.
**Alternatives considered**: Make `withCoAuthorTrailer` tolerate a missing identity. Rejected because it would hide a missing identity at real call sites.

## D15 — 2026-10-23 — Task 7: Prove every attribution mode with real commits in Docker

**Status**: Accepted
**Decision**: One parameterised set of assertions runs twice in `gitIdentity.docker.test.ts`: once against the host's git, ungated, and once in an Alpine container, gated on `GIT_IDENTITY_DOCKER_TEST`. A separate sweep test fails when the literal default identity appears in worker source outside `lib/gitIdentity.ts`.
**Reason**: The host half gives a runnable proof wherever git exists. The Docker half re-proves the `author.*` and `committer.*` config keys on the image's git in CI. No Docker daemon was available while writing it, so the Docker half was checked statically only and CI is its first real run.
**Alternatives considered**: A Docker-only suite, which nobody could run without a daemon. Using the real executor image instead of plain `alpine:3.22` plus `apk add git`, which would catch a git version difference but is heavier.

## D16 — 2026-10-23 — Task 9: Show support info on the login page

**Status**: Accepted
**Decision**: The `mailto:` href is built with `encodeURIComponent` on the local part and the domain, with the `@` kept literal. The plan said `encodeURI`.
**Reason**: `encodeURI` leaves `?`, `&` and `#` alone, and the validator accepts them in an address, so an address such as `a?bcc=x@y` injected a `bcc` header. A test with `new URL` confirmed it.
**Alternatives considered**: Tighten `validEmail` in `env.ts`. Not chosen, to leave Task 8 alone.

## D17 — 2026-10-23 — Task 10: Show support info on the error screens

**Status**: Accepted
**Decision**: `global-error.tsx` carries its own small sanitiser and inline-styled block instead of importing `SupportContact`.
**Reason**: That screen replaces the root layout, so it cannot depend on providers, CSS or the config script, and it must never throw. Its checks are weaker than the server's.
**Alternatives considered**: Share a validator with `env.ts`. Not done, because importing it pulls in `process.env` reads.

## D18 — 2026-10-23 — Task 9: Show support info on the login page

**Status**: Accepted
**Decision**: The support block is an `<address aria-label="Support">`.
**Reason**: Biome rejects `role="group"` on a `div`, and `address` maps to the group role and means contact information.
**Alternatives considered**: A `section` with a heading.

## D19 — 2026-10-23 — Task 9: Show support info on the login page

**Status**: Accepted
**Decision**: The awaiting-approval screen also shows the support contact, in a follow-up commit.
**Reason**: A user waiting for approval is the one most likely to need a contact. The Task 9 review and the spec criteria named only the sign-in screen, so the gap was found by reading the report.
**Alternatives considered**: Leave it to the sign-in screen alone.

## D20 — 2026-10-26 — Review: branch review fixes

**Status**: Accepted
**Decision**: Launcher attribution applies only when the launcher is a member of the repository's owning team. A launcher who reaches the repository only through a shared team gets the configured identity.
**Reason**: The security review showed that a lead's attribution choice would otherwise write a member of another team's email into a repository they only have a share on. The user chose this over a per-user opt-in and over documenting the risk.
**Alternatives considered**: A per-user consent preference, which needs a new column, a migration and a settings control. Documenting the exposure only. Using `isRepoMember`, which includes shared teams and would restore the exposure.

## D21 — 2026-10-26 — Review: branch review fixes

**Status**: Accepted
**Decision**: `git.authorName` is rejected when it has no character outside whitespace and `. , : ; < > " ' \`. The check is defined once in `shared/lib/gitIdentityName` and reused for a launcher's name.
**Reason**: Git refuses to commit under a name made only of those characters (checked on git 2.55), so one valid-looking write would break every commit in a scope. Sharing the check keeps the schema and the launcher fallback from drifting.
**Alternatives considered**: A duplicate regex in the worker. Exporting from `@auto-swe/shared/config`, which the worker's tests mock.

## D22 — 2026-10-26 — Review: branch review fixes

**Status**: Accepted
**Decision**: The support-info warning is logged once per process per distinct message, and a support URL or Slack link with embedded credentials is dropped.
**Reason**: The root layout calls `supportInfo()` on every request, so a mistyped value flooded the log. Credentials in a URL would be shown to every visitor, including on the sign-in screen.
**Alternatives considered**: Warn at boot, which needs an instrumentation hook. A test-only reset export.

## D23 — 2026-10-26 — Review: branch review fixes

**Status**: Accepted
**Decision**: `author` mode depends on git 2.22 or newer, and this is documented as a limitation instead of being enforced.
**Reason**: Older git ignores the `author.*` keys without an error, so the launcher is silently not credited. CI proves only the Alpine image's git. Setting `GIT_AUTHOR_*` variables on each commit would work on older git but would also override the configured identity on every path.
**Alternatives considered**: Set `GIT_AUTHOR_*` environment variables on the guarded commits.

## D24 — 2026-10-27 — Design: where the support contact lives

**Status**: Accepted
**Decision**: The support contact is three optional environment variables on the web container (`NEXT_PUBLIC_SUPPORT_URL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_SUPPORT_SLACK`), read on the server and passed to the browser through `window.__APP_CONFIG__`. It is global.
**Reason**: The web app is a separate process with no database access, and the sign-in page has no signed-in user. A registry-backed value would need an unauthenticated read of settings or a gateway call while rendering the sign-in page. Environment variables need no gateway call, show no flash of missing content, and add no new path that renders operator input as markup. The cost is a restart of the web container to change a value, and no admin form.
**Alternatives considered**: A registry setting read through a new unauthenticated endpoint. A per-team contact, which would also need the registry and a signed-in-only surface.

## D25 — 2026-10-27 — Design: where the git identity is configured

**Status**: Accepted
**Decision**: The git identity is three registry settings in a `git` group that cascade `WORKFLOW_TEMPLATE`, `TEAM`, `ORGANIZATION`, `GLOBAL`, with a team lead able to change them. It is resolved per workspace and is not pinned to a run. There is no per-agent identity and no `CHANNEL` scope.
**Reason**: Agents never run `git commit`. Fixed platform code makes every commit, and several agent personas share one workspace, so an identity on an `Agent` row would add a version bump for a non-behavioral field and would need wiring at commit time. Teams, organizations and templates are the levels at which branch protection, code owners and audit differ. Pinning would need an entry in `pinnedSettings` for a value that does not change how a run is structured.
**Alternatives considered**: An identity on the `Agent` row. A commit trailer that names the agent instead. Pinning the identity at run start, which can be turned on later.

## D26 — 2026-10-27 — Design: launcher attribution defaults and scope

**Status**: Accepted
**Decision**: `git.launcherAttribution` defaults to `none`. The `author` and `co-author-trailer` modes use the launcher's account email and only for a verified address of an owning-team member. The product name, logo, accent color, outbound wording and the `User-Agent` are not configurable.
**Reason**: Both credited modes write a person's email into a repository's history for good, so the default must not do it. The request named support information and the git identity as the whitelabel needs. The rest of the surface the first survey found is cosmetic or a wire identifier that customer integrations depend on, such as `X-AutoSwe-Signature`, the `ats_` token prefix and workflow ids.
**Alternatives considered**: A configurable product name and theme, which was dropped from the scope. GitHub no-reply addresses for the launcher, which exist as a possible later option.
