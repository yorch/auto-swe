# Enterprise readiness

This page states, for six things an enterprise security review asks about, what the code does
today, what it does not, and the scoped piece of work that would close each gap. The six are SAML
and SCIM provisioning, SIEM-friendly audit export, retention, database row-level security, a
default-deny egress option, and a SOC 2 readiness path.

It is a map of gaps, not a certification. **auto-swe holds no SOC 2 report, no ISO 27001
certificate and no other attestation.** Every claim below is a statement about the code; where an
item is a gap it says so and points at the proposal that would close it.

Each section has the same shape: what exists, the gap, and the proposed child issues. A proposal
has a title, acceptance criteria, a rough size (S is days, M is a couple of weeks, L is more than
that or spans packages), its dependencies and an `Owner:` line. Every owner reads `unassigned`
until a person takes the issue. The proposals are text in this document; filing them is a separate
step.

## 1. SAML and SCIM provisioning

### What exists

- **Sign-in methods.** better-auth in `packages/gateway/src/lib/betterAuth.ts` registers GitHub
  (github.com or a GitHub Enterprise host), Google, Okta (through the generic-OAuth plugin, OIDC
  discovery), email and password, and magic links. Credentials for the OAuth providers are
  environment-only and read once at gateway start ([oauth-setup.md](./oauth-setup.md)).
- **SAML is not supported.** [oauth-setup.md](./oauth-setup.md) says so for Okta: only an
  OIDC web-application integration works. The gateway imports no SAML or SSO plugin.
- **No multi-factor authentication of its own, and no way to switch off local sign-in.** The auth
  plugin list holds `magicLink`, `genericOAuth`, `jwt` and the OAuth provider for MCP clients. A
  deployment that needs MFA obtains it from the identity provider (Okta, Google, GitHub), but the
  gateway does not make the identity provider the only way in. `emailAndPassword` is enabled
  unconditionally and `magicLink` is registered with sign-up allowed, both in
  `packages/gateway/src/lib/betterAuth.ts`, whatever the identity provider enforces. A user an
  ADMIN has already activated can therefore sign in with a password, or with a magic link sent to
  their mailbox, and a password reset link does the same, without the identity provider's second
  factor. New sign-ups start inactive, so the exposure is limited to people already admitted, but
  nothing in configuration removes it.
- **Admission is a queue, not a directory sync.** A new user is created inactive and waits at
  `/admin/users` for an ADMIN. The one automatic path is GitHub organisation membership
  (`github.signInAutoApproveOrgs`), which never revokes anyone. Okta group claims are not read.
- **Deprovisioning is manual and immediate.** An ADMIN sets `isActive` false on the user. The
  bearer paths in `packages/gateway/src/plugins/auth.ts` re-check `isActive` for sessions, JWTs
  and personal access tokens, and deactivation commits together with revocation of the account's
  MCP grants. An account cannot deactivate itself.
- **Machine identities** are separate: team-owned service principals with their own scoped tokens
  ([service-principals.md](./service-principals.md)), so a person leaving does not strand
  automation, but nothing links them to an external directory either.
- **Roles.** Platform roles `ENGINEER < LEAD < ADMIN`, team roles and organisation roles are set
  in the dashboard or API. No path assigns them from an identity-provider attribute.

### Gap

An enterprise cannot sign in over SAML, cannot create, update and deactivate users from its
directory, and cannot derive roles or team membership from directory groups. Leavers are removed
only when an ADMIN does it, which is the finding an access review raises first.

### Proposed child issues

**SAML 2.0 single sign-on** (size M; depends on nothing)
- A SAML identity provider can be configured per deployment and signs a user in through the
  ordinary `/api/auth/**` routes, producing the same session as OIDC.
- Assertion signature, audience, `NotOnOrAfter` and replay are validated; an unsigned assertion
  is refused.
- Account linking follows the existing rule for verified email, and the audit log records the
  sign-in with `via: "session"`.
