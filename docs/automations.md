# Automations

An **automation** starts template runs without a person pressing run. Every automation has the same
three parts:

- **When** it fires: an event on a repository and the automation's filters over it.
- **What** it starts: a template, and that template's own options.
- **Limits** on how often: a cooldown, a daily cap, and the guards every decision applies.

Each decision it makes is one row in the decision ledger, whether it started a run or not.

This page describes **event automations**, the generic kind, and the contract every event source
follows. CI-failure triage is the first source ([ci-failure-triggers.md](./ci-failure-triggers.md)
covers what is specific to it). Cron schedules, template webhook URLs and the issue-tracker
transition hook start runs too; they keep their own configuration (§6).

---

## 1. Event automations

An event automation (`Automation`) is a rule on one repository. When an **occurrence** of its
**source** happens on that repository and its filters select it, the platform starts its template.
Automations are opt-in per repository; there are none until someone creates one.

| Field | Part | Meaning | Default |
|---|---|---|---|
| `name` | — | A label | — |
| `source` | when | The event source (§3), e.g. `github.workflow_run.failed`. Fixed once created | — |
| `filters` | when | The source's filters, a JSON object in the source's shape | — |
| `cooldownMinutes` | limits | No new run for the same scope (a branch, for CI) within this many minutes of the last one started (0–10080) | 30 |
| `maxRunsPerDay` | limits | Most runs this automation starts in any 24 hours (1–500) | 10 |
| `templateId` | what | A template to start instead of the source's default: active, global or the repository team's own, not a system template, and one the source can start | the source's default |
| `inputs` | what | The template's options this automation sets. An option left out takes the template's default | `{}` |
| `enabled` | — | — | `true` |

**Options** are whatever the chosen template declares in its input schema, minus the fields every
occurrence fills (`connectionId`, `description`, `ticketId`, and the source's own, such as
`githubRunId`). An automation can never set those. The dashboard renders the options form from the
template's declaration, so a team template that declares its own options gets a form for them. The
dashboard saves only the options changed from the template's default, so an automation made there
follows the template when a default moves; the API stores the options it is sent.

**One builder for save and fire.** `buildAutomationPayload` builds a run's payload in this order:

1. every declared default;
2. the automation's options (only keys the template declares);
3. the repository and what the occurrence fills, which always win.

The result must pass the template's input schema and, where the source has one, the source's
payload contract, which is what the run itself parses.

At save, the payload is built for every shape of occurrence the filters can select (§3). An unknown
option, a key the occurrence fills, or a value the run would refuse is a `400`. At every fire it is
built again, because the template can change after the automation was saved; a payload that no
longer fits is recorded as `FAILED_TO_START`.

Filters are stored as the source's schema parsed them. The database refuses a source it does not
know, and filters that break the source's invariants (an empty event or pattern list). A stored
automation whose filters do not parse matches nothing.

### The Automations page

**Automations** (`/govern/automations`, in the Configuration section of the navigation) lists every
automation the caller may see, of every kind (§5). Each row says:

