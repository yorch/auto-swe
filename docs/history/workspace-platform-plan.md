# Workspace platform: secrets, stacks, and execution backends

> **Frozen build plan.** The tracked work has landed. What is still true (open gaps, items never
> built) lives in the living docs' `## Limitations` sections: `package-registries.md`,
> `repositories.md`, `architecture.md` §10 and `product-overview.md` §7. This file is kept for
> rationale only and is not maintained. The code wins wherever the two disagree.

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
| 1 | Replace the Alpine-only git bootstrap; image-contract probe (activity + workflow + admin route + settings button) | #473 | merged |
| 4 | `Dockerfile.python` / `Dockerfile.jvm`, `build-executor.yml` `stack` input, stack detection with suggested image and gate commands | #473 | merged |
| 5 | `WorkspaceBackend` interface + Docker driver for the agent workspace (`createWorkspace`, harness exec, agent-run finalize); keeper PID recorded at creation | #473 | merged |
| 2 | `PackageRegistry` model (admin-managed, encrypted token), worker-side npm registry proxy, workspace npm/pnpm/yarn config, proxy-side tarball cache | #474 | merged |
| 3 | Lockfile-scoped allowlist (`package-lock.json`, `yarn.lock` classic and Berry, `pnpm-lock.yaml`), refusal message and recorded denials | #474 | merged |
| 2a | All four clients end to end: `clients.docker.test.ts` (npm, pnpm, Yarn classic, Yarn Berry; frozen install in lockfile mode, plus denial of an unlisted package) runs in the CI `docker-tests` job. Found and fixed along the way: the Yarn classic host-level auth line, `always-auth` and `$HOME/.npmrc`; Berry's `unsafeHttpWhitelist`; the denial message as the reason phrase for pnpm | #479 | merged |
| 2b | Package-manager bootstrap: pnpm, Yarn classic and Yarn Berry pre-installed in `Dockerfile.node`; `COREPACK_NPM_REGISTRY` / `COREPACK_NPM_TOKEN` env; `packageManager` pins added to the allowlist | #479 | merged |
| 2b-verify | Corepack downloading a pin that is not pre-installed, through the proxy. The proxy gained the `/<name>/<version>` manifest path Corepack reads (it was a 404) and literal `@scope/pkg` packuments. CI covers a signed pin, a forged signature, a hash pin and a denied pin; a manual run against `registry.npmjs.org` verified real npm signatures for `pnpm@9.15.9` and `yarn@4.5.0` | — | done |
| 2c | npm swaps only the origin of a lockfile `resolved` URL, and uses the default registry even for scopes (npm 11.19 `@npmcli/arborist` `#registryResolved`). The proxy now validates and ignores a tarball path prefix, strips the Artifactory `@scope/` file form, and routes by package name to the scope's or the default registry. Covered by unit tests and the npm e2e case | #479 | merged |
| G1 | Ephemeral sandbox behind `WorkspaceBackend` (`runEphemeral` / `startDetached` always apply lockdown; `runHelper` for the platform's git helpers; volumes); registry wiring for `network: 'egress'` shell steps | #479 | merged |
| G2 | `teamId` for the eval harness and `runGateStandalone` (both eval callers), so they get registries too | #479 | merged |
| G3 | Weekly scheduled executor-image rebuilds from the stored `Connection.executorImageBuild` | #479 | merged |
| G4 | Stack detection over the recursive tree (`ScmProvider.listTree`), with per-directory `components` | #479 | merged |
| 6 | Kubernetes workspace driver: pods per workspace, for autoscaling and isolation | — | not started |
| 7 | Further ecosystems through the proxy (PyPI, Maven, Docker registry v2) | — | not started |
| 8 | Publish / push, opt-in per flow, gated by human approval | — | not started |

## 5. Decisions

These replace the earlier stricter-by-default assumptions, now that the questions are answered.

- **Threat model.** Mainly accidental leakage, but still protected against prompt injection and
  similar attacks. Lockfile mode stays the default, and `open` mode is the per-registry escape
  hatch.
- **Kubernetes.** Run workspaces as pods, for autoscaling and isolation; workers stay Temporal
  workers. Item 6 therefore means a pod driver behind `WorkspaceBackend`, plus a stateless worker
  Deployment that autoscales on task-queue backlog. Obligations already recorded for it:
  - the driver supplies the keeper PID
  - secret env is passed by name only
  - egress control moves to NetworkPolicy, since PodSecurity `restricted` forbids the
    `NET_ADMIN` metadata blackhole
  - there is no per-pod `--pids-limit`
- **Write access.** Needed in some cases but not most. Item 8 stays opt-in per flow and gated by
  human approval, never a default capability of a workspace.
- **Mirror.** No pull-through mirror for now. The proxy fronts Artifactory or any npm registry
  directly.

## 6. Known gaps carried forward

- A Kubernetes driver loses `--pids-limit` (there is only a kubelet-wide `podPidsLimit`). The
  metadata-IP blackhole would need `NET_ADMIN`, which PodSecurity `restricted` forbids. The Docker
  version of that blackhole has never been validated against a real daemon.
- The registry proxy refuses upstream redirects, so an Artifactory configured to redirect downloads
  to object storage is not supported.
- Yarn classic fetches non-default-host `yarn.lock` URLs (Artifactory) directly, without the
  proxy. Only lockfiles resolved against `registry.yarnpkg.com` / `registry.npmjs.org` work.
- Container-contract steps get no registry access (no repository, no lockfile). Shell steps need
  `network: 'egress'` and the proxy at the Docker host alias.
- The scheduled rebuild covers only images built by the workflow after `executorImageBuild`
  existed.
