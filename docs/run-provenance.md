# Run provenance

Every workflow run records how it started: which door it came through, who acted there, and, for a
re-run, which attempt it follows. The record is written when the run row is created and is never
rewritten, except that deleting the user, service principal or previous run clears that field. It
answers "who started this, and by what route?" for the runs table, the run page, the
REST and MCP run tools and the CLI.

## 1. What a run records

| Field | Meaning |
|---|---|
| `trigger` | The door that started the run, one of the `RUN_TRIGGERS` in `shared/lib/runTrigger.ts` |
| `triggerRefId` | An opaque id of the thing behind the door: an automation id, a schedule row id, a parent or epic workflow id, a channel id, or the id of the run a review covers |
| `initiatedById` | The person who acted |
| `initiatedByServiceId` | The service principal that acted ([service-principals.md](./service-principals.md)) |
| `rerunOfRunId` | The run id of the previous attempt, on a re-run |

All five are nullable, and many runs have no initiator because no one acted.

`trigger` is provenance only. A run's behaviour never reads it.

## 2. Launcher and initiator are different things

`WorkflowRun.launchedById` is a **credential key**: it names whose saved GitHub token the run may
use ([user-github-credentials.md](./user-github-credentials.md)). It is never shown as the
initiator, because it is inherited without anyone acting: a cron fire, an epic or PRD child and an
automatic review all carry a human's `launchedById` while that human did nothing at that moment.

The initiator is the person (or service principal) who acted at the door. When the two differ, the
initiator is what the runs table and the run page show. `isMine` on a run still means "the viewer is
`launchedById`" and is unchanged.

## 3. Door, trigger and initiator

| Door | `trigger` | Initiator |
|---|---|---|
| Web, CLI, MCP or the assistant submitting a work request | `work-request` | The signed-in user |
| Re-running a request | `work-request-retry` | The person who retried |
| Running a template | `template-run` | The signed-in user |
| Re-running a template run | `template-retry` | The person who retried |
| Running or re-running a library agent | `agent-run` | The signed-in user (a re-run also sets `rerunOfRunId`) |
| A service-token launch of a template or an agent | `service-token` | The service principal |
| Slack | `slack` | The linked platform user |
| An inbound webhook | `webhook` | Nobody |
| An automation | `automation` | The actor the event names, when it names one and the actor is a verified platform user; the person who clicked, for a manual automation retry; otherwise nobody |
| A schedule fire | `schedule` | Nobody |
| A PRD run | `prd-run` | The signed-in user |
| A PRD story run | `prd-child` | The person who started the PRD run |
| An epic repository run | `epic-child` | The person who started the epic |
| A code review the user asked for | `code-review` | The signed-in user |
| A review attached automatically | `code-review` | Nobody |
| A guarded fix round after a review | `review-fix` | Nobody |
| A channel task | `channel-task` | The linked platform user |
| A channel mention turn | `channel-turn` | The linked platform user |
| An ambient or reactive channel turn | `channel-turn` | Nobody |

MCP's `start_template_run` and `start_agent_run` arrive as `template-run` and `agent-run`. `epic` and
`unknown` are in the trigger vocabulary but no run is written with them: an epic's orchestrator has
no run row of its own, and its repository runs carry `epic-child`.

`triggerRefId` is the automation id, schedule row id, parent or epic workflow id, channel id or
reviewed run id, as the door supplies it. When a request carries no trigger, the worker derives
`epic-child` from a parent workflow id and `schedule` from a `sched-<row id>` workflow id; a
trigger the request supplied is never overwritten. An initiator or previous-run id that is malformed or does not resolve is dropped rather than stored;
`triggerRefId` is stored as given, and an unrecognised trigger is recorded as none.

## 4. Where it is exposed

- **REST.** The run list, run detail, a template's run list and the request workspace return
  `trigger`, `triggerRefId`, `initiatedBy` (`id`, `name` (nullable), `email`), `initiatedByService` (`id`,
  `name`) and `rerunOfRunId`. In the request workspace they are those of the request's latest
  visible attempt. A trigger outside the vocabulary is returned as null. A service-principal caller
  with `runs:read` receives the same fields.
- **MCP.** `list_runs`, `get_run` and `wait_for_run` return the same fields
  ([mcp-server.md](./mcp-server.md)). Names are clipped to 200 code points and emails to 320; a
  `triggerRefId` over 200 is dropped. An unrecognised trigger is null.
- **Dashboard.** The runs table has an Initiated by column, on `/runs` and a template's runs page.
  The run page's rail shows an Initiated by row and, on a re-run, a Previous attempt link. A
  separate Trigger row appears only when a person or service principal initiated the run, because
  otherwise Initiated by already shows the trigger kind. A person is shown by name with the email
  beneath (the email alone when there is no name); a service principal by name; a run with no
  initiator by its trigger kind only.
- **CLI.** `auto-swe runs list` has an INITIATED BY column (the person's name, or email when there is no name;
  the service name; otherwise the raw trigger; truncated to 24 characters); `runs show` prints the
  JSON.

Whoever can see a run sees its initiator's name and email. That is a deliberate choice: the
question "who started this" is useless without an answer a person recognises.

## 5. Untrusted text

An initiator's name and email and a service principal's name are text a user or an administrator
wrote. The REST API returns them as stored. The MCP projection strips invisible and control characters and
clips them, the dashboard strips control and format characters, and the CLI strips control
characters. In-app assistant API results return them unstripped. They remain untrusted: every
consumer must treat them as data. A consumer that puts them in a prompt, a message or a page keeps
that boundary:
the dashboard renders them as plain text, and an MCP client or the in-app assistant that reads them
reads the same user-controlled display names as any other field a person typed.

## Limitations

- Runs created before provenance was recorded have no trigger or initiator and show "Not
  recorded". There is no backfill.
- A manual "Run now" of a schedule is recorded as trigger `schedule` with no initiator, because the
  Temporal schedule's arguments are fixed per schedule.
- A schedule saved before provenance was recorded derives `schedule` from its workflow id until it
  is saved again.
- A channel task started through the general route has no initiator.
- A human retry of a review fix does not reach the run, so review fixes record no initiator.
- A deleted user or service principal leaves the run with its trigger and no initiator, so it reads
  as a system run.
- `rerunOfRunId` names the request's newest earlier run, which is not always the run the person
  clicked re-run from.
- The team overview feed's "by <name>" reads the credential key `launchedById`, not the initiator,
  so it can differ from the runs table; a schedule fire, for one, acts as the schedule's configured
  user.
- Name, email and service name are user- or administrator-controlled text. MCP clients and the
  in-app assistant read the same display names, and a client can map member ids to emails for the
  people who initiated runs it can see.
- The initiator is fixed when the row is created.
- An id that does not resolve is silently stored as null.
- On the dashboard, the request lists, the request workspace, the team overview and the dashboard
  home do not show the initiator.
- `rerunOfRunId` may name a run the viewer cannot open, and the link is shown regardless.
- The initiator's email is visible to everyone who can see the run, including members of teams a
  repository is shared with and service principals with `runs:read`.
- Workflows that create no run row (the epic orchestrator, pull-request evaluation, onboarding pull
  requests) record no provenance.
