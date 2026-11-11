# Audit log

The audit log is an append-only record of administrative and governance actions: who changed what,
what it looked like before and after, and how the request arrived. Rows live in `config_audit_log`
(`ConfigAuditLog`) and are read at `GET /api/v1/admin/audit-log` (ADMIN only) and in the dashboard's
audit page.

## 1. What is audited

Each row carries `entityType`, `entityId`, `action` (`CREATE`, `UPDATE`, `DELETE`), `actorId` (null
when the system acted, such as a webhook or a sweep), `beforeJson`, `afterJson`, `createdAt` and
`context`.

- **Configuration and governance changes** made through the gateway write a row through
  `writeAuditLog` (`gateway/src/lib/auditLog.ts`) in the same transaction as the change where one
  exists, so the entry commits or rolls back with it.
- **Launches.** Every run started through `launchTrackedWorkflow` writes one `CREATE` row, after
  the workflow has started. Its entity is the `WorkRequest` (`entityId` is the work request id), or
  the `ActiveWorkflow` spend-ledger row when the launch has no work request. `afterJson` sets
  `workRequestId` when it is known and `afterJson` carries `source` (the door it came
  through: `work-request`, `work-request-retry`, `template-run`, `template-retry`, `agent-run`,
  `epic`, `campaign`, `prd-run`, `slack`, `webhook`, `automation`, `service-token`), `templateId`,
  `temporalWorkflowId` and `workRequestId`. The actor is the launching user, or null for a system
  launch. A launch that is refused, found to be a duplicate, or compensated after a failed start
  leaves no row. A failed audit write is logged and never fails the launch.
- **Worker-started launches.** Three kinds of run start from worker code, where no gateway request
  exists, and write their `CREATE` row there, after the start, with `source` in `afterJson` and no
  `context` (see below). An epic child (`source: "epic-child"`) and a channel task
  (`source: "channel-task"`, a run under a `chantask-` workflow id, deferred or not) start from
  workflow code, so the row is written by `createWorkflowRun`, their first activity, once the run
  row exists. Its entity is the `WorkflowRun` (`entityId` is the run id), not the `WorkRequest`:
  an epic's children share the work request of the epic, which already has the launch row the
  gateway wrote. `afterJson` also carries `templateId`, `temporalWorkflowId`, `workRequestId` and,
  for a child, `parentWorkflowId`. A PRD child (`source: "prd-child"`) starts inside an activity;
  its row is written under the child's `WorkRequest`, after the start succeeds and also on the
  retry branches that find the child already started, because an attempt can die between the start
  and the write. The actor is the launcher the run carries (`launchedById`); for a repo-less channel
  task, which has none, it is the person recorded as having asked for the work. That fallback names
  the actor of the row only and is never a credential key. At most one row exists per entity and
  source, so the PRD-child row records the first accepted launch for the work request: if that
  child dies in setup and a retry relaunches it under a new workflow id, the row still names the
  first id. The check and the insert run in one transaction under an advisory lock, so overlapping
  attempts cannot both write. A failed write is logged without failing the launch.
- **Scheduled fires** write no audit row. A fire that starts is recorded in the schedule's decision
  ledger ([automations.md](./automations.md)), once per workflow id; a refused fire writes a
  `ScheduledWorkRequest` `UPDATE` row, at most one per reason per hour.
- **Campaigns.** `POST /api/v1/campaigns` writes one `CREATE` row of entity type `Campaign` (the campaign
  id as `entityId`, the launching user as actor) after the workflow has started, beside the launch's
  own `WorkRequest` row. `afterJson` holds the name, recipe reference and parameters, owning team,
  target count, parallelism and the pinned template and version. `POST …/cancel` writes one `UPDATE`
  row with the state before and `CANCELLING` after, and the person who cancelled. A launch that is
  refused or compensated leaves none. See [campaigns.md](./campaigns.md).
- **Eval runs.** `POST /api/v1/platform/evals/runs` writes one `CREATE` row of entity type `EvalRun` after
  the workflow has started, with `afterJson` `{ source: "eval-run", baselineRef, candidateRef,
  datasetId, temporalWorkflowId }`. A refused or failed start leaves no row, and a failed audit write
  is logged without failing the run.
