# MCP server

The gateway is a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP client (an
editor, a coding agent) connects to one URL, signs in through the platform's own OAuth 2.1
authorization server ([oauth-setup.md](./oauth-setup.md#the-platform-as-an-oauth-server-for-mcp-clients)),
and talks to the endpoint over Streamable HTTP. The server is a resource server in the OAuth sense: it
accepts only access tokens that the authorization server issued for it, and it re-checks on every
request that the grant behind the token still stands.

The server exposes read-only tools (eight that follow runs and launches, and the [domain tools](#domain-read-tools), four of which also need the `mcp:admin` scope) and, only when an admin has turned writes on and the user has
consented to them, six write tools (below), and no resources or prompts. A tool calls the same REST
route a dashboard or CLI user would call, made in-process as the signed-in user, so what a tool returns is
what that user is allowed to see, reduced to a short allowlist of fields. The write tools can start a run,
cancel one, start an orchestration and message one; nothing here can approve, merge or answer a human
step, and nothing can attach a repository to an orchestration, decline that request, approve or deny an
orchestration's tool call, or cancel or end an orchestration: those are acts of the person who launched it,
made in the dashboard or the CLI.

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
the server accepts now: `mcp:read` and `mcp:admin` always, `mcp:write` only while `mcp.writeToolsEnabled` is on.
`offline_access` is not listed, as the MCP authorization specification asks.

## Connecting a client

For Claude Code CLI/Desktop and Codex installation, delegation skills and the follow/review loop,
see [Local coding agents](./local-agents.md).

Headless clients can use the optional RFC 8628 device authorization flow described in
[OAuth setup](./oauth-setup.md#device-authorization). It still requires a user to sign in and
approve the exact requested scopes in a browser; it is not a non-interactive credential bootstrap.

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
   and `mcp:write` only while `mcp.writeToolsEnabled` is on. `mcp:write` and `mcp:admin` each carry `mcp:read` with them, and neither carries the other. A
   token left with no MCP scope is answered 403 `insufficient_scope`, with the same `scope="mcp:read"`
   and `resource_metadata` in the challenge.

A failure of the verifier's own dependencies (the keys or the database cannot be read) answers 500 and
is logged. It is never reported as a bad token, so a client does not discard a good one.

Because step 5 reads the database on every call, deleting a consent, disabling a client or deactivating
a user stops that token on its next request instead of when it expires. The user lookup is cached for
30 seconds per gateway process, as for the REST API.

## Tools

Eight core read tools and the [domain read tools](#domain-read-tools), all read-only (`readOnlyHint`), needing the `mcp:read` scope (the four admin-tier domain tools also need `mcp:admin`), and six write tools needing
`mcp:write` ([below](#write-tools)). Every input is a strict object: an argument the tool does not declare
is refused, not ignored.

| Tool | Calls | Returns |
|---|---|---|
| `list_templates` | `GET /api/v1/workflow-templates` | Only visible ACTIVE, promoted, non-system templates: `id`, sanitised `name`, `description` (500 code points), and reduced `inputSchema`. The schema retains `type: object`, property names/types, `required`, enum values, UUID format, array item types/enums and descriptions (280 code points); no defaults, prompts, nodes, spec or author. Unsupported/absent schemas return null, empty contracts retain empty properties. Contracts are bounded to 100 fields and 50 enum values; unsafe or overlong keys/enums make the schema null rather than changing payload semantics. Repository access and budget are checked at launch. |
| `list_agents` | `GET /api/v1/agent-runs/agents` | Launchable agents: `key`, `version`, `name`, and a sanitised description clipped to 300 code points. Optional `repoId` resolves organization overrides as the launch does. No prompts, models, skills or tools. |
| `wait_for_run` | Polls `GET /api/v1/workflow-runs`, `GET /api/v1/workflow-runs/:id`, and `GET /api/v1/human-steps?runId=…` | Exactly one of `runId` or `workRequestId`, and `timeoutSeconds` (default 25, schema maximum 600). Without request `_meta.progressToken`, clamps the timeout to 50 seconds. With a token, allows 600 seconds and emits progress per poll. Returns the `get_run` fields (provenance included) plus `changed` and `pendingHumanStep` (`id`, sanitised `title`, `inboxUrl`, or null). Returns on a status change, terminal status, pending human step, or timeout. When no run row exists yet, waits for one; a timeout without a row returns only `changed: false` and `pendingHumanStep: null`. Honors request cancellation. |
| `list_repositories` | `GET /api/v1/repositories` | `id`, `organizationName`, `repoName`, `defaultBranch`, `isActive`, `team` (`id`, `name`, `slug`). Git repositories only. Inputs: `limit` (default 50, max 100), `offset`. |
| `list_work_requests` | `GET /api/v1/work-requests` | `id`, `externalTicketId`, `createdAt`, `isMine`, and the work request's workflows as `id` and `status`. No description and no requester's name. Inputs: `limit`, `offset`, `ticket` (substring of the ticket id). |
| `list_runs` | `GET /api/v1/workflow-runs` | `id`, `status`, `templateName`, `startedAt`, `endedAt`, `costUsdAccrued`, `workRequest` (`id`, `externalTicketId`), and the provenance fields `trigger`, `triggerRefId`, `initiatedBy`, `initiatedByService` and `rerunOfRunId` ([run-provenance.md](./run-provenance.md)). Inputs: `limit`, `offset`, `status`, `workRequestId`. |
| `get_run` | `GET /api/v1/workflow-runs/:id` | `id`, `status`, `templateName`, timestamps, the provenance fields (`trigger`, `triggerRefId`, `initiatedBy`, `initiatedByService`, `rerunOfRunId`), `costUsdAccrued`, token totals, `steps` as `nodeId`, `status`, `attempt`, `failed`, `result`, `workRequest`, `dashboardUrl`, `branch`, `failure`, and `diffStat`. Input: `runId` (a UUID). |
| `list_pending_human_steps` | `GET /api/v1/human-steps` | `id`, `runId`, `kind`, `nodeId`, `title`, `requestedAt`, `timeoutAt`, `requiredApprovers`, `currentApprovers`, `inboxUrl`, and `truncated`. Pending steps on runs the caller can see (every team's for an administrator), at most 100, newest first; `truncated` is true when the cap was reached. No inputs. |

Paged list tools return `total`, `limit` and `offset` beside their rows. `get_run.branch` is a validated work branch from the stored result, or null when unknown. `failure` is null unless the run failed or timed out; then it is `{ type }`, a fixed enum of the agent-run viewer's known refusal types, `TIMED_OUT`, or `UNKNOWN`, never an error message. `diffStat` sums the already stored result's file line counts as `filesChanged`, `insertions`, and `deletions`, or is null when absent. No diff or file paths are returned. `get_run.result` is exactly
`{ prUrl, prNumber }` or `null`. `prUrl` is rebuilt as `https://<host>/<owner>/<repo>/pull/<prNumber>` and only on a GitHub host the platform is configured for (the instance's own and each connection's GitHub Enterprise override); a link with another host, a query, a fragment, credentials or a different pull request number is dropped, because the result is whatever a workflow's terminate node mapped. A tool
returns `structuredContent` that matches its `outputSchema`, and the same JSON as text.

**What is never returned.** Output is built from an explicit allowlist, because a tool result lands in a
model's context and anything another person wrote is a prompt-injection channel. A tool never returns a
work request's description, a work request's requester name or email (a run's initiator is the one exception, below), a step's error, inputs or outputs, a run's
context or spec snapshot, traces, a human step's context, fields or options, a repository's
description, configuration or credentials, or a link other than the dashboard's and the pull request's.

A ticket id that is outside the characters the submit route accepts is returned as `null`. The few names
a team member authors (a template, a workflow node, a human step's title) and the names the lists and reports return (repository, team, automation and organization names) are clipped and stripped of
control characters, and are still text people wrote, so an agent treats them as data, not instructions. Characters a person cannot see but a model reads (zero-width and bidirectional-override characters, the Unicode tag block, private-use characters, unpaired surrogates) are removed, and names are clipped by code point.

**The one exception: a run's provenance.** `list_runs`, `get_run` and `wait_for_run` return `trigger`,
`triggerRefId`, `initiatedBy` (`id`, `name`, `email`), `initiatedByService` (`id`, `name`) and
`rerunOfRunId` for runs the caller may see, the same as the REST run endpoints
([run-provenance.md](./run-provenance.md)). Control and bidirectional characters are stripped and
lengths clipped, but the name, email and service name are user-controlled text and remain untrusted.

Not exposed: answering or approving a human step, merging, retrying, any write other than the six below,
template editing or specs, traces, and every administrative surface. `list_pending_human_steps` shows that a person is needed and where to go;
the answer is given in the dashboard.

A route's refusal reaches the agent as a fixed message per status (not found, not permitted, rate
limited, unavailable), never the route's own text. A run the caller cannot see is answered exactly as one
that does not exist.

### Domain read tools

Tools beyond the core eight are grouped into domains (`lib/mcp/domains/*.ts`). A domain declares each
tool with the one route behind it and the tier of person it is meant for (`user`, `lead`, `admin`). The
route enforces that tier, through its role gate or in its handler, so the same token reads a team a user belongs to, or every
team for an administrator, exactly as the dashboard does. An `admin`-tier tool is also gated by the `mcp:admin` scope, which the
tier alone does not grant: see [admin read tools](#admin-read-tools). Their inputs are strict, they carry
`readOnlyHint`, and their results follow the same allowlist rule as the core tools.

| Tool | Calls | Returns |
|---|---|---|
| `list_teams` | `GET /api/v1/teams` | `id`, `name`, `slug`, `memberCount`, `repositoryCount` for the teams the caller belongs to (every active team for an administrator). No descriptions or persona prompts. |
| `get_team` | `GET /api/v1/teams/:id` | A team's members as `userId` and team `role` (no names or emails), the repositories it owns, and the repositories shared with it. Input: `teamId`. |
| `list_pull_requests` | `GET /api/v1/pull-requests` | `id`, `number`, `status`, `isDraft`, `ciStatus`, timestamps, `repository`, `ticketId`, `workRequestId`, `latestRun`, `costUsd` and `url` (rebuilt and checked against the configured GitHub hosts, as for `get_run`). No title. Inputs: `limit`, `offset`, `state`, `draft`, `scope` (`MINE` by default), `repoId`, `teamId`, `ticket`. |
| `get_agent_run_limits` | `GET /api/v1/agent-runs/limits` | The step, wall-clock and concurrency ceilings an agent run launches under, and whether agent runs are enabled. Input: optional `repoId`. |
| `list_epics` | `GET /api/v1/epics` | `ticketId`, `status`, `repositoryCount`, timestamps, `requestedById` and `workRequestId` for cross-repository epics. No description, name or email. Inputs: `limit`, `offset`, `scope` (`TEAM` by default), `teamId`. |
| `list_schedules` | `GET /api/v1/scheduled-work-requests` | `id`, `name`, `cron`, `isActive`, `paused`, `lastFiredAt`, `lastRunAt`, `nextRunAt`, `budgetTier`, `repository` and `canManage` for schedules on repositories the caller can reach; `scheduleKnown` is false when the scheduler could not be asked. No description, author or submitted work. |
| `get_run_eval_results` | `GET /api/v1/workflow-runs/:id/eval-results` | For one run, each eval result as `id`, `scorer`, `scoreType`, `source`, `value` (0 to 1), `passed`, `scored` (false when the scorer did not run and `value` is a placeholder), `nodeId`, `agentKey` and `createdAt`. Input: `runId`. Rationales and metadata are not returned. |
| `list_run_effects` | `GET /api/v1/workflow-runs/:id/effects` | For one run, each external effect the run made as `id`, `kind` (pull request, git push, tracker, knowledge base, MCP tool), `status`, `via`, `nodeId`, `agentKey` and `createdAt`, plus `truncated`, which is true when older effects were cut. Input: `runId`. Targets, details and errors are not returned. |
| `list_run_autonomy_decisions` | `GET /api/v1/workflow-runs/:id/autonomy-decisions` | For one run, each publish, approve, reject, request-changes, select or submit event (anything else as `unknown`) as `id`, `event`, `actorId`, `policyName`, `riskClass`, `requiredApprovers` and `createdAt`. Inputs: `runId`, `limit` (1 to 100), `offset`. Decision payloads are not returned. |
| `list_run_evidence` | `GET /api/v1/workflow-runs/:id/evidence` | For one run, each captured UI evidence item as `id`, `kind` (`screenshot`, `video`, `trace` or `log`), `sizeBytes`, `width`, `height`, `nodeId`, `stepAttempt` and `createdAt`. Input: `runId`. Content, links and captions are not returned. |
| `list_agent_library` | `GET /api/v1/platform/agent-library` | Needs `mcp:admin`. Administrators only. The agents in the library as `id`, `key`, `name`, `scope`, `version`, `isActive`, `isVerified`, `modelSpec`, `createdAt` and `updatedAt`: the latest version of each by default, or every version with `all`. Inputs: `all`, `scope`, `orgId`, `teamId`, `channelId`, `workflowTemplateId`. Prompts, descriptions, tool configuration, connection ids, author emails, skill text and scan warning text are not returned. |
| `list_agent_versions` | `GET /api/v1/platform/agent-library/:id/versions` | Needs `mcp:admin`. Administrators only. Every version of one agent lineage, newest first, as `id`, `version`, `isActive`, `isVerified`, `modelSpec`, `createdById` (the creating user's id) and `createdAt`. Input: `agentId`. Prompts, descriptions, tool configuration, connection ids, author emails, skill text and scan warning text are not returned. |
| `list_skills` | `GET /api/v1/platform/skills` | Needs `mcp:admin`. Administrators only. The skills in the library as `id`, `name`, `isBuiltIn`, `isVerified`, `isActive`, `currentRevision`, `usedByCount`, `usedBy` (the agent keys that use it, at most 50), `scanWarningCount` and `externalSource` (`host`, `owner`, `repo`). No inputs. Skill text, descriptions, scan warning text, prompts, tool configuration, connection ids and author emails are not returned. |
| `get_delivery_report` | `GET /api/v1/reports/delivery` | Runs started, succeeded and with a pull request (`runsWithPr`), `successRate`, pull requests CI-passed and merged, spend, cost per merged pull request, median time to merge and CI fix rounds, in total and by repository, team and template (names clipped), with `truncated` and the window bounds `windowStart` and `windowEnd`. Inputs: `window` (7, 30 or 90), `since` and `until` (`YYYY-MM-DD`), `teamId`. |
| `get_quality_report` | `GET /api/v1/reports/quality` | Gate pass rates, CI fix loops, `ciSelfHealRate`, merge rate with and without a rejecting review verdict, and per reviewer persona the verdict, approval and severity counts, with `truncated` and the window bounds `windowStart` and `windowEnd`. Finding categories are not returned. Same inputs as `get_delivery_report`. |
| `get_hitl_report` | `GET /api/v1/reports/hitl` | Human steps by kind and status, how they were resolved, median and 95th percentile wait, `pendingNow`, `oldestPendingAgeMs`, `timedOut`, and autonomy decisions by event and risk class, with `truncated` and the window bounds `windowStart` and `windowEnd`. Approver names are not returned. Same inputs as `get_delivery_report`. |
| `get_automation_report` | `GET /api/v1/reports/automations` | One row per automation the caller can see: `automationId`, `name` (clipped), `enabled`, `lastFiredAt`, `fires`, `started`, `failedToStart`, `outcomes`, `suppressed` counts by cause, `successfulProducedRuns`, `broken` and `noisy`, with `truncated` and the window bounds `windowStart` and `windowEnd`. Suppression reasons are not returned. Same inputs as `get_delivery_report`. |
| `get_budget_report` | `GET /api/v1/reports/budget` | Needs `mcp:admin`. For each organization the caller administers (every one for an administrator): `orgId`, `name` (clipped), `mtdUsd` (month-to-date spend), `monthlyBudgetUsd` and `alertThresholdUsd` (the cap and alert threshold), `projectedUsd` (projected month-end spend), `status` (`over`, `projected_over`, `alert`, `ok`, `no_cap`), `daysInMonth`, `elapsedDays`, `lowConfidence`, and the five costliest runs as `id`, `costUsd`, `status` and `startedAt`, with `topRunsTruncated`. The response also carries `truncated` and the window bounds `windowStart` and `windowEnd`. A caller who administers no organization is refused. No inputs. |
| `orchestrations_list` | `GET /api/v1/orchestrations` | Orchestrations the caller launched or whose team they belong to (every one for an administrator), newest first, as `id`, `title` (80 code points), `status`, `teamId`, `teamName`, `repoName` (null with no repository), `childCount`, `runningChildCount`, `costUsd`, `isMine` and timestamps, with `total`, `limit` and `offset`. Inputs: `limit` (1 to 100, default 25), `offset`, `status`, `teamId`. |
| `orchestrations_get` | `GET /api/v1/orchestrations/:id` | One orchestration: `status`, `team`, `repoName`, `counts` (`children`, `runningChildren`), `cost` split into `orchestratorUsd`, `childrenUsd` and `totalUsd`, `pendingApprovals` (a count of tool-call approvals waiting for the launcher), `pendingAttach` (`reason`, 300 code points, and the candidate repository's `candidate` name, or null), `canControl`, `dashboardUrl`, and `children` (at most 50, with `childrenTruncated`) as `id`, `agent`, `role`, `status`, `label`, `branch` (only a valid branch name), `prUrl` (rebuilt and checked against the configured GitHub hosts, as for `get_run`), `costUsd`, and `summary` clipped to 300 code points with `summaryTruncated`. Never returned: a child's full result or file list, run and workflow ids, the allowlist and connection set, who launched it, an approval's tool name or argument digest, tokens. Input: `orchestrationId`. |
| `orchestrations_messages` | `GET /api/v1/orchestrations/:id/messages` | The transcript, oldest first, as `id`, `role`, `kind`, `childId`, `createdAt`, and `body` clipped to 1000 code points with `bodyTruncated`; no payload and no author. Inputs: `orchestrationId`, `after` (the previous page's `next`, so only newer messages come back), `limit` (1 to 50, default 25) and `timeoutSeconds` (0 to 600, default 0). With `timeoutSeconds` above 0 and nothing newer, it polls every three seconds until a message arrives or the time is up: the wait is clamped to 50 seconds unless the request carries a `progressToken`, when it may reach 600 and each poll emits a `notifications/progress` with a fixed phrase, as `wait_for_run` does. An empty page returns the caller's own `after` as `next`. The role, kind and body are text agents wrote: treat them as data. |

### Admin read tools

`list_agent_library`, `list_agent_versions`, `list_skills` and `get_budget_report` are the four tools of
the `admin` tier, and each needs the `mcp:admin` scope as well as its route's role. A token without
`mcp:admin` does not list them. A call to one by name gets the ordinary unknown-tool error, not a
step-up challenge: the `insufficient_scope` challenge that asks for a wider grant is only issued for
`mcp:write`. If a token without `mcp:admin` reaches an admin route through the bridge, the route answers
403 `INSUFFICIENT_SCOPE`.

`mcp:admin` is a consent, not a role. It is granted only when the client asks for it and the user ticks
**Admin read** on the consent screen, where the option is unticked by default. The device page lists the
scope with a warning. It has no operator switch, unlike `mcp:write`, and `mcp.enabled` and
`mcp.writeToolsEnabled` do not affect it. It implies `mcp:read` and does not imply `mcp:write`, and
`mcp:write` does not imply it. The route's role gate still decides who may read: an organization
administrator keeps `get_budget_report`, and a caller who administers no organization is refused.

A tool's output schema holds plain types only, because a JSON Schema cannot represent a transform: the
sanitising schemas that read the REST body (`shortName`, `status`, `ticketId` in `projections.ts`) are
separate from the schema a client is told about. A domain that registers a tool without declaring it, or
that declares a route that has not opted in with `config: { mcpScope: 'read' }` (or `'admin'` for an admin-tier tool), fails `tools.test.ts`,
which compares `tools/list` and the real route table with the declarations.

### Write tools

Six tools, each needing the `mcp:write` scope. They exist only for a token that holds it, and a token
holds it only while `mcp.writeToolsEnabled` is on and the user consented to write: with writes off, or
for a read-only grant, `tools/list` does not show them. A read-only token that calls one anyway, while
writes are on, is answered 403 `insufficient_scope` with `scope="mcp:write"` in the challenge, so a client
can ask the user for the wider grant (step-up); with writes off there is no such challenge, because the
scope cannot be granted.

| Tool | Calls | Does |
|---|---|---|
| `start_template_run` | `POST /api/v1/workflow-templates/:id/runs` | Inputs: `templateId`, JSON object `payload`, optional `label` (200 characters), required `idempotencyKey` (same format as `submit_work_request`). No callback. Returns `status` (`started` or `already_submitted`) and `workRequestId`; follow with `wait_for_run` and `get_run`. A worker-created run id is not yet available at submit. Requires `mcp.templateRunsEnabled` (default false) as well as write consent and the normal launch guards. Runs use STANDARD; any other `payload.budget` string is refused. |
| `start_agent_run` | `POST /api/v1/agent-runs` | Delegates `prompt` to `agent` (`key` or `key@version`) on `repoId`, with `deliver` (`none`, `draft_pr`, `branch`), optional `baseBranch`, and required `idempotencyKey` (same format as `submit_work_request`). The run acts as the user, using their GitHub credentials. Returns `status` (`started` or `already_submitted`), `workRequestId`, and `effective` limits (`deliver`, `maxSteps`, `maxWallClockSeconds`, or null on replay); follow it with `wait_for_run`. The budget tier is always `STANDARD`. `mcp.agentRunAllowedDeliverModes` defaults to allowing `none` and `draft_pr`; other modes are refused as `MCP_DELIVER_MODE_NOT_ALLOWED`. Dashboard, CLI and service-principal launches are unaffected. |
| `submit_work_request` | `POST /api/v1/work-requests` | Starts a run for a ticket in a repository. Inputs: `externalTicketId`, `repoId`, and `idempotencyKey` (required, 8 to 128 characters of `A-Z a-z 0-9 . _ : ~ -`, sent as the `Idempotency-Key` header), and an optional `description`. Omitted, the brief is built from the ticket, which must be readable from the issue tracker; otherwise the route answers `DESCRIPTION_REQUIRED` and the tool returns a fixed message with nothing launched. There is no budget tier input: a run is always `STANDARD`. Returns `status` (`started`, `already_submitted` for a retry of a key that already launched a run, or `already_running` when the ticket already has a run in flight and nothing was launched), and `workRequestId`, which identifies the submission: pass it to `cancel_run`, or to `list_runs` and `get_run` (via `list_runs`) to follow it. The run itself is created by the worker a moment after the submit, so a `list_runs` for the work request can be empty at first. |
| `cancel_run` | `POST /api/v1/workflow-runs/:id/cancel` | Cancels a run that is still running, if the caller may control it: the same rule as the dashboard, so a member of a team the repository is only shared with can see a run but not cancel it. Input: `runId`, or the `workRequestId` that `submit_work_request` returned (exactly one). A `workRequestId` cancels every running run of that work request that the caller launched, and only those, listing again until a pass finds none left to try (a run that finishes mid-way cannot make one be skipped): a run someone else launched, or that no user launched (a schedule or webhook), is left running and listed in `notCancelled`, and is cancelled only with its own `runId` (which the route's control filter still has to allow). If the worker has not created the run yet, the tool says so and nothing is cancelled. Returns `runIds` (cancelled), `notCancelled` (each with a fixed reason) and `status`: `CANCELLED`, or `PARTIAL` when some run was not cancelled. The result is an error only when nothing was cancelled. A refusal for one run (not found, not running, the platform could not cancel) does not stop the rest; a refusal that applies to every call (writes switched off, the burst limit, a revoked token, a lost scope) does, and the runs not reached are reported as not cancelled. |
| `orchestrations_launch` | `POST /api/v1/orchestrations` | Starts an orchestration as the user: an orchestrator agent that splits `task` (up to 20,000 characters) between the agents on `allowlist` (up to 20 agent keys, optionally `key@version`; omitted or empty, the platform default from `orchestration.defaultAllowlist` applies, and an empty result of that is refused as `ALLOWLIST_REQUIRED` with nothing launched). Inputs: optional `allowlist`, `task`, `repoId` or `teamId` (at least one; with no repository the orchestration is read-only, and `teamId` must be a team the caller belongs to), optional `deliveryDefault` (`none`, `draft_pr`, `branch`; the route refuses one outside `mcp.agentRunAllowedDeliverModes` as `MCP_DELIVER_MODE_NOT_ALLOWED`), and required `idempotencyKey` (same format as `submit_work_request`). There is no budget tier input (always `STANDARD`) and no MCP connection set (a bridged launch that names one is refused, 422 `MCP_CONNECTIONS_NOT_ALLOWED`). The same key with a different request answers 422 `IDEMPOTENCY_KEY_MISMATCH`. The launch is recorded as MCP-launched, and that holds for every agent the orchestrator later starts: a writer's `deliver` must be in the live `mcp.agentRunAllowedDeliverModes` and no more permissive than `deliveryDefault` (order `none`, `branch`, `draft_pr`), else the spawn is refused as `CHILD_NOT_ALLOWED`; and each agent passes the same transactional concurrency cap, counting the orchestrator's own run and the launcher's other runs in flight (409 `AGENT_RUN_CONCURRENCY_EXCEEDED`). An orchestration waiting for a message does not count as in flight. Returns `status` (`started`, or `already_submitted` for a replayed key), `orchestrationId`, `orchestrationStatus`, `dashboardUrl` and `allowlist` (the agents applied, whether given or defaulted); follow with `orchestrations_get` and `orchestrations_messages`. It takes the same write guards and concurrency cap as `start_agent_run`, and the `orchestration.enabled` kill switch (403 `ORCHESTRATION_DISABLED`). |
| `orchestrations_message` | `POST /api/v1/orchestrations/:id/messages`, or `POST /api/v1/orchestrations/:id/children/:childId/messages` when `childId` is given | Sends `body` (up to 4000 characters) as the user to the orchestrator, or to one running agent, which reads it at its next step. Inputs: `orchestrationId`, optional `childId`, `body`. Returns `messageId`, `childId` and `status: sent`. Only the launcher may send one (403 `NOT_LAUNCHER`), and not to an ended orchestration: cancelled, failed or completed (409 `ORCHESTRATION_NOT_ACTIVE`; restarting a completed one is a dashboard or CLI act). A message to an idle (`WAITING`) orchestration restarts its workflow, so it passes the same transactional `mcp.maxConcurrentRuns` cap as a launch: the orchestrator's ledger row is reopened and counted under the per-user lock, and at the cap the message is refused (429 `MCP_RUN_CAP_REACHED`) and nothing is sent. A message to an agent that is not running is refused (409 `CHILD_NOT_ALLOWED`). A message to an orchestration whose delivery default is broader than the highest mode in the live `mcp.agentRunAllowedDeliverModes` (order `none`, `branch`, `draft_pr`; no default counts as `none`) is refused (403 `MCP_DELIVER_MODE_NOT_ALLOWED`), whichever way the orchestration was launched; reads are unaffected. It takes the write switch and the burst limit; it has no idempotency key, so a repeat sends the message again. Steering only: it does not approve, attach or cancel anything. |

**A run launches under the caller's identity**, not a service account. It is recorded as launched by the
user (`launchedById`, run identity `caller`), and where `github.userCredentialsEnabled` is on and the user
has saved a GitHub token for the repository, the run pushes branches and opens pull requests with that
token, as the user. Templates execute authored workflows and may push branches or open pull requests;
an administrator must review installed templates before enabling MCP template launches. Agent-run
delivery restrictions do not constrain template behavior. The tool description says so, and so does the consent screen. The `description` is
also read by the platform's own agents as their instructions. Nothing a write tool does merges a pull
request or answers a human step directly; workflow behavior and human gates depend on the installed template.

A tool never relays the route's own error text. Refusals reach the agent as a fixed message per case:
write access off, no permission, repository or run not found, the organization's monthly budget used up
(402), a key still starting (409, retry with the same key), a key reused for a different request (422), the
concurrency cap, and the burst limit. A ticket that already has a run in flight is a result
(`already_running`), not an error.

**The guards are in the route, not in the tool.** The tool is not the control: all seven write routes declare
`config: { mcpScope: 'write' }`, and when a
request is bridged they call `assertMcpWriteAllowed` before anything else, so a leaked bridge secret plus
a valid write token gets exactly what the tool gets. In order, on `POST /work-requests`:

1. `mcp.writeToolsEnabled` is on (else 403 `MCP_WRITE_DISABLED`).
2. The per-user burst limit `mcp.writeCallsPerMinute` (else 429 `MCP_WRITE_RATE_LIMITED`). It counts route calls, not tool calls: `cancel_run` with a `workRequestId` spends one per own run it attempts to cancel, refused attempts included, and refused calls count.
3. The budget tier is `STANDARD` (else 422 `MCP_BUDGET_TIER_NOT_ALLOWED`).
4. An `Idempotency-Key` is present (else 422 `MCP_IDEMPOTENCY_KEY_REQUIRED`).
5. The route's ordinary flow: the idempotency replay (so a retry of a started run answers with it, even at
   the cap), repository access, org membership and monthly budget (`authorizeLaunch`), and the ticket's
   in-flight check.
6. The concurrency cap, inside the transaction that writes the ledger rows (below), else 429
   `MCP_RUN_CAP_REACHED`.

`cancel_run` takes steps 1 and 2 only, and then the route's own control filter. `orchestrations_message` takes the same two steps, then the route's launcher check. `orchestrations_launch` takes steps 1 to 4 and the transactional concurrency cap, and refuses a delivery mode outside `mcp.agentRunAllowedDeliverModes`. A request that is not
bridged (the dashboard, the CLI) skips all of it.

`start_agent_run` uses the same guard chain, including the transactional concurrency cap. It also
checks `mcp.agentRunAllowedDeliverModes` before lookup or replay, then follows the agent-run route's
repository authorization, agent resolution, ceilings and platform/team admission. A replay returns
the original work request, including when a same-key launch wins a concurrent insert. Replays do not
launch another run; reuse a key only for the same task.

`start_template_run` also applies these guards and the audit hook, plus the ADMIN/GLOBAL
`mcp.templateRunsEnabled` opt-in (403 `MCP_TEMPLATE_RUNS_DISABLED`, including replays). The global
opt-in is conservative: template-authored workflows can push branches and trigger CI, and have no
universal sandbox/draft-only delivery contract. Only ACTIVE, promoted, caller-visible, non-system
templates can launch. The ordinary input, connection, org, budget and source-authorization checks
remain authoritative. Bridged callbacks are refused at the route. Keys are scoped to caller and
template; retries compare label and the complete payload (object key order is immaterial) against
stored inputs, including after a racing insert. A mismatch is 422 `IDEMPOTENCY_KEY_MISMATCH`.
Replay returns the original work request without another launch, even at the cap. Ordinary REST,
CLI and service-principal behavior is unchanged.

**The concurrency cap** `mcp.maxConcurrentRuns` counts the user's in-flight runs of every origin, the
dashboard's included: the user's `ActiveWorkflow` rows with a non-terminal status, which are written
synchronously when a run is submitted (a `WorkflowRun`, which the worker creates a moment later, would
miss a run that has only just been accepted). The count and the insert of the new rows share one
transaction, and that transaction first takes a per-user `pg_advisory_xact_lock`, so parallel submissions
for one user are serialised and the cap cannot be exceeded by racing them, on one gateway process or
several. `launchTrackedWorkflow` takes the check as an optional `guard`; without one, which is every REST
and CLI launch, its behaviour is unchanged.

**Audit.** Every bridged write that reaches the route writes a `McpToolCall` row to the config audit log,
from a hook on the write routes: the actor, the consent id (`entityId`), the OAuth client id and its name, the
tool, a SHA-256 digest of the raw input (never the description or any other input text), the HTTP status,
the refusal code if any, the work request id, and for `cancel_run` the run id it targeted (also on a
refusal). Refusals after authentication are audited too, including a body that fails validation. Not
audited: a request refused before the route knows who is writing (a bad bridge credential, an invalid
token, a token without `mcp:write`, the gateway's global rate limit) and a body that is not valid JSON.
The client's user agent is not recorded, because the inner request is built without any header the
client sent. A failure to write the row is logged and never changes the response, so a run that launched
is not reported to the agent as an error it would retry.

### How a tool is authorized

A tool never reads the database. It makes in-process `GET` calls (or, for a write tool, a `POST`) to the REST
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
   only if it declares `config: { mcpScope: 'read' | 'write' | 'admin' }`: the read routes in the table above
   (including the `/api/v1/inbox` alias of the human-steps route), the seven `write` routes (work requests, agent runs, the template run, run cancel, and the three orchestration routes), and the admin-tier
   routes (with their `/admin` aliases).

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
  subscription capability and holds no persistent subscription connection open for a client.
- A notification is answered 202 with no body.

The response mode is the SDK's `auto`, not `json`: `json` drops any mid-call message (progress, logging)
without a word and warns at boot that it does, while `auto` answers a plain JSON body and only streams if
a handler emits one. `wait_for_run` emits `notifications/progress` when the request's `_meta` contains
a `progressToken` (not a tool argument). Its response is then SSE: progress notifications followed by
the final tool result. Without a token, modern clients receive JSON as before. Each successful poll,
including the last, increments `progress` by one; it counts polls, not percent completion, and has no
`total`. Messages are fixed phrases: `Waiting for a run.`, `Waiting on a human step.`, or `Run status:`
with one of RUNNING, SUCCESS, FAILED, CANCELLED, TIMED_OUT, SKIPPED, UNKNOWN. No titles, node names,
errors or other run-derived free text enter notifications. Progress does not change the three-second
poll interval, rate costs, early-return conditions or human approval boundary. An HTTP disconnect
aborts the wait. Subscriptions remain refused.

The gateway uses Fastify's disabled request, connection and handler timeout defaults and the MCP
route adds no deadline. The SDK's default request timeout applies to outgoing requests, not this
incoming tool handler. Clients and external reverse proxies can still cut a long call: configure
their total/read deadlines above 600 seconds with overhead headroom (for example 660), preserve SSE
streaming without buffering, and allow the authentication and initial reads time to produce the
first notification. Periodic progress is not a guarantee that a client's timeout resets. If these
limits cannot be configured, keep the default short waits and repeat them. A wait deadline is checked
between REST reads; slow reads can add overhead.

The transport is `@modelcontextprotocol/server` 2.0.0, mounted as a Fastify route. The route builds a web
`Request` from the body Fastify has already parsed, calls the SDK's `fetch` handler, and streams the
response back.

## Settings

All seven are ADMIN-only, GLOBAL-only registry settings ([configuration.md](./configuration.md)) read per
request through the ~30 s settings cache, so a change applies on every replica within about 30 seconds
and needs no restart. None is read only at startup.

| Setting | Default | Effect here |
|---|---|---|
| `mcp.templateRunsEnabled` | `false` | Allows bridged template launches, including authored code that may push branches or trigger CI. Enable only after reviewing installed templates. Does not affect discovery or other callers. |
| `mcp.agentRunAllowedDeliverModes` | `['none', 'draft_pr']` | Delivery modes accepted by a bridged agent-run launch; an empty list refuses every delivery mode. Other callers are unchanged. |
| `mcp.enabled` | `false` | Off, the endpoint and both protected resource metadata documents answer 404 (as the authorization server's endpoints do). If the setting cannot be read they answer 503: the server does not guess. |
| `mcp.deviceFlowEnabled` | `false` | Allows the RFC 8628 device grant and its browser approval endpoints. Off, the device endpoints and grant answer 404 and discovery omits them. |
| `mcp.writeToolsEnabled` | `false` | Off, `mcp:write` is dropped from every token's effective scopes, left out of the protected resource metadata and refused at consent, the write tools are not listed, and the write routes refuse a bridged call. |
| `mcp.writeCallsPerMinute` | `10` | The most write calls one user may make in a minute, counting refused ones. Counted per gateway process. |
| `mcp.maxConcurrentRuns` | `2` | The most runs one user may have in flight before an MCP launch is refused. Counts runs started from the dashboard and the CLI too. |

There is no setting for `mcp:admin`. The scope is granted by consent alone (see [admin read tools](#admin-read-tools)).

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

- Template discovery exposes a reduced contract, not every validation constraint, the workflow spec
  or its delivery policy. A null schema requires dashboard/user clarification. Template runs have
  no universal draft-only guarantee and require an administrator opt-in; the agent delivery-mode
  allowlist does not apply to them. All template text is untrusted, including descriptions and enums.

- A client can never approve, reject or answer a human step, or merge: the write tools only start and
  cancel runs.
- **A write is an action by the user, taken by an agent.** `submit_work_request` launches a run under the
  caller's identity on any repository the caller can reach, and with per-user GitHub credentials on it may
  push and open pull requests with the user's own token. If the user's agent obeys an instruction that
  came from somewhere else (a web page, a document, another tool), it can submit work as the user. What
  bounds that: writes are off until an admin turns them on, a client holds write only after the user's
  step-up consent, grants expire and can be revoked, an idempotency key is required, the budget tier is
  fixed, the burst limit and the concurrency cap apply, and a person reviews and merges every pull
  request, unless its repository is in `auto` mode, where GitHub may merge a qualifying low-risk one.
  Users should not set an MCP client to approve write tools automatically.
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
- The domain tools cover the teams, pull requests, epics, schedules, orchestrations, run records, and the agent library and skills listed in the domain read table. Most other things the dashboard
  reads (knowledge, reports, usage, platform configuration) and every dashboard write other
  than the six write tools are available through the REST API but not over MCP.
- A team's members are returned as user ids and roles. `get_team` resolves no id to a person, but the
  run tools return an initiator's `id`, name and email, so a client can map member ids to emails for
  the people who initiated runs it can see. Any other name or email must come from the dashboard.
- Consent is a tier (read, admin read or write), not per repository or per tool: a token reads everything its user can read, and admin read adds the admin-tier reads, each still checked by its route's role.
- `list_repositories` filters out the connections that are not git repositories after the route has
  counted them, so its `total` can exceed the rows a client can ever page through.
- A single-read tool call costs two requests against the gateway's per-IP rate limit: the endpoint's
  and the inner call's. `wait_for_run` polls at three-second intervals, with up to three reads per
  iteration (listing runs for a work request, reading its run, reading pending human steps), all
  counting against that limit. Stop and retry later on a rate-limit refusal. The limit is per process.
- `wait_for_run` samples status, not events: intermediate transitions between polls can be missed.
  It follows the newest run for a work request; use a run id to follow one particular execution.
- Branch and diff totals are available only when recorded in the result. A failed run can have pushed
  a branch without recording it there, and spilled result fields cannot be recovered through MCP.
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
