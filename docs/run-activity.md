# Run activity

A run's Activity section combines workflow step transitions, agent tool calls and model responses,
activity events, outbound HTTP exchanges, and human-step requests and resolutions in time order.
`WorkflowHttpCall` stores HTTP metadata separately from [model transcripts](./transcripts.md);
`AgentTrace` stores tool, model-response, and activity events. This is an operational history, not
a guarantee that every network packet or process action is recorded.

## Worker HTTP capture

The worker installs an activity-scoped fetch wrapper and observes the shared guarded fetch path.
Explicit wrappers cover Octokit, connector clients, MCP/Qodo transports, callbacks, and model
fetches. Calls outside an activity pass through without a worker HTTP row. Nested wrappers do not
double-count an exchange.

Each row carries the workflow and Temporal run IDs, activity type, Temporal attempt, run ID when
available, recording ID, spec node ID, step attempt, spend-owner team/organization, and OpenTelemetry
trace/span IDs when present. Purpose tags distinguish `model`, `embedding`, `scm`, `connector`,
`mcp`, `callback`, `egress`, and `other`; registry-proxy upstream fetches use `egress`.

Rows contain method, scheme, host, port, sanitized path/query, status, duration, byte counts when
known, errors, and blocked-request information. Headers are never stored. Credential query
parameters are removed using the transcript URL sanitizer. Text-like non-model bodies use JSON
secret-key redaction or text credential-shape masking, then a per-body byte cap. Response bodies
are read from a clone in the background rather than delaying delivery to the caller.

Model and embedding fetches produce metadata-only rows, with `transcriptId` linking to the active
transcript when available. Their bodies belong to the transcript, not `WorkflowHttpCall`.

| Registry setting | Default | Bounds / effect |
|---|---|---|
| `workflow.httpCaptureEnabled` | `true` | Enables worker activity fetch capture; does not disable an independently configured egress proxy. |
| `workflow.httpCaptureBodyMaxBytes` | `8192` | Integer 0–65536 bytes per non-model body; 0 disables body storage. |
| `workflow.httpCaptureRetentionDays` | `90` | Integer 1–3650 days. |

These are global ADMIN settings, not run-pinned values or team overrides. Rows buffer per attempt
and flush in batches of up to 100, and at activity close. Persistence failures log warnings and
increment `http_capture.persist_failures` without failing the activity.

## Container egress proxy

The worker hosts an optional authenticated forward proxy for agent workspaces, egress-enabled
`shell` and `containerStep` nodes, and bridge-networked sidecars. Without `EGRESS_PROXY_PORT`,
container networking retains its DNS-filter behaviour and has no forward-proxy capture.

Configure the worker environment and restart it:

```dotenv
EGRESS_PROXY_PORT=8792
EGRESS_PROXY_URL=http://host.docker.internal:8792
EGRESS_PROXY_BIND=0.0.0.0
```

`EGRESS_PROXY_PORT` enables the listener. `EGRESS_PROXY_BIND` defaults to `0.0.0.0`;
`EGRESS_PROXY_URL` advertises the listener to containers (its default uses
`DOCKER_HOST_ALIAS`, or `host.docker.internal`, and the configured port). With a worker in Docker,
publish/reach the configured port on the host or advertise a directly reachable worker address.
Compose advertises the worker hostname on the shared workspace network. On the Kubernetes backend
the default does not exist in a cluster, so with `EGRESS_PROXY_PORT` set the worker refuses to start
unless `EGRESS_PROXY_URL` is a Service name pods can resolve (not the Docker host alias, a loopback
or unspecified host, or `{hostname}`); the namespace NetworkPolicy must allow the port. Do not
expose the listener to untrusted networks unnecessarily.

Each container registration gets a random Basic-auth proxy token. The worker retains its digest
and binds the registration to the registering activity's context and egress allowlist snapshot.
The container receives uppercase/lowercase `HTTP_PROXY` and `HTTPS_PROXY` variables containing
the credentials. `NO_PROXY` / `no_proxy` exclude localhost, loopback, and configured registry/model
proxy hosts and the repository's own git host (clone, fetch and push go direct). A `NO_PROXY` entry also covers subdomains of that host, so `github.com` covers `api.github.com`. Only a plain hostname or IP literal is written there. Teardown releases the registration, closes remaining exchanges, and waits with a
five-second bound. Registrations allow 32 concurrent exchanges and use a 60-second idle timeout.

- Absolute-form plain HTTP is forwarded with method, sanitized path, status, duration and bytes.
- `CONNECT host:port` creates a TCP tunnel without TLS interception. Port 443 uses scheme `https`;
  other ports use `tcp`. A row records the tunnel lifetime and bytes in each direction when it
  closes, including when teardown closes it.
