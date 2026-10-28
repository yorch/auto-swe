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

- [~] **H1. Built-in gates are all `yarn`.** *Non-Node roots done (stack table in `stackDetection.ts`); npm and pnpm roots done (phase 2). Yarn roots keep the built-ins, so `yarn npm audit` stays Berry-only (the detector sees lockfile names, not the Yarn version).* `DEFAULT_COMMANDS` (`worker/src/activities/qualityGates.ts`)
  is `yarn build|lint|test|typecheck` and `yarn npm audit`. Non-Node repos with no `gateCommands`
  exit 127 on every gate; `yarn npm audit` is Berry-only so it also breaks npm, pnpm and Yarn 1.
  Fix: stack-keyed defaults resolved from the detected stack, beneath step config and repo
  `gateCommands`.
- [ ] **H2. Default workspace image is `node:24-alpine`.** A repo with no `executorImage` gets a
  Node image whatever its stack. Fix: resolve a curated image from the detected stack as a
  fallback beneath `executorImage`. (Needs a published image reference per stack; open design
  question below.)
- [~] **H3. Stack detection is advisory only.** *Gates and the test loop now consume it; the image does not (H2).* `detectedStack` is read by the repo form alone.
  Fix: H1 and H2 consume it at run time.

### Medium

- [~] **M4. Test-command detection reads only the root `package.json`.** *Chain done (configured → stack default → package.json); component subdirectories not handled.*
  (`executeImplementation.ts`, `implementerSession.ts`, `utils.ts#detectTestCommand`.)
  Fix: `gateCommands.runTests` → detected-stack suggestion → `package.json` guess; honour
  component subdirectories in a monorepo.
- [ ] M5. Dependency installs are npm-only (no PyPI / Maven / Go module proxy or credentialed path).
- [~] M6. Go image added in phase 2 (`defaults/Dockerfile.go`, `stack` input, gateway enum). None for
  Rust/.NET/Ruby.
- [ ] M7. Eval harness pinned to `node:24-alpine` (`EVAL_WORKSPACE_IMAGE`); `gate` scorers and flake
  screens run on a Node image for every stack.
- [ ] M8. `BUILTIN_SHELL_IMAGES` has no JVM or Go images.
- [x] M9. Built-in skills assumed TypeScript/Node (`testFirst`, `noNewDependencies`); made
  stack-neutral in phase 2. `minimalSurfaceArea` was already hedged per language.
- [ ] M10. Built-in `CODE_SECURITY` patterns cover JS/Python only (no `Runtime.exec`,
  `ObjectInputStream`, SQL concatenation, Go `InsecureSkipVerify`, `crypto/md5`).

- [ ] M14. `runVulnScan` cannot work behind the registry proxy: it 404s audit endpoints, so
  `npm audit`/`pnpm audit`/`yarn npm audit` all fail in a wired workspace. Needs either a proxied
  advisory endpoint or a registry-free scanner default.

### Low

- [ ] L11. Doc drift: `deployment.md` and the shell allowlist comments justify `node:24-alpine` as
  the only yarn-bearing image; `defaults/Dockerfile.node` now installs Corepack on Node 26.
- [ ] L12. No docker-gated test builds the python/jvm images or runs a real non-Node gate.
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
| 6 | Other consumers of `DEFAULT_COMMANDS`? | `standaloneGateRunner` (eval `gate` scorers) still uses yarn defaults; tracked with M7. |
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