- when it fires;
- what it is on (a repository, a team's template, the platform);
- what it starts;
- what it last did: the latest decision for an event automation, a schedule or a template webhook
  (§5), with its reason on hover, and the latest run for the tracker hook.

Rows can be filtered by kind and searched. **Manage** opens where that kind is edited. **New event
automation** asks for a repository and opens its automations. **Schedules**
leads to the schedule editor at `/govern/schedules`, which keeps its own page and live state.

`GET /api/v1/automations` serves the page:

- event automations on the repositories the caller can reach (all, for ADMIN);
- template webhook URLs on templates the caller can read. Managing one also needs platform role
  LEAD, as the webhook routes do, and a webhook's last call is the newest one the caller may see
  (§5), so a global template never shows another team's call;
- for ADMIN only, the tracker transition hook. Its configuration is not read for anyone else.

Each row says whether the caller may manage it. Schedules come from their own list route,
`GET /api/v1/scheduled-work-requests`, so their visibility and permission rules stay where they are
enforced; the dashboard merges them.

### Managing event automations

On the dashboard, **Connections** (`/connections`) has an **Automations** action for each git
repository, and the Automations page opens the same dialog. It lists the repository's event automations and their recent decisions to its members,
and lets those who may manage them add one (one button per source), edit, enable, disable and
remove one. The form has a tester: given an occurrence (for CI, an event, a branch and a workflow
file), it says whether the automation would react and, if not, which filter rules it out. It calls
the source's own `mismatch`, the same one the webhook path uses, and says nothing about the limits,
which depend on earlier runs.

| Route | Who |
|---|---|
| `GET /api/v1/automations/events?connectionId=` | A member of the owning team or of a team the repository is shared with, or ADMIN; under an enforcing [access gate](./repo-access-gating.md) a member also needs a current GitHub permission on the repository. The response says whether the caller may manage them (`canManage`) |
| `POST /api/v1/automations/events` | ADMIN, or a LEAD of the repository's **owning** team |
| `PATCH` / `DELETE /api/v1/automations/events/:id` | The same |
| `GET /api/v1/automations/events/:id/fires?limit=` | A member, as for the list |
| `POST /api/v1/automations/events/:id/fires/:fireId/retry` | Those who may manage, as a launch decision: takes one decision that started no run again (§2) |
| `GET /api/v1/automations/events/templates?connectionId=&source=` | Those who may manage: the templates an automation of that source may start, each with the options it declares |

An event automation starts runs on the repository with the platform credential. That is why
managing one stays with the owning team, like every other repository setting, and a shared team can
read them but not create one.

Saving an automation that can start runs is a **launch decision**, made as it is for a schedule.
This covers creating an enabled automation, and any change that leaves one on. Editing an
automation that is off, and switching one off, are not launch decisions. The repository must be
active. The access gate judges the caller's own GitHub login (the runs use the platform
credential), and the caller must belong to the repository's organization, which must be under its
monthly cap. Every create, update and delete is written to the audit log (entity `Automation`).

A source may **gate** an option value: refuse it at save unless a setting allows it, or unless the
automation uses the source's default template. For CI, pushing a fix onto a pull request's branch
is gated this way. A gated value is refused with `OPTION_DISABLED` or `INVALID_INPUTS`. The run
decides again when it acts.

## 2. From occurrence to run

A source's webhook normalizer turns a verified delivery into an occurrence, without calling the
host. The engine (`handleOccurrence`) then:

1. **Ignores**, with nothing recorded:
   - what the source's normalizer or its `ignore` rule never acts on (for CI, the platform's own
     branches);
   - an occurrence no enabled automation of that source matches;
   - a deployment, organization or team with the source's kill switch off.
2. **Lets the first matching automation act.** Repository rows are taken oldest first, and
   automations oldest first within each. One occurrence starts at most one run, however many
   automations or repository rows match it.
3. **Records the decision** as an `AutomationFire`, keyed by the occurrence on its repository
   (`dedupeKey`). A redelivered webhook answers `duplicate` and starts nothing, unless the earlier
   decision was `FAILED_TO_START`: that one is taken again. The decision is taken
   under a transaction lock on the **repository**, so concurrent deliveries see each other. A run
   is **suppressed** when:

   | Outcome | When |
   |---|---|
   | `SUPPRESSED_PRECONDITION` | The source says the occurrence cannot start a run (for CI, a pull-request failure with no open pull request) |
   | `SUPPRESSED_BUDGET` | The repository's organization is over its monthly budget |
   | `SUPPRESSED_OWN_OUTPUT` | The occurrence's subject is something a run of the platform produced (for CI, a fix commit it pushed): acting on it would answer the platform's own output with more of it |
   | `SUPPRESSED_SAME_SUBJECT` | A run was already started on the repository for this subject (for CI, the commit), by any automation |
   | `SUPPRESSED_COOLDOWN` | A run started for this scope (for CI, the branch) within the automation's `cooldownMinutes` |
   | `SUPPRESSED_IN_FLIGHT` | A run started for this scope within the source's look-back is still in progress: its ledger row is open **and** Temporal does not report the execution over (a Temporal that cannot answer counts as running) |
   | `SUPPRESSED_DAILY_CAP` | This automation started `maxRunsPerDay` runs in the last 24 hours |
   | `FAILED_TO_START` | The automation's template is missing, inactive, a system template, or one the source cannot start; or its options no longer fit it |

4. Otherwise **starts the run** (`STARTED`): a ticket and description from the source, the
   payload from the builder, a workflow id `<prefix>-<automation8>-<part>`. The run has no
   requesting user, so it uses the platform credential and never a person's saved token. Starting
   the workflow is tried three times. A retry that finds the execution already started counts as
   started, because an earlier attempt whose reply was lost did start it. If every attempt fails,
   the decision becomes `FAILED_TO_START` and the delivery answers `503`. A failed start counts
   against nothing: only `STARTED` decisions suppress later occurrences.

