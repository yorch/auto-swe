# Automations

An **automation** starts template runs without a person pressing run. Every automation has the same
three parts:

- **When** it fires: an event on what the automation belongs to (a repository, or a team) and
  the automation's filters over it.
- **What** it starts: a template, and that template's own options.
- **Limits** on how often: a cooldown, a daily cap, and the guards every decision applies.

Each decision it makes is one row in the decision ledger, whether it started a run or not.

This page describes **event automations**, the generic kind, and the contract every event source
follows. CI-failure triage is the first source ([ci-failure-triggers.md](./ci-failure-triggers.md)
covers what is specific to it); events other services post to a team's signed endpoints are another
([inbound-events.md](./inbound-events.md)); a new issue in a Jira filter, found by polling, is a
third (§3.2). Cron schedules, template webhook URLs and the issue-tracker
transition hook start runs too; they keep their own configuration (§5).

---

## 1. Event automations

An event automation (`Automation`) is a rule that belongs to an **owner**. When an
**occurrence** of its **source** happens on that owner and its filters select it, the platform
starts its template. Automations are opt-in; there are none until someone creates one.

Each source declares what its automations belong to (its `target`):

- **A repository** (`connectionId`): the rule is on one git repository, its runs act on that
  repository, and the repository's owning team manages it. The two GitHub sources target a
  repository.
- **A team** (`teamId`): the rule belongs to a team and has no repository of its own; its runs act
  on none and take the workspace their template declares, unless it names a repository to act on
  (§1, *Team automations*). Inbound events target a team.

The database holds every automation to at least one owner (`automations_owner_present`). A row
that names a repository is a repository automation, whatever else it names. The API creates an
automation only on the owner its source targets, and answers `400 SOURCE_TARGET_MISMATCH`
otherwise.

| Field | Part | Meaning | Default |
|---|---|---|---|
| `name` | — | A label | — |
| `source` | when | The event source (§3), e.g. `github.workflow_run.failed`. Fixed once created | — |
| `filters` | when | The source's filters, a JSON object in the source's shape | — |
| `cooldownMinutes` | limits | No new run for the same scope (a branch, for CI) within this many minutes of the last one started (0–10080) | 30 |
| `maxRunsPerDay` | limits | Most runs this automation starts in any 24 hours (1–500) | 10 |
| `templateId` | what | A template to start instead of the source's default: active, global or the owning team's own (the repository's team, or the team automation's team), not a system template, and one the source can start. Required for a source with no default (`400 TEMPLATE_REQUIRED`) | the source's default |
| `targetConnectionId` | what | For a team automation only: a repository the team owns or is shared that its runs act on (*Team automations*) | none |
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
3. the repository (for an automation that has one) and what the occurrence fills, which always
   win.

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

**Automations** (`/admin/automations`, in the Configuration section of the navigation) lists every
automation the caller may see, of every kind (§5). Each row says:

- when it fires;
- what it is on (a repository, a team, a team's template, the platform);
- what it starts;
- what it last did: the latest decision for an event automation, a schedule or a template webhook
  (§5), with its reason on hover, and the latest run for the tracker hook.

Rows can be filtered by kind and searched. **Manage** opens where that kind is edited: a
repository's automations, or for an automation with no repository, its team's. **New event
automation** asks for a repository and opens its automations. **Schedules**
leads to the schedule editor at `/admin/schedules`, which keeps its own page and live state.

`GET /api/v1/automations` serves the page:

- event automations on the repositories the caller can reach, and team automations of the teams
  they belong to (all, for ADMIN). A team automation's row names its team and no repository;
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
| `GET /api/v1/automations/events?teamId=` | A member of the team, or ADMIN: the team's automations that have no repository |
| `POST /api/v1/automations/events` | ADMIN, or a LEAD of the repository's **owning** team; for a team automation (`teamId` instead of `connectionId`), ADMIN or a LEAD of that team |
| `PATCH` / `DELETE /api/v1/automations/events/:id` | The same |
| `GET /api/v1/automations/events/:id/fires?limit=` | A member, as for the list |
| `POST /api/v1/automations/events/:id/fires/:fireId/retry` | Those who may manage, as a launch decision: takes one decision that started no run again (§2) |
| `GET /api/v1/automations/events/templates?connectionId=&source=` (or `teamId=`) | Those who may manage: the templates an automation of that source may start, each with the options it declares |

Every route below the list takes the automation's owner from the row: a repository's rules for a
repository automation, a team's for a team automation. A caller who may not read the owner gets
`404`, so an automation, and its decisions, are never visible outside the teams that may read its
owner.

An event automation starts runs on the repository with the platform credential. That is why
managing one stays with the owning team, like every other repository setting, and a shared team can
read them but not create one.

Saving an automation that can start runs is a **launch decision**, made as it is for a schedule.
This covers creating an enabled automation, and any change that leaves one on. Editing an
automation that is off, and switching one off, are not launch decisions. The repository must be
active. The access gate judges the caller's own GitHub login (the runs use the platform
credential), and the caller must belong to the repository's organization, which must be under its
monthly cap. Every create, update and delete is written to the audit log (entity `Automation`).