- **Reviews and send-backs from the review page.** Sending a review
  (`POST /api/v1/pull-requests/:id/review`) or sending a pull request back to the agent
  (`POST …/send-back`) writes one `CREATE` row of entity type `PullRequestReview`, with the pull
  request's id as `entityId` and the person as actor, after the host accepted it. `afterJson` is
  `{ kind: "review", event, comments, hasBody, headSha, githubReviewId, prNumber, repositoryId }` or
  `{ kind: "send-back", hasNote, headSha, githubCommentId, prNumber, repositoryId }`. It records
  counts and ids, never the text of a review, a comment or a note, and never a token. A review's row
  commits in one transaction with the deletion of the drafts it sent; a refused or failed send, and
  one whose outcome is unknown, leaves no row, and a failed audit write is logged without failing a
  send that already happened.
- **Sign-ins.** Each session created by better-auth writes a `CREATE` row of entity type `Session`
  with `afterJson` `{ "event": "sign_in" }`, the user as actor, and a context of `via: "session"`
  plus the request id and truncated address. The address is the request's (`request.ip`), not the
  session row's `ipAddress`, which better-auth fills from `X-Forwarded-For` whatever the proxy
  setting; the row's value is used only when the hook runs outside a request.

## 2. The `context` field

`context` says how an action arrived. It is a JSON object, null on rows written before the column
existed and on rows written outside a request. Fields are omitted when they do not apply.

| Field | Meaning | Derived from |
|---|---|---|
| `via` | The credential path: `jwt`, `pat`, `service`, `assistant`, `mcp`, or `session` (a better-auth session cookie presented directly, and sign-in rows). Browser traffic from the dashboard is labelled `jwt`, because it sends session-bridge JWTs | `request.authMethod`, stamped by `requireAuth` on the path that admitted the request |
| `requestId` | The gateway's request id, to correlate with server logs | `request.id` |
| `ip` | The caller's address, truncated | `request.ip`, then `truncateIp` |
| `servicePrincipalId` | The service principal behind a `service` call | `request.principal` |
| `conversationId`, `actionId` | The assistant conversation, and the confirmed action a `confirm` route spent | `request.assistant` |
| `mcpClientId` | The OAuth client behind an `mcp` call | `request.mcpBridge` |

`gateway/src/lib/auditContext.ts` keeps the request in an `AsyncLocalStorage`, entered by a global
`preHandler` hook. The context is built when a row is written rather than snapshotted when the hook
runs, because some routes authenticate in their own `preHandler`: an earlier snapshot would leave
`via` empty for them.
`writeAuditLog` reads it and accepts an explicit `context` that overrides it. Direct
`configAuditLog.create` writers inside request handlers spread `auditContextData()` into `data`.

## 3. Privacy

- The address is truncated before it is stored: IPv4 to its /24 (the last octet is zero), IPv6 to its
  /48. An IPv4-mapped IPv6 address in dotted form (`::ffff:198.51.100.23`) is treated as the IPv4
  address it wraps; the hex form (`::ffff:c633:6417`) is truncated as IPv6. An address that cannot
  be parsed is omitted.
- The user agent is not stored.
- An `assistant` call arrives from the worker, so its peer address would say nothing about the
  person. `ip` is omitted and the conversation (and confirmed action) is recorded instead. An `mcp`
  call is bridged in-process with the outer request's client address as its remote address, so its
  truncated `ip` is the client's, recorded beside the MCP client id.

## 4. Retention

Audit rows are kept forever by default. The registry setting `audit.configLogRetentionDays` (ADMIN,
GLOBAL only) turns on a sweep: `0` (the default) keeps everything, otherwise the value must be at
least 365 days. A stored value below that floor fails the setting's schema, is ignored, and the
default applies, so nothing is deleted. The sweep runs on the `AUDIT_ACTIVITY_PRUNE_*` schedule
([configuration.md](./configuration.md)) and deletes rows older than the cutoff in batches, at most
100,000 per run; the next run continues.

