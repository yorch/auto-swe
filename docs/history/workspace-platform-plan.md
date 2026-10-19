# Workspace platform: secrets, stacks, and execution backends

> **Build plan, kept here while it is in progress.** It tracks the work and lets it be picked up
> again later. When the tracked work lands, sweep it for anything still true (open gaps, never-built
> items) and move that into the living docs' `## Limitations` sections. After that the file is
> frozen like the rest of `docs/history/`. The code wins wherever the two disagree.

## 1. Questions

1. **Secrets.** How do agents and workflows run commands that need authentication (Artifactory,
   private npm / PyPI / Maven, Docker registries) without handing those credentials to an agent?
2. **Stacks.** How do we support repositories on different stacks (Node, Python, Java, …)?
3. **Execution substrate.** How could workers run on something other than a local Docker daemon,
   for example Kubernetes?

## 2. Where the system starts from

- `createWorkspace` (`worker/src/activities/workspace.ts`) runs `docker run … sleep infinity`, and
  every later step is a `docker exec`. The default bridge network has open egress, and the agent
  runs as the image user, usually root, with `bash`.
- **Git credential.** It never enters the container's environment or `.git/config`. It is injected
  on each call through `git -c http.extraheader`. Before each authenticated call the repo config is
  rewritten from an allow-list and every stray process is SIGKILLed (`killStrayProcessesScript`).
- **Model credential.** For harness runtimes it never enters the container either. The worker-side
  `claudeCode/modelProxy.ts` holds the real key and hands each turn a token that works only at the
  proxy, only for that turn.
- **Images.** Each connection has an `executorImage` (null means inherit `WORKSPACE_IMAGE`) and
  `gateCommands`. `defaults/` contains only `Dockerfile.node`. `build-executor.yml` builds one repo
  at a time and is never run on a schedule.
- **Docker coupling.** Docker is hardcoded in about a dozen worker files. The only Kubernetes story
  is "run the worker as a StatefulSet with the host socket".

## 3. Decisions and their rationale

### 3.1 Secrets

- **Exposure mechanism.** A worker-side proxy that adds credentials to outbound requests, modelled
  on the model proxy. The workspace gets registry URLs that point at the proxy and a per-workspace
  token that only works there. The real registry credential never leaves the worker.
- **Lockfile-scoped access.** In the default `lockfile` mode the proxy serves only the
  `name@version` pairs found in the lockfiles committed on the base branch. That set is read at
  clone time, before the agent can edit anything. A proxy that adds a token to any `GET` protects
  the token but not the packages, because private artifacts are often source code. Any other
  request is refused with a message that names the package, and the refusal is recorded so it
  shows up on the run. An `open` mode exists for registries whose packages are not sensitive.
- **Read-only.** Only `GET` and `HEAD` reach the upstream. Publish, login, search and audit are
  refused.
- **Proxy-side cache.** Immutable tarballs are cached on the worker, per registry, with a size cap.
  This is the read-only dependency cache. A shared volume that an agent running as root can write
  to would let one run poison the next.
- **Rejected options.**
  - Env vars or files in the container: the agent can read and exfiltrate them.
  - A trusted "install first" phase: every gate already gets a fresh container, and installs
    already run inside commands the repo authors.
  - An in-container credential helper: the stray-process sweep kills it at every authed git call.
- **Authority.** Registries are managed by platform admins only, the same authority that sets
  `executorImage`: whoever chooses what sees a credential is held to one level.

### 3.2 Stacks

- **Image contract.** An executor image provides `sh`, `git` and `tar`, can run `sleep infinity`
  under `--init`, and has a `/workspace` the exec user can write to. A probe checks this when an
  admin asks; it runs as a short Temporal workflow because only the worker can reach Docker.
- **Fix the Alpine-only `git` bootstrap.** `which git || apk add git` fails on any non-Alpine image
  without git. Instead: use git if present; otherwise try `apk`, then `apt-get`; otherwise fail
  with an error that names the contract.
- **Curated images.** `defaults/Dockerfile.python` and `defaults/Dockerfile.jvm` sit beside the Node
  one. JVM builds run without daemons (`-Dorg.gradle.daemon=false`, Kotlin in-process), because the
  stray-process sweep kills background daemons. `build-executor.yml` takes a `stack` input.
- **Stack detection.** The scheduled dependency scan already fetches manifests. It also records
  which stack it detected, plus suggested gate commands, and the repository settings show that as a
  suggestion.

