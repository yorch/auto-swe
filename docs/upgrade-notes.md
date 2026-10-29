# Upgrade notes

Notes for operators of a deployment that ran earlier code. Each entry describes a defect that
exposed a credential somewhere it should not have been, and what you do about it. An entry is
keyed by the condition that makes your deployment affected and by the commit that fixed it, not by
a version number: the packages are unversioned, so a commit is the only identifier a deployment
can compare against.

Read an entry when its **Affected** line matches your deployment. An entry that does not match
needs nothing from you.

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

"Contains" means the build commit descends from the fix commit. Only the worker image matters for
every entry here: the gateway and web images never run a workspace command.

---

## 2. Quick reference

| Secret | Where it was exposed | How long the secret is good | Action |
|---|---|---|---|
| GitHub PAT (instance, or a per-host PAT for a GitHub Enterprise host) | Kubernetes API-server audit logs, `kubectl` and `docker` process arguments (entries 1 and 4) | Until you revoke it or its own expiry on GitHub | Rotate |
| GitHub App installation token | The same places | One hour (GitHub sets it; the worker reads `expires_at` from GitHub's answer and caches the token until a minute before it) | Nothing to rotate: an expired token is harmless. The App id and private key were never exposed |
| A user's own GitHub token (`user-github-credentials.md`) | The same places, on runs that user launched | Until the user revokes it or its own expiry on GitHub | The user rotates it |
| Registry-proxy token | Kubernetes Pod objects, etcd and `kubectl get pod`; `docker run` arguments and `docker inspect` (entries 2 and 4) | One workspace's life, then revoked; every token is also lost when the worker restarts | Usually none; clean up leftovers (entry 2) |
| Provider `apiBase` that carries a credential in its path or query | `kubectl exec` arguments and environment pairs; `docker exec` arguments (entry 3) | Until the gateway or provider rotates it | Rotate that gateway token |
| Provider API key | Never in an argument list or environment pair. Inside a workspace pod when no model proxy was configured (entry 5) | Until you rotate it | Rotate if the workspace ran code you do not trust |

---

## 3. Entries

### UN-1. GitHub credential in Kubernetes exec command lines

**Affected.** All of these:

- `WORKSPACE_BACKEND=kubernetes`.
- A worker image built from a commit that does not contain `d9365e26` (target-repository clone,
  base fetch, `gitAuthed` fetch and push). Clones of a repository's dependency checkouts
  (`cloneDependencyRepos`, used when a repository has dependency edges) are fixed one commit later,
  by `8e372963`.

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

1. Find the runs. Search your API-server audit logs, and any sink that receives them, for exec
   requests (`objectRef.subresource` is `exec`) whose `requestURI` contains `extraheader`,
   `x-access-token`, or the base64 prefix `eC1hY2Nlc3MtdG9rZW46` (the encoding of
   `x-access-token:`). A hit confirms the token was logged. Do not paste hits into tickets or chat.
2. Rotate every PAT that could have been used since the first Kubernetes run: create the new token
   on GitHub, save it at `/admin/integrations` under GitHub (for a GitHub Enterprise host, under
   Per-host credentials), then revoke the old one on GitHub. Revoking is the rotation; saving
   alone leaves the old token live.
3. If you enabled per-user credentials, tell every user who launched runs against a Kubernetes
   worker to save a new token for each repository on the Connections page and revoke the old one.
4. Purge or redact the matching audit entries per your retention policy (see
   [If you cannot tell](#4-if-you-cannot-tell)). Check the places that copy those logs: SIEM,
   object storage, backups.
5. Check any load balancer, managed control-plane log or API gateway in front of your API server
   for request-URL logging. This note cannot tell you what your infrastructure records.

**Verify the fix is running.** The worker contains `d9365e26` and `8e372963`. For a running
cluster: run a workspace, then look at its `kubectl exec` requests in the audit log. The clone and
fetch commands name `$ASW_GIT_AUTH` (and not a value), and a search for `extraheader=AUTHORIZATION`
finds nothing from new runs.

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
   your policy treats even dead tokens as sensitive.
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
start without it, so the Kubernetes case is a worker older than that commit, or one configured
before it existed.

**What was exposed and where.** The `apiBase` value was passed as an `ANTHROPIC_BASE_URL=...`
environment pair on the exec command, and as inline JSON in the harness's `--settings` argument.
Under Kubernetes both are part of the `?command=` query of the exec request and land in the audit
log (see UN-1). Under Docker both are `docker exec` arguments, visible in `ps` on the worker host.

**What was not exposed.** The provider API key itself: it travels as `secretEnv` (a stdin preamble
under Kubernetes, `-e NAME` without a value under Docker). A gateway that authenticates by API key
only, with an origin-only `apiBase`, exposed nothing.

**Exposure window and lifetime.** From the first Claude Code turn without the model proxy until
your worker contained the fix. A path token is valid until its issuer rotates it.

**Actions.**

1. List your provider credentials at `/models` under Credentials, and open each one that is used
   by a Claude Code agent. Note every `apiBase` that has anything after the host.
2. For each, rotate that token at the gateway or provider, and save the new `apiBase`.
3. On Kubernetes, search the audit logs as in UN-1 for the token text of the old `apiBase`
   (search the host and the start of the path).
4. On Docker, treat it like UN-4.

The gateway refuses an `apiBase` that carries a username or password (`credentialInputProblem`);
the check is present in the oldest commit this repository's history holds (`c1a7fffb`). It does not
look at the path or query, which is why they needed this fix, and it does not re-check a credential
saved before it existed. A stored credential with userinfo in its `apiBase` was a credential in a
URL: rotate it.

**Verify the fix is running.** The worker contains `3200071c`. A turn with a path-bearing
`apiBase` then shows no `ANTHROPIC_BASE_URL=` pair and no inline `--settings` JSON on its exec
command, and the pinned settings layer is a file under the harness home.

The same commit adds a run-time guard: the Docker and Kubernetes backends refuse a plain
`NAME=value` environment pair whose name contains TOKEN, SECRET, PASSWORD, API_KEY, AUTH,
CREDENTIAL, NPMRC or YARNRC (an exact exception exists for `YARN_NPM_ALWAYS_AUTH`). It checks
names only: a credential in a value, or under an innocuous name, is not seen.

---

### UN-4. Credentials in process arguments on the Docker backend

**Affected.** All of these:

- `WORKSPACE_BACKEND=docker` (the default).
- A worker image built from a commit that does not contain the fix for the value in question (the
  list below).
- A host where something other than the worker can read process arguments: other local users,
  command-line auditing (`auditd` `execve` records, EDR agents, process accounting), or a runtime
  monitor that records container processes.

A single-tenant host with no command-line capture is unaffected in practice.

**What was exposed and where.** The Docker CLI runs on the worker host with the command in its
argument list, so the value is in `ps` for as long as that command runs, and in anything that
records it:

| Value | In the argument list until | Commands |
|---|---|---|
| Git header `AUTHORIZATION: basic <base64>` | `d9365e26` | workspace clone, fetch and push; the shell-step push |
| Clone URL with the token in clear text | `8e372963` for dependency checkouts; `3200071c` for a shell step's clone and base fetch | `docker exec`, `docker run` |
| Registry-proxy token (`COREPACK_NPM_TOKEN`, `YARN_NPM_AUTH_TOKEN`) | `c4d1a285` for the workspace container; `83dc2ff5` for the shell-step npmrc helper; `3200071c` for the shell-step sandbox | `docker run -e NAME=value` |
| Provider `apiBase` with a credential in its path | `3200071c` | `docker exec` |

The history this repository holds starts at a commit that already passes the git header in the
command, so the start of the window is not known: treat every Docker worker built before the fix
as affected.

**What was not exposed.** Docker daemon API request bodies are not normally logged. The Docker
socket proxy shipped with this project (`infra/docker-socket-proxy/haproxy.cfg`) logs the HTTP
request line, not bodies. If you enabled daemon debug logging, an authorization plugin, or put a
body-logging proxy in front of the socket, check those logs too. Whether the daemon's event stream
(`docker events`) records exec commands in your version is not verified here: check it in your
environment. The provider API key and the platform's own secrets were never in an argument list.

**What still shows after the fixes.** The fixes name a variable in the Docker command
(`-e NAME`) and pass its value through the client's environment, which `ps` does not show. Three
things remain by design, listed in the Limitations of [`architecture.md`](./architecture.md):
`docker inspect` of a container shows the `Config.Env` it was created with, which includes the
registry-proxy token of a workspace; inside the container the git header is in the environment and
in git's argument list for the length of each call; and a shell step's clone helper shows the
header to a host `ps` for the length of the clone.

**Exposure window and lifetime.** The seconds to minutes each command ran, per command. Lifetimes
are those in the quick reference.

**Actions.**

1. Upgrade the worker to a build containing `3200071c` (which contains all of the above).
2. Decide whether anyone or anything that could read process arguments on a worker host existed
   in the window. If so, rotate the PAT, per-host PATs and per-user tokens as in UN-1 step 2 and
   3. An App installation token needs nothing.
3. Search host command-line audit data for `extraheader`, `x-access-token` or the base64 prefix
   `eC1hY2Nlc3MtdG9rZW46`; purge or redact per your retention policy.
4. If you ran shell steps with a registry, the shell-step sandbox token was also in `docker
   inspect` of that container while it existed. It is dead once the step ends.

**Verify the fix is running.** The worker contains `3200071c`. While a workspace command runs,
`ps -eo args | grep -E 'extraheader|x-access-token'` on the worker host finds no `docker` process
that carries the value.

---

### UN-5. Provider API key inside Kubernetes workspace pods

**Affected.** `WORKSPACE_BACKEND=kubernetes`, Claude Code agents, no model proxy configured, and
a worker built from a commit that does not contain `7cccdd43`.

**What was exposed and where.** Without the proxy the harness gets the raw provider API key as
`ANTHROPIC_API_KEY` in its environment inside the workspace. It reached the pod through a stdin
preamble, so it was not in any audit log or Pod object. Anything the agent ran in that workspace
could read it.

**Actions.** If the agents in those workspaces ran code you do not trust (a target repository you
do not control, a prompt-injected run), rotate the provider key. Then set
`HARNESS_MODEL_PROXY_PORT` and a `HARNESS_MODEL_PROXY_URL` that workspace pods resolve; a worker
containing `7cccdd43` refuses to start until both are set. See [`agents.md`](./agents.md).

---

## 4. If you cannot tell

If you cannot establish which commit your workers ran, whether per-user credentials were on,
or whether anything logged command lines: rotate first, then clean up.

1. Rotate the PAT, every per-host PAT, and ask users to rotate their own tokens (UN-1 step 2 and
   3). An App needs no rotation.
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
by the SHA of the fixing commit, and entries are append-only: a correction adds a note to the entry
or a new entry, and does not rewrite what an operator may already have acted on.

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
- **The start of the Docker window is unknown.** This repository's history begins at a commit that
  already passed the git header in the command, so earlier builds may be affected in the same way.
- **The fixes narrow where a value travels; they do not remove every copy.** What remains is
  listed in the Limitations of [`architecture.md`](./architecture.md) and
  [`package-registries.md`](./package-registries.md).
- **Some host behaviour is not verified here.** Whether your Docker version records exec commands
  in its event stream, and whether your network exposes the registry proxy, are properties of your
  environment.
