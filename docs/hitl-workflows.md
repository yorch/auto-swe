# Human-In-The-Loop (HITL) Workflows

> How to pause a running workflow, collect human input or approval, and resume execution.

---

## Overview

HITL nodes let you insert a human decision point anywhere in a workflow spec. When the interpreter reaches a HITL node it:

1. Creates a `WorkflowHumanStep` row in the DB with status `PENDING`.
2. (Optionally) sends a Slack notification to the team.
3. Parks the Temporal workflow at the node — no polling, no timeout loops.
4. Waits for a human to respond via the inbox UI or the REST API.
5. On response, fires a Temporal signal (`hitl_<nodeId>`), which unblocks the workflow and routes to the configured next node.
6. If the configured `timeout` elapses with no response, the workflow is automatically routed to `onTimeout`.

This is useful for:

- Requiring a human sign-off before a PR is opened.
- Collecting configuration values (branch names, environment targets, feature flags) that the agent can't infer.
- Letting a reviewer read and annotate a diff before it's merged.
- Presenting the agent with a list of options chosen by a human rather than the LLM.

---

## Node types

All four node types share a `timeout` field (ISO 8601 duration, e.g. `"24h"`, `"30m"`, `"7d"`) and an `onTimeout` routing target.

### `humanApproval`

Pauses the workflow and presents a binary approve/reject choice. The most common HITL node.

```yaml
type: humanApproval
title: "Approve implementation before opening PR"          # required; 1–200 chars
description: "Tests passed. Approve to open the PR or reject to discard."  # optional; max 2000 chars
contextFrom: context.currentCodeResult.summary             # optional; workflow context path to display
onApprove: setAwaitingCi                                   # required; node to route to on approval
onReject: terminateRejected                                # required; node to route to on rejection
onTimeout: terminateTimedOut                               # required; node to route to on timeout
timeout: "24h"                                             # required; ISO 8601 duration
```

Valid API actions: `approve`, `reject`.

### `humanDecision`

Presents 2–10 labelled options and routes to the corresponding next node. Use when the workflow needs a human to choose a path that the LLM shouldn't decide alone.

```yaml
type: humanDecision
title: "Apply the reviewer notes before opening the PR?"   # required
description: "..."                                         # optional
contextFrom: context.reviewSummary                        # optional
options:                                                   # required; 2–10 items
  - label: "Yes — apply the notes"
    value: "apply"
    next: addressFeedback
  - label: "No — looks good, open PR"
    value: "skip"
    next: openPR
storeAs: context.applyFeedbackChoice                      # optional; stores selected value
onTimeout: openPR                                         # required
timeout: "30m"                                            # required
```

Valid API action: `select` (with `value` set to one of the option values).

### `humanInput`

Presents a structured form with 1–20 typed fields. The submitted values are stored in the workflow context and available to downstream nodes.

```yaml
type: humanInput
title: "Configure the deployment"                         # required
description: "Fill in the deployment parameters."        # optional
fields:                                                   # required; 1–20 items
  - key: environment
    label: "Target environment"
    type: select
    options: [staging, production]
    required: true
  - key: version
    label: "Version tag"
    type: text
    required: true
  - key: dryRun
    label: "Dry run only?"
    type: boolean
storeAs: context.deployConfig                            # optional; stores submitted object
onSubmit: runDeploy                                      # required; node to route to after submit
onTimeout: terminateTimedOut                             # required
timeout: "1h"                                            # required
```

Field types: `text`, `number`, `boolean`, `select`. The `options` array is only relevant for `select` fields.

Valid API action: `submit` (with `value` set to an object keyed by field `key`).

### `humanReview`

Shows content (e.g. a diff or generated document) for the reviewer to read and optionally edit or annotate. The reviewer submits their text and the workflow continues.

```yaml
type: humanReview
title: "Review the implementation diff"                  # required
description: "Leave notes for the agent. Submit to continue."  # optional
contentFrom: context.currentCodeResult.diff              # required; workflow context path to show
storeAs: context.reviewFeedback                         # optional; stores submitted text
onSubmit: storeFeedback                                 # required
onTimeout: openPR                                       # required
timeout: "8h"                                           # required
```