- A configuration read at start is documented as such in `oauth-setup.md`, or made hot-reloadable.
- First step of the issue is deciding between better-auth's own SSO support and a separate
  library; that decision is part of the issue, not assumed here.
- Owner: unassigned

**SCIM 2.0 user provisioning** (size L; depends on the SAML issue only for a shared identity key)
- `/scim/v2` serves `Users` (create, read, patch, replace, delete) and `Groups` behind a
  dedicated bearer token that is not a personal access token.
- Deactivation through SCIM sets `isActive` false and revokes sessions, personal access tokens
  and MCP grants in one transaction, exactly as the admin route does.
- Every SCIM write is audited with `via: "scim"` and a distinct actor.
- A SCIM-created user skips the approval queue only when the deployment opts in.
- Owner: unassigned

**Directory group to role and team mapping** (size M; depends on SCIM `Groups` or on SAML
attribute release)
- An ADMIN maps a group to a platform role, a team and a team role; the mapping is a registry
  setting or table, not code.
- A user's role never rises above the mapping's floor and never falls below a manually set
  `ADMIN`, unless the deployment opts in.
- Removing a user from the group removes the membership on the next sync.
- Owner: unassigned

**Disable local (password / magic-link) sign-in when SSO is enforced** (size M; depends on nothing)
- A registry setting (ADMIN, GLOBAL, default off) turns on enforcement. While it is on, email and
  password sign-in, sign-up, password reset, and magic-link sign-in are refused for every user,
  and the dashboard shows only the identity-provider buttons.
- The check runs per request, not only in `buildAuth()` at boot, so turning the setting on or off
  takes effect without a gateway restart.
- Sessions created by a local method before enforcement is turned on are revoked in the same
  change, and the issue states whether a personal access token minted from such a session survives.
- Each refused local attempt is recorded, with the account's email and the route, in the audit log.
- A break-glass path that restores local sign-in is available without database access (an
  environment value read at start), and it is documented in `docs/oauth-setup.md`.
- Route tests cover each local sign-in route under enforcement, and under enforcement a user who
  signs in through the identity provider keeps the same session and roles as before.
- Owner: unassigned

## 2. SIEM-friendly audit export, including tool executions

### What exists