A decision that started no run can be **taken again**: by redelivering the webhook when it was
`FAILED_TO_START`, or with **Decide again** in the automation's history (the retry route above) for
any outcome but `STARTED`. The retry reads the occurrence from the ledger's `facts`, needs the
automation on and its filters still selecting the occurrence, and passes every limit a delivery
does, so a decision that still holds (a cooldown that has not run out, the platform's own output)
is recorded again. The earlier row stays in the history, marked `retriedAt`, with its dedupe key
moved aside to `<key>~<its id>`; concurrent retries and redeliveries take it at most once.

### The ledger

`AutomationFire` rows belong to the **repository** (`repoKey`, `<host>/<owner>/<repo>` lowercased)
and the **source**, not to the automation or the connection row. The guards count one source's
decisions on one repository. The exception is the own-output check, which matches the subject on
its own: a commit sha names one commit wherever it is. The automation and connection links are set to null
when either is deleted, and the limits keep reading the rows. So deleting and recreating an
automation, or a repository row, does not forget which subjects were handled, what the platform
produced, or what is still in flight. Each row keeps:

- `subjectKey`: what one run is enough for;
- `scopeKey`: what the cooldown and in-flight checks count over;
- `producedKey`: what a run produced;
- `facts`: the occurrence as the source saw it, which the history shows and a retry decides
  from;
- `retriedAt`: set when the decision was taken again.

**Retention.** A daily sweep (`ScheduledAutomationDecisionPruneWorkflow`, the
`auto-swe-automation-decision-prune` schedule) deletes decisions that started no run once they are
older than `workflow.automationDecisionRetentionDays` (default 90 days, at least 7). `STARTED`
decisions are kept regardless, because the same-subject and own-output guards read them; a sweep
deletes in batches of 2,000 and at most 100,000 rows, leaving any backlog to the next one. The
seven-day floor keeps a decision at least as long as GitHub lets a delivery be redelivered, so a
redelivery finds its decision rather than being decided afresh. The schedule's switch and cadence
are environment-only ([configuration.md](./configuration.md)).

## 3. Event sources

| Source | When | Subject / scope | Default template | Kill switch |
|---|---|---|---|---|
| `github.workflow_run.failed` | A GitHub Actions run of a `push`, `pull_request` or `schedule` workflow fails ([ci-failure-triggers.md](./ci-failure-triggers.md)) | the commit / the branch | `ci-triage-and-fix` | `github.ciFailureTriggersEnabled` |
| `github.issues.labeled` | A person adds one of the automation's labels to an open issue (§3.1) | that labelling / the issue | `default-engineering` | `github.issueLabelAutomationsEnabled` (off by default) |

A source is a pure descriptor (`EventSource` in `@auto-swe/shared/automation`) plus a webhook
normalizer in the gateway. The descriptor declares:

- **Filters:** the filter schema, its defaults, and the form fields;
- **Matching and display:** `mismatch`, a tester, and descriptions for lists and history;
- **Payload:** the payload keys it fills, the ticket and fields of a run, and an optional payload
  contract;
- **Decision keys:** subject and scope, the dedupe key, and the workflow-id prefix;
- **Templates:** its default template, and which templates it can start;
- **Early exits:** its `ignore` and `precondition` rules and its in-flight look-back;
- **Switches and gating:** its kill switch, and any gated options.

Adding a source means:

1. a descriptor;
2. a normalizer;
3. a branch in the webhook route;
4. the source key in the database's `automations_source_known` check, with a CHECK on its filters.

The engine, API, dashboard and ledger take it from there.

### 3.1 Issue labels

A label added to an open issue starts the automation's template on the issue: by default the
engineering template, which implements it and opens a pull request. The filters name the labels
(compared without case). The run's description is the issue's title, its body (the first 4,000
characters) and a link back; its ticket is synthetic, `issue-<number>-<hash>`.

Issue forms add labels on behalf of whoever opens the issue, so a label says nothing about who
asked. Three things stand between an issue and a run:

- **The switch.** `github.issueLabelAutomationsEnabled` is off by default (ADMIN, per team or
  organization).
- **The person.** The source names who added the label (`actor`). A run starts only when that
  GitHub account, matched by its numeric id on the repository's host (not by login, which can be
  renamed and reused), is linked to an **active** platform user who is a **member** of the
  repository's owning team or a team it is shared with. Anyone else's labelling is recorded as
  `SUPPRESSED_PRECONDITION`. A label added by a bot or an App, the platform's own included, is
  ignored.
