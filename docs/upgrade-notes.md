# Upgrade notes

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

Every SHA below is a commit on `main`. The worker image carries the commit it was built from:

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
was built from. Only the worker image matters for every entry here: the gateway and web images
never run a workspace command.

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