| Record | Where | What it covers | How to get it out |
|---|---|---|---|
| Configuration and governance changes, launches, sign-ins | `config_audit_log` | State changes only, with before and after JSON and a `context` object (credential path, request id, truncated address) | `GET /api/v1/admin/audit-log` (offset pages) and a CSV export capped at 50,000 rows, with `X-Export-Truncated` set when the cap cut the file ([audit-log.md](./audit-log.md)) |
| Refusals, sensitive reads, exports | `user_activity_events` | A signed-in `403`, tagged reads and exports; a `401` is counted in the `http.denied` counter and writes no row | Dashboard; 90 days by default ([user-activity.md](./user-activity.md)) |
| Transcript reads, exports, holds | `TranscriptAccessLog` | Who read a model transcript and how | `GET /api/v1/platform/transcripts/access-log`, ADMIN ([transcripts.md](./transcripts.md)) |
| Agent tool calls | `AgentTrace` rows of kind `tool_call` | Tool name, input and output JSON, duration, error; scanner refusals carry the `SECURITY_TRACE_ERRORS` tags | Per run, through the run viewer and `GET /api/v1/workflow-runs/:id/activity/export` (NDJSON with an EOF sentinel) |
| Shell and container step execution | `shell.exec` and `container.exec` activity events | Image, masked command, network, egress allowlist snapshot, exit code, duration, output artifact | Same per-run export ([run-activity.md](./run-activity.md)) |
| Outbound HTTP from the worker and the egress proxy | `WorkflowHttpCall` | Method, host, path, status, bytes, blocked and reason; no headers | Same per-run export |
| Governed external writes | `external_write` activity events | Connection, node, outcome | Same per-run export |
| Process telemetry | OpenTelemetry | Traces, metrics and logs from gateway and worker | OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT` ([deployment.md](./deployment.md)) |

So tool executions are recorded, with more detail than the audit log, but they live in run
history and not in the audit log.

### Gap

- Nothing pushes events to a SIEM. There is no webhook, syslog or object-store sink. The two
  routes a collector could poll are offset-paged (`audit-log`) or CSV with a hard row cap.
- The audit log has no incremental cursor, so a collector cannot ask for "everything after this
  id" without risking gaps and duplicates when rows share a timestamp.
- Tool executions can be exported only one run at a time. There is no org- or time-window query
  across runs, and no common event schema across the audit log, activity events, transcript
  access log and run activity.
- `AgentTrace` and `WorkflowRun` have no retention sweep (section 3), so a SIEM that depends on
  the database as its source of truth gets whatever the operator has not deleted.
- The audit table is append-only by convention in the application. No database trigger or
  privilege restriction on `config_audit_log` appears in the migrations, and rows carry no hash
  chain, so a database administrator can alter history undetectably.
- Worker-written audit rows carry no `context`, and a denied request writes no audit row.

### Proposed child issues

**Cursor-based, schema-stable event export API** (size M; depends on nothing)
- One ADMIN route streams NDJSON of audit rows, activity events and transcript access rows,
  ordered by `(createdAt, id)`, resumable with an opaque cursor, with a documented schema and a
  `source` field.
- A collector that resumes from its last cursor sees no gaps and no duplicates, including across
  rows with equal timestamps.
- Service-principal and personal tokens are refused unless an explicit export scope exists.
- Each export is itself audited and the export writes its own `config_audit_log` row. Today the
  CSV export (`/audit-log/export`, tagged `activity: 'export'` in `packages/gateway/src/routes/admin.ts`)
  is recorded only as an `export` row in `user_activity_events`, which is queued in memory and can
  be dropped under load ([user-activity.md](./user-activity.md)), so it is absent from the table
  an auditor reads.
- Owner: unassigned

**Tool-execution events in the exportable stream** (size M; depends on the export API)
- `tool_call`, `shell.exec`, `container.exec`, `external_write` and blocked egress rows are
  selectable by time window and team without naming a run.
- Tool input and output are excluded or masked by default, using the redaction already applied
  at trace write time.
- Tenant visibility uses the existing run visibility predicate, and the route is
  declared in `lib/assistantPolicy.ts` as `never`.
- Owner: unassigned

**Push sink for audit events** (size M; depends on the export API)
- An ADMIN configures one HTTPS destination (and optionally an OTLP logs endpoint). Delivery
  uses the guarded fetch, a transactional outbox like run callbacks, signed requests and retry.
- A destination that is down delays delivery and never blocks the request that wrote the row.
- Owner: unassigned

**Tamper evidence for the audit log** (size M; the hash chain depends on nothing, and the role
restriction depends on the application database role issue in section 4)
- Each row stores a hash over its content and the previous row's hash, and a verification route
  reports the first break.
- The application database role used by the gateway and worker has no `UPDATE` or `DELETE` on
  `config_audit_log` except through the retention sweep's path. This needs the separate role that
  section 4 proposes: today the gateway, the worker and the migrations share one `DATABASE_URL`
  (section 4), so no grant can be withheld from the process that writes the log.
- Owner: unassigned

## 3. Retention policy, including what a deleted run leaves behind

### What exists

| Data | Retention | Control |
|---|---|---|
| `config_audit_log` | Forever by default; optional sweep, at least 365 days | `audit.configLogRetentionDays`; setting changes and sweep summaries are never pruned |
| `user_activity_events` | 90 days | `analytics.activityRetentionDays`, at least 7 |
| Model transcripts | 365 days, with per-run and per-transcript legal holds | `workflow.transcriptRetentionDays` |
| Transcript access log | 2555 days | `workflow.transcriptAccessLogRetentionDays` |
| Worker HTTP rows | 90 days | `workflow.httpCaptureRetentionDays` |
| UI evidence and its artifacts | 90 days | `uiValidation.evidenceRetentionDays` |
| Automation decisions that started no run | 90 days by default, at least 7; decisions that started a run are kept | `workflow.automationDecisionRetentionDays` |
| Run callback deliveries that were delivered or dead | 30 days by default, at most 3650; pending deliveries are never deleted | `workflow.callbackDeliveryRetentionDays` |
| Lessons in memory | Not pruned automatically; deleting forgets through every copy | [memory.md](./memory.md) |
| Temporal history | The namespace retention the operator sets | [deployment.md](./deployment.md) |

The sweeps run as Temporal schedules and delete in bounded batches. The transcript sweep also
removes artifacts left `pending` for a day, orphaned transcript parts and orphaned UI evidence
artifacts. Legal holds apply to transcripts only; they do not hold HTTP rows.

**Deleting a run.** No gateway route deletes a `WorkflowRun`. A run disappears only when an
operator deletes it in the database. The relations then cascade: `AgentTrace`, `WorkflowStep`
and `WorkflowArtifact` rows go with the run, and so do its HTTP rows. The cascade removes the
artifact *row*; it does not call the artifact store. The object in S3 or the file on the
filesystem store stays, with nothing pointing at it, and no sweep walks the bucket for
unreferenced keys. [deployment.md](./deployment.md) tells the operator to set a bucket
lifecycle rule for this reason. Transcript parts carry no run id and are unaffected by a run's
deletion; the transcript sweep owns them.

### Gap

- `WorkflowRun`, `WorkflowStep`, `AgentTrace` and run artifacts of kinds other than transcript
  parts and UI evidence (for example `shell.step` and `container.step` output) have no age-based
  sweep. They grow until an operator deletes them by hand.
- Deleting a run by hand orphans stored objects permanently, and the orphans are unreachable
  from the application.
- There is no per-team or per-organisation retention, no user-triggered erasure of a person's
  data other than memory deletion, and no single place that states every period.
- Legal hold covers transcripts but not the audit log, traces or artifacts.

### Proposed child issues

**Run-data retention sweep with artifact deletion through the store** (size L; depends on nothing)
- A registry setting (ADMIN, GLOBAL, default off) sets a maximum age for terminal runs. The
  sweep deletes the run, its traces and steps, and deletes each artifact through `artifactStore`
  before its row, so the object goes too.
- Runs whose transcripts carry a run-level legal hold (`AgentTranscript.runLegalHold`, set through
  `packages/gateway/src/routes/transcripts.ts`), and runs that have not reached a terminal status,
  are skipped. The run row itself has no hold today; the retention reference issue below adds one.
- The sweep writes one audit summary row like the audit retention sweep does and reports
  progress as a metric.
- Owner: unassigned

**Orphaned artifact object reaper** (size M; depends on nothing)
- A scheduled job lists store keys older than a day with no `WorkflowArtifact` row and deletes
  them, in dry-run mode first, for the S3 and filesystem backends.
- The filesystem backend keeps refusing to run against a directory whose store id does not
  match, as it does today.
- Owner: unassigned

**Retention policy reference and per-organisation overrides** (size M; depends on the run-data
sweep, whose skip rule it changes)
- One table in the docs, generated from the registry, lists every retention setting and its
  default; `yarn docs:check` fails when a retention setting is missing from it.
- Registry retention settings that are safe to scope gain an ORGANIZATION override.
- Legal hold extends to the audit log and to the run itself. The run-data sweep's skip rule
  reads the transcript-level hold that exists today; this issue replaces that read with a hold on
  the run row, so one hold covers the run, its transcripts and its artifacts, and the sweep skips
  a run under it.
- Owner: unassigned

## 4. Row-level security as defence in depth for the tenant guard

### What exists

- **Application-layer isolation.** Membership is checked on the routes. The shared Prisma
  singleton in `packages/shared/src/db.ts` is extended once by `tenantGuardExtension()`
  (`packages/shared/src/lib/tenantGuard.ts`), so gateway and worker get the same guard. It
  throws on `findMany`, `count`, `aggregate`, `groupBy`, `updateMany` and `deleteMany` against a
  tenant-scoped model when the query has no predicate that narrows by `teamId` or `orgId`. It
  throws unless `TENANT_GUARD_WARN=1` is set.
- **Deliberate exemptions** are `runUnscoped(reason, models, fn)` and `asPlatformAdmin`, and
  `tenantGuard.coverage.test.ts` reads the source to fail on a mass query that neither carries a
  tenant key nor sits inside an exemption naming its model. The same test fails on any file that
  constructs its own `PrismaClient`.
- **What it does not cover.** Single-row lookups (`findUnique`, `findFirst`) are unguarded by
  design, raw SQL bypasses the extension, and a `runUnscoped` region still allows repeat queries
  on the models it names ([architecture.md](./architecture.md)).
- **Tenant keys.** `TENANT_SCOPED_MODELS` lists the models that carry `teamId` or `orgId`:
  agents, traces, transcripts, memory and knowledge items, connections, credentials, service
  principals, templates, automations, shell audit rows, rollups and similar. Several tables that
  hold the most sensitive data carry no tenant column at all. `WorkflowRun`, its work request,
  its steps and its artifacts are reached through joins (the run visibility predicate keys on the
  requester, the repository, the template and the channel), and `config_audit_log` is ADMIN-only
  with no tenant columns.
- **One database identity.** Gateway and worker each open a single `pg` pool through
  `PrismaPg({ connectionString })` with `DATABASE_URL`. There is one role, no per-request
  database session variable, and no policy in the schema or migrations. The deployment
  runbook applies migrations with the same `DATABASE_URL`.
- **pgvector queries** use raw SQL for similarity search on memory and knowledge, so they sit
  outside the extension.

### Gap

A bug that reaches the database without passing the guard (a raw query, a single-row lookup that
skips the follow-up membership check, a `runUnscoped` block that is too wide) reads across
tenants. Postgres enforces nothing on top of it. Row-level security would need three things the
platform does not have: a database identity that is not the table owner (owners bypass policy
unless `FORCE ROW LEVEL SECURITY` is set), a per-transaction tenant context set from the
authenticated principal, and tenant keys on the tables joined through runs.

### Proposed child issues

**Design spike: RLS feasibility and scope** (size S; depends on nothing)
- A written decision on the role split (migration owner, application role), how the principal
  reaches Postgres (a transaction-scoped `set_config` inside a Prisma extension), how the worker,
  which acts without a request, derives one, and how background sweeps and `runUnscoped` map to a
  bypass role.
- An inventory of tables by tenant column, with a ranking of the ones worth protecting first
  (memory and knowledge items, traces, transcripts, credentials).
- A measured cost on the existing `*.pg.test.ts` suites, because wrapping every query in a
  transaction changes connection use.
- Owner: unassigned

**Application database role without table ownership** (size M; depends on the spike)
- Migrations run as one role, gateway and worker as another with only the grants they need.
  `docs/deployment.md`, the Helm chart and the compose files carry both connection strings.
- Owner: unassigned

**RLS pilot on tables that already carry a tenant key** (size L; depends on the role split)
- Policies on a small set from the spike, enabled with `FORCE ROW LEVEL SECURITY`, reading the
  principal from the transaction setting; unset context means no rows, not all rows.
- A `*.pg.test.ts` suite proves a session scoped to team A cannot read or write team B's rows
  through raw SQL, and that the tenant guard and the policies agree on a sample of existing
  queries.
- The pgvector raw queries run inside the same context.
- Owner: unassigned

**Tenant key on run-owned tables** (size L; depends on the pilot)
- `WorkflowRun` and its dependent tables gain a denormalised owner so a policy does not have to
  re-derive visibility, with a backfill migration written to the rules in the
  `prisma-pgvector-hnsw` skill.
- Owner: unassigned

## 5. A default-deny egress option for shell steps and workspaces

### What exists

- **Three levels** in the `workspace.egressPolicy` setting: `open`, `restricted`, `blocked`.
  It is ADMIN-only, run-pinned, overridable per template, team and organisation, and a launch
  may narrow it for one run but never widen it (`400 EGRESS_POLICY_WIDENS`)
  ([run-activity.md](./run-activity.md#run-egress-policy)).
- **The default is `open`.** Under `open` an agent workspace has unfiltered outbound access (git
  and package installs need it). With the worker's egress proxy configured, `HTTP_PROXY` holds
  cooperating clients to the team allowlist, and a client that ignores proxy variables is not
  held.
- **Setup can be looser than the agent.** The ADMIN-only, run-pinned `workspace.setupEgressPolicy`
  defaults to `inherit`. `open` or `restricted` can temporarily loosen agent-workspace setup, with
  verified process termination and replacement of the final network rules before agent execution.
  Attached services intentionally remain running under the final policy. Shell/containerStep steps
  do not use this setting. Treat setup as repository-controlled code with access to its declared
  secrets and wired workspace/proxy credentials, not as a trusted package-install boundary; see
  [setup network phases](./run-activity.md#setup-and-agent-network-phases).
- **Delivery git has a fresh trust boundary.** Implementer/TDD, fix sessions, resumed rebases and
  merge/resolver delivery authenticate only in fresh trusted workspaces, on Docker and Kubernetes.
  Capped bundles preserve commit history; trusted git verifies object integrity and ancestry and
  pushes the exact imported SHA without forcing. The agent workspace sees only local bundles, not
  the delivery credential. Review fetches, repeated CI-verification setup and dependency, submodule,
  LFS and knowledge-base checkouts still authenticate in the workspace, including after repository
  code has run; see [architecture limitations](./architecture.md#limitations).
- **Shell and container steps** default to `network: "none"` in the node. A step that sets
  `network: "egress"` is held to the team's `egressAllowlist` by a DNS filter (and the egress
  proxy when configured); under `open`, an empty allowlist permits any host. Under `restricted`
  with an allowlist, a verified holder-netns lock confines the step and detached sidecars to the
  egress proxy and any wired registry proxy. Direct public-IP sockets and `--noproxy` are blocked.
- **Setting it to `restricted` or `blocked` at GLOBAL scope already makes the whole deployment
  default-deny**, for agent workspaces by a network lock (an `iptables` helper container on
  Docker; labelled pods and `NetworkPolicy` objects on Kubernetes), proven after it is applied.
  An unprovable lock fails the workspace with a non-retryable `EGRESS_POLICY_UNENFORCEABLE`.
  `blocked` forces shell and container steps to no network.
- **Related controls:** Docker workspaces reject private/non-public destinations even under
  `open`, with explicit exceptions for DNS, worker proxy ports, the git host and operator CIDRs.
  A NET_ADMIN helper installs the baseline before services start; kernel read-back is mandatory
  and failure removes the workspace. Cloud metadata REJECTs precede exceptions. The opt-in
  `WORKSPACE_DISK_LIMIT` caps writable layers, with a fail-closed Docker quota probe at worker boot.
  The model provider key never enters a workspace (model proxy), and registry credentials stay
  in the worker's registry proxy.

### What flipping the default would break

Setting `restricted` as the default changes behaviour for every deployment that has not set the
setting itself:

- Agent runs with an empty team allowlist can reach only the model proxy, the registry proxy
  when wired, and the repository's git host. Package installs fail unless the registry proxy is
  configured or the mirror is allowlisted through the egress proxy.
- A non-empty allowlist with no egress proxy (`EGRESS_PROXY_PORT`) refuses the workspace.
- Dependency repositories, Git LFS and submodules on a host other than the repository's own
  fail after the lock unless the host is allowlisted and the proxy is in place.
- Shell and container steps with `network: "egress"` and an empty allowlist lose network, and
  steps with an allowlist are refused when the proxy is absent. A step with a sidecar is refused.
- On Kubernetes the namespace manifest must be re-applied and the worker's Role extended, and the
  CNI must enforce `NetworkPolicy`; on Docker the helper image needs `iptables` and `ip6tables`
  ([upgrade-notes.md](./upgrade-notes.md) UN-12).
- Any template whose steps reach hosts outside the allowlist, such as a UI validation that
  loads an external page, fails until those hosts are allowlisted.

### Gap

A fresh deployment is open by default. Setup readiness checks configured egress policies against
fresh worker capability reports, and policy and team-allowlist saves warn without rejecting the save
when enforcement is unavailable. A default-deny deployment profile remains opt-in. The unfiltered
`NO_PROXY` git host and worker-originated traffic that no policy governs remain as stated
in [run-activity.md](./run-activity.md) and [architecture.md](./architecture.md).

### Proposed child issues

**Opt-in default-deny deployment profile** (size M; depends on nothing)
- A documented profile (environment values, registry settings and a seeded team allowlist for the
  git host, package mirrors and the model provider) that sets `restricted` at GLOBAL scope.
- The templates in the library that need network access are identified, and the profile
  allowlists the hosts they need deliberately.
- The default for a fresh install stays `open` unless the issue decides otherwise; flipping it
  is a separate, breaking change with an upgrade note.
- Owner: unassigned

## 6. SOC 2 readiness path

**No SOC 2 report exists for auto-swe, and this section is not evidence of one.** SOC 2 attests
to an organisation's controls over a period, assessed by an auditor against the Trust Services
Criteria. Software supplies some of those controls; the rest are policies, people and
operations that the organisation running the platform must provide.

### Controls the platform supplies

| Criteria area | Control in the platform | Where it is described |
|---|---|---|
| CC6.1 logical access | Platform, team and organisation roles; repository membership via owning or shared teams; hashed personal access tokens; scoped service principals; admin approval queue; deactivation that takes effect on the next request; ADMIN-only grants for registry settings. Not a control yet: email and password and magic-link sign-in cannot be switched off when the identity provider enforces MFA, so the identity provider's second factor can be bypassed (section 1, "Disable local sign-in" issue) | [architecture.md](./architecture.md), [teams.md](./teams.md), [service-principals.md](./service-principals.md), [configuration.md](./configuration.md) |
| CC6.1 data isolation | Application-layer tenant guard and its coverage test | [architecture.md](./architecture.md) |
| CC6.1, CC6.7 protection of stored secrets | AES-256-GCM envelope for provider, connection and integration credentials, key rotation procedure, signed download links | [model-configuration.md](./model-configuration.md), [transcripts.md](./transcripts.md) |
| CC6.6 boundaries | Docker socket proxy, hardened workspaces (capabilities dropped, resource caps, metadata blackhole), egress policies, SSRF guard on operator-supplied URLs, rate limits | [architecture.md](./architecture.md), [run-activity.md](./run-activity.md), [deployment.md](./deployment.md) |
| CC6.8 malicious input | Seven runtime scanners (sensitive files, pre-write content, shell commands, code security, skill content, LLM output, memory content), a diff gate that fails on critical findings | [agents.md](./agents.md) |
| CC7.2 monitoring | OpenTelemetry traces, metrics and logs; alert rules for transcript persistence; security-event feed; per-run activity | [deployment.md](./deployment.md), [run-activity.md](./run-activity.md) |
| CC7.2, CC4.1 logging | Audit log, activity events, transcript access log, run traces | [audit-log.md](./audit-log.md), [user-activity.md](./user-activity.md) |
| CC8.1 change management of agent work | Versioned templates and agents pinned per run, human-in-the-loop gates, autonomy policies that fail closed, draft pull requests only, no merge by default, signed bundles | [hitl-workflows.md](./hitl-workflows.md), [autonomy-policies.md](./autonomy-policies.md), [pr-evaluation.md](./pr-evaluation.md), [bundles.md](./bundles.md) |
| C1.1, C1.2 confidentiality and disposal | Retention sweeps, legal holds on transcripts, memory deletion through every copy | section 3, [memory.md](./memory.md) |
| P-series privacy | Truncated client addresses, user agent not stored, opt-in page views | [user-activity.md](./user-activity.md) |

### What the organisation must supply

None of these is implemented by the code, and an auditor will ask for each:

- **Scope and boundary.** The system description, the in-scope environments and the list of
  subservice providers (the cloud host, the model providers, GitHub, Slack, trackers).
- **Policies.** Information security, access control and periodic access review, acceptable
  use, risk assessment, vendor management, change management for the platform itself,
  incident response, business continuity and disaster recovery, data classification, retention
  and disposal, and secure development.
- **People controls.** Onboarding and offboarding checklists (section 1 describes the manual
  deactivation step), security awareness training, background checks where the policy requires.
- **Infrastructure controls the platform does not provide.** TLS termination, encryption of the
  database volume and the artifact store, network segmentation, backup and a tested restore for
  Postgres and the artifact store, host patching, secrets management for the environment
  variables, MFA at the identity provider, log retention long enough to cover the audit period,
  and centralised logging with alerting (sections 2 and 3 describe what the platform makes
  available).
- **Operating evidence over the period.** Periodic user and role access reviews, change tickets
  and approvals for platform upgrades, vulnerability scan results, penetration test reports,
  incident records and post-mortems, restore test records, vendor reviews and policy
  acknowledgements. The audit log export and the user list give raw material for the access
  review; the organisation produces the review itself.
- **An auditor and a period.** A Type I report covers design at a date; a Type II report covers
  operation over a window, commonly six to twelve months.

### Suggested sequence

1. Decide scope and which Trust Services categories apply (security is required; availability,
   confidentiality, processing integrity and privacy are optional).
2. Write the policies above and name an owner for each.
3. Close the gaps in sections 1 to 3 that the auditor will test first: deprovisioning, audit
   export, and retention of run data.
4. Run a readiness assessment against a control matrix built from the table above, and record
   which controls are platform-supplied and which are organisational.
5. Collect evidence for the chosen window, then engage the auditor.

### Proposed child issue

**Control matrix and evidence runbook** (size S; depends on nothing)
- A document maps each Trust Services criterion in scope to a platform control, a procedure and
  the route or query that produces its evidence.
- The runbook lists how to produce a user and role access report, an audit log export for a date
  range, and a list of configuration changes, from existing routes.
- The document states which criteria the platform does not address.
- Owner: unassigned

## Limitations

- A looser setup policy can expose setup secrets and workspace/proxy credentials to repository code
  with broader network access. Final process termination and agent locking cannot undo exfiltration
  or file changes; intentionally long-lived attached services remain outside that cleanup guarantee.

- Egress readiness is based on workers' self-declared reports. Reports expire after thirty
  minutes and refresh every ten minutes without re-probing; they are not continuous attestation.

- **No SAML and no SCIM.** Sign-in is OIDC, email and password, or magic link. Users are
  admitted through a queue and removed by an ADMIN. No identity-provider attribute sets a role or
  a team.
- **No in-product MFA, and local sign-in is not switched off by SSO.** MFA is obtained from the
  identity provider, but email and password and magic-link sign-in stay available to every
  activated user, so the identity provider's second factor can be bypassed. No setting disables
  them (section 1, "Disable local sign-in" issue).
- **No audit push and no cursor-based export.** The audit log is read by offset or exported as
  CSV of at most 50,000 rows. Tool executions are in run history and exportable one run at a time.
- **The audit log is not tamper-evident.** It is append-only in the application, with no hash
  chain and no database-level restriction.
- **Run data is not subject to an age-based sweep.** `WorkflowRun`, `WorkflowStep`, `AgentTrace`
  and most run artifacts are kept until an operator deletes them. A run deleted by hand leaves
  its stored objects behind.
- **Tenant isolation is not enforced by the database.** There is no row-level security, one
  database role, and no per-request database context.
- **The default egress policy is `open`.** The default-deny levels exist and need an enforceable
  deployment; nothing checks that before they are selected.
- **No certification.** There is no SOC 2 report or other attestation, and the platform supplies
  only part of the controls an audit examines.
- **The proposals are not filed.** Each child issue above has an owner of `unassigned` and no
  tracking issue number until someone files it.
