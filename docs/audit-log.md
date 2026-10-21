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
  `epic`, `prd-run`, `slack`, `webhook`, `automation`, `service-token`), `templateId`,
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
- **Eval runs.** `POST /platform/evals/runs` writes one `CREATE` row of entity type `EvalRun` after
  the workflow has started, with `afterJson` `{ source: "eval-run", baselineRef, candidateRef,
  datasetId, temporalWorkflowId }`. A refused or failed start leaves no row, and a failed audit write
  is logged without failing the run.
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