Two kinds of row are never deleted by the sweep, whatever their age: registry setting changes
(`ConfigSetting` rows, so the record of who set a retention stays) and the retention summary rows
(`AuditLogRetention`). Rows of every other entity type are pruned.
When a run deleted anything it writes one `AuditLogRetention` summary row: system actor, `afterJson`
`{ deleted, cutoff, retentionDays, more }`. If that write fails it is logged and the deletion stands
without it. The same sweep prunes user-activity events ([user-activity.md](./user-activity.md)).

## 5. Run effects

Beside the audit log, each run keeps a record of what it changed **outside the sandbox**: the run
effects ledger (`run_effects`, `RunEffect`). It records and does not gate: nothing is approved,
denied or rolled back because of a row. A row has a `kind`, an `action`, a `target` (a URL, branch,
external id or tool name), a `status` (`DONE`, `FAILED` or `SKIPPED`), the path it took (`via`: `harness_relay`,
`mastra_mcp` or `activity`), the spec node and agent that did it, and a small `detail` object.

| Kind | Recorded when |
|---|---|
| `MCP_TOOL` | An agent calls an MCP tool the server did not annotate `readOnlyHint: true`, through the harness relay or the Mastra binding. A tool with no annotation counts as a mutation. This includes the `mcp` workflow node's call. |
| `PULL_REQUEST` | The pull request step creates a PR on the host (`target` is its URL; `detail` has the number, branch and head). A failed create is recorded too. A retry that gets back the PR an earlier attempt opened does not record it again. Re-arming a PR that is already open writes only the platform's own row, not the host, so it is not an effect; the new head is the `GIT_PUSH`. |
| `GIT_PUSH` | A step pushes a branch: the implementer and its fix sessions, the merge-conflict resolver, and an agent run's gated commit (`target` is the branch; `detail` has the head commit when known). A rejected push is recorded, then the error is thrown as before. |
| `TRACKER` | A tracker write: the PR-opened, run-started and run-finished syncs, and the epics and stories a PRD run creates. A provider never throws on a failed call: `syncOnEvent` resolves the class of the first write the tracker refused (`rejected`, `unauthorized`, `server_error` and so on), and the row is `FAILED` with that class as its error; a create that returns null is `FAILED` too. Every step of a sync event runs even if an earlier one failed. A GitHub sync the repository check declined (`out_of_scope`, `no_repository`) is recorded as a refused sync the same way. A sync that had nothing to send (a GitHub run-started, a Jira or Linear issue already in the target status; a Jira issue with no transition to the target is `FAILED`, as `no_transition`) wrote nothing and is recorded `SKIPPED`; one that wrote a comment, link or status change is `DONE`. A provider that cannot say what it wrote is recorded `DONE`. A create that was never attempted (no credentials, a GitHub project key that is not `owner/repo`, or one outside the repositories the run targets) records nothing. |
| `KNOWLEDGE_BASE` | The PR-link write-back (`updatePageWithPrLink` returns `{ ok: false, error }` on failure) and the pages a PRD run creates (a null page is a failure; Notion with no space configured sends nothing and records nothing). Only the write is an effect: a failed config lookup or page search is a read and records nothing. |

What a row holds is bounded. The tool or call input is never stored: `inputDigest` is a plain SHA-256 of
its redacted, canonical form. It is not keyed, and two inputs that differ only in a value the
redaction replaced digest the same. `detail`, `error` and `target` pass
through the trace redaction (credentials in URLs, bearer tokens, secret-looking keys and values),
`detail` is capped near 4 KB (an oversized one is replaced by a truncated preview) and `error` at
1,000 characters.

Writing a row is best effort, like trace persistence: it never throws, never fails the step it
records, and gives up after five seconds. A write that fails is logged as a warning and the row is
lost.

`runId` is null-on-delete and `workflowId` is kept, so a row outlives its run. Its retention is its
own: `audit.runEffectRetentionDays` (ADMIN, GLOBAL only) is `0`, keep forever, by default, otherwise
at least 30 days. The `AUDIT_ACTIVITY_PRUNE_*` sweep deletes older rows in the same batches as the
other halves. Unlike the audit log it writes no summary row.