Valid API action: `submit` (with `value` set to the reviewer's text string).

---

## Signal flow

```
Workflow interpreter
  └─ reaches HITL node
       ├─ INSERT WorkflowHumanStep (status=PENDING, signalName=hitl_<nodeId>)
       ├─ POST Slack notification (if Slack integration configured)
       └─ scheduleActivity(waitForSignal, timeout=<duration>)
             │
             │   human acts in inbox UI or via API
             ▼
Gateway POST /api/v1/inbox/:id/respond
  ├─ validate action against HITL_VALID_ACTIONS[kind]
  ├─ UPDATE WorkflowHumanStep SET status=RESOLVED (atomic, race-safe)
  └─ temporal.signalWorkflow(workflowId, signalName, [{ action, value, resolvedBy }])
             │
             ▼
Temporal signal received
  └─ workflow routes to onApprove / onReject / next option / onSubmit
             │
             ▼ (or on timeout)
Temporal timer fires
  └─ workflow routes to onTimeout
```

The DB update is authoritative — even if the Temporal signal fails (e.g. a transient network error), the step is recorded as resolved and the workflow proceeds on its next heartbeat.

---

## The inbox UI

All pending steps are visible at `/inbox`. The page polls every 10 seconds.

- **Admins** see all pending steps across all teams.
- **Leads and Engineers** see only steps from runs belonging to their teams.

Each card shows the step title, kind badge, description, and a link to the associated run. Click **Respond** to expand the action form:

| Kind | UI shown |
| ---- | -------- |
| APPROVAL | Approve / Reject buttons |
| DECISION | One button per option |
| INPUT | Typed form fields with a Submit button |
| REVIEW | Pre-populated textarea with a Submit button |

When a run is open at `/runs/<id>` and it has pending steps, those steps also appear in a **Pending actions** card in the right column — no need to navigate to the inbox.

The sidebar shows a count badge next to **Inbox** when there are pending steps. The top bar shows an inline amber indicator when `inboxCount > 0`.

---

## Designing a HITL workflow

The `human-code-review` template is a complete example that combines `humanReview` and `humanDecision`:

1. Agent implements and runs lint + typecheck.
2. `humanReview` shows the diff; reviewer submits optional notes.
3. `humanDecision` asks whether to apply the notes.
   - "Yes": agent addresses feedback, then opens PR.
   - "No": agent opens PR immediately.

Relevant snippet from `packages/shared/src/workflow/templates/humanCodeReview.ts`:

```typescript
humanReview: {
  contentFrom: 'context.currentCodeResult.diff',
  description: 'Review the diff and leave notes for the agent. Submit to continue.',
  onSubmit: 'storeFeedback',
  onTimeout: 'openPR',
  storeAs: 'context.reviewFeedback',
  timeout: '8h',
  title: 'Review the implementation diff',
  type: 'humanReview',
},
applyFeedbackDecision: {
  onTimeout: 'openPR',
  options: [
    { label: 'Yes — apply the notes', next: 'addressFeedback', value: 'apply' },
    { label: 'No — looks good, open PR', next: 'openPR', value: 'skip' },
  ],
  timeout: '30m',
  title: 'Apply the reviewer notes before opening the PR?',
  type: 'humanDecision',
},
```

The `pr-approval-gate` template shows the simplest pattern — implement, test, `humanApproval`, then open PR:

```typescript
approve: {
  description: 'Tests passed. Approve to open the PR or reject to discard.',
  onApprove: 'setAwaitingCi',
  onReject: 'terminateRejected',
  onTimeout: 'terminateTimedOut',
  timeout: '24h',
  title: 'Approve implementation before opening PR',
  type: 'humanApproval',
},
```

### Design guidelines

- Keep `timeout` realistic. `24h` is reasonable for approvals; `8h` for reviews during a working day; `30m` for a quick decision during active iteration. Long timeouts don't hurt throughput — the workflow parks cheaply inside Temporal.
- Always route `onTimeout` to a sensible default. For approvals, `terminateTimedOut` (non-blocking team) or `openPR` (auto-proceed) are the two common choices.
- Use `storeAs` when downstream nodes need the human's response. The stored value is available as `context.<path>` in later node `inputs`.
- Use `contextFrom` / `contentFrom` to give the human relevant context. The value is fetched from the workflow context at the time the node executes and included in the step's `context` field.

---

## Timeout behaviour

When the `timeout` duration elapses:

- The `WorkflowHumanStep` row is **not** automatically updated to `TIMED_OUT`. The DB row stays `PENDING` until manually cancelled or until the workflow terminates.
- The workflow routes to `onTimeout` and continues normally.
- If a human then tries to respond to the timed-out step, the gateway returns `409 RUN_NOT_RUNNING` (if the run finished) or `409 ALREADY_RESOLVED` (if the step was cancelled on workflow exit).

---

## Cancellation

When a workflow exits abnormally (cancelled by the user or failed), all `PENDING` steps for that run are bulk-updated to `CANCELLED` by the worker's cleanup activity (`cancelPendingHumanSteps`). This prevents stale inbox entries for finished runs.

---

## API reference

All endpoints require at least the `ENGINEER` role. Visibility follows the same team-membership rules as the inbox UI.

### `GET /api/v1/inbox`

Returns up to 100 `PENDING` steps visible to the authenticated user, ordered by `requestedAt` descending.

Response:
```json
{
  "data": [
    {
      "id": "<uuid>",
      "runId": "<uuid>",
      "nodeId": "approve",
      "kind": "APPROVAL",
      "title": "Approve implementation before opening PR",
      "description": "Tests passed. Approve to open the PR or reject to discard.",
      "status": "PENDING",
      "context": null,
      "options": null,
      "fields": null,
      "requestedAt": "2026-06-06T10:00:00Z",
      "run": {
        "id": "<uuid>",
        "status": "RUNNING",
        "workflowId": "eng-acme-payments-api-JIRA-42",
        "workRequest": {
          "externalTicketId": "JIRA-42",
          "description": "Add idempotency key support to /payments"
        }
      }
    }
  ]
}
```

### `GET /api/v1/inbox/:id`

Returns a single step by ID (same shape as one element of the list above).

Returns `404` if the step does not exist or is not visible to the caller.

### `POST /api/v1/inbox/:id/respond`

Submit a response to a pending step.

Request body:
```json
{ "action": "approve" }
```
```json
{ "action": "select", "value": "apply" }
```
```json
{ "action": "submit", "value": { "environment": "staging", "version": "v1.2.3", "dryRun": false } }
```
```json
{ "action": "submit", "value": "The diff looks good but please add input validation on line 42." }
```

Valid actions per kind:

| Kind | Valid actions |
| ---- | ------------- |
| `APPROVAL` | `approve`, `reject` |
| `DECISION` | `select` |
| `INPUT` | `submit` |
| `REVIEW` | `submit` |

Returns `400` with `INVALID_ACTION` if the action is not valid for the step's kind.
Returns `409` with `ALREADY_RESOLVED` if the step was already resolved or the workflow is no longer running.
Returns `200` with `{ "data": { "id": "...", "status": "RESOLVED" } }` on success.
