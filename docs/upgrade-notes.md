# Upgrade notes

## Restricted egress default

**Affected:** deployments relying on the implicit `open` egress policy, custom worker environments
without an egress proxy, and repositories calling hosts outside the dependency baseline/team list.

**Fixing commit:** `48423c5fdcabd5d2c08bfe80ea24365fa42b27a6`.

`workspace.egressPolicy` defaults to `restricted`. Compose and Helm enable the proxy on port 8792;
custom deployments must configure `EGRESS_PROXY_PORT` and a container-reachable `EGRESS_PROXY_URL`
(required on Kubernetes). Otherwise GLOBAL restricted refuses worker startup. Review
`workspace.egressBaselineAllowlist` at GLOBAL or ORGANIZATION scope and add application-specific
hosts to each team's allowlist. Both use hostname or wildcard-hostname entries.

Clients must use the HTTP(S) proxy. Unlisted hosts are refused; direct public sockets outside the
platform/git exceptions are blocked even for allowlisted hostnames. Dependency redirects and CDN hosts not
on the tight baseline may need explicit entries. Team and baseline allowlists remain live rather
than frozen per run; template-code sign-off snapshots include both but do not pin execution.

To retain the earlier behavior, set **GLOBAL `workspace.egressPolicy` to `open`** in platform
configuration before restarting workers. An empty team list then remains unrestricted, with the
baseline ignored. Existing explicit scoped policies and run-pinned policy values still apply.

Notes for operators of a deployment that ran earlier code. Each entry describes an operator action
required by an upgrade, including credential exposure and database migrations. An entry is
keyed by the condition that makes your deployment affected and by the commit that fixed it, not by
a version number: the packages are unversioned, so a commit is the only identifier a deployment
can compare against.

Read an entry when its **Affected** line matches your deployment. An entry that does not match
needs nothing from you.