`GET /api/v1/workflow-runs/:id/effects` (ENGINEER, the same run visibility as the run's traces;
service tokens do not reach it) returns a run's effects oldest first, at most 1,000, with
`truncated` set when there were more (the page is then the newest 1,000, and the older rows are
left out). The run page shows them under "External effects". The
in-app assistant may call the route (a read).

## Limitations

- Some writers do not carry a context: every writer in the worker and in `shared` code, which run
  outside a gateway request. The retention sweep's summary row is one of them. The MCP consent audit
  builds its context from the request itself, because it runs in an `onResponse` hook where the async
  store is unreliable, and names the path `session`.
- A launch through the gateway is recorded under `WorkRequest` (or `ActiveWorkflow`), not
  `WorkflowRun`: the run row is created later by the worker, so its id does not exist when the launch
  is audited. A gateway launch with neither id writes no launch row. Launches the worker writes are
  keyed on the `WorkflowRun` (epic children and channel tasks) or the `WorkRequest` (PRD children).
- A worker-started launch row has no `context`, because the worker has no request to describe;
  its door is `afterJson.source`. A started scheduled fire is in the decision ledger, not here.
- A worker-written launch row whose write fails is logged and not retried, so that launch has no row.
- Channel turns (the assistant answering in a channel, with no task) are conversation runs, not
  launches, and write no launch row.
- `ip` is `request.ip`. With `TRUST_PROXY` enabled and a gateway that clients can reach directly, a
  client can choose the address that is logged.
- Every session creation writes a `sign_in` row, including those made by `revokeOtherSessions` and
  by automatic sign-in after email verification, so the log holds sign-ins the person did not
  start by typing credentials.
- Denied requests and reads are not in the audit log; only actions that change state are. Refusals
  and sensitive reads are recorded separately, with their own retention
  ([user-activity.md](./user-activity.md)).
- A signed transcript download link authenticates outside `requireAuth` and carries no `via`.
- The dashboard shows only `via`, the truncated address and the request id of a row's `context`;
  the other fields (service principal, assistant conversation, MCP client) are in the API response.
  The CSV export carries the same three as `ip`, `via` and `request_id`, at the end of each row.
- Retention is off by default, so the table grows without bound until an operator sets it.
- Test apps built without the hook produce rows with no context.
- Run effects are best effort: a write that fails or times out is lost, and a row is only as complete
  as the hook that writes it. Nothing detects a missing row.
- Run effects record changes, not reads: a read-only MCP tool call, a connector read, a clone and a
  fetch are not rows. The classification trusts the server's `readOnlyHint`.
- Run effects cover the sites listed in section 5 only. Not covered: the tracker syncs the gateway
  sends from CI and merge webhooks; Slack posts and notifications; run callbacks and outbound
  event deliveries; the `writeOutcome` and `runTool` workflow nodes' connector writes; GitHub
  actions taken by the review-feedback and CI-fix paths other than the push; the remote side effects
  of a command an agent runs in `bash` (a `git push` or `curl` typed there is not seen, though the
  shell scanner may block it); and anything a plugin or sub-agent does that does not go through the
  MCP relay or binding.
- A run effect has no `runId` when the run row did not exist yet or its lookup failed; such a row is
  found by `workflowId` only, and the route does not return it.
- An activity retry that repeats a write records it again, so a row counts attempts, not distinct
  changes. The one exception is the pull request create, which is not recorded twice for one URL.
- A tracker create or knowledge-base write is recorded `DONE` when the provider's HTTP call
  succeeded. Linear's GraphQL client fails only on a non-2xx status, so a GraphQL `errors` array
  returned with HTTP 200 on a create is recorded `DONE`.
- A create that is refused before any request (a tracker base URL the SSRF check rejects) is
  recorded `FAILED` like a failed call; only the cases listed under `TRACKER` and `KNOWLEDGE_BASE`
  are detected as not attempted.
- Outside an activity there is no workflow to attach a row to, so none is written.
- A row keeps its `teamId` and `orgId` after the team or organization is deleted; they are not
  foreign keys.
- The five-second limit on a write stops the caller waiting, not the write: the underlying database
  call is not cancelled and may still land after the timeout is logged.
- The retention sweep skips the effects of a run under transcript legal hold, and only those. A row
  whose run is gone (`runId` null) or that never had one is not held.
