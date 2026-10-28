# Multi-stack support — assessment and progress tracker

This file is a working tracker, deliberately outside `docs/` (the living docs forbid status
prose, see AGENTS.md §5). Once an item ships, its behaviour is documented in the living doc that
owns it (`docs/repositories.md`, `docs/deployment.md`) and the item is ticked here. Delete this
file when every item is closed or dropped.

Legend: `[ ]` open · `[~]` in progress · `[x]` done · `[-]` dropped

## Summary

Node/TypeScript works end to end. JVM and Python have curated executor images and stack-agnostic
plumbing, but defaults, dependency access and guardrails assume Node. Go is detected but has no
image. Stack support is per-repo and admin-configured (`executorImage` + `gateCommands`); nothing
resolves it from the detected stack at run time.

| Stack | Image | Gate defaults | Test loop | Deps via registry | Scanner/skills fit |
|---|---|---|---|---|---|
| Node/TS | Curated | Work if repo defines scripts | Good | Proxy | Good |
| Python | Curated (`uv`) | Need `gateCommands` | Needs `runTests` | Direct egress only | Partial |
| Java/Kotlin | Curated (Temurin JDK, Maven) | Need `gateCommands` | Needs `runTests` | Direct egress only | Weak |
| Go | None | Need `gateCommands` | Needs `runTests` | Direct egress only | Weak |
| Rust/.NET/Ruby | None | Need `gateCommands` | Needs `runTests` | Direct egress only | Weak |

## Work items

### High

- [x] **H1. Built-in gates are all `yarn`.** *Done across phases 1–3: non-Node roots, npm and pnpm, and (phase 3) the `packageManager` pin and Yarn flavour. Yarn Classic has the built-ins minus `runVulnScan` by design: `yarn audit` posts to a hard-coded public host, so it can neither use the proxy nor stay private.*
  Original gap: the built-in gate defaults were `yarn build|lint|test|typecheck` and `yarn npm audit`. Non-Node repos with no `gateCommands`
  exit 127 on every gate; `yarn npm audit` is Berry-only so it also breaks npm, pnpm and Yarn 1.
  Fix: stack-keyed defaults resolved from the detected stack, beneath step config and repo
  `gateCommands`.
- [~] **H2. Default workspace image is `node:24-alpine`.** *Mechanism done (phase 3): `WORKSPACE_IMAGE_PYTHON|JVM|GO` map a detected stack to a deployer-chosen image, beneath `executorImage`, and the probe tests it. Still open: nothing publishes the curated images, so a deployer builds and hosts their own.*
  Node image whatever its stack. Fix: resolve a curated image from the detected stack as a
  fallback beneath `executorImage`. (Needs a published image reference per stack; open design
  question below.)
- [x] **H3. Stack detection is advisory only.** *Gates, the test loop and the image now consume it (phases 1–3). Original gap: detection was read by the repo form alone.*
  Fix: H1 and H2 consume it at run time.

### Medium

- [~] **M4. Test-command detection reads only the root `package.json`.** *Done for a repo whose only stack component is a subdirectory (phase 3): the command runs there and reads that directory's `package.json`. Still open: several components with no root signal resolve as unconfigured, and a polyglot root serves only its Node side.*
  (`executeImplementation.ts`, `implementerSession.ts`, `utils.ts#detectTestCommand`.)
  Fix: `gateCommands.runTests` → detected-stack suggestion → `package.json` guess; honour
  component subdirectories in a monorepo.
- [ ] M5. Dependency installs are npm-only (no PyPI / Maven / Go module proxy or credentialed path).
- [~] M6. Go image added in phase 2 (`defaults/Dockerfile.go`, `stack` input, gateway enum). None for
  Rust/.NET/Ruby.