> **Act first, read second.** Kubernetes, or Docker with command-line or event capture, and a
> worker built before `3200071c`: rotate PATs, per-host PATs and user tokens now (UN-1 steps 1
> and 2), and any provider `apiBase` token that has a path or query (UN-3), then read the
> entries. A Docker worker with no model proxy hands the provider API key to code the agent runs
> at every commit (UN-5).
>
> **Standing exposure, whatever your build:** host- or node-level process auditing records the git
> credential from git's own argument list inside each workspace on every authenticated call
> ([details](#standing-exposure-the-credential-in-a-workspaces-git-argument-list)). Upgrading does not end it.

---

## 1. Is your worker running a fix?

SHAs below identify source changes; squashed histories require comparing source instead of commit
ancestry. The worker image carries the commit it was built from:

```bash
# in the running worker container (or: docker inspect <image> --format '{{.Config.Env}}')
printenv COMMIT_HASH
```

The shipped image workflow also ends each image tag with the short commit
(`<timestamp>-<commit>`). `COMMIT_HASH` reads `unknown` on an image built without that build
argument; for such an image, compare the source it was built from instead. With a clone of the
repository:

```bash
git merge-base --is-ancestor <fix-sha> <your-build-sha> && echo "contains the fix"
```

"Contains" means the build commit descends from the fix commit. An image built by a pull-request
run takes `COMMIT_HASH` from the pull request's merge ref, which is not a commit on `main`, so the
command above can fail for it; use an image built from a `main` commit, or compare the source it
was built from. For workspace credential entries, only the worker image matters: the gateway and
web images never run a workspace command. Database and scheduling entries also require the
gateway and migration rollout described in their Actions.

---

## Standing exposure: the credential in a workspace's git argument list

This is current behaviour on every build, including the fixed ones, not a defect with a fix commit.
Each authenticated git call runs inside the workspace, and the shell there expands
`$ASW_GIT_AUTH` into git's own argument list as `-c http.extraheader=AUTHORIZATION: basic <base64>`
(base64 of `x-access-token:<token>`). On a runc runtime a container process is a host process, so
anything that records process arguments on the Docker host or on a Kubernetes node (`auditd`
`EXECVE`, EDR agents, Falco `proc.cmdline`) records that header on every authenticated call, at
every commit, on both backends. A sandboxed runtime (gVisor, Kata Containers, the VM behind Docker
Desktop) may keep those processes out of the host's view; verify that in your environment before
relying on it. The fixes moved the value off the `docker` and `kubectl` command lines; they did not
remove it from git's. [`architecture.md`](./architecture.md) lists the in-container visibility and
the shell-step helper's host `ps` visibility under its Limitations; it does not list host- or
node-level capture, which this section is the record of.

- The header in a workspace `git` process is by design and does not show a vulnerable build. A
  clear-text `x-access-token:` URL in one is not by design: see
  [Recognising a hit](#recognising-a-hit).
- Exclude workspace and container processes from that capture, or treat those logs as
  credential-bearing: restrict who reads them and apply your retention policy to them.
- A GitHub App installation token is good for one hour; a PAT is good until revoked. Prefer the
  App where you can. This repository implements no other mitigation for this path.

---

## 2. Quick reference

| Secret | Where it was exposed | How long the secret is good | Action |
|---|---|---|---|
| GitHub PAT (instance, or a per-host PAT for a GitHub Enterprise host) | Kubernetes API-server audit logs, `kubectl` and `docker` process arguments, Docker exec events, and for a while a lingering git process environment, and for a while the clone's `origin` URL (entries 1, 4, 6 and 7). On every build, git's own argument list inside the workspace ([standing exposure](#standing-exposure-the-credential-in-a-workspaces-git-argument-list)) | Until you revoke it or its own expiry on GitHub | Rotate |
| GitHub App installation token | The same places | One hour (GitHub sets it; the worker reads `expires_at` from GitHub's answer and caches the token until a minute before it) | Nothing to rotate. The token carries the installation's full permissions and audit logs often reach a SIEM within seconds: if anyone outside your trust boundary could read the logs in near real time, review the installation's activity in GitHub's audit log for the exposure window. The App id and private key were never exposed |
| A user's own GitHub token (`user-github-credentials.md`) | The same places, on runs that user launched | Until the user revokes it or its own expiry on GitHub | The user rotates it |
| Registry-proxy token | Kubernetes Pod objects, etcd and `kubectl get pod`; `docker run` arguments and `docker inspect` (entries 2 and 4) | One workspace's life, then revoked; every token is also lost when the worker restarts | Usually none; clean up leftovers (entry 2) |
| Provider `apiBase` that carries a credential in its path or query | `kubectl exec` arguments and environment pairs; `docker exec` arguments (entry 3) | Until the gateway or provider rotates it | Rotate that gateway token |
| Provider API key | Never in an argument list or environment pair. Inside the workspace, as `ANTHROPIC_API_KEY`, for Claude Code agents with no model proxy: on Docker at every commit, on Kubernetes before `7cccdd43` (entry 5) | Until you rotate it | Configure the model proxy; rotate if the workspace ran code you do not trust |

### Recognising a hit

A command line reaches your logs encoded, so a plain-text search for the readable form never
matches. The Kubernetes API server records the exec command as repeated `command=` query
parameters, encoded like Go's `url.Values.Encode`: space is `+`, `=` is `%3D`, `:` is `%3A`,
`'` is `%27`, `"` is `%22`, `/` is `%2F`, `@` is `%40`, `$` is `%24`, `{` is `%7B`. Any one of these
in a `kubectl exec` request, or in a `docker` or `kubectl` process, confirms a token was logged
by a build without the fix. Inside a workspace, the two forms differ. The header
(`AUTHORIZATION: basic`, base64 prefix `eC1hY2Nlc3MtdG9rZW46`) in a `git` process is by design on
every build ([standing exposure](#standing-exposure-the-credential-in-a-workspaces-git-argument-list)).
A clear-text `x-access-token:` URL in a `git` process's arguments is not: current code clones only
the credential-free URL, so it marks a build older than the fix (the main clone before `3397bff3`,
dependency checkouts before `8e372963`, a shell step's clone before `3200071c`):

| Search for | Meaning |
|---|---|
| `AUTHORIZATION%3A+basic+` (decoded: `AUTHORIZATION: basic `) | The git header with a value after it |
| `eC1hY2Nlc3MtdG9rZW46` | Base64 of `x-access-token:`, the start of every header value (check: `node -e "console.log(Buffer.from('x-access-token:').toString('base64'))"`) |
| `x-access-token%3A` (decoded: `x-access-token:`) | A clone URL with the token in clear text, `https%3A%2F%2Fx-access-token%3A<token>%40<host>` |

To read a hit, URL-decode it (`+` is a space), then base64-decode what follows `basic `. Do not
search for the bare word `extraheader`: the fixed commands carry it too. A fixed command names
`ASW_GIT_AUTH` and has no `basic <base64>` after it. From `d9365e26` the request carries
`%22http.extraheader%3D%24ASW_GIT_AUTH%22`; from `8e372963` it carries
`%22http.extraheader%3D%24%7BASW_GIT_AUTH%3A%3Fgit+credential+not+delivered%7D%22`.

Host process records are not URL-encoded but have their own traps. In `ps`, use
`grep -F 'AUTHORIZATION: basic'` or `grep -F 'x-access-token:'`. In `auditd`, an `EXECVE` argument
that holds a space or a double quote is hex-encoded, and the `sh -c` script always does, so `grep` of
`audit.log` finds nothing: read the records with `ausearch -i`, or search for the hex of the
string. Verify the method on your own system against a known string before you rely on a
negative result.

---

## 3. Entries

### UN-1. GitHub credential in Kubernetes exec command lines

**Affected.** All of these:

- `WORKSPACE_BACKEND=kubernetes`.
- A worker image built from a commit that does not contain `8e372963`. `d9365e26` fixes the
  target-repository clone, base fetch, `gitAuthed` fetch and push. It does not fix dependency
  checkouts (`cloneDependencyRepos`, used when a repository has dependency edges), which still
  logged the clear-text token URL until `8e372963`. A build that contains `d9365e26` but not `8e372963` is partly fixed.

The Kubernetes backend first exists at `68b1dd23`, so no earlier build can be affected.

**What was exposed and where.** `kubectl exec` sends the command to the API server as repeated
`?command=` query parameters on the `pods/exec` request. The request URI is recorded in
API-server audit logs even at the `Metadata` level, and by anything between the worker and the API
server that logs request URLs. Three kinds of value were in the command:

- The git header, `-c http.extraheader=AUTHORIZATION: basic <base64>`, inside the `sh -c` script
  text. The base64 decodes to `x-access-token:<token>`. It is encoding, not protection.
- For dependency checkouts, the clone URL `https://x-access-token:<token>@host/...`, with the token
  in clear text, in the `git clone` command.
- The same two values in the argument list of the `kubectl` client process on the worker host or
  pod, for as long as each command ran.

The credential is whichever one the run used to reach GitHub, in this order: the token of the user
who launched the run, if per-user credentials are enabled and that user saved one for the
repository; otherwise the platform credential of the repository's host (the instance's PAT or App
installation, or the PAT or App you recorded for that GitHub Enterprise host under
`GitHubHostCredential`). See [`user-github-credentials.md`](./user-github-credentials.md).

**What was not exposed.** The GitHub App id and private key, and the signed JWT used to mint an
installation token, which are handled in the worker process and never sent into a workspace. Your
provider API keys (they travel as `secretEnv`, in a stdin preamble).

**Exposure window and lifetime.** From the first run on the Kubernetes backend until your worker
contained the fix. The audit entry lives as long as your retention (often a year or more), so the
exposure lasts as long as the credential does:

| Credential | Still valid? |
|---|---|
| App installation token | No, after one hour. It matters only to someone who read the log inside that hour. An installation token carries the installation's full permissions on every repository it covers |
| Instance PAT, per-host PAT | Yes, until revoked |
| User's own token | Yes, until revoked |

**Actions.**

1. Rotate every PAT that could have been used since the first Kubernetes run: create the new token
   on GitHub, save it at `/admin/integrations` under GitHub (for a GitHub Enterprise host, under
   Per-host credentials), then revoke the old one on GitHub. Revoking is the rotation; saving
   alone leaves the old token live.
2. If you enabled per-user credentials, tell every user who launched runs against a Kubernetes
   worker to save a new token for each repository on the Connections page and revoke the old one.
3. Find the runs, to learn the window and who could have read it. Search your API-server audit
   logs, and any sink that receives them, for exec requests (`objectRef.subresource` is `exec`)
   whose `requestURI` matches a search in [Recognising a hit](#recognising-a-hit). Do not paste
   hits into tickets or chat.
4. Purge or redact the matching audit entries per your retention policy (see
   [If you cannot tell](#4-if-you-cannot-tell)). Check the places that copy those logs: SIEM,
   object storage, backups.
5. Check any load balancer, managed control-plane log or API gateway in front of your API server
   for request-URL logging. This note cannot tell you what your infrastructure records.

**Verify the fix is running.** The worker contains `8e372963`. For a running cluster: run a
workspace, then look at its `kubectl exec` requests in the audit log. The clone and fetch
commands contain `ASW_GIT_AUTH` with no `basic <base64>` after it, and none of the searches in
[Recognising a hit](#recognising-a-hit) matches a `kubectl exec` request from a new run. A node-level
process record of the header in git inside the pod is the standing exposure, not a failure of this check. A search that finds
nothing proves the fix only if the same search finds a known string in your log pipeline.

---

### UN-2. Registry-proxy token in Kubernetes Pod objects

**Affected.** All of these:

- `WORKSPACE_BACKEND=kubernetes`.
- The registry proxy is configured (`REGISTRY_PROXY_PORT` set; see
  [`package-registries.md`](./package-registries.md)), so workspaces receive a token.
- A worker image built from a commit that does not contain `c4d1a285`.

**What was exposed and where.** The per-workspace proxy token, as `COREPACK_NPM_TOKEN` and
`YARN_NPM_AUTH_TOKEN` in the `env` of the workspace Pod. It was readable by anyone with `get pods`
in the workspace namespace (`kubectl get pod -o yaml`), stored in etcd and in etcd snapshots, and
present in the body of the `pods create` request wherever your audit policy records request bodies
(not at `Metadata` level). The npmrc that also carries the token is written through stdin and was
not on any command line.

**What was not exposed.** The upstream registry credentials: a workspace holds only the proxy's
token, never an upstream token. Any GitHub credential (that is UN-1).

**Exposure window and lifetime.** The token is 32 random bytes minted per workspace. The worker
keeps a digest of it in memory only and revokes it when the workspace is released; a worker
restart drops all of them. It works only at the worker's registry proxy and, in lockfile mode,
only for the package versions committed on the base ref. A token read from a finished run is
dead. A token of a run still in progress when you read it is live until that run ends.

**Actions.**

1. Upgrade the worker to a build containing `c4d1a285`, and apply the matching RBAC from
   `infra/kubernetes/workspace-namespace.yaml` before it starts: the worker now needs `create` and
   `delete` on `secrets` and `list` and `watch` on `pods`, or workspace creation fails its
   preflight.
2. No rotation is needed for completed runs. Delete leftover workspace Pods from older runs (the
   worker does not reap finished Pod objects), and expire etcd snapshots that predate the fix if
   your policy treats even dead tokens as sensitive. After the fix the token is still held in a
   Kubernetes Secret while the workspace lives, so it sits in etcd and in the `secrets create`
   request body wherever your audit policy records bodies (not at `Metadata` level), and in
   snapshots taken meanwhile; it is dead once the workspace is released, and the same advice
   applies to those snapshots.
3. Restart the worker once after the upgrade: that revokes any registration still alive from an
   old process.
4. If the registry proxy's address is reachable from outside the cluster or from other tenants,
   treat a token read during a live run as usable until that run ends. Whether it is reachable is a
   property of your network: verify in your environment.

**Verify the fix is running.** The worker contains `c4d1a285`. Create a workspace and run
`kubectl get pod <workspace> -o yaml`: the two token variables appear as `valueFrom.secretKeyRef`,
not as `value`, and a Secret named `<pod>-env` exists, owned by the Pod.

---

### UN-3. Claude Code provider base URL in exec arguments and environment

**Affected.** All of these:

- A provider credential whose `apiBase` has a path, query or fragment that carries a secret (some
  LLM gateways put a token in the path). A bare origin carries none.
- Claude Code turns that ran without the worker's model proxy, so the harness talked to your
  `apiBase` directly. With the proxy (`HARNESS_MODEL_PROXY_PORT` set), the harness receives the
  proxy's per-turn URL and token, and `apiBase` never reaches the workspace.
- A worker image built from a commit that does not contain `3200071c`.

On Docker the proxy is optional. On Kubernetes a worker built from `7cccdd43` or later refuses to
start without it, whatever its configuration, so the Kubernetes case is a worker older than that
commit.

**What was exposed and where.** The `apiBase` value was passed as an `ANTHROPIC_BASE_URL=...`
environment pair on the exec command, and as inline JSON in the harness's `--settings` argument.
Under Kubernetes both are part of the `?command=` query of the exec request and land in the audit
log (see UN-1). Under Docker both are `docker exec` arguments, visible in `ps` on the worker host.

**What was not exposed.** The provider API key itself: it travels as `secretEnv` (a stdin preamble
under Kubernetes, `-e NAME` without a value under Docker). A gateway that authenticates by API key
only, with an origin-only `apiBase`, exposed nothing.

**Exposure window and lifetime.** The harness first passed `apiBase` as `ANTHROPIC_BASE_URL` at
`2bcc49fd` (2026-10-03), so no earlier build is affected. The window runs from the first Claude
Code turn without the model proxy until your worker contained `3200071c`. A path token is valid
until its issuer rotates it.

**Actions.**

1. List your provider credentials at `/models` under Credentials, and open each one that is used
   by a Claude Code agent. Note every `apiBase` that has anything after the host.
2. For each, rotate that token at the gateway or provider, and save the new `apiBase`.
3. On Kubernetes, search the audit logs as in UN-1 for the token text of the old `apiBase`, in
   its URL-encoded form (see [Recognising a hit](#recognising-a-hit)): search the host and the
   start of the path with `:`, `/` and `@` written as `%3A`, `%2F` and `%40`.
4. On Docker, treat it like UN-4.

The gateway refuses an `apiBase` that carries a username or password (`credentialInputProblem`);
since `1d7b03b7` (2026-10-03). It checks the URL's userinfo only (and the API key for whitespace and
control characters). It does not look at the path or query, which is why they needed this fix, and it
does not re-check a credential saved before it existed. A stored credential with userinfo in its `apiBase` was a credential in a
URL: rotate it.

**Verify the fix is running.** The worker contains `3200071c`. A turn with a path-bearing
`apiBase` then shows no `ANTHROPIC_BASE_URL=` pair and no inline `--settings` JSON on its exec
command, and the pinned settings layer is a file under the harness home.

`3200071c` also adds a run-time guard against credential-named environment pairs, which needs no
operator action; the current rule and what it misses are in the Source invariants table of
`AGENTS.md`.

---

### UN-4. Credentials in process arguments on the Docker backend

**Affected.** All of these:

- `WORKSPACE_BACKEND=docker` (the default).
- A worker image built from a commit that does not contain the fix for the value in question (the
  list below).
- A host where something other than the worker can read process arguments or exec events: other
  local users, command-line auditing (`auditd` `execve` records, EDR agents, process accounting),
  a runtime monitor that records container processes, or anything that subscribes to the Docker
  event stream (see below).

Do not treat a host as unaffected until you have checked every consumer on it. Which consumers you
run is not something this repository can show: verify in your environment.

**What was exposed and where.** The Docker CLI runs on the worker host with the command in its
argument list, so the value is in `ps` for as long as that command runs, and in anything that
records it:

| Value | First in a Docker command line | In the argument list until | Commands |
|---|---|---|---|
| Clone URL with the token in clear text | Main workspace clone: `5cdb253d` (2026-02-23), `docker exec … git clone '<url>'`. Shell-step clone: `89573d41` (2026-05-13), the same URL via `docker run`. Dependency checkouts: `8f1f4a82` (2026-08-21) | Main clone: `3397bff3` (2026-09-02), after which it carried the header until `d9365e26`. Dependency checkouts: `8e372963`. Shell-step clone: `3200071c` (its base fetch runs in the same script, using the `origin` the clone configured) | `docker exec`, `docker run` |
| Git header `AUTHORIZATION: basic <base64>` | `4763a611` (2026-07-21), as `-c http.extraheader='…'` on fetch and push; the main clone from `3397bff3` | `d9365e26` (workspace clone, fetch and push; the shell-step push) | `docker exec`, `docker run` |
| Registry-proxy token | `e0187a3f` (2026-10-20) emitted `-e YARN_NPM_AUTH_TOKEN=<token>`; `b248b650` (2026-10-20) added `-e COREPACK_NPM_TOKEN=<token>` | `c4d1a285` for the workspace container; `83dc2ff5` for the shell-step npmrc helper; `3200071c` for the shell-step sandbox | `docker run -e NAME=value` |
| Provider `apiBase` with a credential in its path | `2bcc49fd` (2026-10-03) | `3200071c` | `docker exec` |
| Container-step node inputs | `0e1d9b5b` (2026-06-18), `-e CONTAINER_STEP_INPUT=<json>`; a credential only if a workflow author routed one into a node input (below) | Not tied to a cited commit (below) | `docker run` |

The Kubernetes backend exists from `68b1dd23` (2026-10-21), so the Kubernetes entries cannot
affect an earlier build. A Docker worker built before the fix for a value is affected from that
value's first commit, not only recent builds. This repository cannot tell how long your own
deployment ran each build.

**Container-step inputs.** A build whose `containerStep.ts` passes `CONTAINER_STEP_INPUT` in
`secretEnv` keeps the node inputs out of `docker run` arguments; an older build put them there.
That change removes the value from the argv only: it is still in the container's configured
environment, so `docker inspect` shows it in `Config.Env` for as long as the container exists,
which matters most for a sidecar. The inputs are workflow data, so this exposes a credential only
if an author routed one into a node input. The top box's "built before `3200071c`" cutoff does not
cover this item: check the file in your build's source. Rotate any credential an input carried,
and search host command-line records for the input's text. Shell and container steps run on the
Docker backend only; the Kubernetes driver refuses them.

**What was not exposed.** Docker daemon API request bodies are not normally logged. The Docker
socket proxy shipped with this project (`infra/docker-socket-proxy/haproxy.cfg`) logs the HTTP
request line, not bodies. If you enabled daemon debug logging, an authorization plugin, or put a
body-logging proxy in front of the socket, check those logs too. The provider API key and the
platform's own secrets were never in an argument list.

**The Docker event stream and exec records.** The Docker daemon records the command of each
`docker exec` in its event stream (`docker events`, actions `exec_create` and `exec_start`, with
the command line in the action text), and `GET /exec/{id}/json` returns the process arguments
while the exec record exists. This is Docker behaviour this repository cannot test, so confirm it
on your version. Anything that subscribes to the stream and persists it (monitoring and security
agents, Falco, Portainer, cAdvisor, SIEM shippers) holds the same data as a command-line audit:
before `d9365e26` the header, and before `8e372963` and `3200071c` the clear-text token URL of the
commands those fixed. Treat that data like command-line audit data in the actions below.

**What still shows after the fixes.** The fixes name a variable in the Docker command
(`-e NAME`) and pass its value through the client's environment, which `ps` does not show. Three
things remain by design, listed in the Limitations of [`architecture.md`](./architecture.md):
`docker inspect` of a container shows the `Config.Env` it was created with, which includes the
registry-proxy token of a workspace; inside the container the git header is in the environment and
in git's argument list for the length of each call, which a host process audit also sees
([standing exposure](#standing-exposure-the-credential-in-a-workspaces-git-argument-list)); and a
shell step's clone helper shows the header to a host `ps` for the length of the clone.

**Exposure window and lifetime.** The seconds to minutes each command ran, per command. Lifetimes
are those in the quick reference.

**Actions.**

1. Upgrade the worker to a build containing `3200071c` (which contains the fixes in the table above, but
   not the container-step item).
2. Decide whether anyone or anything that could read process arguments on a worker host existed
   in the window, including a consumer of the Docker event stream. If so, rotate the PAT,
   per-host PATs and per-user tokens as in UN-1 steps 1 and 2. Process auditing of git inside the
   workspaces continues to record the header after the fix. An App installation token needs no
   rotation (see the quick reference for its caveat).
3. Search host command-line audit data and stored Docker events with the searches in
   [Recognising a hit](#recognising-a-hit) (`AUTHORIZATION: basic`, `eC1hY2Nlc3MtdG9rZW46`,
   `x-access-token:`; the URL-encoded spellings apply only where a log is URL-encoded); purge or
   redact per your retention policy.
4. If you ran shell steps with a registry, the shell-step sandbox token was also in `docker
   inspect` of that container while it existed. It is dead once the step ends.

**Verify the fix is running.** The worker contains `3200071c`. While a workspace command runs,
`ps -eo args | grep -F 'AUTHORIZATION: basic'` and `... | grep -F 'x-access-token:'` on the worker
host find no `docker` process that carries a value. A `git` process inside a workspace that carries the
header is the standing exposure; a `docker` process that carries a value, or a `git` process with a
clear-text token URL, is a failure. To check an event consumer, look for `ASW_GIT_AUTH` in the
stored exec event with no `basic <base64>` after it.

---

### UN-5. Provider API key inside the workspace

**Affected.** Claude Code agents (see [`agents.md`](./agents.md)) running with no model proxy
(`HARNESS_MODEL_PROXY_PORT` unset), on either backend:

- **Docker, at any commit.** The model proxy is optional on this backend and the key stays inside
  the workspace when it is off. This is current behaviour, not a fixed defect: no commit changes
  it. (The shipped compose files turn the proxy on; a deployment that does not use them may not.)
- **Kubernetes, with a worker built before `7cccdd43`.** From that commit the worker refuses to
  start without the proxy.

**What was exposed and where.** Without the proxy the harness gets the raw provider API key as
`ANTHROPIC_API_KEY` in its environment inside the workspace. On Kubernetes it reached the pod
through a stdin preamble, so it was not in any audit log or Pod object. Anything the agent ran in
that workspace could read it.

**Actions.** Configure the model proxy: set `HARNESS_MODEL_PROXY_PORT` and, on Kubernetes, a
`HARNESS_MODEL_PROXY_URL` that workspace pods resolve (a worker containing `7cccdd43` refuses to
start until both are set). See [`configuration.md`](./configuration.md),
[`deployment.md`](./deployment.md) and [`agents.md`](./agents.md). If the agents in those
workspaces ran code you do not trust (a target repository you do not control, a prompt-injected
run), rotate the provider key; configuring the proxy does not retire a key already read.

**Verify.** A Claude Code turn's harness receives the proxy's per-turn URL and token instead of
the provider key (`agents.md`).

---

### UN-6. GitHub credential kept alive by a background process

**Affected.** Both backends, with a worker image built from a commit that does not contain
`8e372963`. It matters when code you do not trust ran in the workspace after a credential-bearing
call.

**What was exposed and where.** The hardened configuration for the version-control client lacked
`gc.auto=0` and `maintenance.auto=false`, so a `fetch` or `commit` could spawn `maintenance run
--auto`, which detaches. The header is in that client's environment (`GIT_CONFIG_PARAMETERS`) for
the length of a call; the detached process kept it past the call, readable by anything the agent
ran afterwards through `/proc/<pid>/environ`. The commit that fixed it records the behaviour as
confirmed with `GIT_TRACE`. This repository cannot show whether it happened in your runs. The
credential is the one in UN-1: the platform credential or the token of the user who launched the
run.

**Actions.** If agents ran code you do not trust in a build before `8e372963`, rotate as in UN-1
steps 1 and 2. If not, nothing is needed beyond upgrading.

**Verify the fix is running.** The worker contains `8e372963`.

---

### UN-7. GitHub credential in the workspace's `.git/config`

**Affected.** `WORKSPACE_BACKEND=docker` (the Kubernetes backend exists only from `68b1dd23`),
with a worker image built from a commit that does not contain `4763a611` (the agent workspace) or
`6b4ee97e` (shell-step volumes). It matters when code you do not trust ran in such a workspace, or
when people outside your trust boundary can read stored traces or transcripts.

**What was exposed and where.** The clone left `https://x-access-token:<token>@host/...` as
`origin` in the workspace's `.git/config`, in clear text, for the workspace's whole life: from
`5cdb253d` (2026-02-23) until `4763a611` (2026-07-21) for the agent workspace, and from `89573d41`
(2026-05-13) until `6b4ee97e` (2026-08-21) for a shell step's volume. The agent, and any code it
ran, could read it. So could any command whose output printed the remote (`git remote -v`,
`git config --get remote.origin.url`, `cat .git/config`), and that output went into the model's
prompt and into the run's stored `AgentTrace` rows and agent transcripts
([`transcripts.md`](./transcripts.md)). Both stores mask a URL's userinfo at write time from
`9f59da0c` (2026-08-27); a row written before that commit has no such guarantee, the prompt was
never masked, and a mask is not a guarantee for any other spelling. Treat the stored traces and
transcripts of runs from an affected build as credential-bearing: restrict who reads them and
apply your retention policy to them. The credential is the one in UN-1.

**Actions.** If code you do not trust ran in a workspace from an affected build, or the traces and
transcripts are readable beyond your trust boundary, rotate as in UN-1 steps 1 and 2 (an App
installation token is dead after an hour). Purge or redact those traces and transcripts, and their
backups, per your retention policy.

**Verify the fix is running.** The worker contains `4763a611` and `6b4ee97e`. In a new workspace,
`git remote get-url origin` prints a URL with no `x-access-token:`.

### UN-8. Pull-request evaluation: migration and the steps that make it enforce

This entry is not a credential defect. It lists what an operator must do, on a deployment that ran
earlier code, for pull-request evaluation ([`pr-evaluation.md`](./pr-evaluation.md)) to take effect.

**Affected.** Every deployment whose gateway and worker images are built from a commit that contains
`7ddfd551`. A build before it has none of this.

**What changes.** A migration adds the table `pr_evaluations` and the column
`connections.pr_evaluation_mode`. The normal migrate step applies it (`prisma migrate deploy`, which the
gateway image runs before it starts); nothing is run by hand. The feature is **off**: nothing is evaluated and
no status is posted until an admin sets `prEvaluation.enabled`. No repository is in `auto` mode, and
`prEvaluation.autoMergeAllowed` is off.

**Actions.**

1. Apply the migration with the normal migrate step.
2. To use the feature, set `prEvaluation.enabled` at `/admin/platform-settings`, and make sure the
   GitHub App delivers `pull_request` and `pull_request_review` events.
3. To make approver counts bind, a repository admin marks the status context
   `auto-swe/pr-evaluation` (or the value of `prEvaluation.requiredStatusContext`) as a **required**
   check in branch protection or a ruleset. This binds only for a repository in `auto` mode;
   `advisory` always reports success.
4. For `auto` mode, additionally pin that required check to the platform's **GitHub App** (a personal
   access token cannot be pinned, so `auto` needs App credentials), and allow auto-merge on the
   repository. Until both are true `auto` is refused.

**Verify.** `auto-swe pr-policy status <repoId>` shows the mode and the last evaluation, and a
pull request the platform opened shows the status `auto-swe/pr-evaluation` on its head commit.

---

### UN-9. Pull-request evaluation: earlier evidence no longer counts toward `auto`

This entry is not a credential defect. It describes a tightening of the evidence gate
([`pr-evaluation.md`](./pr-evaluation.md) §9).

**Affected.** Every deployment with at least one repository in `auto` mode, or with evaluation rows
recorded before commit `a51c0b59`. A build before it counts every low-risk merge, whoever
approved and whichever repository it was in.

**What changes.** A migration adds the nullable columns `requester_id`, `changed_lines` and
`trusted_approvers` to `pr_evaluations`. The gate counts a row only when all three are recorded
(and the changed lines reach `prEvaluation.autoEvidenceMinChangedLines`, with at least one trusted
approval), and it also requires the repository's own merges
(`prEvaluation.autoMinRepoEvidence`) and several distinct requesters
(`prEvaluation.autoMinDistinctRequesters`). Rows written before this change hold NULL and no longer
count, so **a repository already in `auto` stops having new pull requests armed** until new evidence
accumulates. Its mode and its status checks are unchanged; only arming stops.

**Actions.**

1. Apply the migration with the normal migrate step.
2. Expect no arming on repositories in `auto` until the thresholds are met again from new merges,
   or lower the four evidence settings at `/admin/platform-settings` if the new defaults are too
   strict for the deployment. Lowering a threshold cannot revive old rows: they hold NULL and never
   count, and `autoMinRepoEvidence` has a floor of 1, so at least one new qualifying merge in the
   repository is needed. `auto-swe pr-policy status <repoId>` lists each unmet condition.
3. A pull request the platform armed before the upgrade **stays armed** until its next evaluation
   event, so GitHub may merge it in the meantime. To disarm them immediately, toggle
   `prEvaluation.autoMergeAllowed` off at `/admin/platform-settings`, which runs the disarm sweep.

**Verify.** `auto-swe pr-policy status <repoId>` shows the deployment and repository figures and
every unmet condition.

---

### UN-10. Pull-request evaluation: bot approval (migrations and the steps that turn it on)

This entry is not a credential defect. It lists what an operator must do, on a deployment that ran
earlier code, for bot approval ([`pr-evaluation.md`](./pr-evaluation.md) §16) to take effect. The
approval is **not on** after the upgrade.

**Affected.** Every deployment whose gateway and worker images are built from a commit that contains
`a51c0b59`. A build before it has no approver App and no bot approval.

**What changes.** Migrations add the singleton table
`github_approver_app` (`github_approver_app`), the column `connections.pr_evaluation_bot_approval`
(default false, with a CHECK that keeps it false unless the mode is `auto`,
`pr_evaluation_bot_approval`), the column `pr_evaluations.bot_approved` (default false,
`pr_evaluation_bot_approved`) and the column `github_approver_app.retired_app_slugs`
(`github_approver_retired_slugs`). The normal migrate step applies them (`prisma migrate deploy`, which
the gateway image runs before it starts); nothing is run by hand. Nothing else changes: no approver App
is configured, `prEvaluation.botApprovalAllowed` is off, and every repository's bot approval flag is
false, so the platform submits no approving review and no pull request merges on a bot approval.

**Actions.**

1. Apply the migrations with the normal migrate step.
2. To use bot approval, follow the setup in [`pr-evaluation.md`](./pr-evaluation.md#166-operator-setup):
   create a separate GitHub App with only *Pull requests: Read and write*, install it on selected
   repositories only, save its credentials at `PUT /api/v1/integrations/github-approver-app`, set the
   base branch's rules (the required status pinned to the platform App, at least one required review,
   dismissal of stale approvals), and then turn on, in order, `prEvaluation.enabled`,
   `prEvaluation.autoMergeAllowed`, `prEvaluation.botApprovalAllowed`, the repository's mode `auto` and
   the repository's bot approval. Try it on a test repository first, and read the evidence a fresh
   repository needs before it can reach `auto` in
   [`pr-evaluation.md`](./pr-evaluation.md#166-operator-setup).
3. Review `prEvaluation.botApprovalMaxLines`, `prEvaluation.botApprovalMaxFiles` and
   `prEvaluation.botApprovalPaths` before turning it on: the defaults (50 lines, 3 files,
   documentation and test paths) are the limits a change must meet.

**Verify.** `auto-swe pr-policy status <repoId>` prints a `Bot approval:` line that reads `off for this
repository (…)` for every repository until an admin turns it on (the parenthesis says whether the
deployment allows it and whether an approver App is configured), and `GET /api/v1/integrations/github-approver-app` reports it unconfigured.

---

### Device authorization codes require the new migration

**Affected.** A deployment that enables `mcp.deviceFlowEnabled` on a database that has not applied
`20261029132410_mcp_device_codes`.

**Action.** Apply the migrations before enabling the setting. The gateway expects Better Auth's
`device_codes` table, including its OAuth resource and client fields; do not enable the device flow
against an older schema. The normal deployment migration step applies this migration.

**Verify the fix is running.** The gateway and shared package contain `c4253ec2`, migration
`20261029132410_mcp_device_codes`, and the generated `DeviceCode` Prisma model.

---

### Reporting attribution backfill (`20261029130735_reporting_attribution`)

**Affected.** Deployments applying commit `265c2a938f0ca6df969a481643efcf00fae302b3` or a descendant
that has not yet applied `20261029130735_reporting_attribution`. The migration adds nullable
WorkflowRun team/organization attribution, PullRequest template/run attribution, and the HITL
resolution-source columns, then backfills existing workflow runs and repository-matched pull
requests.

**Expected cost.** Runtime scales with the number of stored workflow runs and pull requests. The
migration blocks writes to `workflow_runs` and `pull_requests` while the backfills run. Large
deployments should schedule a maintenance window or raise the migration session's statement timeout.

**Actions.** Nothing manual is required beyond the normal `migrate deploy`; the migration performs
both backfills. No historical HITL source is inferred, so existing resolution-source values remain
null.

---

### Workflow-run rollup history

**Affected.** Deployments applying the workflow-run rollup bucket-version migration.

The migration removes existing rollup rows because their duration buckets use the previous
format. The recompute horizon is rebuilt automatically. To rebuild older history, set
`WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS` to the desired number of days; until those days are rebuilt,
older report windows use live reads and remain subject to the live-row cap.

---

### Workflow-run dirty-day source indexes (`cad3fc2644fd6df8695141de668ce29b5e2fb3d4`)

**Affected.** Deployments applying this commit or a descendant that have not yet applied
`20261029201256_rollup_dirty_source_timestamps`.

**Expected cost.** The migration creates ordinary, transactional indexes on `workflow_runs`,
`pull_requests`, `workflow_steps`, and `agent_traces`. PostgreSQL holds write-blocking locks on
each table while its index is built. On large installations, schedule the migration during a
maintenance window when workflow, step, and trace writes can pause for the index-build duration.

**Actions.** No manual SQL is required. The standard migration deploy applies the indexes; the
worker uses them to find changed source rows for frozen rollup days.

### Reporting visibility rollup dimensions (`4d7b5af2`)

**Affected.** Deployments applying the report visibility rollup-dimension migration.

**Actions.** Set `WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS` to rebuild the desired history; until it is
rebuilt, older report windows use live reads. ORG_ADMINs do not receive organization-wide reports
or digests until the organization enables `analytics.orgWideReports`.

### Persisted workflow-run repository attribution (`fbb2266d`)

**Affected.** Deployments applying commit `fbb2266d` or a descendant that have not yet applied
`20261030170000_workflow_run_repo_attribution`.

**Expected cost.** The migration backfills repository attribution by rewriting `workflow_runs` and
blocks writes while it runs. Large deployments should schedule a maintenance window.

**Actions.** The standard migration deploy applies the backfill. The rollup bucket version changes,
so older report windows use live reads until they are rebuilt; set
`WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS` to the desired history. A platform ADMIN enables
`analytics.orgWideReports` per organization before ORG_ADMINs receive organization-wide reports or
digests for it.

---

### HTTP capture on by default, and the workspace egress proxy (`<fixing commit SHA>`)

**Affected.** Deployments that ran a build without `workflow.httpCaptureEnabled` (now `true` by
default) and that did not set it themselves, and deployments that set `EGRESS_PROXY_PORT` while
running an earlier build.

**HTTP capture.** Worker activity fetch metadata and capped, redacted bodies are now stored in
`workflow_http_calls` and kept for `workflow.httpCaptureRetentionDays` (default 90). Redaction is
best-effort, not a general PII scrub. If your data-handling policy does not allow storing
third-party request or response bodies for 90 days, set `workflow.httpCaptureEnabled` to `false` or
lower the retention in `/admin/platform-settings` before the upgrade reaches production, and purge
existing rows with the retention job or by hand. Rows written by an earlier build under the
non-JSON path were masked for credential shapes only; PEM keys and JWTs in them may be stored.

**Egress proxy.** With `EGRESS_PROXY_PORT` set, every agent workspace routes HTTP and HTTPS through
the worker proxy, and the team egress allowlist and the private-address guard apply to it. The
repository's own git host is excluded (`NO_PROXY`, which also covers its subdomains: `github.com` covers `api.github.com`), so clone, fetch and push go direct; any other
host a run reaches, including a dependency repository on a different host, needs an allowlist
entry. A GitHub Enterprise host on a private address no longer fails through the proxy for git, but
other traffic to private addresses is refused.

**Actions.** Decide the capture setting and retention before upgrading; add allowlist entries for
non-git hosts your workspaces need; no migration is involved.

**Verify the fix is running.** `NO_PROXY` in a new workspace contains the repository's host, and a
`git ls-remote origin` there succeeds with a restrictive team allowlist.

### Reporting rollups: built-day markers, first-sweep rebuild load and index builds (`<fixing commit SHA>`)

**Affected.** Deployments that applied `20261029201256_rollup_dirty_source_timestamps` or
`20261029195849_rollup_duration_buckets_and_dirty_days`, or that apply
`20261030180000_rollup_built_days`.

**What changes.**

- `20261030180000_rollup_built_days` adds the small table `rollup_built_days` and marks every day
  that already has workflow-run rollup rows. It runs after the rollup bucket-version migration,
  which removes all rows of the previous version, so on an upgrade from earlier code it seeds
  nothing. A built day with no runs has no rows, so a day is marked when the sweep rebuilds it:
  the recompute window on its next pass, older days through the backfill
  (`WORKFLOW_RUN_ROLLUP_BACKFILL_DAYS`, off unless set, at most ten days per sweep). Until a day is
  rebuilt it reads from live data, and a weekly digest that spans it records `rollup_incomplete`.
  The default recompute window (`WORKFLOW_RUN_ROLLUP_RECOMPUTE_DAYS`, 30) covers the 14 days a
  digest reads, so digests recover after the first sweep; the backfill matters only for older
  report history. Nothing is run by hand.
- `20261029201256_rollup_dirty_source_timestamps` stamps every existing `workflow_runs` and
  `pull_requests` row with the migration time in `updated_at`. The first sweep after it treats
  every historical run day as changed and queues them all; the sweep rebuilds at most 60 dirty
  days per sweep, oldest first, so a long history takes several sweeps and adds read load on
  `workflow_runs`, `pull_requests`, `workflow_steps` and `agent_traces` while it drains. Rollup
  results stay correct throughout; no action clears the backlog sooner.
- `20261029195849_rollup_duration_buckets_and_dirty_days` builds plain (not concurrent) indexes on
  `workflow_runs(ended_at, started_at)`, `pull_requests(merged_at, run_id)`,
  `pull_requests(closed_at, run_id)` and `workflow_human_steps(resolved_at, run_id)`. PostgreSQL
  blocks writes to each table while its index is built. The indexes that
  `20261029201256_rollup_dirty_source_timestamps` builds, including the ones on `agent_traces` and
  `workflow_steps`, are described in the entry "Workflow-run dirty-day source indexes" above. A
  migration that has to run in a transaction cannot build any of these concurrently, so the
  supported route is a maintenance window with the gateway and worker stopped, or a raised
  `statement_timeout` on the migration session. Do not create these indexes by hand beforehand: the
  migration then fails on the existing name.

**Actions.** Apply the migrations with the normal migrate step, in a window sized for all of the
index builds above.

---

### UN-11. Kubernetes worker refuses to start on an unreachable proxy URL

**Affected.** `WORKSPACE_BACKEND=kubernetes`, with a worker built from a commit that contains this
check, and any of these: `REGISTRY_PROXY_PORT` set with no `REGISTRY_PROXY_URL`;
`EGRESS_PROXY_PORT` set with no `EGRESS_PROXY_URL`; or a model, registry or egress proxy URL that
names the Docker host alias, contains `{hostname}`, or names a loopback or unspecified host
(`localhost`, `127.0.0.0/8`, `[::1]`, `0.0.0.0`).

**What changes.** The worker exits at boot, naming each variable. These setups were already
broken at run time: an unset URL defaults to the Docker host alias, which does not exist in a
cluster, and from a workspace pod a loopback host is the pod itself, so package installs through
the registry proxy and outbound HTTP(S) through the egress proxy failed. Nothing was exposed.

**Actions.** Set each URL to a Service name workspace pods resolve, and allow the proxy ports in
the workspace namespace's NetworkPolicy (`infra/kubernetes/workspace-namespace.yaml` allows 8790,
8791 and 8792). To run without the registry or egress proxy, unset its port. See
[`deployment.md`](./deployment.md).

**Verify.** The worker boots. The check validates the URL's host, not that the Service exists.

---

### UN-12. Kubernetes workspace namespace: re-apply the manifest for egress policies `blocked` and `restricted` (`7fd21a8b`)

**Affected.** `WORKSPACE_BACKEND=kubernetes` deployments that applied
`infra/kubernetes/workspace-namespace.yaml` before this commit and run agents or workflows under
egress policy `blocked` or `restricted`. On the Docker backend only the helper-image note below
and the rollout order below apply.

**What changes.** The manifest gains two NetworkPolicies, `workspace-egress-blocked` (DNS and the
worker's model and registry proxy ports) and `workspace-egress-restricted` (the same plus the
egress forwarding proxy port, admitted by selecting the worker pods), an
`asw/egress NotIn [blocked, restricted]` selector on `workspace-egress`, and `patch` on pods and
`create` on networkpolicies in the worker's Role. A workspace the worker locks is labelled
`asw/egress=blocked` or `asw/egress=restricted`, which moves it from the broad policy to the
matching narrow one, and the worker adds a policy of its own for the addresses the allowed hosts resolve to. Both
`blocked` and `restricted` agent runs lock their workspace at the network layer, so both need
the new manifest and RBAC. Without the new manifest the label changes nothing: the lock check from
inside the pod still reaches the internet, and the run fails closed. Only runs with policy `open`
are unaffected.

On the Docker backend the lock runs `iptables` and `ip6tables` in a helper container
(`WORKSPACE_METADATA_BLOCK_IMAGE`, default `alpine:3.20`) and installs both with `apk` when the
helper image lacks either. The install path is apk-only: a non-Alpine helper image, or an offline
deployment whose helper cannot reach a package mirror, needs an image that already has both:
set `WORKSPACE_METADATA_BLOCK_IMAGE` to one.

**Actions.** Re-apply the manifest (keeping your adjusted worker namespace, labels and proxy ports
in all three policies), then confirm a locked run starts. On every backend, roll the workers out
before the gateway: an older worker neither pins `workspace.egressPolicy` nor reads the
`egressPolicy` launch field, so a `blocked` or `restricted` run starts with its network open.

**Verify.** `kubectl -n auto-swe-workspaces get networkpolicy workspace-egress-blocked workspace-egress-restricted`,
and `kubectl auth can-i patch pods` and `kubectl auth can-i create networkpolicies` as the worker's
ServiceAccount answer `yes`.

---

### Repository-backed knowledge bases: migration and default-on indexing (`78fb6827`, `1ca52a51`)

**Affected.** Deployments whose database does not contain migration
`20261106130000_repo_knowledge_bases`, or whose gateway/worker predates KB workflow registration.

**What changes.** The migration adds KBs, shares, links, snapshots and vector chunks, plus run
override/pinning fields. KB vector search uses snapshot-scoped exact cosine scans, not an HNSW
index. Gateway startup synchronizes a default-on
Temporal indexing sweep. With no configured KBs the sweep has nothing to index; configured KBs
can consume SCM requests and embedding-provider usage.

**Actions.** Back up the database and apply the normal `yarn db:deploy` migration rollout before
starting code that reads these tables. Use PostgreSQL with pgvector and regenerate Prisma clients
when building from source (`yarn db:generate`). Roll out compatible workers before the gateway
starts KB workflows. Set `KNOWLEDGE_BASE_SYNC_ENABLED=false` before gateway startup if automatic
periodic indexing is unwanted; otherwise the default cron is `*/30 * * * *` (UTC). Restart the
gateway to apply environment changes. This switch controls the sweep, not manual, push or
run-start indexing. See [knowledge-bases.md](./knowledge-bases.md).

**Verify.** The migration is applied; the gateway and worker boot with KB workflow/activity
registration, and the Temporal schedule `auto-swe-knowledge-base-sync` matches the enabled/cron
configuration. For a configured KB, request reindexing and inspect its snapshot status before
relying on provider connectivity.

---

### UN-13. App preview recipes: secret values in `previewConfig.env`

**Affected.** Deployments with a repository whose app preview recipe holds a secret (an API key, a
database password) under `env`. Those values are stored as plain JSON on the connection and shown
to anyone who can open the repository form.

**What changes.** A recipe can name the repository's encrypted setup secrets under `secrets`; the
preview's commands receive them as `env` values were received. `env` keeps working unchanged, and
nothing is moved automatically. The migration `20261106220000_eval_dataset_setup_secrets` (an
optional repository link on eval datasets) applies with the normal rollout.

**Actions.** For each such repository, open it in the dashboard and choose **Move env values to
setup secrets** under App preview (or `POST /api/v1/repositories/:id/preview/env-to-secrets`), then
rotate any credential that was ever stored in `env`, since it may already have been read. Roll the
workers out before using `secrets` in a recipe: an older worker ignores the field, so the preview
starts without those variables.

**Verify.** The repository's recipe shows no `env` values that are secret, and its setup-secrets
panel lists the moved names.

### UN-14. Short setup secrets and secret-looking preview `env` values stop working

**Affected.** Deployments with a repository setup secret shorter than 8 characters, or with an app
preview recipe whose `env` has a secret-looking name or value (see
[ui-validation.md](./ui-validation.md)).

**What changes.** A workspace setup that names a setup secret shorter than 8 characters fails with
`WORKSPACE_SETUP_FAILED` before any step runs, and saving a shorter value is refused. A preview
whose recipe still has a secret-looking `env` value fails to start with `PREVIEW_ENV_LOOKS_SECRET`,
and saving such a recipe is refused. No migration is needed.

**Actions.** Before rolling out, replace each short setup secret with a value of at least 8
characters (rotate the credential if it allows a longer one), and move secret-looking preview `env`
values with **Move env values to setup secrets** under App preview, or
`POST /api/v1/repositories/:id/preview/env-to-secrets`. Rotate anything that was stored in `env`.

**Verify.** Every repository's setup-secrets panel accepts its saved values, and the App preview
form shows no move prompt.

### UN-15. Random-looking preview `env` values, processes left by setup steps, and ORG eval dataset links

**Affected.** Deployments with an app preview recipe whose `env` holds a value that looks randomly
generated (a key, a commit SHA, a UUID; see [ui-validation.md](./ui-validation.md)); with a
workspace setup whose steps start a process meant to keep running; or with an ORGANIZATION eval
dataset linked to a repository outside its organization.

**What changes.** Such a preview fails to start with `PREVIEW_ENV_LOOKS_SECRET`, and saving its
recipe is refused, until the value is moved to setup secrets or its key is listed under
`publicEnv`. Every process the setup steps leave running is now stopped before the agent runs, also
when setup names no secrets. Linking an ORGANIZATION dataset to a repository outside its
organization is refused; an existing such link keeps working until it is changed. No migration is
needed.

**Actions.** Before rolling out, open each repository's App preview form: move a value that is a
secret with **Move env values to setup secrets**, and add the key of one that is not to
`publicEnv`. Move a long-running process a setup step starts into `services`. Review the
"Setup secrets from" repository of each ORGANIZATION eval dataset.

**Verify.** The App preview form shows no move prompt, and the repository's workspace setup
succeeds.

---

### UN-16. Built-in workflows use `storeAs`, `onFailure`, `status` and `maxVisits` (`674c0e10`)

**Affected.** Any deployment where the gateway can run newer code than the worker, even briefly:
the gateway syncs the built-in templates at start-up, and a worker built before `674c0e10`
ignores the four new node fields.

**What changes.** The built-in templates are re-versioned with fewer nodes. A worker that does not
know the fields runs the new specs wrongly: `storeAs` is dropped (review and pull-request steps get
no code result), the review, CI and sign-off loops have no attempt limit, and `onFailure` routes
become blocking failures. A run started in that window also replays differently once the worker is
upgraded. Runs started before the sync pin the older template version and are unaffected. An
installation whose `workflowAuthor` agent prompt was edited keeps its edit and does not learn the
new fields. No migration is needed.

**Actions.** Upgrade the worker before, or together with, the gateway. If the gateway ran first,
cancel and re-run any run started from a built-in template since, rather than letting it continue.
To give a customised `workflowAuthor` the new fields, re-apply the built-in prompt from the agent
library.

**Verify.** `printenv COMMIT_HASH` in the worker container names a commit that contains
`674c0e10` (section 1), and a new `ticket-to-merge` run stops its review loop after the configured
number of rounds.

---

### UN-17. Generic steps on connection types with no implementation now fail

**Affected.** Deployments with a custom template or bundle whose generic `readSource`,
`writeOutcome` or `runTool` step targets a connection of type `http_api`, `hubspot` or `mcp`, a
`git_repo` or `notion` `runTool`, or a `slack_workspace` `readSource`; or an input schema with an
`http_api` or `hubspot` connection field.

**What changes.** Those steps used to report success without acting. They now fail with the
non-retryable `CONNECTOR_NOT_IMPLEMENTED`, and saving a template whose input schema declares an
`http_api` or `hubspot` connection field is refused. Steps that already ran keep their recorded
outcome. No migration is needed.

**Actions.** Audit custom templates for the pairings above. Replace a step that never acted with
the `mcp` node or another implemented connector, or remove it.

**Verify.** A run of the template no longer ends in `CONNECTOR_NOT_IMPLEMENTED`.

---

### Epics and PRD runs need team LEAD on each owning team (`8ed7461f`)

**Affected.** Deployments whose API or CLI callers start epics (`POST /api/v1/epics`) or PRD runs
(`POST /api/v1/prd-runs`) as a platform LEAD who is only an ENGINEER on the team that owns one of
the named repositories, or who reach a repository only through a share.

**What changes.** The server now requires team LEAD or team ADMIN membership of the owning team of
every repository the epic or PRD run names, beside the platform LEAD role. A caller without it gets
`403 FORBIDDEN`, whose `message` and `error.reasons` (`team-lead-required`) name the repositories.
The dashboard already offered the epic mode to leads only. A platform ADMIN is unaffected. No
migration is involved.

**Actions.** Grant the caller team LEAD on the owning team, or have a team lead launch the epic or
PRD run. Check automation that starts either under a service account.

---

### Organization budget dollars are ORG_ADMIN's; members read a percentage (`8ed7461f`)

**Affected.** Deployments whose API, CLI or script consumers read an organization's budget as a
plain ORG_MEMBER, or parse the `402 ORG_BUDGET_EXCEEDED` body for the cap.

**What changes.** `GET /api/v1/platform/organizations/:orgId/budget` now requires ORG_ADMIN (or
platform ADMIN). For an ORG_MEMBER, `GET /api/v1/platform/organizations/:orgId` omits
`monthlyBudgetUsdCents`, and `GET /api/v1/platform/organizations` omits `monthlyBudgetUsdCents` and
`currentMonthUsage` from rows where the caller is not an ORG_ADMIN. The `402 ORG_BUDGET_EXCEEDED`
body (and a schedule's refusal reason) no longer states the cap in cents; the code is unchanged.
`GET /api/v1/platform/organizations/:orgId/budget/status` is new and open to any org member: it
returns `state`, `percentUsed` and `alertThresholdPercent`, with no amount. The same `/api/v1/admin/organizations`
aliases follow. A non-ORG_ADMIN's `alert.percent` is rounded to one decimal. In
`GET /api/v1/teams/:teamId/overview`, `admin.monthCostUsdCents` is absent for a team ADMIN who is not
an ORG_ADMIN of a capped organization. An organization-scope report digest carries the budget in
dollars only when its creator is still an ORG_ADMIN (or platform ADMIN) and every target is an email
to an ORG_ADMIN; otherwise its budget section is a state and a percentage. No migration is involved.

**Actions.** Make consumers that need the cap or the spend act as an ORG_ADMIN, or move them to the
status endpoint; stop parsing the cap out of the 402 message. For a digest that should carry
dollars, make its creator an ORG_ADMIN and send it by email to ORG_ADMIN recipients only.

---

### UN-18. Built-in templates carry macro metadata and are re-versioned (`2899bcb0`)

**Affected.** Any deployment with a built-in template in a running A/B experiment, or with
reporting that compares a built-in template version over time.

**What changes.** The gateway syncs the built-in templates at start-up, and every one built on the four macro helpers gains a
`uses` map and `use` node tags (metadata only; the nodes are unchanged), so each is appended as a new
version. A template whose latest version is its previous built-in version is activated on the new
one. A template in a live experiment stays on its old version, and the start-up log warns. Version
history and per-version analytics split at the sync. An older gateway or worker reads the new specs
and ignores the metadata, so a mixed-version deploy runs the same graph.

**Actions.** For each built-in template in an experiment, end or promote the experiment, then
promote the new version. Nothing else needs to be done.

**Verify.** The template's active version in the library is the newest built-in version.

---

### Review routing: a repository override can only tighten, and the queue follows the host's head (`<fixing commit SHA>`)

**Affected.** Deployments with a stored `connections.review_routing` override that is looser than
the team or organization `prEvaluation.humanMinRisk`, `humanAboveLines`, `humanPaths`,
`humanSkipsBotApproved` or `quickReviewMaxLines` setting (an ADMIN could write one), or whose
repository is read by the attention queue (`GET /api/v1/pull-requests?order=attention`) while
evaluation is off for it.

**What changes.** An override is now combined with the setting by taking the stricter value, so a
looser value stored earlier stops having any effect, and the repository follows the setting for that
key. A pull request whose repository has evaluation off (the feature switch, the repository's mode
or its deactivation) reads `not_evaluated` instead of from a stored evaluation. A new nullable
column, `pull_requests.host_head_sha` (migration `20261110000300_pull_request_host_head`), records
the head the host reports from `synchronize` webhooks, the platform's own pushes and every
evaluation that lands; it is filled as they arrive and needs no backfill. Until a row has a value
the queue compares the platform's own head, so a person's push to a pull request that has no value
(a deployment that receives no `synchronize` webhooks, such as one waiting for CI by polling, or a
row older than the column) is not seen by the queue until the next evaluation of that pull request
lands; an evaluation of the old head still counts until then. Evaluation rows written before
`pr_evaluations.human_objection` exist read as no recorded objection, so a request for changes
recorded earlier counts only through the row's changes-requested count. Glob entries in `prEvaluation.humanPaths` or an override that can never match (a leading
`./`, `/` or `!`, a backslash, a trailing `/`) are refused when written; an entry already stored
that way is still stored and still matches nothing.

**Actions.** Apply the migration (`yarn db:deploy`). To keep a looser routing for a repository,
change the setting at its team or organization scope: the override cannot do it. Review stored
`humanPaths` entries for the spellings above and rewrite them (`infra/` becomes `infra/**`).

---

### UN-19. `vulnerability-remediation` declares an input schema

**Affected.** A deployment whose global `vulnerability-remediation` template was seeded by a build
without the migration `20261110000000_event_endpoint_fixed_type`, which ships in the same change.
The migration is the marker: before the upgrade it has no row in `_prisma_migrations`, and after
it the template predates it when

```sql
SELECT t.created_at < m.finished_at AS seeded_before
  FROM workflow_templates t, _prisma_migrations m
 WHERE t.name = 'vulnerability-remediation' AND t.team_id IS NULL
   AND m.migration_name = '20261110000000_event_endpoint_fixed_type';
```

returns `true`. Such a deployment is affected if any of these holds:

- an admin saved an `inputSchema` on it by hand (to let an automation start it);
- it is archived, is running an A/B experiment, or is active on a version an admin saved rather
  than its latest built-in version;
- something launches it through `POST /api/v1/workflow-templates/:id/runs` with a payload that
  names `packageName`, `vulnerableVersions`, `fixedVersions`, `severity`, `advisoryId` or `budget`
  with a value of another type, a `severity` other than `critical`, `high`, `medium` or `low`, a
  `packageName`, version or `advisoryId` longer or with other characters than §2 of the
  maintenance doc allows, or no `connectionId`.

A deployment with none of these needs nothing.

**What changes.** The template declares its run inputs ([maintenance-workflows.md](./maintenance-workflows.md)
§2): the SWE inputs, with only `connectionId` required, and five optional advisory fields an
`inbound.event` automation can map. At gateway start-up, sync fills the schema into a stored row
that has none, whether or not the template's spec changed, but only while the template is active
on its latest built-in version with no A/B experiment running. A schema already stored is never
replaced, so one an admin saved by hand stays as it is and does not gain the shipped fields. The
spec also changes (the remediation prompt names the advisory fields), so a new built-in version is
appended and activated on the same terms; runs already started keep the version they pinned. The
template change needs no manual step. The same change adds the migration
`20261110000000_event_endpoint_fixed_type` (a nullable `fixed_type` column on event endpoints and
its check constraint); the deployment's usual `prisma migrate deploy` step (`yarn db:deploy`)
applies it, and existing endpoints keep their stored type pointer with no action.

**Actions.**

1. If an admin saved a schema by hand, compare it with the shipped one in
   `packages/shared/src/workflow/templates/vulnerabilityRemediation.ts`; to adopt the shipped one,
   save it over yours with `PATCH /api/v1/workflow-templates/:id`.
2. If the template is archived, experimenting, or on an admin's version, save the shipped schema
   the same way when you want automations to start it.
3. Fix any launcher whose payload the new schema refuses.

**Verify.** `GET /api/v1/workflow-templates/:id` for the template returns an `inputSchema` naming
`packageName`, and the template is offered when an inbound-event automation is created.

---

### UN-20. Input schemas enforce `pattern` and `maxLength`

**Affected.** A deployment upgrading from a build without the migration
`20261110000000_event_endpoint_fixed_type` (it ships in the same change: before the upgrade it has
no row in `_prisma_migrations`), with a workflow template, global or a team's, installed from a bundle or saved by hand, whose
stored `inputSchema` gives a property (or an array's `items`) a `pattern` or a `maxLength`. Earlier
builds ignored both keywords, so a schema copied from JSON Schema could carry them unnoticed. A
deployment with no such template needs nothing.

Find them in the database (a property that is itself named `pattern` or `maxLength` also matches;
read each hit):

```sql
SELECT id, name, team_id, status FROM workflow_templates
 WHERE input_schema::text ~ '"(pattern|maxLength)"';
```

A fresh launch validates against the template's own schema, so these rows are the ones to fix.
Each template version also keeps a snapshot of the schema it was created under, and only a retry
of a recorded run (`POST /api/v1/work-requests/:id/retry`) validates against that snapshot. The
snapshot cannot be edited, so a hit there needs no action beyond knowing that a retry of a run on
that version is refused: start a new run instead. To list them, for information only:

```sql
SELECT template_id, version FROM workflow_template_versions
 WHERE input_schema::text ~ '"(pattern|maxLength)"';
```

For a bundle not yet reinstalled, search its template files for the same two keys.

**What changes.** Both keywords are now checked at launch, on every path that validates a run's
inputs (a hand launch, a work request, a template webhook, Slack and an automation). This fails
closed:

- `maxLength` is enforced: a longer value is refused.
- A `pattern` is run only if it is within the accepted subset ([automations.md](./automations.md)):
  no groups, alternation, backreferences or lookaround, at most one quantifier whose count varies,
  at most 200 characters, a `maxLength` of at most 256 beside it, and at most 8 properties with a
  `pattern` in one schema. A stored pattern outside the
  subset is never run, and **every** launch that supplies the field is refused with
  `'<field>' cannot be checked: the template's input schema declares a pattern this platform does
  not run`. A pattern on an array's `items` is not supported at all and refuses the field the same
  way.
- Saving such a schema (`PATCH /api/v1/workflow-templates/:id`) and installing a bundle that
  carries one are refused, with a message naming the property and the rule.

**Actions.** For each template the query finds, fix its schema: rewrite the pattern within the
subset (for example `^(CVE|GHSA)-\d+$` becomes `[A-Z][0-9A-Za-z-]*`, which has one varying
quantifier), drop an
`items.pattern` (constrain items with `enum` or `maxLength`), and keep `maxLength` at or below 256
beside a pattern. Save it with `PATCH /api/v1/workflow-templates/:id`, or fix the bundle and
reinstall it. Then fix any launcher that sends a value the corrected schema refuses.

**Verify.** The `PATCH` succeeds, and a launch with a conforming value starts a run instead of
answering `cannot be checked`.

---

### UN-21. Docker workspace private-network baseline and optional disk quota

**Affected.** Docker deployments whose workspaces reach internal hosts other than the repository
git host, configured DNS or worker proxies. Also affected: deployments whose metadata helper
image cannot install or run iptables/ip6tables. Kubernetes deployments need no action.

**Fix commit.** Identified before its SHA is assigned by `buildBaselineEgressScript` and
`assertBaselineEgress` in `packages/worker/src/lib/workspaceBackend/docker.ts`; compare the source
when commit ancestry is unavailable.

**Actions.** Set `WORKSPACE_PRIVATE_EGRESS_ALLOW` to the narrow IPv4/IPv6 addresses or CIDRs
needed by other internal services. Leave `WORKSPACE_BLOCK_PRIVATE_EGRESS` and
`WORKSPACE_BLOCK_METADATA` enabled. Ensure `WORKSPACE_METADATA_BLOCK_IMAGE` is available and
contains iptables and ip6tables; preinstallation avoids package-mirror access per workspace.
The helper must succeed: failure no longer permits an unprotected workspace to run.
If setting `WORKSPACE_DISK_LIMIT`, provision a quota-capable Docker storage driver (overlay2
requires XFS with pquota); the worker refuses to start if its probe cannot enforce the limit.

**Verify.** A workspace starts, reaches its git host and intended internal exceptions, and cannot
reach an unlisted private host or a cloud metadata address. With a disk limit configured, worker
startup completes the storage-opt probe.

---

### UN-22. Docker disk limits reject drivers that silently ignore storage-opt

**Affected.** Docker deployments setting `WORKSPACE_DISK_LIMIT` with the containerd `overlayfs`
driver or another driver outside overlay2, devicemapper, btrfs and zfs. A successful
`docker run --storage-opt size=...` alone does not establish enforcement on those drivers.

**Fix commit.** Identified before its SHA is assigned by the supported-driver check in
`assertDockerDiskLimit` in `packages/worker/src/lib/workspaceBackend/docker.ts`; compare the
source when commit ancestry is unavailable.

**Actions.** Provision a supported storage driver (overlay2 needs XFS with pquota), or unset
`WORKSPACE_DISK_LIMIT` and accept that writable layers have no application-configured cap.
The worker refuses startup when the probe container's driver is unsupported or cannot be read.

**Verify.** Worker startup with the limit configured succeeds only on a supported driver.
An unsupported `overlayfs` driver produces a `WORKSPACE_DISK_LIMIT cannot be enforced` error.

---

### UN-23. Docker egress shell and container steps receive the private-network baseline

**Affected.** Docker deployments with shell or container steps using `network: egress` that reach
internal hosts, including detached container-step sidecars. Kubernetes deployments need no action:
ephemeral steps and detached container-step sidecars are unsupported there.

**Fix commit.** Identified before its SHA is assigned by `ephemeralNetworkHolderArgs` and
`prepareEphemeralNetwork` in `packages/worker/src/lib/workspaceBackend/docker.ts`; compare the source
when commit ancestry is unavailable.

**Actions.** Set `WORKSPACE_PRIVATE_EGRESS_ALLOW` to the narrow IPs/CIDRs needed by internal
destinations other than configured DNS and wired worker proxies. A DNS hostname allowlist entry
alone does not permit a private address. Ensure `WORKSPACE_METADATA_BLOCK_IMAGE` can run `sleep`
and that the baseline helper can install or run iptables/ip6tables. Baseline installation or
verification failure prevents author code from starting. Keep private and metadata blocking enabled.

**Verify.** An egress step reaches public hosts and intended exceptions, rejects private peers and
metadata, preserves its output and exit code, and leaves no network holder after teardown. A detached
sidecar remains reachable through its loopback-published holder port until teardown.

---

### UN-24. Docker agent workspaces use UID/GID 1000 by default

**Affected.** Docker deployments whose repository setup scripts or custom executor images need
root for repository code. The bare `node:24-alpine` default needs no image change: the worker installs
git and bash during trusted preparation, before clone/setup/agent execution. The code
marker is `WORKSPACE_RUN_AS_ROOT` in the workspace configuration and `--user 1000:1000` in the
Docker workspace driver. Kubernetes and shell/containerStep image users are unchanged.

**Actions.** Build additional OS dependencies into the executor image, and make application
files writable by UID/GID 1000. Images without apk/apt-get must include git and bash; curated images
already do. Fix setup scripts to install
dependencies into the checkout or HOME, without sudo or system package installs. The worker prepares
the workspace directories and sets `HOME=/workspace/.home`; dependency caches from another UID or
HOME are not reused. To retain legacy image-defined user, HOME and copy behavior while adapting an
image or script, set exactly `WORKSPACE_RUN_AS_ROOT=true` on the worker and restart it. This preserves
the image's USER: an image that selects a non-root user stays non-root. Root bootstrap authority is
revoked before handing off the workspace and cannot be restored after ordinary execution.

**Verify.** Start a real agent workspace, run `id -u; id -g` (both 1000 without the opt-out), write a
file under `$HOME`, run the repository setup, edit and commit a tracked file, then export and read
the diff. With the opt-out, verify the image's expected UID instead. Confirm trusted delivery can
import and commit the exported tree. Remove the opt-out after adapting root-dependent images/scripts.

---

### UN-25 — Restricted shell/container steps bypassed the proxy with direct sockets

**Affected condition.** Docker deployments running `shell` or `containerStep` nodes with
`network: "egress"`, `workspace.egressPolicy=restricted` and a non-empty team allowlist, where the
command or detached sidecar uses raw sockets or `--noproxy` to reach a public host directly.

**Fix commit:** `b28e9bd4` — restricted step network holders receive a verified proxy-only lock
before author code starts. Only the wired egress and registry proxies are outbound exceptions;
the allowlisted destination itself is not directly reachable.

**Action.** Configure commands and sidecars to honor `HTTP_PROXY` / `HTTPS_PROXY`. Raw TCP clients
need explicit proxy CONNECT support. A sidecar's published-port request/reply path remains
available, but does not grant arbitrary outbound access. `open`, `blocked`, and empty-allowlist
behavior is unchanged.

**Verification.** In a restricted egress step, use `curl --proxy "$HTTP_PROXY"` to an allowlisted
HTTP URL and confirm success. A raw public-IP TCP connect and
`curl --noproxy '*' --connect-timeout 3 https://1.1.1.1/` must fail. The execution event records
`egress (allowlist via proxy; network-locked)`. A missing proxy or unprovable strict lock refuses
the step before author startup.

### Organization GitHub connections (`8d4d3a64`)

**Affected.** Deployments applying commit `8d4d3a64` or a descendant that use an existing GitHub
App without OAuth during installation or with a Setup URL instead of the organization callback.

**Actions.** In the instance GitHub App's settings, enable **Request user authorization (OAuth)
during installation**. GitHub disables the Setup URL in this mode. Set the first user-authorization
Callback URL to `<WEB_URL>/github/install/callback`; preserve any other callbacks needed by the App.
Keep the App's client ID, client secret and private key configured in the platform. The web and API
URLs must use HTTPS and belong to the same GitHub host family; the gateway verifies the App's slug
through `GET /app`. The manifest creates a private App: an operator who wants installations on
other GitHub accounts changes its installation availability to **Any account**.

The standard migration deploy adds the nullable, indexed installation-to-organization link with
`ON DELETE SET NULL`. Existing installations remain unlinked and available across organizations.
Platform admins link or unlink installations through the installation editor; the confirmation
shows the count of existing repositories whose teams belong to another organization.

**Verification.** An organization admin connects a new, unregistered installation from the
organization's GitHub section and confirms the OAuth callback. A registered installation cannot
be claimed again; a platform admin changes its link instead. A callback without organization
state returns to the existing admin installation form. Existing repositories continue working
after linking, including repositories owned by teams outside the linked organization. Links scope
only new imports and installation changes, not runs. See [GitHub App setup](./github-app-setup.md#connecting-an-organization)
for the self-service flow and its limitations.

---


## 4. If you cannot tell

If you cannot establish which commit your workers ran, whether per-user credentials were on,
or whether anything logged command lines: rotate first, then clean up.

1. Rotate the PAT, every per-host PAT, and ask users to rotate their own tokens (UN-1 steps 1 and
   2); treat stored traces and transcripts as credential-bearing (UN-7). An App needs no rotation (see the quick reference for its caveat).
2. Rotate any provider `apiBase` token (UN-3).
3. Upgrade the worker to a build that contains `3200071c` and, on Kubernetes, apply the RBAC in
   `infra/kubernetes/workspace-namespace.yaml`.
4. Purge or redact audit entries and command-line records that match the patterns above, per
   your retention policy. If the logs are immutable or held for compliance, record that they
   contain credentials that have been revoked, and restrict who can read them.

---

## 5. How these notes are maintained

A change that needs an operator to act on a deployment that ran earlier code adds an entry here
in the same change. That covers rotating a credential, purging logs, running a migration by hand,
and changing configuration. An entry is keyed by the condition that makes a deployment affected and
by the SHA of the fixing commit. An entry states conditions and facts in the present tense, not a
history of the change; it is corrected by adding a note or a new entry, not by rewriting what an
operator may already have acted on.

---

### UN-24. Automation template kinds require the widened database constraint

**Affected.** Deployments whose `workflow_templates_kind_check` accepts only null or `review`.

**Fix commit.** Identified before its SHA is assigned by the migration
`20261112040227_automation_template_kind`; compare the source when commit ancestry is unavailable.

**Actions.** Apply `yarn db:deploy` before starting the updated gateway or running `yarn db:seed`.
The migration widens the CHECK constraint to accept `automation`. The built-in sync fills null
kinds on CI triage, PR feedback and Channel Task without changing explicit kinds or workflow versions.
Starting the gateway before applying the migration fails during that sync.

**Verify.** The gateway health endpoint returns 200. CI triage, PR feedback and Channel Task carry
`kind: "automation"` and have no hand-launch action; integrations and the run API still launch them.

---

### UN-26. Existing repository preview files become active configuration

**Affected:** A connected repository already contains `.auto-swe/preview.yml` on its trusted base
branch, has no connection `previewConfig` override, and uses UI verification or a browser-enabled
agent. Previously ignored files supply the preview recipe, including service images and commands.

**Action:** Review that file before running previews. Remove or rename a stray file if it is not
intended to configure previews, or set an explicit connection recipe to override it. Invalid files
fail preview resolution instead of behaving as an unconfigured repository.

**Source marker:** `resolveRepoPreview` in `packages/worker/src/lib/repoConfigResolver.ts` reads
`REPO_PREVIEW_FILE` when the connection recipe is unset.

### Team members require organization membership backfill

**Affected.** Deployments with team memberships whose users have no membership in the team's
organization.

**Fix commit.** Identified before its SHA is assigned by migration
`20261112180000_team_member_organizations`; compare the source when commit ancestry is unavailable.

**Actions.** Run `yarn db:deploy` before starting the updated gateway. The migration inserts missing
`ORG_MEMBER` rows without changing existing organization roles. It is idempotent and leaves HNSW
indexes unchanged. Review the resulting organization access: existing team members gain organization
membership. Sign-up and platform user-invite default-team enrollment also ensure organization
membership transactionally and preserve existing roles. Organization removal does not cascade to teams.

**Verify.** Every existing team member has an organization membership for that team's organization
immediately after the migration; a later organization removal can leave a team membership behind.

### Trusted organizations also approve team invitations

**Affected.** Deployments with `Organization.trustedInvites` enabled on any organization.

**Fix commit.** Identified before its SHA is assigned by the shared `inviteUser` helper and
`POST /api/v1/teams/:id/members/invite`; compare the source when commit ancestry is unavailable.

**Actions.** Review the organization's team leads and team admins before deploying the gateway.
Trust covers their team invitations as well as organization-admin invitations while the organization
is active. Clear `trustedInvites` through `PATCH /platform/organizations/:orgId` before upgrading
if those inviters must not approve new accounts. Platform ADMIN invitations approve regardless of trust.

**Verify.** An invitation from a team lead in an active trusted organization records approval source
`team_lead`. With trust cleared, that invitation creates an inactive account in the approval queue.
Existing approved accounts are not deactivated by clearing trust.

## Docker deployments whose worker addresses HAProxy or the socket directly

**Fixed by:** `ee6e3c39b4f5099074d39517f94c8810d8f853df`.

**Affected:** custom Docker compose deployments whose worker's `DOCKER_HOST` names HAProxy or the
host socket rather than `docker-policy-broker`. Identify the required build by the presence of
`packages/docker-broker/src/server.ts` and `assertDockerBroker` in worker startup.

**Action:** add/build the `docker-policy-broker` service and its private `docker-broker-state`
volume from the app/prod compose definitions. Connect worker and broker on one internal network,
broker and HAProxy on a different internal network, and remove every worker route to HAProxy or
the host socket. Set `DOCKER_HOST=tcp://docker-policy-broker:2375`. Publish neither API port.
Keep HAProxy's socket mount and root user; its read-only filesystem, dropped capabilities and
no-new-privileges remain required.

Configure `DOCKER_BROKER_ALLOWED_IMAGES` for custom/private executor, service and git-helper
repositories. Helper images match the exact `WORKSPACE_METADATA_BLOCK_IMAGE` reference; match
`WORKSPACE_RUNTIME` on broker and worker. Preserve the broker state volume across upgrades;
existing containers/volumes without its private label are deliberately not adopted. Drain and
remove old workspaces before cutover. Use one broker per daemon/state volume, not active replicas.
Pin `APP_IMAGE_DOCKER_BROKER` with the other application images. See
[deployment](./deployment.md#0-what-youre-deploying) for limits and repository-pattern syntax.

The worker refuses startup without the broker's signed denial probe. Only direct-socket local
development may explicitly set `DOCKER_BROKER_REQUIRED=false`; it logs that policy protection is
disabled. Broker bootstrap retries transient upstream failures without serving before ownership
reconstruction; invalid state or permanent upstream policy failures stop it.

## Kubernetes workers without workspace Pod admission resources

**Fixed by:** `ee6e3c39b4f5099074d39517f94c8810d8f853df`.

**Affected:** Kubernetes deployments without the `<workspace-namespace>-pods`
ValidatingAdmissionPolicy and Deny binding, or without the worker's named-resource read grants.
Identify the required worker by `assertWorkspaceAdmission` in
`packages/worker/src/lib/workspaceBackend/kubernetes/ready.ts`.

**Action:** use Kubernetes 1.30+ and apply both
`infra/kubernetes/workspace-namespace.yaml` and `infra/kubernetes/workspace-admission.yaml`,
adjusting the namespace and worker ServiceAccount references together, or upgrade the Helm chart.
The installer needs cluster-scoped admission and RBAC installation privileges. The worker receives
only `get` on its named policy, binding and namespace; its namespaced workload permissions stay
unchanged. Helm also grants `get` on the configured RuntimeClass when required. Do not grant it
policy mutation rights.

Keep PodSecurity `restricted`. Root/capability-adding preview services retain their existing
namespace-exception requirement. With `K8S_REQUIRE_RUNTIME_CLASS=true`, label the namespace
`asw/required-runtime-class=<K8S_WORKSPACE_RUNTIME_CLASS>`; Helm's
`workspaces.requireRuntimeClass=true` does this when creating the namespace.
For existing namespaces (`workspaces.createNamespace=false`), maintain the labels yourself.
Optional `workspaces.serviceAccountName` designates one additional allowed account; default stays
allowed. Pod Secret env references must name `<pod-name>-env`; do not retain unrelated Secrets in
this namespace. CEL cannot verify their owner UIDs or prevent a deleted pod name being reused
while its Secret awaits garbage collection.

The boot check defaults on. Only explicit `K8S_REQUIRE_ADMISSION_POLICY=false` (Helm
`workspaces.requireAdmissionPolicy=false`) skips it with a warning for local development.
That opt-out does not remove chart-rendered admission rules. See
[Kubernetes Helm](./kubernetes-helm.md#limitations) for remaining limits.
## Limitations

- **A SHA identifies code, not your deployed image.** The comparison in §1 holds only if your
  image really was built from the commit you think. An image built without the build arguments
  reports `unknown`.
- **The notes cannot tell you whether anyone read your logs.** They tell you where a value was
  recorded and how long it is good; whether it was used is a question for your own audit trail,
  on GitHub as well as in your cluster.
- **They cannot enumerate your log sinks.** Load balancers, managed control planes, SIEM
  forwarders, backups and host agents are yours to check.
- **How long your deployment ran each build is unknown.** The start commits in UN-4 date the code,
  not your rollout; only your own deployment records say which build ran when.
- **Host-level capture of git inside a workspace is standing.** No fix removes the header from
  git's argument list there; whether your audit pipeline records it is yours to check.
- **The container-step item has no commit cited.** It is identified by the code marker in UN-4,
  which you check in your build's source.
- **The fixes narrow where a value travels; they do not remove every copy.** What remains is
  listed in the Limitations of [`architecture.md`](./architecture.md) and
  [`package-registries.md`](./package-registries.md).
- **Some host behaviour is not verified here.** Whether your Docker version records exec commands
  in its event stream and which consumers you run, whether your network exposes the registry proxy,
  what your log pipeline does to an encoded command line, and whether the lingering process of
  UN-6 occurred, are properties of your environment.
- **They cannot tell you what a leaked token did.** For an App installation token, which has the
  installation's full permissions, the only record is GitHub's audit log.

---

### Workspace commits skip repository hooks and global git config; steps record their base first (`<fixing commit SHA>`)

**Affected.** Deployments whose repositories rely on a commit hook running inside the agent
workspace (a `pre-commit` formatter or `lint-staged`, a `commit-msg` check, anything wired through
husky or `core.hooksPath`) for the commits the platform makes; deployments whose workspace image or
repository requires signed commits (`commit.gpgsign=true`) or sets `core.autocrlf`, a commit
template or another commit-time default in the global or system git config; and deployments that
read the scanned diff of a pushed change for binary files.

**What changes.** Every implementer step (`executeImplementation`, the CI, review and gate fix
sessions) and the merge-conflict resolver now commit with hooks off and push the committed sha
(`<sha>:refs/heads/<branch>`), as the steps with `allowedPaths` or the test-integrity guard already
did. These commits also ignore the global and system git config (the commit identity is passed
explicitly) and force `commit.gpgsign=false`, so a commit is never signed and no image-level
`core.autocrlf`, `commit.template` or similar default applies to it; a repository or host that
rejects unsigned commits rejects these. The merge-conflict resolver additionally rewrites the
repository config from an allow-list and deletes `.git/info/attributes` before each merge, so a
`merge.<name>.driver`, filter or attribute left in a workspace does not run. The base the diff is
read against is recorded before the agent runs and before the repository's setup command, so a
step whose starting commit cannot be read now fails non-retryably before the paid session
(`DIFF_BASE_UNREADABLE`). The hooks that no longer run on a workspace commit are the repository's
own; files a hook would have reformatted at commit time are committed as the agent left them.
`CodeResult.diff` carries a file that is binary by name (an extension such as `png`, `jar`, `so`,
`pdf`, `sqlite`, `onnx`, `pkl`, `keystore`) or, for a name that does not claim to be text, by an
executable or archive header (ELF, Mach-O, PE, WebAssembly, ZIP, gzip) as its header and its
printable strings (ASCII and UTF-16), not its bytes. A file that is UTF-16 text is carried decoded
as UTF-8. Any other file is carried whole, and one that contains a NUL byte is refused by the
security gate (`SECURITY_GATE_FAILURE`, category `hidden-content`); add the path of a file that
must hold a NUL byte (a test fixture, a data file with a tool-fixed name) to the setting
`workspace.nulAllowedPaths`, or store UTF-16 text as UTF-8 with `working-tree-encoding` in
`.gitattributes`. `mergeBranches` no longer runs the repository's setup command, and an agent run
reads its base before it. `headSha` is the pushed commit.

**Actions.** Move any formatting or validation a hook performed into the repository's test or gate
command (`gateCommands`), where it runs before the commit. If a host requires signed commits, use
its own signing mechanism (a bot App) rather than the workspace's git config. Name a committed
binary for what it is, or list its path in `workspace.nulAllowedPaths` at `/admin/platform-settings`
(a path listed there is no longer read line by line). Committed executables (`.so`, `.dll`, `.jar`,
`.wasm`) are not reviewed by the gate: send them to a reviewer with CODEOWNERS. No migration, no
credential rotation.

**Verify the fix is running.** A commit the platform made in a workspace did not run the repository's
`pre-commit` hook, and a pushed branch tip equals the run's reported `headSha`.

---