### Team automations

A team automation has no repository, so the rules that hang off the repository move to the team:

- **Who.** Members of the team read its automations and their decisions; ADMIN and the team's
  LEADs manage them. The team must be active to turn one on.
- **The launch decision.** Saving one that can start runs, and **Decide again**, check the caller's
  membership of the team's organization and that organization's monthly cap. There is no
  repository, so there is no access-gate check.
- **The run.** It spends against the team's organization — the request records that organization
  as the one it is charged to, so the run is billed, counted in flight and capped mid-run there like
  a repository run — resolves the source's kill switch and
  gated options for the team, starts a template that is global or the team's own, and carries no
  `connectionId`. A source that acts only for a repository's members (`actor`) cannot start a run
  for a team: such a decision is `SUPPRESSED_PRECONDITION`.
- **A repository to act on.** A team automation may name one (`targetConnectionId`): a git
  repository the team owns or one shared with it (`400 TARGET_REPOSITORY_NOT_REACHABLE`
  otherwise). Saving it on is then also a launch decision on that repository. The automation stays
  the team's: the team manages it, and its decisions stay on its source's owner key, not the
  repository's. Its runs carry the repository's `connectionId`. A repository that is inactive, or no
  longer the team's or shared with it, when an occurrence arrives makes the decision
  `FAILED_TO_START`; deleting the repository deletes the automation. For a repository another team
  owns, each decision also resolves the source's kill switch for that team (off is
  `SUPPRESSED_PRECONDITION`, recorded, unlike the automation team's own switch, which ignores the occurrence) and checks that team's organization's budget (`SUPPRESSED_BUDGET`). The database allows a target
  only on a row with a team and no `connectionId` (`automations_target_connection_team_only`).
