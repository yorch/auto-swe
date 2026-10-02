# MCP server

The gateway is a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP client (an
editor, a coding agent) connects to one URL, signs in through the platform's own OAuth 2.1
authorization server ([oauth-setup.md](./oauth-setup.md#the-platform-as-an-oauth-server-for-mcp-clients)),
and talks to the endpoint over Streamable HTTP. The server is a resource server in the OAuth sense: it
accepts only access tokens that the authorization server issued for it, and it re-checks on every
request that the grant behind the token still stands.

The server exposes five read-only tools and, only when an admin has turned writes on and the user has
consented to them, two write tools (below), and no resources or prompts. A tool is a call to the same REST
route a dashboard or CLI user would call, made in-process as the signed-in user, so what a tool returns is
what that user is allowed to see, reduced to a short allowlist of fields. The write tools can start a run
and cancel one; nothing here can approve, merge or answer a human step.

It is off until an admin turns on `mcp.enabled`, and read-only until an admin also turns on
`mcp.writeToolsEnabled`.

## Endpoints

| URL | Purpose |
|---|---|
| `{BETTER_AUTH_URL}/api/v1/mcp` | The MCP endpoint (`POST`; `GET` and `DELETE` answer 405). It is also the RFC 8707 resource identifier and the `aud` of every access token. |
| `{BETTER_AUTH_URL}/.well-known/oauth-protected-resource/api/v1/mcp` | RFC 9728 protected resource metadata, at the path-inserted URL a client derives from the resource identifier. |
| `{BETTER_AUTH_URL}/.well-known/oauth-protected-resource` | The same document at the root. |
| `{BETTER_AUTH_URL}/.well-known/oauth-authorization-server/api/auth` | RFC 8414 metadata of the authorization server, which the protected resource metadata points at. |

The protected resource metadata names the resource, the authorization server's issuer, and the scopes
the server accepts now: `mcp:read` always, `mcp:write` only while `mcp.writeToolsEnabled` is on.
`offline_access` is not listed, as the MCP authorization specification asks.

## Connecting a client

A client needs only the endpoint URL. Without a token the endpoint answers 401 with a
`WWW-Authenticate` challenge that names the protected resource metadata and the default scope:

```
WWW-Authenticate: Bearer scope="mcp:read",
  resource_metadata="https://auto-swe.example.com/.well-known/oauth-protected-resource/api/v1/mcp"
```

A request that presents a token the server refuses gets the same challenge with `error="invalid_token"`.

The client follows the metadata to the authorization server, registers itself (anonymous Dynamic Client
Registration, public client, PKCE `S256`), sends the user to sign in, and receives a JWT access token
and, when it asked for `offline_access`, a rotating refresh token. For Claude Code that is:

```bash
claude mcp add --transport http auto-swe https://auto-swe.example.com/api/v1/mcp
```

Other clients take the same URL and discover the rest. A client must send `resource` (the endpoint URL)
on its authorization and token requests; the authorization server refuses a request without it.

## How a request is authorized

Every request to the endpoint passes these checks, in this order, before the MCP protocol sees it:

1. **MCP is on.** Otherwise 404, before the body is read, so a disabled endpoint answers 404 whatever the request carries. The setting is read per request.
2. **Origin.** A request carrying an `Origin` header whose host is not a configured `CORS_ORIGIN` host
   or the gateway's own host is refused with 403. A request with no `Origin` (every non-browser client)
   passes.
3. **A bearer token.** The `Authorization: Bearer` header only. Missing, malformed or invalid: 401 with
   the challenge above.
4. **The token itself.** One verifier, shared by every entry point:
   - the header `typ` is `at+jwt` and names a `kid`; an opaque token, a personal access token (`ats_`),
     the REST API's JWT and the `jwt` plugin's session-to-JWT token are all refused here;
   - the signature is `EdDSA`, verified against the authorization server's published keys, read in
     process from the same database (no HTTP call). Keys are cached for five minutes. A token naming a
     key the cache has not seen triggers one re-read, and no more than one per ten seconds, so a key
     rotation does not fail tokens and a stream of random key ids does not become a stream of reads;
   - `iss` is `{BETTER_AUTH_URL}/api/auth`, `exp` has not passed, and `sub` and a client id are present;
   - `aud` is exactly the endpoint URL. A token with no audience, another audience, or this one among
     others is refused (RFC 8707: the server accepts tokens issued for it and for nothing else).
5. **The grant behind the token, per call, from the database.** The token's user has a consent for the
   token's client; the consent was not written after the token was issued (a re-consent supersedes the
   tokens before it, with five seconds of tolerance for clock skew between replicas); the client is not
   disabled or deleted; the user is active.
6. **Scopes.** The effective scopes are the token's MCP scopes, narrowed to what the user consented to,
   and `mcp:write` only while `mcp.writeToolsEnabled` is on. `mcp:write` carries `mcp:read` with it. A
   token left with no MCP scope is answered 403 `insufficient_scope`, with the same `scope="mcp:read"`
   and `resource_metadata` in the challenge.

A failure of the verifier's own dependencies (the keys or the database cannot be read) answers 500 and
is logged. It is never reported as a bad token, so a client does not discard a good one.

Because step 5 reads the database on every call, deleting a consent, disabling a client or deactivating
a user stops that token on its next request instead of when it expires. The user lookup is cached for
30 seconds per gateway process, as for the REST API.

## Tools

Five read tools, all read-only (`readOnlyHint`), needing the `mcp:read` scope, and two write tools needing
`mcp:write` ([below](#write-tools)). Every input is a strict object: an argument the tool does not declare
is refused, not ignored.

| Tool | Calls | Returns |
|---|---|---|
| `list_repositories` | `GET /api/v1/repositories` | `id`, `organizationName`, `repoName`, `defaultBranch`, `isActive`, `team` (`id`, `name`, `slug`). Git repositories only. Inputs: `limit` (default 50, max 100), `offset`. |
| `list_work_requests` | `GET /api/v1/work-requests` | `id`, `externalTicketId`, `createdAt`, `isMine`, and the work request's workflows as `id` and `status`. No description and no requester's name. Inputs: `limit`, `offset`, `ticket` (substring of the ticket id). |
| `list_runs` | `GET /api/v1/workflow-runs` | `id`, `status`, `templateName`, `startedAt`, `endedAt`, `costUsdAccrued`, `workRequest` (`id`, `externalTicketId`). Inputs: `limit`, `offset`, `status`, `workRequestId`. |
| `get_run` | `GET /api/v1/workflow-runs/:id` | `id`, `status`, `templateName`, timestamps, `costUsdAccrued`, token totals, `steps` as `nodeId`, `status`, `attempt`, `failed`, `result`, `workRequest` and `dashboardUrl`. Input: `runId` (a UUID). |
| `list_pending_human_steps` | `GET /api/v1/human-steps` | `id`, `runId`, `kind`, `nodeId`, `title`, `requestedAt`, `timeoutAt`, `requiredApprovers`, `currentApprovers`, `inboxUrl`, and `truncated`. Pending steps on runs the caller can see (every team's for an administrator), at most 100, newest first; `truncated` is true when the cap was reached. No inputs. |

A list tool returns `total`, `limit` and `offset` beside its rows. `get_run.result` is exactly
`{ prUrl, prNumber }` or `null`. `prUrl` is rebuilt as `https://<host>/<owner>/<repo>/pull/<prNumber>` and only on a GitHub host the platform is configured for (the instance's own and each connection's GitHub Enterprise override); a link with another host, a query, a fragment, credentials or a different pull request number is dropped, because the result is whatever a workflow's terminate node mapped. A tool
returns `structuredContent` that matches its `outputSchema`, and the same JSON as text.

**What is never returned.** Output is built from an explicit allowlist, because a tool result lands in a
model's context and anything another person wrote is a prompt-injection channel. A tool never returns a
work request's description, a requester's name or email, a step's error, inputs or outputs, a run's
context or spec snapshot, traces, a human step's context, fields or options, a repository's
description, configuration or credentials, or a link other than the dashboard's and the pull request's.
A ticket id that is outside the characters the submit route accepts is returned as `null`. The few names
a team member authors (a template, a workflow node, a human step's title) are clipped and stripped of
control characters, and are still text a person wrote. Characters a person cannot see but a model reads (zero-width and bidirectional-override characters, the Unicode tag block, private-use characters, unpaired surrogates) are removed, and names are clipped by code point.

Not exposed: answering or approving a human step, merging, retrying, any write other than the two below,
templates, traces, and every administrative surface. `list_pending_human_steps` shows that a person is needed and where to go;
the answer is given in the dashboard.

A route's refusal reaches the agent as a fixed message per status (not found, not permitted, rate
limited, unavailable), never the route's own text. A run the caller cannot see is answered exactly as one
that does not exist.

### Write tools

Two tools, each needing the `mcp:write` scope. They exist only for a token that holds it, and a token
holds it only while `mcp.writeToolsEnabled` is on and the user consented to write: with writes off, or
for a read-only grant, `tools/list` does not show them. A read-only token that calls one anyway, while
writes are on, is answered 403 `insufficient_scope` with `scope="mcp:write"` in the challenge, so a client
can ask the user for the wider grant (step-up); with writes off there is no such challenge, because the
scope cannot be granted.

| Tool | Calls | Does |
|---|---|---|
| `submit_work_request` | `POST /api/v1/work-requests` | Starts a run for a ticket in a repository. Inputs: `externalTicketId`, `description`, `repoId`, and `idempotencyKey` (required, 8 to 128 characters of `A-Z a-z 0-9 . _ : ~ -`, sent as the `Idempotency-Key` header). There is no budget tier input: a run is always `STANDARD`. Returns `status` (`started`, `already_submitted` for a retry of a key that already launched a run, or `already_running` when the ticket already has a run in flight and nothing was launched), and `workRequestId`, which identifies the submission: pass it to `cancel_run`, or to `list_runs` and `get_run` (via `list_runs`) to follow it. The run itself is created by the worker a moment after the submit, so a `list_runs` for the work request can be empty at first. |
| `cancel_run` | `POST /api/v1/workflow-runs/:id/cancel` | Cancels a run that is still running, if the caller may control it: the same rule as the dashboard, so a member of a team the repository is only shared with can see a run but not cancel it. Input: `runId`, or the `workRequestId` that `submit_work_request` returned (exactly one). A `workRequestId` cancels every running run of that work request that the caller launched, across all pages, and only those: a teammate's run on the same work request is left running and listed in `notCancelled`, and is cancelled only with its own `runId` (which the route's control filter still has to allow). If the worker has not created the run yet, the tool says so and nothing is cancelled. Returns `runIds` (cancelled), `notCancelled` (each with a fixed reason) and `status`: `CANCELLED`, or `PARTIAL` when some run was not cancelled. The result is an error only when nothing was cancelled. A refusal for one run (not found, not running, the platform could not cancel) does not stop the rest; a write refusal that applies to every call (writes switched off, the burst limit) does, and the runs not reached are reported as not cancelled. |

**A run launches under the caller's identity**, not a service account. It is recorded as launched by the
user (`launchedById`, run identity `caller`), and where `github.userCredentialsEnabled` is on and the user
has saved a GitHub token for the repository, the run pushes branches and opens pull requests with that
token, as the user. The tool description says so, and so does the consent screen. The `description` is
also read by the platform's own agents as their instructions. Nothing a write tool does merges a pull
request or answers a human step: the run opens a pull request and waits for a person.

A tool never relays the route's own error text. Refusals reach the agent as a fixed message per case:
write access off, no permission, repository or run not found, the organization's monthly budget used up
(402), a key still starting (409, retry with the same key), a key reused for a different request (422), the
concurrency cap, and the burst limit. A ticket that already has a run in flight is a result
(`already_running`), not an error.

**The guards are in the route, not in the tool.** The tool is not the control: both routes declare
`config: { mcpScope: 'write' }` (exactly these two), and when a
request is bridged they call `assertMcpWriteAllowed` before anything else, so a leaked bridge secret plus
a valid write token gets exactly what the tool gets. In order, on `POST /work-requests`:

1. `mcp.writeToolsEnabled` is on (else 403 `MCP_WRITE_DISABLED`).
2. The per-user burst limit `mcp.writeCallsPerMinute` (else 429 `MCP_WRITE_RATE_LIMITED`). It counts route calls, not tool calls: `cancel_run` with a `workRequestId` spends one per run it cancels, and refused calls count.
3. The budget tier is `STANDARD` (else 422 `MCP_BUDGET_TIER_NOT_ALLOWED`).
4. An `Idempotency-Key` is present (else 422 `MCP_IDEMPOTENCY_KEY_REQUIRED`).
5. The route's ordinary flow: the idempotency replay (so a retry of a started run answers with it, even at
   the cap), repository access, org membership and monthly budget (`authorizeLaunch`), and the ticket's
   in-flight check.
6. The concurrency cap, inside the transaction that writes the ledger rows (below), else 429
   `MCP_RUN_CAP_REACHED`.

`cancel_run` takes steps 1 and 2 only, and then the route's own control filter. A request that is not
bridged (the dashboard, the CLI) skips all of it.

**The concurrency cap** `mcp.maxConcurrentRuns` counts the user's in-flight runs of every origin, the
dashboard's included: the user's `ActiveWorkflow` rows with a non-terminal status, which are written
synchronously when a run is submitted (a `WorkflowRun`, which the worker creates a moment later, would
miss a run that has only just been accepted). The count and the insert of the new rows share one
transaction, and that transaction first takes a per-user `pg_advisory_xact_lock`, so parallel submissions
for one user are serialised and the cap cannot be exceeded by racing them, on one gateway process or
several. `launchTrackedWorkflow` takes the check as an optional `guard`; without one, which is every REST
and CLI launch, its behaviour is unchanged.

**Audit.** Every bridged write that reaches the route writes a `McpToolCall` row to the config audit log,
from a hook on the two routes: the actor, the consent id (`entityId`), the OAuth client id and its name, the
tool, a SHA-256 digest of the raw input (never the description or any other input text), the HTTP status,
the refusal code if any, the work request id, and for `cancel_run` the run id it targeted (also on a
refusal). Refusals after authentication are audited too, including a body that fails validation. Not
audited: a request refused before the route knows who is writing (a bad bridge credential, an invalid
token, a token without `mcp:write`, the gateway's global rate limit) and a body that is not valid JSON.
The client's user agent is not recorded, because the inner request is built without any header the
client sent. A failure to write the row is logged and never changes the response, so a run that launched
is not reported to the agent as an error it would retry.

### How a tool is authorized

A tool never reads the database. It makes one in-process `GET` (or, for a write tool, `POST`) to the REST
route above, so that route's
role check, visibility filter, tenant guard, rate limit and audit apply to it unchanged, for a team
member, an outsider and an ADMIN alike. Two properties keep that from becoming a way around REST's own
rules:

1. **The inner call re-presents the caller's own access token**, and the route verifies it again with the
   same verifier the endpoint used (signature, audience, consent, client, user, scopes). Identity is
   never asserted in a header. A token revoked, or a user deactivated, between the endpoint admitting the
   request and the inner call stops the tool call at the route.
2. **Only a bridged call may use an MCP token on REST, and only on a route that opted in.** Each gateway
   process draws a random secret at boot (32 bytes, never configured, never stored) and the bridge sets
   it in `X-Auto-Swe-Mcp-Bridge` on its inner calls. The inner request's headers are built from nothing:
   no header the client sent is forwarded, and the only thing taken from the outer request is the
   client's address, so the call is rate limited as the client is. A route accepts a bridged MCP token
   only if it declares `config: { mcpScope: 'read' | 'write' }`, and exactly the five read routes in the
   table above do (six paths, counting the `/api/v1/inbox` alias of the human-steps route), all `read`,
   plus the two `write` routes of the write tools.

`requireAuth` applies these rules, in this order, to any request that carries the bridge header (its
presence, in whatever form, is enough to take this path, so no other credential is tried after it):

| # | Rule | Otherwise |
|---|---|---|
| 1 | The header is exactly this process's secret (compared in constant time; a repeated, empty, truncated or lengthened value is not it) | 403 |
| 2 | The route declares `mcpScope` | 403 |
| 3 | The credential is an `Authorization: Bearer` access token, not a personal access token | 401 |
| 4 | The shared MCP verifier accepts the token | 401 (500 if the verifier's keys or database cannot be read) |
| 5 | The token's effective scopes include the one the route declares | 403 `INSUFFICIENT_SCOPE` |

The request then runs as the token's user with their current role, and the route's own role check follows.
A request with no bridge header is unchanged: an MCP token on a REST route is neither a personal access
token nor an API JWT, so it is refused 401, and the secret alone, without a valid token, grants nothing.

## Transport

The endpoint is stateless: every request is served by a fresh server instance, nothing is kept between
requests, and there is no session id. It serves two protocol eras from one definition:

| Era | Recognised by | Response |
|---|---|---|
| Revision `2026-07-28` | A per-request `_meta` envelope naming the protocol version | A single `application/json` body, as long as no handler emits a message before its result (no tool does) |
| 2025-era (`initialize` handshake) | No envelope | A one-frame `text/event-stream` body, which is how the SDK's stateless fallback frames it |

- A `POST` whose body is not `application/json` is answered 415; a body that is not valid JSON, 400.
- `GET` and `DELETE`, the 2025-era session operations, are answered 405 once the caller is authenticated.
- `subscriptions/listen` is refused (JSON-RPC error `-32603`, not a stream). The server advertises no
  subscription capability and holds no connection open for a client.
- A notification is answered 202 with no body.

The response mode is the SDK's `auto`, not `json`: `json` drops any mid-call message (progress, logging)
without a word and warns at boot that it does, while `auto` answers a plain JSON body and only streams if
a handler emits one. The tools emit none, so clients see JSON either way, and a later tool that reports
progress will work instead of losing it.

The transport is `@modelcontextprotocol/server` 2.0.0, mounted as a Fastify route. The route builds a web
`Request` from the body Fastify has already parsed, calls the SDK's `fetch` handler, and streams the
response back.

## Settings

All four are ADMIN-only, GLOBAL-only registry settings ([configuration.md](./configuration.md)) read per
request through the ~30 s settings cache, so a change applies on every replica within about 30 seconds
and needs no restart. None is read only at startup.

| Setting | Default | Effect here |
|---|---|---|
| `mcp.enabled` | `false` | Off, the endpoint and both protected resource metadata documents answer 404 (as the authorization server's endpoints do). If the setting cannot be read they answer 503: the server does not guess. |
| `mcp.writeToolsEnabled` | `false` | Off, `mcp:write` is dropped from every token's effective scopes, left out of the protected resource metadata and refused at consent, the write tools are not listed, and the write routes refuse a bridged call. |
| `mcp.writeCallsPerMinute` | `10` | The most write calls one user may make in a minute, counting refused ones. Counted per gateway process. |
| `mcp.maxConcurrentRuns` | `2` | The most runs one user may have in flight before `submit_work_request` is refused. Counts runs started from the dashboard and the CLI too. |

## Operations

- **Behind a proxy**, the gateway must receive `/api/v1/mcp` and `/.well-known/*`, and
  `BETTER_AUTH_URL` must be the public HTTPS URL. The protected resource metadata is refused with a 500
  (and a log line) when the issuer is neither HTTPS nor `localhost`.
- **Rate limit.** The gateway's global per-IP limit applies to the endpoint, and write tools have their own
  per-user burst limit (`mcp.writeCallsPerMinute`).
- **A user stuck at the cap.** A run whose `ActiveWorkflow` row was left non-terminal by a crash, by a
  Temporal terminate done outside the platform, or by a workflow that failed before its run row was
  created (nothing to cancel in the dashboard either) counts against `mcp.maxConcurrentRuns` until the row is
  fixed: set its `currentStatus` to a terminal value (`CANCELLED`, `FAILED`, `COMPLETED` or `TIMED_OUT`).
  Raising `mcp.maxConcurrentRuns` frees the user meanwhile.

## Limitations

- A client can never approve, reject or answer a human step, or merge: the write tools only start and
  cancel runs.
- **A write is an action by the user, taken by an agent.** `submit_work_request` launches a run under the
  caller's identity on any repository the caller can reach, and with per-user GitHub credentials on it may
  push and open pull requests with the user's own token. If the user's agent obeys an instruction that
  came from somewhere else (a web page, a document, another tool), it can submit work as the user. What
  bounds that: writes are off until an admin turns them on, a client holds write only after the user's
  step-up consent, grants expire and can be revoked, an idempotency key is required, the budget tier is
  fixed, the burst limit and the concurrency cap apply, and a person reviews and merges every pull
  request. Users should not set an MCP client to approve write tools automatically.
- The concurrency cap is checked under a lock that only MCP submissions take, so a run started from the
  dashboard or the CLI at the same instant as an MCP submission can exceed the cap, by as many as are
  launched concurrently.
- A run whose workflow fails before the worker has created its run row leaves its `ActiveWorkflow` row
  non-terminal with no run, so it keeps counting against the cap and `cancel_run` cannot reach it; see
  Operations.
- The burst limit is counted per gateway process, so with several replicas a user can reach the limit on
  each. Disabling writes, and a user's deactivation, take up to 30 seconds to reach every replica.
- A cap refusal comes after the idempotency replay, so a retry of a run that already started is answered
  with it even at the cap, and a retry that raced its own first submit is answered with the replay or
  "still starting", not the cap; a new key for a ticket already in flight is answered "already running".
- Resources and prompts are not exposed.
- Consent is read or write, not per repository or per tool: a token reads everything its user can read.
- `list_repositories` filters out the connections that are not git repositories after the route has
  counted them, so its `total` can exceed the rows a client can ever page through.
- A tool call costs two requests against the gateway's per-IP rate limit: the endpoint's and the inner
  call's. The limit is per gateway process.
- The names a team member authors (template, node, human step title) can still carry text that tries to
  steer a model. They are length-limited and stripped of control characters, not made safe.
- On a configured GitHub host, the owner and repository segments of `get_run`'s `prUrl` can still carry
  up to about 200 characters of text chosen by whoever controls the run's result; that is inherent to
  returning any pull request link.
- Fastify registers a `HEAD` twin of each `GET` route, so the `HEAD` forms also accept a bridged call
  (no body). The human-steps routes are also mounted as `/api/v1/inbox`, which opts in the same way.
- Only OAuth tokens are accepted. A personal access token cannot be used, so a headless agent with no
  browser has no way to connect.
- Browser-hosted MCP clients are not supported: the endpoint's `Origin` check admits only the
  deployment's own hosts.
- A token issued within five seconds before its consent was re-written survives that re-write until it
  expires (at most 10 minutes), because the generation check tolerates that much clock skew.
- The 2025-era leg answers with a one-frame event stream even though the response is a single message.
- Disabling MCP or the write setting takes up to 30 seconds to reach every replica, and a user's
  deactivation up to 30 seconds on a replica other than the one that handled it.
- The signing keys and consent are read per gateway process; per-replica caches are not shared.