- Missing/unknown credentials receive 407 and create no row. A non-empty team allowlist admits
  exact hosts and `*.example.com` subdomains (not the bare `example.com`). Denials receive 403 and
  produce blocked rows. An empty allowlist permits public destinations.
- Address resolution rejects loopback, private, link-local, cloud metadata and other unsafe
  addresses through the shared address guard. Every resolved address must pass, and the socket
  connects to a checked address, preventing a second DNS lookup from rebinding it.

All proxy rows have `source: egress_proxy`, `purpose: egress`, and no bodies. Socket errors do not
crash the worker; persistence failures log and increment `egress_proxy.persist_failures`.

### Run egress policy

The `workspace.egressPolicy` setting (ADMIN-only, run-pinned, overridable per workflow template,
team and organization; default `open`) decides how much outbound access a run's containers get.
A launch may choose a stricter level for one run, never a looser one (see
[Launch-time narrowing](#launch-time-narrowing)).

| Level | Agent workspace | `shell` / `containerStep` with `network: "egress"` |
|---|---|---|
| `open` | Unfiltered; with the worker's egress proxy configured, `HTTP_PROXY` holds cooperating clients to the team allowlist. | The team allowlist via the DNS filter (and the egress proxy when configured); an empty allowlist permits any host. |
| `restricted` | The team allowlist is mandatory: an empty list leaves only what `blocked` allows, and a non-empty allowlist with no egress proxy configured refuses the workspace with `EGRESS_POLICY_UNENFORCEABLE`. Enforced by the egress proxy plus a network lock that confines the workspace to the model proxy, the registry proxy when wired, the repository's git host and, for a non-empty allowlist, the egress proxy. A raw socket or `--noproxy` reaches nothing else. | An empty allowlist forces `network` to `none`. With an allowlist the step is held to it by the egress proxy and the DNS filter only; it is not network-locked. The step is refused when the worker's egress proxy is not configured. |
| `blocked` | Only the model proxy, the registry proxy when wired, and the repository's git host (plus cluster DNS on Kubernetes). There is no forwarding proxy. | `network` is forced to `none`. |

A capped step records `none (capped by egress policy <level>)` as its network in its execution
event. A `containerStep` sidecar needs network access, so it is refused where the policy forbids
it. When a lock cannot be established or proved, the workspace is destroyed and the activity fails
with a non-retryable `EGRESS_POLICY_UNENFORCEABLE`.

The lock is applied after provisioning (clone and registry wiring) and before any agent code runs.
It covers the agent workspace only:

- **Docker.** A short-lived helper container with `NET_ADMIN` shares the workspace's network
  namespace and installs default-deny rules. The names to allow are resolved first and pinned in
  the workspace's hosts file, and the embedded DNS resolver is blocked. The helper image
  (`WORKSPACE_METADATA_BLOCK_IMAGE`, default `alpine:3.20`) needs both `iptables` and `ip6tables`,
  or `apk` plus network access to install them; the install path is apk-only, so a non-Alpine
  helper image must already carry both. The lock reads the policies back from the kernel and
  fails closed on anything but a drop. A Docker workspace's attached services share its network
  namespace, so they are locked with it and a service that needs outbound access fails.
- **Kubernetes.** The pod is labelled `asw/egress=blocked` or `asw/egress=restricted`, which moves
  it onto the matching narrow NetworkPolicy (`workspace-egress-blocked` /
  `workspace-egress-restricted`), and the worker adds a per-pod policy of `/32` and `/128`
  addresses for the allowed hosts. The
  worker proves the lock with a connection probe before and after the label. The namespace manifest
  must be re-applied and the worker's Role extended; see
  [deployment](./deployment.md#kubernetes).

Consequences for what runs afterwards:

- The trusted delivery workspace of an agent run is created `blocked` whenever the run's policy is
  not `open`: it only imports the agent's tree, commits and publishes.
- Dependency repository checkouts run after the lock. Under `blocked`, and under `restricted` with
  an empty allowlist, one on a host other than the repository's git host fails and is skipped with
  a warning; Git LFS and submodules on other hosts fail the same way. Under `restricted` with an
  allowlist they succeed only over HTTPS to an allowlisted host through the egress proxy (the
  workspace carries `HTTPS_PROXY`; only the repository git host is in `NO_PROXY`).
- The Claude Code harness cannot install `bash` from a package mirror once the network is locked,
  so the executor image must already contain it; under `restricted` with the mirror allowlisted,
  `apk add bash` goes through the egress proxy and succeeds.

Allowed and blocked connections appear as `egress_proxy` HTTP activity rows (`blocked` and
`blockReason` set for a denial), as described above. Connections dropped by the network lock are
not recorded; only traffic sent through the egress proxy produces rows. Traffic the worker itself originates (model,
SCM, connectors, MCP) is not governed by the policy.

#### Launch-time narrowing

`POST /api/v1/agent-runs`, `POST /api/v1/work-requests` and
`POST /api/v1/workflow-templates/:id/runs` accept an optional `egressPolicy`. A value looser than
the one configured for the run is refused with `400 EGRESS_POLICY_WIDENS`. The CLI exposes it as
`--egress-policy` on `agent run`, `run` and `workflows run`, and the launch forms have a "Network
access" select. A retry or re-run keeps the stricter of the stored and the currently configured
value, and an idempotency-key replay of a work request, or an MCP replay, refuses a different
value (a REST agent-run or template launch reusing a key is deduplicated by workflow id with no
comparison). A requested level is echoed in the agent-run response's `effective` block and the
launch audit entry; the pinned level of every run is `egressPolicy` on
`GET /api/v1/workflow-runs/:id`.

## Execution and governed-write events

Shell and container-step execution writes `shell.exec` and `container.exec` activity events with
image, masked command, network, egress allowlist snapshot, exit code, duration, and output-artifact ID when
available. Shell output uses a `shell.step` artifact; container-step stdout/stderr uses a redacted
`container.step` artifact, separate from its parsed JSON result.

Governed external writes emit `external_write` activity events with connection/provider, node,
and outcome (`done`, `replayed`, `refused`, `deferred` or `ambiguous`), without the write's secret
payload. `deferred` is a refusal before anything was sent that Temporal retries (a 429 or an
unresolved host), as opposed to the final `refused`.
These events supplement, rather than replace, the external-write ledger and governance checks.

## UI evidence

Workflow activities and agents attach screenshots, browser recordings, traces and text logs to a
run. Evidence metadata records its kind, source, caption, page URL, workflow node, attempt and
dimensions where known; its bytes use the workflow artifact store. The Evidence panel requests
short-lived, user-bound media links and the gateway rechecks the user's current account and run
visibility each time a link is fetched. Only PNG/JPEG/WebP images, WebM video, ZIP archives and
plain text are served with their respective media types; other types are downloaded as opaque
binary data. How the `uiVerify` step and the agent browser tool produce this evidence, and the
per-repository preview recipe behind it, are in [ui-validation.md](./ui-validation.md).

Evidence items are limited by `uiValidation.maxScreenshotBytes`, `uiValidation.maxVideoBytes` and
`uiValidation.maxEvidencePerRun`. A trace card opens its trace in the self-hosted Playwright viewer
on the dashboard origin. The download also works with `npx playwright show-trace <file>`. Snapshots
replay on the dashboard origin. Playwright strips scripts from snapshot HTML, but the content comes
from the app under test.

## Retention

The daily transcript sweep (`AGENT_TRANSCRIPT_PRUNE_ENABLED`, `AGENT_TRANSCRIPT_PRUNE_CRON`,
default `57 4 * * *`) also prunes HTTP rows whose `createdAt` exceeds
`workflow.httpCaptureRetentionDays`, in bounded batches. Disabling that sweep stops HTTP pruning
too. Deleting a run cascades to its HTTP rows. Transcript legal holds do not hold HTTP metadata or
bodies; transcripts and artifacts have their own retention rules. The same scheduled sweep removes
expired UI evidence and its artifacts using `uiValidation.evidenceRetentionDays`. Evidence cleanup
runs after transcript pruning and does not fail transcript pruning.

## API and authorization

All routes below require ENGINEER or higher and refuse service-principal tokens. Run visibility matches the traces route,
including repository-access gating; inaccessible runs return 404. Run control means the owning
team or requester, or ADMIN, using the same control filter as transcript content.

| Route | Behaviour |
|---|---|
| `GET /api/v1/workflow-runs/:id/activity` | Visible-run readers receive `{ data, nextCursor }`. |
| `GET /api/v1/workflow-runs/:id/http-calls/:callId` | Visible-run readers receive `{ data }` for that run's call. Request/response body fields are omitted without run control. |
| `GET /api/v1/workflow-runs/:id/activity/export` | Requires run control. Streams NDJSON with an EOF sentinel and writes a structured `run_activity_export` log line with actor, run and filters. |

List/export filters are `kinds` (comma-separated `step`, `tool_call`, `llm_response`,
`activity_event`, `http_call`, `human_step`), `recordingId`, `specNodeId`, and ISO `since`.
`recordingId` also includes fan-out descendants. `limit` defaults to 100, at most 500;
`cursor` is an opaque keyset cursor. Items ascend by timestamp and stable source-prefixed ID,
including separate started/ended and requested/resolved IDs at equal timestamps.

Items expose `id`, `ts`, `kind`, recording/spec-node linkage, step/Temporal attempts, optional
`agentKey`, summary, and compact typed detail. List and export omit HTTP bodies and trace
input/output payloads. HTTP detail reports source/purpose, destination, status, timing, byte
counts, blocking/error information, transcript linkage, and body presence. Export ends with
`{"kind":"eof","complete":true}`; a client treats a missing sentinel as incomplete.

## Dashboard

The run page's collapsible Activity section mounts its queries when opened. It offers kind chips,
DAG/step-linked node filtering, ascending paged history and Load more. Rows show time, kind, node
and summary; HTTP rows add method, host/path, status, duration and a blocked badge. Expanding an
HTTP row loads detail and, with control permission, redacted bodies. Export downloads filtered
NDJSON through the authenticated blob downloader and checks the EOF sentinel.

Active runs poll using `since`, with a 30-second overlap and periodic loaded-page refreshes.
Terminal runs stop polling and receive a final refresh. Paging and browser content-visibility
hints reduce rendering work; the section does not use a dedicated virtualization library.

## Limitations

- The policy governs agent-controlled containers only. Worker-originated traffic (model calls, SCM,
  connectors, MCP) is not affected.
- Under `restricted` with an allowlist, `shell` and `containerStep` steps are enforced by the
  egress proxy and the DNS filter, not by a network lock, so a client that ignores proxy variables
  can still reach a literal IP address.
- Under `blocked`, and `restricted` with an empty allowlist, steps run with no network and no
  registry proxy, so a step that needs package installs fails.
- On Kubernetes, DNS to the cluster DNS service stays reachable under both locking levels. It is a
  low-bandwidth exfiltration channel; closing it needs a DNS policy outside the platform manifest.
  The lock also requires a CNI that enforces NetworkPolicy.
- Allowed names are resolved once, when the lock is applied. A host whose addresses rotate (a CDN)
  can become unreachable for later git operations, which then fail closed.
- Dependency repositories, Git LFS and submodules on a host other than the repository's own git
  host fail after the lock under `blocked` and under `restricted` with an empty allowlist; with an
  allowlist they succeed only over HTTPS to an allowlisted host through the egress proxy.
- A Docker workspace's attached services share its network namespace, so they are locked with it
  and a service that needs outbound access fails.
- The repository's git host is excluded from the workspace proxy (`NO_PROXY`, which also matches
  its subdomains), so git traffic to it, including a GitHub Enterprise host on a private address, is neither subject to the team
  allowlist nor recorded as proxy rows. Other hosts a run clones from (dependency repositories on
  a different host) go through the proxy and need an allowlist entry.
- The same `NO_PROXY` entry covers the git host's subdomains, so workspace traffic to hosts such
  as `api.github.com`, `gist.github.com` and `uploads.github.com` also bypasses the team
  allowlist and is not recorded as proxy rows.
- The proxy is cooperative, not transparent interception. Direct sockets and clients that ignore
  proxy environment variables bypass its enforcement and logging. The DNS filter remains; its
  hostname restriction alone does not prevent literal-IP connections.
- CONNECT exposes a destination and aggregate tunnel bytes, not individual HTTPS requests,
  paths, status codes or bodies. No container traffic body is captured, including plain HTTP.
- Kubernetes agent workspaces receive proxy env, but the backend does not support ephemeral
  shell execution or detached sidecars. The boot check validates the advertised URL's host, not
  that the Service exists or that the NetworkPolicy admits the port.
- Worker capture wraps fetch and the shared guarded-fetch path, not arbitrary `node:http` or
  `node:https` clients, subprocess traffic, or third-party clients with an independent transport.
- Body reads stop after two seconds; binary/unknown content types have no body. Incomplete or
  invalid JSON bodies declared as JSON are dropped rather than storing unredactable fragments.
  Valid redacted JSON can still be cut at the storage cap; `bodiesTruncated` signals truncation.
  Byte counts may be absent for incomplete reads. Redaction is best-effort, not a general PII scrub.
- Persistence is best-effort. Process loss, database failures or bounded teardown can leave gaps;
  persistence failures never fail the underlying activity. Open tunnels have no row until closure.
- Proxy credentials are visible to code inside the registered container. They are not an isolation
  boundary against that code; release revokes them.
- The Activity list/export is not a transcript or full event-payload export. Execution event detail
  is compact; full output is in artifacts. HTTP history has no legal hold and can expire separately.
- Live updates poll rather than push. Substantially delayed older rows may require loading more
  history or reopening the section. Export buffers a Blob in the browser and is not streamed to disk.