### 3.3 Execution substrate

There are three separate axes, and only the third is in scope:

- **Orchestration engine.** Keep Temporal. It runs on Kubernetes through its Helm chart, and
  replacing it would rewrite the interpreter, HITL, signals and replay for no user-facing gain.
- **Where the worker runs.** Possible today, apart from the Docker socket.
- **Where workspaces run.** In scope. A `WorkspaceBackend` interface (create, attach, exec, copy,
  pause, remove) with a Docker driver extracted from the existing code, with no behaviour change.

The driver contract has to carry obligations a Kubernetes driver must meet:

- **The driver supplies the keeper PID.** Under `--init`, the "lowest-numbered child of PID 1"
  heuristic is right. In a pod, `sleep infinity` is itself PID 1, so the same heuristic would spare
  an agent process and let it read the git credential.
- **Secret env is passed by name.** `docker exec -e NAME` hides the value. The Kubernetes exec API
  only takes argv, so a value there is readable in `/proc` and in the apiserver audit log. This is
  why the credential proxy comes before a Kubernetes driver.

## 4. Work items

| # | Item | PR | State |
|---|---|---|---|
| 1 | Replace the Alpine-only git bootstrap; image-contract probe (activity + workflow + admin route + settings button) | A (#473) | in review |
| 4 | `Dockerfile.python` / `Dockerfile.jvm`, `build-executor.yml` `stack` input, stack detection with suggested image and gate commands | A (#473) | in review |
| 5 | `WorkspaceBackend` interface + Docker driver for the agent workspace (`createWorkspace`, harness exec, agent-run finalize); keeper PID recorded at creation | A (#473) | in review |
| 2 | `PackageRegistry` model (admin-managed, encrypted token), worker-side npm registry proxy, workspace npm/pnpm/yarn config, proxy-side tarball cache | B | in review |
| 3 | Lockfile-scoped allowlist (`package-lock.json`, `yarn.lock` classic and Berry, `pnpm-lock.yaml`), refusal message and recorded denials | B | in review |
| 2a | Verify pnpm, Yarn classic and Yarn Berry end to end through the proxy (only npm is verified: `npm ci` succeeds, and an unlisted package gets the 403) | — | not started |
| 2b | Package-manager bootstrap: allowlist the root `package.json` `packageManager` pin and pass `COREPACK_NPM_REGISTRY` / `COREPACK_NPM_TOKEN`, or pre-install pnpm/yarn in the curated image | — | not started |
| 2c | Check how npm routes scoped tarballs under `replace-registry-host=always` when the scope's upstream differs from the default registry | — | not started |
| 6 | Kubernetes workspace driver (pods, NetworkPolicy egress, runtimeClass) | — | not started |
| 7 | Further ecosystems through the proxy (PyPI, Maven, Docker registry v2) | — | not started |
| 8 | Publish / push (remote BuildKit, gated by human approval) | — | not started |

PR A is based on `main`. PR B is stacked on PR A.

## 5. Assumptions made without an answer

These were asked as open questions. The work goes ahead on the stricter assumption in each case,
so loosening one later is a configuration change, not a redesign.

- **Threat model.** The agent is treated as a possible adversary (prompt injection), not only as a
  source of accidental leaks. Hence lockfile scoping by default.
- **Write access.** Out of scope: the proxy only resolves dependencies.
- **Kubernetes.** Only the backend seam is built. No driver yet.
- **Mirror.** No pull-through mirror is assumed. The proxy works against Artifactory or any npm
  registry as its upstream.

## 6. Known gaps carried forward

- The ephemeral shell / container-step sandbox (`lib/ephemeralContainer.ts`, `shellStep.ts`,
  `containerStep.ts`) still calls Docker directly. It is outside the `WorkspaceBackend` seam until a
  second driver needs it.
- A Kubernetes driver loses `--pids-limit` (there is only a kubelet-wide `podPidsLimit`). The
  metadata-IP blackhole would need `NET_ADMIN`, which PodSecurity `restricted` forbids. The Docker
  version of that blackhole has never been validated against a real daemon.
- The registry proxy refuses upstream redirects, so an Artifactory configured to redirect downloads
  to object storage is not supported.
- `build-executor.yml` is still never run on a schedule, so images pick up base-image fixes only
  when someone rebuilds them.