- **The run's identity.** The run records that user as its requester (`RunInput.requestedById`),
  for attribution only. It uses the platform credential, as every automation run does; it never
  acts with the person's own saved token.

Each labelling is its own subject, so removing and adding a label again starts again; the issue is
the scope, so a labelling while an earlier run on the issue is open is `SUPPRESSED_IN_FLIGHT`, for
up to 14 days. A closed issue and a pull request are ignored.

## 4. Permissions on the host

What an occurrence needs from the host is the source's: for CI, the **Workflow run** event and
**Actions: Read**; for issue labels, the **Issues** event and **Issues: Read**
([github-app-setup.md](./github-app-setup.md)).

## 5. Other kinds of automation

These start runs too and keep their own configuration. The Automations page lists them beside
event automations.

Schedules and template webhooks also write their decisions to the ledger, under their own sources
(`schedule.fire`, `template_webhook.call`), with the schedule's or template's id as subject and
scope and no repository key. Event sources' guards read only their own source, so these rows never
suppress anything:

- **A schedule fire** is recorded by the worker when the run is created (`STARTED`, keyed by the
  fire's workflow id, so a retried activity records it once) or when the owner's launch decision
  refuses it: `SUPPRESSED_IN_FLIGHT` for a fire skipped while the request is still running,
  `SUPPRESSED_BUDGET` over the cap, `SUPPRESSED_PRECONDITION` for every other refusal, with the
  refusal's message as the reason.
- **A template webhook call** is recorded once its token names a template: `STARTED`, or
  `FAILED_TO_START` (inactive template, no active version, a payload or base branch or connection
  it refuses), `SUPPRESSED_BUDGET`, or `SUPPRESSED_SAME_SUBJECT` for an idempotency key already used.
  A call to an unknown token records nothing.

A refusal is keyed by the owner, its reason and the hour, so a per-minute cron that keeps being
refused, or a caller hammering a webhook, leaves one row an hour per reason. `GET
/api/v1/scheduled-work-requests` returns each schedule's `lastDecision`; the Automations list returns
a webhook's latest call only when the caller may see it: a call on a repository they can reach, or a
call on no repository to a team's own template. The retention sweep removes these rows like any
other decision that started no run.

| Kind | Configured at | Who |
|---|---|---|
| Cron schedule (`ScheduledWorkRequest`) | `/govern/schedules`, linked from the Automations page | ADMIN, or a LEAD of the owning team or a team the repository is shared with |
| Template webhook URL | the template's page | LEAD+ who may edit the template |
| Issue-tracker transition | `/studio/integrations` → Tracker | ADMIN |

## Limitations

- **Two event sources.** Failed GitHub Actions runs and issue labels start event automations; a
  comment, a review or a pull request label does not.
- **An issue run acts on the issue's text.** The labeller is a member, but the issue's title and
  body may be anyone's: an issue opened by an outsider and labelled by a member carries the
  outsider's text into the run's description, as a work request typed from it would. Only the first
  4,000 characters of the body are used, and later edits to the issue are not seen.
- **Membership is read when the label arrives.** A person who leaves the team keeps the runs they
  already started; a person whose GitHub account is not linked to their platform user cannot start
  one.
- **The other kinds keep their own storage.** Schedules, template webhook URLs and the tracker
  transition are configured where they always were (§5). Schedules and webhooks record their latest
  decision, but not a full history in the dashboard, and only the first refusal of a reason in an
  hour; a schedule's history starts with its first recorded fire. The tracker transition writes no
  ledger rows: the page shows its latest run. A webhook call on a global template with no repository
  is shown only to admins.
- **A renamed repository starts a fresh ledger.** The ledger is keyed by the repository's name on
  its host, so after a rename the subject, cooldown and in-flight checks no longer see the earlier
  decisions. They come back with the next ones. The own-output check matches a commit wherever it
  is, so a fix the platform pushed is still recognised.
- **Started decisions are never pruned.** The retention sweep removes only decisions that started
  no run, so the ledger still grows by one row per run started, and an own-output or same-subject
  guard never lapses. A redelivery older than the retention is decided afresh.
- **Shared teams do not manage event automations.** A LEAD of a team the repository is shared with
  can read them, but only the owning team's leads and ADMIN manage them, unlike schedules (§5).
- **The daily cap is the automation's own.** Deleting and recreating an automation starts its cap
  afresh; the repository-wide guards (subject, scope, in flight) and the own-output check, which
  matches the subject across the source's whole ledger, are not affected.