- **Where.** The team's page has an **Automations** action (on its event-endpoint card) that lists
  and edits the team's automations.

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
3. **Records the decision** as an `AutomationFire`, keyed by the occurrence on its owner
   (`dedupeKey`). A redelivered webhook answers `duplicate` and starts nothing, unless the earlier
   decision was `FAILED_TO_START`: that one is taken again. The decision is taken
   under a transaction lock on the **owner**, so concurrent deliveries see each other. A run
   is **suppressed** when:

   | Outcome | When |
   |---|---|
   | `SUPPRESSED_PRECONDITION` | The source says the occurrence cannot start a run (for CI, a pull-request failure with no open pull request) |
   | `SUPPRESSED_BUDGET` | The owning team's organization is over its monthly budget |
   | `SUPPRESSED_OWN_OUTPUT` | The occurrence's subject is something a run of the platform produced (for CI, a fix commit it pushed): acting on it would answer the platform's own output with more of it |
   | `SUPPRESSED_SAME_SUBJECT` | A run was already started on the owner for this subject (for CI, the commit), by any automation |
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
moved aside to `<key>~<its id>`; concurrent retries and redeliveries take it at most once. A
decision is taken again only on the owner key it was recorded under: a repository key for a
repository automation, the team's key for a team automation, or, for a source that names its owner
from the occurrence, exactly that key (`@endpoint/<id>` for an event, whose endpoint must still be
the team's and on).

### The ledger

`AutomationFire` rows belong to an **owner** (`ownerKey`, stored in the `repo_key` column, which
keeps the name it had when every owner was a repository so that processes of an older release
keep working during an upgrade) and the **source**, not to the automation or the connection row.
The owner key takes one of two shapes:

- **A repository** is `<host>/<owner>/<repo>`, lowercased, with no prefix. Every source's dedupe
  key starts with it, so a redelivered webhook finds the decision recorded for it.
- **Anything else** is `@<kind>/<id>`: `@team/<team id>` for a team automation,
  `@endpoint/<endpoint id>` for an inbound event's decisions ([inbound-events.md
  §4.1](./inbound-events.md#41-decisions)), and `@owner/<id>` for a schedule's or a template
  webhook's rows (§5). A source may name its owner key from the occurrence (`ownerKey`); inbound
  events do, so every decision about one endpoint's events shares one key whichever automation
  made it. A host never contains `@`, so
  no sigil key can be read as a repository. `repositoryOwnerKey`, `isRepositoryOwnerKey` and
  `parseOwnerKey` (`@auto-swe/shared/automation`) build and read them.

Only a repository key names a host, so only a repository's decisions match a person's account on
a host (the `actor` check). The transaction lock is `automation-repo:<key>` for a repository, the
same lock earlier gateways take, and `automation-owner:<key>` for any other owner.

The guards count one source's decisions on one owner. The exception is the own-output check: on a
repository it matches the subject on its own, since a commit sha names one commit wherever it is;
on any other owner it matches within that owner, so one team's output never suppresses another
team's occurrence. The automation and connection links are set to null
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
| `github.issues.labeled` | A person adds one of the automation's labels to an open issue (§3.1) | that labelling / the issue | `ticket-to-merge` | `github.issueLabelAutomationsEnabled` (off by default) |
| `github.pull_request.feedback` | A changes-requested review, an `/auto-swe fix` command, or (opt-in) Qodo's review bot reviewing lands on a pull request ([pr-feedback.md](./pr-feedback.md)) | the review or comment / the pull request | `address-pr-feedback` | `github.prFeedbackAutomationsEnabled` (off by default) |
| `inbound.event` | A verified event posted to one of the team's event endpoints is of a selected type and meets the automation's conditions ([inbound-events.md](./inbound-events.md)); targets a **team** | the event's subject / its scope (from pointers; by default the event id / its type) | none: the automation names one | `workflow.inboundEventsEnabled` (off by default) |
| `jira.filter.new_issue` | A poll of the automation's Jira filter (a JQL) finds an issue it has not seen (§3.2) | the issue / the issue | `ticket-to-merge` | `workflow.jiraPollAutomationsEnabled` (off by default) |

A source is a pure descriptor (`EventSource` in `@auto-swe/shared/automation`) plus a webhook
normalizer in the gateway, or, for the Jira source, a poller in the gateway (§3.2). The descriptor
declares:

- **Filters:** the filter schema, its defaults, and the form fields (a source whose filters need a
  form of their own, like inbound events, declares none and the dashboard renders its own);
- **Matching and display:** `mismatch`, a tester, and descriptions for lists and history;
- **Payload:** the payload keys it fills (and, through `filledKeys`, the ones its filters fill,
  such as an event's mapped fields), the ticket and fields of a run, an optional payload contract,
  and an optional `templateProblem` for what the filters need of a template;
- **Decision keys:** subject and scope, the dedupe key, the workflow-id prefix, and optionally the
  owner key the occurrence names;
- **Templates:** its default template (or none, when an automation must name one), and which
  templates it can start;
- **Early exits:** its `ignore` and `precondition` rules and its in-flight look-back;
- **Switches and gating:** its kill switch, and any gated options.

Adding a source means:

1. a descriptor, with its `target` (a repository or a team);
2. a normalizer;
3. a branch in the webhook route, or a receiver of its own (inbound events have
   `POST /api/v1/webhooks/events/:endpointId`);
4. the source key in the database's `automations_source_known` check, with a CHECK on its filters
   (for inbound events, `automations_inbound_event_filters`, which also keeps them on a team).

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
  repository's owning team or a team it is shared with, **and** the launch decision every other
  launch path takes allows them now: the [access gate](./repo-access-gating.md)'s GitHub
  permission check, membership of the repository's organization, and its monthly cap. Anyone
  else's labelling is recorded as `SUPPRESSED_PRECONDITION` with the reason. A label added by a bot
  or an App, the platform's own included, is ignored.
- **The run's identity.** The run records that user as its requester (`RunInput.requestedById`): it
  is visible to them as their run, and it counts toward their in-flight runs wherever those are
  capped. It uses the platform credential, as every automation run does; it never acts with the
  person's own saved token.
- **What the run reads.** The issue's title and body as GitHub shows them: HTML comments, which
  GitHub does not render and the labeller therefore never saw, are dropped first.

Each labelling is its own subject, so removing and adding a label again starts again; the issue is
the scope, so a labelling while an earlier run on the issue is open is `SUPPRESSED_IN_FLIGHT`, for
up to 14 days. A closed issue and a pull request are ignored.

### 3.2 Jira filter

A new issue in a Jira filter starts the automation's template on the issue: by default
`ticket-to-merge`, which implements it and opens a pull request. The automation holds one **JQL**
(a query, or `filter = <id>` for a saved filter), one repository and one template, so a deployment
with many repositories has one automation for each. The run's ticket is the Jira key, so the
ticket-context step and tracker sync work on it. Its description starts with the key and a link to
the issue, then the summary and the description (the first 4,000 characters) inside a block marked
as untrusted text.

**Three settings** govern it. All are ADMIN's:

| Setting | Meaning | Default |
|---|---|---|
| `workflow.jiraPollAutomationsEnabled` | Whether a team's or organization's Jira filter automations poll and start runs. While off, no Jira request is made for them, and a save does not ask Jira either | off |
| `workflow.jiraPollProjectKeys` | The Jira projects a team's or organization's automations may act on. Empty means none | empty |
| `workflow.jiraPollIntervalSeconds` | Seconds between polls, for the whole deployment (60–86400) | 300 |

**Why the allowlist.** The platform asks Jira with its own one credential, which can see every
project the credential can. The query is narrowed to the allowed projects, and every issue that
comes back is checked against them again, so what the JQL says never widens what is acted on. JQL
with an unbalanced parenthesis outside a quoted string is refused, because it could end the
narrowing early.

**Saving.** ADMIN, or a LEAD of the repository's owning team, saves one, as for any event
automation. An enabled one needs an allowed project, a Jira tracker that is configured, and a JQL
Jira accepts: while the polling switch is on for the team, the platform asks Jira once, for one
result, and answers `JQL_REJECTED` when Jira refuses the query and `502 TRACKER_UNAVAILABLE` when
it cannot be reached. Neither stores anything or carries Jira's text. With the switch off the
allowed-project and tracker checks still apply, but Jira is not asked. A disabled one is a draft
and asks nothing of Jira. The create and change routes allow 20 requests a minute for each user
(each IP address, for a personal access token).

**Polling.** One gateway loop polls every enabled automation in turn, the one polled longest ago
first, and waits one interval after a round ends. Each automation is claimed through a lease on its
poll state, so every gateway replica may run the loop. A round stops waiting for a poll that has
not finished in four minutes and goes on; the poll itself runs on until it ends or its lease
expires. A round stops starting automations after ten minutes and resumes where it left off.

- **The first poll starts nothing.** It records every issue the filter already returns as seen.
  A baseline belongs to the query as Jira is asked it: the JQL and the allowed projects. So the
  same holds when the JQL changes, when a project is added to the allowlist, and when an
  automation is switched back on. An automation that is not polled because the team's polling is
  off, its repository is inactive or retired, or the allowlist is empty, records why and forgets
  its baseline; when polling resumes the next poll takes a new one. Only an issue that appears afterwards starts a
  run. A trailing `ORDER BY` and the order of the allowlist do not change the query.
- **New means a key the automation has not seen.** An issue starts a run once. Moving it to
  another project gives it a new key, which is new.
- **At most 50 issues a poll,** in key order (by project, then issue number). The rest wait for the
  next poll.
- **The limits of §2 apply.** An issue the engine suppresses (the daily cap, the budget, an open
  run) is recorded in the ledger and counted as seen; a manager takes it again with **Decide
  again**. An issue is marked seen only after the engine has decided it, so a poll that stops
  between the two decides it again and the ledger answers `duplicate`.
- **A stall is visible.** An issue that cannot be read, or whose start failed, ends the poll and
  stays unseen, so it is tried again at the next poll and the issues behind it wait. An issue that
  has moved to another project since the search is marked seen: it has a new key. The tick reads
  each automation again just before polling it, so one switched off in the meantime is not polled,
  and a poll that fails or is abandoned does not keep its place at the front of the order. The
  automation's row shows the reason in words:

  | Code | Meaning |
  |---|---|
  | `NO_ALLOWED_PROJECTS` | The team's allowlist is empty |
  | `SWITCHED_OFF` | Polling is switched off for the team |
  | `REPOSITORY_INACTIVE` | The repository is inactive, or its GitHub App installation is retired |
  | `FILTER_TOO_BROAD` | The filter returns more than 1,000 issues, or Jira's result could not be read to the end, so none is acted on |
  | `JQL_REJECTED` | Jira refuses the query |
  | `TRACKER_UNAVAILABLE` | Jira could not be reached or an issue could not be read |
  | `INVALID_FILTERS` | The saved JQL does not parse or is unbalanced |
  | `START_FAILED` | The engine could not start the run, or ignored the issue |

The dashboard's JQL box keeps the query as typed. The source offers no "would this match" tester,
since Jira evaluates the JQL.

**What the history shows.** An automation's decisions list the issue key, its link and its project.
The title is shown only to those who manage the automation, and the description never: the history
is readable by members of every team the repository is shared with, who may have no access to the
Jira project. **Decide again** on a Jira decision is refused when the issue's project is no longer
on the team's allowlist.

**The Jira transition hook starts runs too** (§5), under its own workflow id. It is not per
project: it acts on any ticket whose transition reaches its trigger status, when the deployment
has a trigger status configured and exactly one active repository. Where both are true, a ticket
that the hook and a filter both reach starts two runs, so use one of them.

## 4. Permissions on the host

What an occurrence needs from the host is the source's: for CI, the **Workflow run** event and
**Actions: Read**; for issue labels, the **Issues** event and **Issues: Read**; for pull-request
feedback, the **Pull request review**, **Pull request review comment** and **Issue comment**
events, with **Pull requests: Read & write** for the thread replies
([github-app-setup.md](./github-app-setup.md)). A Jira filter needs no GitHub permission of its own
beyond what its template's run needs; it reads Jira with the issue-tracker integration's
credential (`/admin/integrations` → Tracker), which must be able to read the allowed projects.

## 5. Other kinds of automation

These start runs too and keep their own configuration. The Automations page lists them beside
event automations.

Schedules and template webhooks also write their decisions to the ledger, under their own sources
(`schedule.fire`, `template_webhook.call`), with the schedule's or template's id as subject and
scope and `@owner/<that id>` as owner key; they are read by that id, never by repository. Event sources' guards read only their own source, so these rows never
suppress anything:

- **A schedule fire** is recorded by the worker when the run is created (`STARTED`, keyed by the
  fire's workflow id, so a retried activity records it once) or when the owner's launch decision
  refuses it: `SUPPRESSED_IN_FLIGHT` for a fire skipped while the request is still running,
  `SUPPRESSED_BUDGET` over the cap, `SUPPRESSED_PRECONDITION` for every other refusal, with the
  refusal's message as the reason.
- **A template webhook call** is recorded once its token names a template: `STARTED`, or
  `FAILED_TO_START` (a refused or missing signature, inactive template, no active version, a
  payload or base branch or connection it refuses), `SUPPRESSED_BUDGET`, or `SUPPRESSED_SAME_SUBJECT` for an idempotency key already used.
  A call to an unknown token records nothing.

A refusal is keyed by the owner, its reason and the hour, so a per-minute cron that keeps being
refused, or a caller hammering a webhook, leaves one row an hour per reason. `GET
/api/v1/scheduled-work-requests` returns each schedule's `lastDecision`; the Automations list returns
a webhook's latest call only when the caller may see it: a call on a repository they can reach, or a
call on no repository to a team's own template. The retention sweep removes these rows like any
other decision that started no run.

| Kind | Configured at | Who |
|---|---|---|
| Cron schedule (`ScheduledWorkRequest`) | `/admin/schedules`, linked from the Automations page | ADMIN, or a LEAD of the owning team or a team the repository is shared with |
| Template webhook URL | the template's page | LEAD+ who may edit the template |
| Issue-tracker transition | `/admin/integrations` → Tracker | ADMIN |

### 5.1 Signed template webhooks

A template's webhook URL (`POST /api/v1/webhooks/:token`) is a bearer credential: whoever holds the
URL can start a run. A **signing secret** adds proof that the body came from someone holding the
secret, and that it is recent. Each call carries

```
X-AutoSwe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

- The MAC covers the **raw request body bytes** exactly as sent, prefixed with the timestamp and a
  dot. A JSON body that is parsed and re-serialised before signing (keys reordered, whitespace
  changed) does not verify.
- The key is the secret's UTF-8 bytes. Secrets are generated by the platform (`whsec_` followed by
  32 random bytes, base64url).
- `t` must be a whole number of seconds written in plain decimal (no sign, no leading zeros) within
  **300 seconds** of the gateway's clock, in either direction. An older or far-future timestamp is
  refused as `stale`.
- A header may carry several `v1=` entries; the call verifies when any of them matches. Unknown keys
  (`v0=`, `v2=`) are ignored. Comparison is constant-time.
- A refusal is `401 SIGNATURE_INVALID`, with the reason in the message: the header is `missing`,
  `malformed`, `stale`, or does not match (`mismatch`).

On the template's page, under **Webhook trigger → Signing**, a LEAD+ who may edit the template can:

| Action | Route | Effect |
|---|---|---|
| Generate / rotate secret | `POST /api/v1/workflow-templates/:id/webhook/signing-secret/rotate` | Returns the new secret **once**. The secret it replaces stays valid for 24 hours |
| Remove secret | `DELETE /api/v1/workflow-templates/:id/webhook/signing-secret` | Removes the current and the previous secret. Refused (`409 WEBHOOK_SIGNATURE_REQUIRED`) while the template requires signatures |
| Require signed calls | `PUT /api/v1/workflow-templates/:id/webhook/require-signature` `{ "required": true }` | Unsigned calls are refused. Turning it on without a secret is `409 WEBHOOK_SIGNING_NOT_CONFIGURED` |

Each change is audited on the template (whether a secret exists, whether a previous one is still
accepted, and the switch), never the secret. Secrets are stored with the same AES-256-GCM envelope
as every other credential, and `rotateEncryptionKey` re-encrypts them.

How a call is decided, before anything else about the template is looked at:

1. Signing is **required** when the template's switch is on, or when the registry setting
   `workflow.templateWebhookRequireSignature` (ADMIN, default off) resolves to true for the
   template's team. It resolves like every setting, most specific scope first: a TEAM override
   wins over the ORGANIZATION one, which wins over GLOBAL — so a TEAM `false` exempts that team from
   an organization-wide `true`, and the effective-config view shows exactly what is enforced. A
   global template has no team, so only the GLOBAL value applies to it. The setting can only add
   a requirement; it never turns off a template's own switch.
2. Required, and the template has no secret: every call is refused with
   `409 WEBHOOK_SIGNING_NOT_CONFIGURED`.
3. Required: the call must carry a valid signature, or it is refused.
4. Not required, but a secret exists and the call carries the header: the signature is still
   checked, and a bad one is refused. A call without the header is accepted.
5. No secret, not required: the header is ignored.

A refused call is recorded in the template's decision history as `FAILED_TO_START` with the code
(`SIGNATURE_INVALID` or `WEBHOOK_SIGNING_NOT_CONFIGURED`), once an hour per code like any other
refusal. The Automations list marks a webhook that still accepts unsigned calls as **unsigned**
(no secret) or **signature optional** (a secret, not required); the API returns `signed` and
`signatureRequired` on each `template_webhook` row.

**Rotation.** Rotate, update the sender to the new secret within 24 hours, and the old one lapses on
its own. A sender that cannot switch atomically can sign with both secrets for the overlap — the
header carries one `v1=` entry per secret.

**A signed call's identity is its timestamp and body.** When a call's signature verifies, its
run's workflow id is derived from the signed `t` and a hash of the body bytes, in a namespace no
`Idempotency-Key` can reach, and the `Idempotency-Key` header is **ignored** (headers are not
signed; honouring it would let a captured call be replayed under a fresh key). Sending the same
`(t, body)` again — a retry, or a captured call replayed inside the 300-second window — is refused
with `409 RUN_CONFLICT` and recorded as `SUPPRESSED_SAME_SUBJECT`. A retrying sender must therefore
resend the **same timestamp and body** it signed the first time (or deduplicate on its side):
re-signing a retry with a new `t` is a new call and starts another run. An unsigned call keeps the
`Idempotency-Key` behaviour described in [product-overview.md](./product-overview.md).

**Verifying or signing elsewhere.** `@auto-swe/sdk` exports the same implementation the gateway
uses: `signAutoSweRequest(secret, rawBody, nowSec)` returns the header value (pass an array of
secrets to sign with several), and `verifyAutoSweSignature({ header, rawBody, secrets, nowSec })`
returns `{ ok: true }` or `{ ok: false, reason }`. `AUTO_SWE_SIGNATURE_TEST_VECTOR` is a
known-answer vector for checking another implementation. Without the SDK, in Node:

```js
import { createHmac } from 'node:crypto';

const body = JSON.stringify({ description: 'nightly sweep' }); // send exactly these bytes
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', process.env.AUTO_SWE_WEBHOOK_SECRET)
  .update(`${t}.${body}`)
  .digest('hex');
await fetch(webhookUrl, {
  body,
  headers: { 'content-type': 'application/json', 'x-autoswe-signature': `t=${t},v1=${v1}` },
  method: 'POST',
});
```

The webhook token is part of the URL, so the gateway's request log and its trace spans record the
path with the token replaced by `[redacted]` — matched after percent-decoding, and also inside log
messages that quote a URL, such as the not-found line for a mistyped webhook path.

### 5.2 Reporting the outcome

A webhook call may ask to be told how its run went: a top-level `callback` object in the body,
`{ "url": "…" }` or `{ "endpointId": "…" }` with an optional `context`, names a callback endpoint of
the **template's team** that accepts template webhook launches (`acceptTemplateWebhookLaunches`,
off by default), or a URL under one. Deliveries say `launchedBy: { kind: "template_webhook" }`, since
the caller holds a token, not an identity. The platform then POSTs a signed body there when the
run waits for a human and when it ends ([run-callbacks.md](./run-callbacks.md)). The `callback` key is
taken out of the body before the payload is validated against the template's inputs and stored, so
a template cannot use `callback` as an input of its own (a non-object value is left as input). A
global template's webhook refuses a callback (`400 CALLBACKS_UNAVAILABLE`): it has no team to
register endpoints. A callback the team has not registered is refused before anything starts and
recorded as `FAILED_TO_START` with its code.

## Limitations

- **Five event sources.** Failed GitHub Actions runs, issue labels, pull-request review feedback
  and new issues in a Jira filter start automations on a repository, and events posted to a team's
  endpoints start automations on a team; a pull request label or a push does not.
- **Jira polling is Jira Cloud only,** one JQL for each automation, and starts runs on one
  repository. A filter that should feed several repositories is several automations.
- **A Jira issue is new once.** A ticket starts one run however its status changes later, and an
  issue that leaves the filter and returns is not new. Moved to another project, it has a new key
  and starts a run if it is allowed there.
- **Jira polling is not in creation order across projects.** A poll takes issues by project, then
  issue number, so with more than 50 new at once a project that sorts late waits for the next poll.
- **Jira text is somebody else's.** The summary and description may have been written by anyone
  with write access to an allowed project. The allowlist limits which projects, not who wrote the
  text; the text is marked as untrusted in the run's description, which lowers the risk and does
  not remove it. Only the first 4,000 characters of the description are used by the poll. The run's
  ticket-context step then reads the live issue with the platform credential, including its latest
  comments, which anyone with comment permission may have written, and its parent: neither is
  limited to the allowed projects, and later edits are seen there.
- **A Jira filter can tell its author what exists.** Jira validates every clause of the JQL, so
  `JQL_REJECTED` against success, and which allowed issues match, tell a lead whether a project,
  user, version or field exists for the platform's credential, and can hint at relationships to
  issues outside the allowlist (`linkedIssues()`, `parent =`, an epic link). The same signal
  appears at poll time through `lastError`. No issue content outside the allowlist is returned. The
  route limit, the lack of retries at save and the allowlist bound it.
- **The create and change limit covers every source.** The 20 requests a minute on creating and
  changing event automations is per route, so it applies to automations of every source, and by IP
  address for a personal access token.
- **There is no cap on the number of Jira filter automations.** Each polls the shared Jira
  credential every interval, and the tick's time budget is shared by all of them, so one team with
  many can delay the rest.
- **One repository, one ledger.** Two teams that register the same GitHub repository share its
  ledger: an issue one team's automation decided is a duplicate for the other's.
- **Decide again reads the issue as it was.** Taking a Jira decision again reads the recorded
  occurrence, not the issue now.
- **Suppressed Jira issues are not taken again by themselves.** Only a manager's **Decide again**
  does. An automation stalled by an unreadable issue or a failed start waits until that is fixed.
- **New event automation starts from a repository.** On the Automations page, **New event
  automation** asks for a repository; a team's automations open from the team's page or from an
  existing team automation's row.
- **A team automation acts on at most one repository,** the one it names, and none otherwise. It
  cannot act through a source with an `actor`.
- **An issue run acts on the issue's text.** The labeller is a member, but the issue's title and
  body may be anyone's: an issue opened by an outsider and labelled by a member carries the
  outsider's text into the run's description, as a work request typed from it would. Only the first
  4,000 characters of the body are used, and later edits to the issue are not seen.
- **Membership is read when the label arrives.** A person who leaves the team keeps the runs they
  already started; a person whose GitHub account is not linked to their platform user cannot start
  one.
- **Decide again uses the issue as it was.** Taking an issue decision again reads the recorded
  occurrence, not the issue now: a run can start on an issue closed or unlabelled since. The
  labeller's launch decision is taken again, as of now.
- **The other kinds keep their own storage.** Schedules, template webhook URLs and the tracker
  transition are configured where they always were (§5). Schedules and webhooks record their latest
  decision, but not a full history in the dashboard, and only the first refusal of a reason in an
  hour; a schedule's history starts with its first recorded fire. The tracker transition writes no
  ledger rows: the page shows its latest run. A webhook call on a global template with no repository
  is shown only to admins.
- **The URL token still identifies the template.** A signature proves the body, not who may call:
  the token selects the template, and anyone with the token and no secret is refused only when
  signing is required. A leaked token on an unsigned, unrequired webhook still starts runs.
- **No IP allowlisting.** A webhook accepts calls from any address; signing and the per-route rate
  limit (60 a minute) are the only controls on who calls it.
- **The signature covers the timestamp and body only.** Headers are not signed. A replayed signed
  call cannot start a second run (its run is keyed by the signature), but it is answered and
  recorded as a duplicate; and an unsigned call to a webhook that does not require signing is
  not protected at all.
- **The rotation overlap is fixed at 24 hours,** and there is one previous secret: rotating twice
  within a day drops the first secret at once.
- **Removing a secret under policy locks the webhook.** Where policy requires signing, removing the
  secret refuses every call until a new one is generated.
- **A renamed repository starts a fresh ledger.** The ledger is keyed by the repository's name on
  its host, so after a rename the subject, cooldown and in-flight checks no longer see the earlier
  decisions. They come back with the next ones. The own-output check matches a commit wherever it
  is, so a fix the platform pushed is still recognised.
- **Started decisions are never pruned.** The retention sweep removes only decisions that started
  no run, so the ledger still grows by one row per run started, and an own-output or same-subject
  guard never lapses. A redelivery older than the retention is decided afresh.
- **Shared teams do not manage event automations.** A LEAD of a team the repository is shared with
  can read them, but only the owning team's leads and ADMIN manage them, unlike schedules (§5).
- **A decision recorded mid-upgrade can keep an empty owner key.** A schedule or template webhook
  decision written by a process older than the owner key, while an upgrade rolls out, keeps the
  empty key it was written with. Nothing reads those rows by owner key, so the Automations page and
  the schedule list are unaffected.
- **The daily cap is the automation's own.** Deleting and recreating an automation starts its cap
  afresh; the repository-wide guards (subject, scope, in flight) and the own-output check, which
  matches the subject across the source's whole ledger, are not affected.
