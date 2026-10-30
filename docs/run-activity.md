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
Compose advertises the worker hostname on the shared workspace network. Kubernetes workspace pods
need an advertised URL reachable from their network. Do not expose the listener to untrusted networks
unnecessarily.

Each container registration gets a random Basic-auth proxy token. The worker retains its digest
and binds the registration to the registering activity's context and egress allowlist snapshot.
The container receives uppercase/lowercase `HTTP_PROXY` and `HTTPS_PROXY` variables containing
the credentials. `NO_PROXY` / `no_proxy` exclude localhost, loopback, and configured registry/model
proxy hosts. Teardown releases the registration, closes remaining exchanges, and waits with a
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

## Execution and governed-write events

Shell and container-step execution writes `shell.exec` and `container.exec` activity events with
image, masked command, network, egress allowlist snapshot, exit code, duration, and output-artifact ID when
available. Shell output uses a `shell.step` artifact; container-step stdout/stderr uses a redacted
`container.step` artifact, separate from its parsed JSON result.

Governed external writes emit `external_write` activity events with connection/provider, node,
and outcome (`done`, `replayed`, `refused`, or `ambiguous`), without the write's secret payload.
These events supplement, rather than replace, the external-write ledger and governance checks.

## UI evidence

Workflow activities and agents attach screenshots, browser recordings, traces and text logs to a
run. Evidence metadata records its kind, source, caption, page URL, workflow node, attempt and
dimensions where known; its bytes use the workflow artifact store. The Evidence panel requests
short-lived, user-bound media links and the gateway rechecks the user's current account and run
visibility each time a link is fetched. Only PNG/JPEG/WebP images, WebM video, ZIP archives and
plain text are served with their respective media types; other types are downloaded as opaque
binary data.

Evidence items are limited by `uiValidation.maxScreenshotBytes`, `uiValidation.maxVideoBytes` and
`uiValidation.maxEvidencePerRun`. Trace files can be opened with
`npx playwright show-trace <file>`.

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

- The proxy is cooperative, not transparent interception. Direct sockets and clients that ignore
  proxy environment variables bypass its enforcement and logging. The DNS filter remains; its
  hostname restriction alone does not prevent literal-IP connections.
- CONNECT exposes a destination and aggregate tunnel bytes, not individual HTTPS requests,
  paths, status codes or bodies. No container traffic body is captured, including plain HTTP.
- Kubernetes agent workspaces receive proxy env, but the backend does not support ephemeral
  shell execution or detached sidecars. Proxy reachability from pods is an operator concern.
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