- [x] M7. Dataset cases ran on `node:24-alpine` whatever their stack. A case now names a `stack`
  (nullable `eval_cases.stack`, API-only) that maps to a digest-pinned base; null stays on the
  original image so stored scores do not rebase. (`gate` scorers already used the repo's image.)
- [x] M8. `BUILTIN_SHELL_IMAGES` had no JVM or Go images; added `eclipse-temurin:21-jdk-alpine` and
  `golang:1.26-alpine`.
- [x] M9. Built-in skills assumed TypeScript/Node (`testFirst`, `noNewDependencies`); made
  stack-neutral in phase 2. `minimalSurfaceArea` was already hedged per language.
- [x] M10. Built-in `CODE_SECURITY` patterns covered JS/Python only; five patterns added (Java and Go
  exec, unsafe deserialization, SQL built at the call, weak hash). Original gap: JS/Python only (no `Runtime.exec`,
  `ObjectInputStream`, SQL concatenation, Go `InsecureSkipVerify`, `crypto/md5`).

- [x] M14. `runVulnScan` could not work behind the registry proxy; the proxy now relays the bulk
  advisory query (npm, pnpm 10.34.7 and Yarn 4.18.1 each exercised against the proxy). Original gap: it cannot work behind the registry proxy: it 404s audit endpoints, so
  `npm audit`/`pnpm audit`/`yarn npm audit` all fail in a wired workspace. Needs either a proxied
  advisory endpoint or a registry-free scanner default.

### Low

- [x] L11. Doc drift: `deployment.md` and the shell allowlist comments justify `node:24-alpine` as
  the only yarn-bearing image; `defaults/Dockerfile.node` now installs Corepack on Node 26.
- [x] L12. Docker-gated `executorImages.docker.test.ts` builds all four curated images and checks the
  contract and toolchain; Go also runs its real gate commands. (Python/JVM gates need a package
  index, so they are not run.)
- [ ] L13. Detection suggestions are conservative: root manifest only; no build/lint/typecheck
  suggestions outside Node.

## Design for H1–H3 and M4

Resolution order, most specific first, for each gate command:

1. gate step `command`
2. repo `gateCommands[gate]`
3. **new:** stack default for the repo's primary detected stack (`Connection.detectedStack.primary`)
4. today's built-in (`yarn …`), kept as the final fallback so an undetected repo behaves exactly as
   before

The stack defaults live in one table in `@auto-swe/shared` next to `detectStack`, so the form
suggestion and the run-time fallback cannot disagree. A stack default is only offered where the
ecosystem names the command unambiguously; a gate with no unambiguous default for a stack resolves
to `null` and the existing `noCommandResult` path reports it (a failure, never a silent pass).

For Node, the package manager is inferred from the lockfile at detection time and stored with the
detection, so `yarn …` is not forced on an npm or pnpm repo; the audit command is per package
manager.

Test command (M4): same chain — `gateCommands.runTests`, then the stack default, then the
`package.json` guess — so the TDD loop and the `runTests` gate always run the same command.

### Open questions

- H2: which image reference does a stack resolve to? The curated Dockerfiles are built per
  repository by `build-executor.yml`; there is no published, shared tag. Until one exists, H2 stays
  open and H1/M4 ship on their own (a stack default is useful with any image that has the
  toolchain).
- Detection runs on a weekly scan; a freshly onboarded repo has no `detectedStack` until then.
  Is a detect-on-onboard hook in scope?

## Review log

Self-review of the first change (no sub-agent tooling was available; this was a deliberate
hostile read of the diff by the author, not an independent review).

| # | Challenge | Outcome |
|---|---|---|
| 1 | Could a stored `detectedStack` row inject a gate command around the admin-gated `gateCommands`? | No: run-time commands come from a static table keyed on the root stack; stored `suggestedGateCommands` strings are never read. Covered by a test with a hostile stored command. |
| 2 | A malformed or old JSON row throws in the activity? | `detectedGateDefaults` assumes no shape and returns null; covered for strings, numbers, arrays, null components, unknown stacks. |
| 3 | Does a polyglot repo silently change behaviour? | Node outranks the others at the root, so it keeps the built-in gates; a stack only in a subdirectory is ignored. Documented under Limitations. |
| 4 | Does an existing Python/JVM repo regress? | It failed before (exit 127). Gates without a table entry now fail as "no command configured" with the remedy, instead of 127. `onFail: 'warn'` makes them optional. No pass becomes a fail that was a pass. |
| 5 | Is the Python `runTests` honest? | It assumes `pytest` is installed by the repo's own setup; the curated image does not ship it. Documented, not fixed. |
| 6 | Other consumers of `DEFAULT_COMMANDS`? | The eval `gate` scorer fell back to yarn. Fixed in phase 2b: `gateCommandFor` (new `gateCommand.ts`) is the one resolver for `resolveCommand` and the scorer; the scorer now also honours the repo's `gateCommands`, which it ignored before. |
| 7 | Widened suggestions (build/`go vet`) vs the "conservative" stance? | Accepted: they share the run-time table, so form and runtime agree. `ruff` stays suggestion-only because the image lacks it. |

Gate results: typecheck, biome check, docs:check, invariants:check pass. `yarn test`: 7 failures in
`shellStep.test.ts` / `workspace.test.ts` (real-git suites) that fail identically on a clean tree;
`pi/runtime.test.ts` failed once under full-suite load and passes alone with and without the change.

### Phase 2 (npm/pnpm gates, Go image, neutral skills)

Same caveat: author self-review, no independent agent.

| # | Challenge | Outcome |
|---|---|---|
| 8 | Does `npm run …` change behaviour for an existing npm repo? | `yarn build` already ran the package.json script in an npm repo, so build/lint/test/typecheck are near-neutral. The real fixes are the audit command and no longer needing `yarn` on the image. Said so in the PR rather than claiming a large behaviour change. |
| 9 | Two root lockfiles (a stale `yarn.lock` beside `package-lock.json`) would flip yarn→npm by list order. | Found in review. The manager is recorded only when exactly one root lockfile exists; otherwise it is unknown and the built-ins stay. Tested. |
| 10 | Would the Node table replace the test loop's smarter `package.json` guess (`npx vitest run` when no test script)? | Yes, if wired naively. `detectTestCommand` skips Node roots; tested. |
| 11 | `runVulnScan` for npm/pnpm now works? | No: the registry proxy 404s audit endpoints, so every audit command fails behind it, as `yarn npm audit` already did. Not fixed; added as M14 and documented under Limitations. |
| 12 | A `packageManager` pin in package.json that disagrees with the lockfile? | Not read; the lockfile wins. Left as is. |
| 13 | Does the Go image satisfy the executor contract, and does the Claude Code harness have a binary for it? | Built and run: uid 1000, git/tar/rg/bash/sha256sum present, `/workspace` writable, glibc (not musl), `go test`/`build`/`vet` pass as uid 1000. Verified by hand only; no docker-gated CI test exists (L12). |
| 14 | Does editing built-in skill text break pinned runs or admin edits? | `syncSkills` cuts a new `SkillRevision` per content change, so in-flight runs keep the pinned text; an admin edit to a built-in is overwritten by sync, as before. |
| 15 | Is `golang:1.26-bookworm` digest-pinned like the other bases? | Yes, the multi-arch index digest. It is not covered by the weekly base-image refresh unless the repo's `executorImageBuild` is recorded. |

Gate results: typecheck, build, biome check, docs:check, invariants:check and the three Docker image
builds pass. `yarn test`: 6 failures in the real-git suites (`shellStep`, `workspace`) that fail on a
clean tree; `epics.test.ts` timed out once under full-suite load and passes alone (22/22).

### Phase 2b (M7, M8, M10, M14, L11, L12)

Same caveat: author self-review, no independent agent.

| # | Challenge | Outcome |
|---|---|---|
| 16 | Can the new audit POST become an exfiltration channel from a hostile workspace? | The body must be exactly `{name: [versions]}` with name/version charsets validated; in lockfile mode every pair must also be committed. It cannot carry free text. Tested with hostile bodies. |
| 17 | Does an audit leak private-scope package names to the default registry? | It would have. A body naming any package another registry serves is refused (403), not trimmed — a trimmed audit would read as a complete one. Tested, and against real npm. |
| 18 | gzip bodies (npm sends them) and decompression bombs? | Bodies are gunzipped with a `maxOutputLength` equal to the request cap. Verified with real npm that it sends gzip, and that `NPM_CONFIG_AUDIT=false` (set for installs) does not stop an explicit `npm audit`. |
| 19 | New SQL pattern: is it linear? | No — the first version was quadratic (keyword search inside the literal rescans to end of line per candidate). Caught by the adversarial-input test written alongside; the keyword is now anchored to the literal's start. |
| 20 | Could a new eval `stack` become an arbitrary-image channel? | It is an enum at the API and a closed map in the worker; an unknown stored value throws instead of falling back, and `Object.hasOwn` guards `__proto__`/`constructor`. Existing cases (null) keep the original image, so no score rebases. |
| 21 | Is Dockerfile.go safe under the agent workspace's flags? | Checked the driver: agent workspaces are not `--read-only` (only the shell-step runner is), so caches under `/home/executor` are writable. The new docker test runs it with `--cap-drop=ALL` and no-new-privileges as uid 1000. |
| 22 | pnpm and Yarn 4 audit are only claimed from the shared endpoint. | Cases added to `clients.docker.test.ts`, which CI runs on the curated node image. They could not run here (no registry egress to build it), so CI is their first run. |

Known open after this phase: eval cases cannot be given a stack in the dashboard or edited after
creation; the eval bases carry no build tool beyond the language toolchain; Rust/.NET/Ruby have no
image; M5 (PyPI/Maven/Go module proxying) and monorepo subdirectory components are untouched.

Gate results for phase 2b: typecheck, `yarn build`, biome check (explicit dirs + `.github`), `docs:check`,
`invariants:check`, `migrations:check`, the site build and the gateway/worker/web image builds pass.
`yarn test`: 9 failures in `shellStep`/`workspace` (real-git, fail on a clean tree) plus 3 five-second
timeouts under full-suite load (`transcripts`, `users`, `pi/runtime`) that pass alone (102/102).
The curated-image docker test passed locally for go, python and jvm (25 tests); node and the pnpm/yarn
audit cases could not be built here (no registry egress) and are first exercised by CI.

### Phase 2c — CI failure in `clients.docker.test.ts`

The new pnpm audit case failed. It was reproduced locally by building an image from the stock node
base plus pnpm 10.34.7 and Yarn 4.18.1 tarballs packed on the host (the sandbox cannot reach the
public registry from inside a build), then running the four audit cases.

| # | Finding | Outcome |
|---|---|---|
| 23 | The claim "pnpm audit uses the bulk endpoint" was wrong, and was written without running pnpm. | pnpm 10.34.7 posts a dependency tree to `audits/quick`, then `audits`; it never calls the bulk endpoint. The proxy answered 405. Corrected here and in the docs and PR text. |
| 24 | Fix: serve the legacy endpoints too. | The tree is validated recursively (known keys only, charsets on every value, `install`/`remove`/`metadata` empty, depth ≤ 100, ≤ 200k nodes) and the validated tree is what is forwarded. Same lockfile and private-scope checks as the bulk body. 12 unit cases, including hostile trees. |
| 25 | The fake upstream in the docker test only answered the bulk path. | It now answers the legacy path with a clean pnpm-shaped report; the test asserts pnpm used `audits/quick`. |
| 26 | An existing unit test used `audits/quick` as its example of a refused POST path. | Pointed at a path that is still refused. |

After the fix all four audit cases pass locally with real npm, pnpm and Yarn 4. Not re-run here: the
rest of that suite (it needs Yarn classic and Corepack from the curated Node image), so a CI run is
still the authority for it.

### Rebase onto main (after #529–#532)

Read before reapplying: what changed on `main`, and whether it changed an assumption this branch made.

| `main` change | Effect on this branch |
|---|---|
| #531: the registry proxy bounds buffered fetches (a per-registration `Semaphore`, 8 slots, 64 queued, 30 s wait), puts the upstream fetch and body read under a 20 s deadline, and frees a slot when the client hangs up. | The audit relay was a new buffered path with none of that: unbounded concurrency, no deadline, and a slot-less body read. Reapplying it as it was would have undone #531 for one route. It now takes a slot after the cheap checks, reads the client's body and the upstream's answer under the deadline, and releases on hang-up; four tests pin that. |
| `Dockerfile.jvm` back to Temurin 21, Dependabot ignoring major bumps (LTS policy). | Consistent with the eval `jvm` base (the same digest) and the `eclipse-temurin:21-jdk-alpine` shell image. The docs say "Temurin JDK", not a version. |
| Two new migrations at `20261028000000` and `20261028010000`. | The eval-case-stack migration shared the first prefix; renamed to `20261028020000` so it sorts after everything on `main`, as the Prisma skill requires. `migrations:check` passes. |
| #530 keeps the git auth header out of exec argv. | Unrelated to this work, but it fixed the real-git suites that used to fail on a clean tree: the full run went from 12 failures to 2, and both pass alone. |
| #531 `unrunnableTestCause` change in `utils.ts`. | The same file as this branch's `detectTestCommand` edit; separate functions, no interaction. |
| Doc edits to `package-registries.md` and `repositories.md`. | Merged by hand: both texts kept. |

Conflicts were confined to the proxy source and its test file. The test file's conflict markers cut
through the end of `main`'s last test, so the file was rebuilt from `main`'s version plus this
branch's block, not marker-resolved.

Gates after the rebase: install `--immutable`, typecheck, build, biome (explicit dirs + `.github`),
`docs:check`, `invariants:check`, `migrations:check`, the site build and the gateway/worker/web image
builds pass. `yarn test`: 2 failures in `workspace.test.ts` that pass alone (80/80). The curated-image
docker test passes for go, python and jvm (25), and the four audit cases pass with real npm, pnpm
10.34.7 and Yarn 4.18.1.

### Phase 3 (H1, H2, M4/H3) — reviewed by Opus 5.5 through the `claude` CLI

Unlike phases 1–2, an independent reviewer was available: `claude -p --model claude-opus-5-5` with
read-only tools (Read, Grep, Glob, `git show/diff/log`, `rg`; no Edit/Write), run three times — on the
design before any code, on the diff, and on the fixes. Every finding below was checked against the code
before being accepted or declined.

| Round | Finding | Outcome |
|---|---|---|
| Design | Recording the raw `packageManager` string would flip every npm/pnpm repo back to `yarn` gates after its next scan. | Kept the enum; Yarn's flavour is its own field; parsed with the existing `packageManagerPins()`. |
| Design | Running gates in the only component could verify the wrong directory silently (a Makefile repo with one nested `package.json`). | Fires only with a complete listing, the `cd` shows in the recorded command, and uncertain cases keep today's behaviour. Documented as a limitation. |
| Design | `cd`-wrapping must not touch admin commands; Node roots must keep the `package.json` guess in the test loop; a component's guess must read the component's file. | Done and tested. |
| Design | A yarn-berry table duplicates `DEFAULT_COMMANDS`. | One shared table (`YARN_GATE_DEFAULTS`) that `DEFAULT_COMMANDS` is built from. |
| Design | Yarn Classic audit `test $? -lt 8` would pass a network error (exit 1). | Declined, then the real finding: Yarn 1's audit hard-codes `registry.yarnpkg.com` (read in its source), so it never reaches the proxy and would send private names to a public host. No default; documented. |
| Design | Pin the target per run. | **Declined** — needs a column, a migration and replay-safe plumbing. Documented limitation: a scan landing mid-run can move later steps. |
| Design | Cut `WORKSPACE_IMAGE_NODE`. | Done. |
| Diff | The only-component rule almost never fired: the 50-directory cap counted every directory, not signal directories. | **Real bug, predating this branch** (it also dropped components sorted past the 50th). Filter, then cap; tested with 120 doc directories. |
| Diff | Gradle multi-project: a root `settings.gradle.kts` with one subproject made the subproject the target, so `./gradlew` was not found. | `settings.gradle[.kts]` is a JVM signal. |
| Diff | Nothing stops a call site reverting to `repo.executorImage ?? undefined` (both typecheck). | New `invariants:check` rule, proved by deliberately reverting one call site. |
| Diff | The image probe ignored the stack image. | The gateway passes the detection, the worker resolves it (the gateway may not have the worker's env). |
| Diff | A Node component with no lockfile got Yarn 4 gates, which fail there. | npm's commands; an ambiguous (two-lockfile) component keeps the built-in Yarn commands. |
| Fixes | Nested Gradle/Maven projects (`server/settings.gradle.kts` + `server/app/build.gradle.kts`) still read as two components. | A JVM signal below another JVM signal belongs to the parent. |

Found by running things rather than by review: joining a component's gate commands in one shell leaks
the first `cd` into the second (production runs each gate in its own `sh -c`; the test and the `inDir`
comment now say so), and the scorer test's `systemConfig` mock lacked `stackImages`, which turned a real
resolution into a silently failed gate.

Environment notes, not code: the worker image build failed with `cannot allocate memory` in the Docker
VM — identically on `main` plus a trivial manifest edit — and passed after clearing the builder cache.
An ad-hoc Yarn 1 `install` through the proxy hung in a locally assembled image; it is unrelated to this
change (no audit is routed through the proxy for Classic) and not investigated.

Still open after this phase: publishing the curated images (H2), several components with no root signal
(M4), detect-on-onboard, pinning a run to its detection, M5 (PyPI/Maven/Go proxying), Rust/.NET/Ruby.
