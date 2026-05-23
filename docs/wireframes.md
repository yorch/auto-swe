# Web Dashboard — ASCII Wireframes

> **Tech stack:** Next.js 16 + React 19 + Tailwind CSS 4 + custom "Workshop Telemetry" primitives (no shadcn/Radix; see `packages/web/src/components/ui/`) + Recharts
> **API base:** `GET/POST/PATCH/PUT/DELETE /api/v1/*` (gateway on `:8080`)
> **Auth:** any of (a) better-auth session cookie (browser, default), (b) JWT bearer (legacy email+password, HS256 by default for Docker Compose; RS256 if `JWT_PRIVATE_KEY_PATH` is set), or (c) personal access token (`ats_…`) for CLI / scripts — mint at Settings → API tokens.
> **Roles:** `ADMIN > LEAD > ENGINEER` (numeric hierarchy 3 > 2 > 1)
>
> See [Web UI Technical Stack](#web-ui-technical-stack) at the end of this document for full library details.

> **Status note (2026-05-18).** This file is a historical design doc — kept for context on intent. Where it diverges from what shipped, the shipped UI is authoritative (see `packages/web/src/app/`). Notable differences:
>
> - **Dashboard** now ships an onboarding panel (3-step "get started" + collapsible API example) that replaces the empty-state when the user has no runs, plus a persistent `+ Submit work request` button in the header that opens a modal form.
> - **`/runs`** (not in this doc) is a global workflow-run history with status + template filters and offset pagination — distinct from `/workflows` which lists `ActiveWorkflow` rows.
> - **Settings** has an "API tokens" section (create / list / revoke personal access tokens with a one-time secret-reveal modal) — used by the CLI via `AUTO_SWE_TOKEN`.
> - **Team detail** has a shell-image allowlist editor (one image per line, validated against `DOCKER_IMAGE_REF_RE`) and an egress hostname allowlist editor, both gated to platform ADMIN or team-ADMIN (`canManageTeamConfig`). Platform LEAD without a team-ADMIN membership does not see these editors.
> - **Team member remove** (DELETE `/teams/:id/members/:userId`) is implemented and exposed in the UI. Remove + add + role-change all require platform LEAD + team LEAD+.
> - **Epics** is a real form (multi-repo selector) that routes to the epic workflow on submit; the doc's "dependency graph builder" is not built — dependencies come from the Planner agent's decomposition.

---

## Table of Contents

- [Web Dashboard — ASCII Wireframes](#web-dashboard--ascii-wireframes)
  - [Table of Contents](#table-of-contents)
  - [1. Global Layout](#1-global-layout)
  - [2. Dashboard Home](#2-dashboard-home)
  - [3. Workflow List](#3-workflow-list)
  - [4. Workflow Detail](#4-workflow-detail)
  - [5. Epic List](#5-epic-list)
  - [6. Epic Visualizer](#6-epic-visualizer)
  - [7. Context Inspector](#7-context-inspector)
  - [8. RBAC / Users](#8-rbac--users)
  - [9. Repositories](#9-repositories)
  - [10. Lessons Browser](#10-lessons-browser)
  - [11. Settings](#11-settings)
  - [12. Login](#12-login)
  - [13. Teams List](#13-teams-list)
  - [14. Team Detail](#14-team-detail)
  - [Route Summary](#route-summary)
  - [Web UI Technical Stack](#web-ui-technical-stack)
    - [Package Dependencies (`packages/web/package.json`)](#package-dependencies-packageswebpackagejson)
    - [Architecture Decisions](#architecture-decisions)

---

## 1. Global Layout

Persistent chrome wrapping every authenticated page. Sidebar collapses on
mobile to a hamburger menu.

```text
┌──────────────────────────────────────────────────────────────────────┐
│  TOP BAR                                                             │
│  ┌──────────┐    ┌───────────────┐     ┌────────┐ ┌───────────────┐  │
│  │ ≡  Logo  │    │ Team: Acme ▾  │     │ ? Help │ │ ● J. Doe  ▾  │  │
│  └──────────┘    └───────────────┘     └────────┘ └───────────────┘  │
├────────────┬─────────────────────────────────────────────────────────┤
│  SIDEBAR   │                                                         │
│            │                                                         │
│  Dashboard │              PAGE CONTENT AREA                          │
│  Workflows │              (scrollable)                               │
│  Epics     │                                                         │
│  Teams     │                                                         │
│  Lessons   │                                                         │
│  ────────  │                                                         │
│  Repos ¹   │                                                         │
│  Users ¹   │                                                         │
│  ────────  │                                                         │
│  Settings  │                                                         │
│            │                                                         │
│            │                                                         │
│  [Logout]  │                                                         │
├────────────┴─────────────────────────────────────────────────────────┤
│  FOOTER: v0.1.0 · Gateway healthy ●                                 │
└──────────────────────────────────────────────────────────────────────┘
```

**RBAC notes:**

- ¹ "Repos" and "Users" sidebar links visible only to `ADMIN`.
- "Epics" link visible to `LEAD+`.
- "Teams" link visible to all authenticated users.
- User dropdown shows role badge: `[ADMIN]`, `[LEAD]`, or `[ENG]`.
- Team selector dropdown in top bar filters Workflows, Repos, and Lessons by selected team. "All Teams" option shows combined view (ADMIN sees all teams; others see only their teams).

---

## 2. Dashboard Home

**Route:** `/`
**RBAC:** `ENGINEER+`
**Data:** `GET /api/v1/workflows` (aggregated client-side)

```text
┌─────────────────────────────────────────────────────────────────┐
│  DASHBOARD                                                      │
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │
│  │ IMPLEMENTING│ │ IN REVIEW   │ │ AWAITING CI │ │ COMPLETED │ │
│  │             │ │             │ │             │ │           │ │
│  │     12      │ │      4      │ │      2      │ │    87     │ │
│  │   ▲ 3 today │ │             │ │  1 failing  │ │  ▲ 5 week │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └───────────┘ │
│                                                                 │
│  ┌──────────────────────────────┐ ┌────────────────────────────┐│
│  │ NEEDS ATTENTION              │ │ RECENT ACTIVITY            ││
│  │                              │ │                            ││
│  │ ⚠ JIRA-892  CI failed ×3    │ │ 14:02  PR #241 merged     ││
│  │   repo: payments-api        │ │ 13:58  JIRA-910 started   ││
│  │   [Retry CI] [View] ²       │ │ 13:45  Lesson captured    ││
│  │                              │ │ 13:30  PR #239 opened     ││
│  │ ⚠ JIRA-876  Timed out       │ │ 13:12  JIRA-888 approved  ││
│  │   repo: user-service        │ │ 12:55  CI passed #238     ││
│  │   [View]                     │ │ 12:40  JIRA-876 timed out ││
│  │                              │ │                            ││
│  │ ⏳ JIRA-901  Awaiting merge  │ │ [View all →]               ││
│  │   repo: web-app             │ │                            ││
│  │   [View]                     │ │                            ││
│  └──────────────────────────────┘ └────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- Status cards link to `/workflows?status=<STATUS>`.
- ² `[Retry CI]` button calls `POST /api/v1/workflows/:id/retry-ci` (LEAD+ only; hidden for ENGINEER).
- `[View]` navigates to `/workflows/:id`.

---

## 3. Workflow List

**Route:** `/workflows`
**RBAC:** `ENGINEER+`
**Data:** `GET /api/v1/workflows?status=&repo=&page=&limit=`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  WORKFLOWS                                         [+ New Request]   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Filter: [Status ▾] [Team ▾] [Repository ▾] [Search ticket..] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──┬────────────┬──────────┬──────────────┬──────────┬──────────┬──────────┐  │
│  │☐ │ Ticket     │ Team     │ Repository   │ Status   │ Branch   │ Updated  │  │
│  ├──┼────────────┼──────────┼──────────────┼──────────┼──────────┼──────────┤  │
│  │☐ │ JIRA-910   │ Frontend │ web-app      │ ● IMPL   │ auto/910 │ 2m ago   │  │
│  │☐ │ JIRA-892   │ Payments │ payments-api │ ◉ FAIL   │ auto/892 │ 15m ago  │  │
│  │☐ │ JIRA-901   │ Frontend │ web-app      │ ○ MERGE  │ auto/901 │ 1h ago   │  │
│  │☐ │ JIRA-888   │ Platform │ user-svc     │ ● REVIEW │ auto/888 │ 2h ago   │  │
│  │☐ │ JIRA-876   │ Platform │ user-svc     │ ✕ TIMED  │ auto/876 │ 3h ago   │  │
│  │☐ │ JIRA-865   │ Payments │ payments-api │ ✓ DONE   │ auto/865 │ 1d ago   │  │
│  └──┴────────────┴──────────┴──────────────┴──────────┴──────────┴──────────┘  │
│                                                                      │
│  ☐ Select all    [Retry CI] ² [Terminate] ³        « 1 2 3 ... »    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- `[+ New Request]` opens a modal → `POST /api/v1/work-requests` (ENGINEER+).
- Row click → `/workflows/:id`.
- ² Bulk `[Retry CI]` visible to LEAD+ only.
- ³ Bulk `[Terminate]` visible to ADMIN only → `DELETE /api/v1/workflows/:id`.
- Status dot color codes: green=COMPLETED, blue=IMPLEMENTING, yellow=IN_REVIEW/AWAITING_CI, red=FAILED/TIMED_OUT, gray=AWAITING_HUMAN_MERGE.

---

## 4. Workflow Detail

**Route:** `/workflows/:id`
**RBAC:** `ENGINEER+`
**Data:** `GET /api/v1/workflows/:id` (includes `pullRequests[]`, `agentLessons[]`)

```text
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back to Workflows                                                 │
│                                                                      │
│  JIRA-892 · payments-api                          Status: ◉ FAILED   │
│  Branch: auto/JIRA-892                                               │
│  Temporal ID: eng-JIRA-892-payments-api                              │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ LIFECYCLE TIMELINE                                            │  │
│  │                                                               │  │
│  │  ●────────●────────●────────◉────────○────────○               │  │
│  │  Start   Impl    PR Open  CI Fail   Review   Merge            │  │
│  │  13:00   13:25   13:40    13:52                               │  │
│  │                            ↑ attempt 3/5                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────┐ ┌──────────────────────────────┐   │
│  │ PULL REQUESTS               │ │ ACTIONS                  ²   │   │
│  │                             │ │                              │   │
│  │ PR #241 — OPEN              │ │ [Approve Plan]   LEAD+       │   │
│  │   HEAD: a1b2c3d             │ │ [Retry CI]       LEAD+       │   │
│  │   CI: ✕ FAILED              │ │ [Terminate]      ADMIN       │   │
│  │   [View on GitHub ↗]        │ │                              │   │
│  │                             │ │ [View Context →]             │   │
│  └─────────────────────────────┘ └──────────────────────────────┘   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ LESSONS CAPTURED (2)                                          │  │
│  │                                                               │  │
│  │ ┌──────────────────────────────────────────────────────────┐  │  │
│  │ │ CI_FAILURE · 13:52                                      │  │  │
│  │ │ Rationale: Missing env var DATABASE_URL in test stage    │  │  │
│  │ │ Summary: Always include DATABASE_URL in CI env config... │  │  │
│  │ └──────────────────────────────────────────────────────────┘  │  │
│  │ ┌──────────────────────────────────────────────────────────┐  │  │
│  │ │ REVIEW_REJECTION · 12:30                                │  │  │
│  │ │ Rationale: Reviewer flagged missing input validation     │  │  │
│  │ │ Summary: Validate all request body fields at handler...  │  │  │
│  │ └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- ² Action buttons are role-gated:
  - `[Approve Plan]` → `POST /api/v1/workflows/:id/approve` (LEAD+).
  - `[Retry CI]` → `POST /api/v1/workflows/:id/retry-ci` (LEAD+).
  - `[Terminate]` → `DELETE /api/v1/workflows/:id` (ADMIN) — shows confirmation dialog.
- `[View Context →]` navigates to `/workflows/:id/context`.
- `[View on GitHub ↗]` opens the PR URL in a new tab.

---

## 5. Epic List

**Route:** `/epics`
**RBAC:** `LEAD+`
**Data:** `GET /api/v1/workflows` (filtered by `parentWorkflowId IS NULL` and has children)

```text
┌──────────────────────────────────────────────────────────────────────┐
│  EPICS                                               [+ New Epic]    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Filter: [Status ▾] [Search ticket ID...]                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────┬────────────┬──────────────────┬──────────┬────────┐  │
│  │ Ticket     │ Repos      │ Child Workflows  │ Progress │ Action │  │
│  ├────────────┼────────────┼──────────────────┼──────────┼────────┤  │
│  │ JIRA-800   │ 3 repos    │ 3/3 completed    │ ████████ │ [View] │  │
│  │ JIRA-850   │ 2 repos    │ 1/2 in progress  │ ████░░░░ │ [View] │  │
│  │ JIRA-900   │ 4 repos    │ 0/4 implementing │ ░░░░░░░░ │ [View] │  │
│  └────────────┴────────────┴──────────────────┴──────────┴────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- `[+ New Epic]` opens modal → `POST /api/v1/epics` (LEAD+). Fields: ticket ID, repo selection, dependency graph builder.
- `[View]` → `/epics/:id`.
- Progress bar computed from child workflow statuses.

---

## 6. Epic Visualizer

**Route:** `/epics/:id`
**RBAC:** `LEAD+`
**Data:** `GET /api/v1/workflows` (filtered by `parentWorkflowId = :id`) + dependency graph from Temporal query

```text
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back to Epics                                                     │
│                                                                      │
│  EPIC: JIRA-850                                  Progress: 1/2       │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    DEPENDENCY GRAPH                            │  │
│  │                                                               │  │
│  │                 ┌─────────────────┐                            │  │
│  │                 │  JIRA-850       │                            │  │
│  │                 │  (Epic Root)    │                            │  │
│  │                 └────────┬────────┘                            │  │
│  │                    ┌─────┴──────┐                              │  │
│  │                    ▼            ▼                              │  │
│  │          ┌──────────────┐ ┌──────────────┐                    │  │
│  │          │ payments-api │ │ user-svc     │                    │  │
│  │          │ ● IMPL       │ │ ✓ DONE       │                    │  │
│  │          │ PR #242      │ │ PR #240      │                    │  │
│  │          │              │ │ (merged)     │                    │  │
│  │          └──────────────┘ └──────────────┘                    │  │
│  │              depends on ──→                                   │  │
│  │                                                               │  │
│  │  Legend: ● In progress  ✓ Completed  ✕ Failed  ○ Waiting      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ CHILD WORKFLOWS                                               │  │
│  │                                                               │  │
│  │ ┌────────────┬──────────────┬──────────┬─────────┬──────────┐ │  │
│  │ │ Repository │ Status       │ Branch   │ PR      │ Action   │ │  │
│  │ ├────────────┼──────────────┼──────────┼─────────┼──────────┤ │  │
│  │ │ payments   │ ● IMPL       │ auto/850 │ #242    │ [Detail] │ │  │
│  │ │ user-svc   │ ✓ COMPLETED  │ auto/850 │ #240 ✓  │ [Detail] │ │  │
│  │ └────────────┴──────────────┴──────────┴─────────┴──────────┘ │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- Graph nodes are clickable → `/workflows/:childId`.
- `[Detail]` rows link to `/workflows/:childId`.
- Dependency edges show blocking relationships from `dependencyGraph[]`.

---

## 7. Context Inspector

**Route:** `/workflows/:id/context`
**RBAC:** `ENGINEER+`
**Data:** `GET /api/v1/workflows/:id` → `workRequest.contextSnapshot`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back to Workflow JIRA-892                                         │
│                                                                      │
│  CONTEXT SNAPSHOT                       Captured: 2025-01-15 13:00   │
│  (read-only · immutable after capture)                               │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ SUCCESS CRITERIA                                              │  │
│  │                                                               │  │
│  │  ✓  1. Add retry logic to payment webhook handler             │  │
│  │  ✓  2. Exponential backoff with max 5 attempts                │  │
│  │  ✓  3. Dead-letter queue after final failure                  │  │
│  │  ○  4. Unit tests covering all retry scenarios                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ TICKET DATA                                           [JSON]  │  │
│  │                                                               │  │
│  │  Title: Payment webhook retry mechanism                       │  │
│  │  Type: Story                                                  │  │
│  │  Priority: High                                               │  │
│  │  Source: Jira / Linear / GitHub Issues / etc.                 │  │
│  │  Description:                                                 │  │
│  │    As a payments team member, I want webhook delivery          │  │
│  │    to automatically retry on failure so that we don't          │  │
│  │    lose payment events...                                     │  │
│  │                                                    [Expand ▾] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ DOCUMENTATION                                         [JSON]  │  │
│  │                                                               │  │
│  │  Page: Payments Architecture Guide                            │  │
│  │  Source: Confluence / Notion / wiki / etc.                    │  │
│  │  Content preview:                                             │  │
│  │    ## Webhook Processing                                      │  │
│  │    The payments service receives webhooks from Stripe...      │  │
│  │                                                    [Expand ▾] │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ INJECTED LESSONS (from similarity search at capture time)     │  │
│  │                                                               │  │
│  │  • CI_FAILURE: Always set DATABASE_URL in test env            │  │
│  │  • REVIEW_REJECTION: Validate request bodies at handler level │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- `[JSON]` toggle switches between formatted view and raw JSON.
- `[Expand ▾]` reveals full content of truncated sections.
- Entire page is read-only — no edit actions.

---

## 8. RBAC / Users

**Route:** `/users`
**RBAC:** `ADMIN` only
**Data:** `GET /api/v1/users`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  USERS & ROLES                                       [+ Add User]    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Search: [Filter by email or Slack ID...]                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────┬──────────┬──────────────────┬───────────────┬────────┬────────┐  │
│  │ Email             │ Role     │ Teams            │ Slack ID      │ Active │ Action │  │
│  ├───────────────────┼──────────┼──────────────────┼───────────────┼────────┼────────┤  │
│  │ alice@co.com      │ [ADMIN▾] │ Payments, Frontend│ U0123ALICE   │   ●    │ [Edit] │  │
│  │ bob@co.com        │ [LEAD ▾] │ Platform         │ U0456BOB      │   ●    │ [Edit] │  │
│  │ carol@co.com      │ [ENG  ▾] │ Frontend         │ —             │   ●    │ [Edit] │  │
│  │ dave@co.com       │ [ENG  ▾] │ Payments         │ U0789DAVE     │   ○    │ [Edit] │  │
│  └───────────────────┴──────────┴──────────────────┴───────────────┴────────┴────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────── MODAL ──────────────────────────────┐
  │  ADD / EDIT USER                                               │
  │                                                                │
  │  Email:     [________________________]                         │
  │  Role:      ( ) ENGINEER  ( ) LEAD  ( ) ADMIN                  │
  │  Slack ID:  [________________________] (optional)              │
  │  Active:    [✓]                                                │
  │                                                                │
  │                              [Cancel]  [Save]                  │
  └────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- `[+ Add User]` → `POST /api/v1/users` via modal.
- `[Edit]` → `PATCH /api/v1/users/:id` via same modal pre-filled.
- Role dropdown inline-editable as shortcut → `PATCH /api/v1/users/:id`.
- `●` / `○` indicates `isActive` status.

---

## 9. Repositories

**Route:** `/repositories`
**RBAC:** `ENGINEER+` (read), `ADMIN` (create/edit)
**Data:** `GET /api/v1/repositories`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  REPOSITORIES                                    [+ Onboard Repo] ¹  │
│                                                                      │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐     │
│  │ 📦 payments-api  │ │ 📦 user-svc      │ │ 📦 web-app       │     │
│  │                  │ │                  │ │                  │     │
│  │ acme/payments    │ │ acme/user-svc    │ │ acme/web-app     │     │
│  │ Team: Payments   │ │ Team: Platform   │ │ Team: Frontend   │     │
│  │ Branch: main     │ │ Branch: main     │ │ Branch: develop  │     │
│  │ Active: ●        │ │ Active: ●        │ │ Active: ●        │     │
│  │ Workflows: 4     │ │ Workflows: 2     │ │ Workflows: 6     │     │
│  │                  │ │                  │ │                  │     │
│  │ [Edit] ¹         │ │ [Edit] ¹         │ │ [Edit] ¹         │     │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────── MODAL ──────────────────────────────┐
  │  ONBOARD REPOSITORY                                            │
  │                                                                │
  │  Organization:    [________________________]                   │
  │  Repo Name:       [________________________]                   │
  │  Team:            [____Payments ▾__________]                   │
  │  Default Branch:  [____main________________]                   │
  │  GitHub URL:      [________________________] (optional)        │
  │     Default: https://github.com (set for GHE instances)        │
  │  GitHub API URL:  [________________________] (optional)        │
  │     Default: https://api.github.com (GHE: <host>/api/v3)      │
  │  MCP Server Ref:  [________________________] (optional)        │
  │  Executor Image:  [____node:24-alpine______] (optional)        │
  │                                                                │
  │                              [Cancel]  [Create]                │
  └────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- ¹ `[+ Onboard Repo]` and `[Edit]` visible to ADMIN only.
- `[+ Onboard Repo]` → `POST /api/v1/repositories` via modal.
- `[Edit]` → `PATCH /api/v1/repositories/:id` via modal pre-filled.
- Card click → filtered view of `/workflows?repo=:id`.

---

## 10. Lessons Browser

**Route:** `/lessons`
**RBAC:** `ENGINEER+` (read/search), `ADMIN` (delete)
**Data:** `GET /api/v1/lessons/search?q=&repoId=&limit=` and `GET /api/v1/lessons`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  LESSONS                                                             │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ 🔍 [Semantic search...                    ] [Repo ▾] [Search] │  │
│  │                                                               │  │
│  │ Filter by type: [All ▾]  CI_FAILURE | REVIEW_REJECTION        │  │
│  │                          SECURITY_VIOLATION | MERGE_CONFLICT   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  CI_FAILURE · payments-api · JIRA-892           Sim: 0.92     │  │
│  │                                                               │  │
│  │  Rationale: Missing env var DATABASE_URL in CI test stage     │  │
│  │  Summary:   Always include DATABASE_URL in CI environment     │  │
│  │             configuration. The test runner requires a live     │  │
│  │             database connection string even for unit tests...  │  │
│  │                                                               │  │
│  │  Created: 2025-01-15              [View Workflow] [Delete] ¹  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  REVIEW_REJECTION · user-svc · JIRA-876         Sim: 0.85    │  │
│  │                                                               │  │
│  │  Rationale: Reviewer flagged missing input validation         │  │
│  │  Summary:   All public API handlers must validate request     │  │
│  │             body fields before processing...                  │  │
│  │                                                               │  │
│  │  Created: 2025-01-14              [View Workflow] [Delete] ¹  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Showing 2 results (cosine similarity ≥ 0.7)        « 1 2 3 ... »   │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- Search input performs semantic similarity search via `GET /api/v1/lessons/search?q=<query>&repoId=<id>&limit=20`.
- Without search query, shows all lessons via `GET /api/v1/lessons` (most recent first).
- `Sim:` score shown only when a search query is active.
- ¹ `[Delete]` visible to ADMIN only → `DELETE /api/v1/lessons/:id` with confirmation.
- `[View Workflow]` → `/workflows/:workflowId`.

---

## 11. Settings

**Route:** `/settings`
**RBAC:** `ENGINEER+` (own profile only)
**Data:** JWT claims (client-side) + `GET /api/v1/auth/slack/connect`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  SETTINGS                                                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ PROFILE                                                       │  │
│  │                                                               │  │
│  │  Email:  alice@company.com                                    │  │
│  │  Role:   ADMIN                                                │  │
│  │                                                               │  │
│  │  Change Password                                              │  │
│  │  Current:   [________________________]                        │  │
│  │  New:       [________________________]                        │  │
│  │  Confirm:   [________________________]                        │  │
│  │                                          [Update Password]    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ SLACK CONNECTION                                              │  │
│  │                                                               │  │
│  │  Status: ● Connected as @alice                                │  │
│  │  Slack ID: U0123ALICE                                         │  │
│  │                                                               │  │
│  │  [Reconnect Slack]  [Disconnect]                              │  │
│  │                                                               │  │
│  │  — OR if not connected: —                                     │  │
│  │                                                               │  │
│  │  Status: ○ Not connected                                      │  │
│  │  [Connect Slack Account]                                      │  │
│  │  (Redirects to Slack OAuth)                                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- `[Connect Slack Account]` / `[Reconnect Slack]` → redirects to `GET /api/v1/auth/slack/connect` (OAuth flow).
- `[Update Password]` → `PATCH /api/v1/users/:id` (self-update, same user only).
- Email and Role are read-only (role can only be changed by ADMIN on `/users` page).

---

## 12. Login

**Route:** `/login`
**RBAC:** None (unauthenticated)
**Data:** `POST /api/v1/auth/login`

```text
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                                                                      │
│                         ┌──────────────────┐                         │
│                         │    auto-swe       │                         │
│                         │    ──────────     │                         │
│                         └──────────────────┘                         │
│                                                                      │
│                    ┌──────────────────────────┐                      │
│                    │                          │                      │
│                    │  Email                   │                      │
│                    │  [______________________]│                      │
│                    │                          │                      │
│                    │  Password                │                      │
│                    │  [______________________]│                      │
│                    │                          │                      │
│                    │  [       Sign In       ] │                      │
│                    │                          │                      │
│                    │  ─────── or ───────      │                      │
│                    │                          │                      │
│                    │  [  Sign in with Slack ] │                      │
│                    │                          │                      │
│                    └──────────────────────────┘                      │
│                                                                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- `[Sign In]` → `POST /api/v1/auth/login { email, password }` → stores JWT + refresh token in `httpOnly` cookie or `localStorage`.
- `[Sign in with Slack]` → redirects to `GET /api/v1/auth/slack/connect`.
- On success, redirects to `/` (Dashboard Home).
- On failure, inline error message: "Invalid email or password."
- If already authenticated, redirects to `/`.

---

## 13. Teams List

**Route:** `/teams`
**RBAC:** `ENGINEER+` (filtered to own teams; ADMIN sees all)
**Data:** `GET /api/v1/teams`

```text
┌──────────────────────────────────────────────────────────────────────┐
│  TEAMS                                               [+ New Team] ¹  │
│                                                                      │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐     │
│  │ Payments         │ │ Platform         │ │ Frontend         │     │
│  │                  │ │                  │ │                  │     │
│  │ Your role: LEAD  │ │ Your role: ENG   │ │ Your role: ADMIN │     │
│  │ Members: 5       │ │ Members: 3       │ │ Members: 4       │     │
│  │ Repos: 2         │ │ Repos: 1         │ │ Repos: 3         │     │
│  │ Active: ●        │ │ Active: ●        │ │ Active: ●        │     │
│  │                  │ │                  │ │                  │     │
│  │ [View]           │ │ [View]           │ │ [View]           │     │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────── MODAL ──────────────────────────────┐
  │  CREATE TEAM                                                    │
  │                                                                │
  │  Name:         [________________________]                      │
  │  Slug:         [________________________] (auto-generated)     │
  │  Description:  [________________________] (optional)           │
  │                                                                │
  │                              [Cancel]  [Create]                │
  └────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- ¹ `[+ New Team]` visible to Platform ADMIN only → `POST /api/v1/teams`.
- `[View]` → `/teams/:id`.
- Card shows user's own role badge in that team.
- Member and repo counts fetched from team detail.

---

## 14. Team Detail

**Route:** `/teams/:id`
**RBAC:** Team `ENGINEER+`
**Data:** `GET /api/v1/teams/:id` (includes `memberships[]`, `repositories[]`)

```text
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back to Teams                                                     │
│                                                                      │
│  Payments Team                                       Active: ●       │
│  Slug: payments · Your role: ADMIN                                   │
│  Description: Handles payment processing services                    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ MEMBERS                                   [+ Add Member] ¹    │  │
│  │                                                               │  │
│  │ ┌───────────────────┬──────────────┬────────────────────────┐ │  │
│  │ │ User              │ Team Role    │ Action                 │ │  │
│  │ ├───────────────────┼──────────────┼────────────────────────┤ │  │
│  │ │ alice@co.com      │ [ADMIN ▾] ¹  │ [Remove] ¹             │ │  │
│  │ │ bob@co.com        │ [LEAD  ▾] ¹  │ [Remove] ¹             │ │  │
│  │ │ carol@co.com      │ [ENG   ▾] ¹  │ [Remove] ¹             │ │  │
│  │ │ dave@co.com       │ [ENG   ▾] ¹  │ [Remove] ¹             │ │  │
│  │ │ eve@co.com        │ [ENG   ▾] ¹  │ [Remove] ¹             │ │  │
│  │ └───────────────────┴──────────────┴────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ REPOSITORIES                                                   │  │
│  │                                                               │  │
│  │ ┌──────────────────┐ ┌──────────────────┐                     │  │
│  │ │ 📦 payments-api  │ │ 📦 payments-web  │                     │  │
│  │ │ acme/payments    │ │ acme/pay-web     │                     │  │
│  │ │ Workflows: 4     │ │ Workflows: 2     │                     │  │
│  │ └──────────────────┘ └──────────────────┘                     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ TEAM SETTINGS ¹                                               │  │
│  │                                                               │  │
│  │ Name:         [____Payments_______________]                   │  │
│  │ Description:  [____Handles payment proc..._]                  │  │
│  │                                                               │  │
│  │                              [Save Changes]                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Interactions:**

- ¹ Member management (add, role change, remove) and team settings visible to Team ADMIN only.
- `[+ Add Member]` opens a modal with user search → `POST /api/v1/teams/:id/members`.
- Role dropdown inline-editable → `PATCH /api/v1/teams/:id/members/:userId`.
- `[Remove]` → `DELETE /api/v1/teams/:id/members/:userId` with confirmation.
- Repository cards link to `/workflows?repo=:id`.
- Team settings → `PATCH /api/v1/teams/:id`.

---

## Route Summary

| Route                         | Page                    | Min Role               |
| ----------------------------- | ----------------------- | ---------------------- |
| `/login`                      | Login                   | —                      |
| `/reset-password`             | Reset Password          | —                      |
| `/`                           | Dashboard Home          | ENGINEER               |
| `/workflows`                  | Active Runs             | ENGINEER               |
| `/workflows/:id`              | Workflow Detail         | ENGINEER               |
| `/runs/:id`                   | WorkflowRun Detail      | ENGINEER               |
| `/epics`                      | Epic List               | LEAD                   |
| `/epics/:id`                  | Epic Visualizer         | LEAD                   |
| `/templates`                  | Template List           | ENGINEER               |
| `/templates/:id`              | Template Editor / DAG   | ENGINEER               |
| `/templates/:id/runs`         | Template Run History    | ENGINEER               |
| `/templates/:id/analytics`    | Template Analytics      | ENGINEER               |
| `/templates/:id/diff`         | Version Diff            | ENGINEER               |
| `/analytics`                  | Platform Analytics      | ENGINEER               |
| `/teams`                      | Teams List              | ENGINEER               |
| `/teams/:id`                  | Team Detail             | ENGINEER (team member) |
| `/lessons`                    | Lessons Browser         | ENGINEER               |
| `/repositories`               | Repositories            | ENGINEER               |
| `/users`                      | RBAC / Users            | ADMIN                  |
| `/settings`                   | Settings                | ENGINEER               |
| `/admin/model-config`         | Model Configuration     | ADMIN                  |
| `/admin/access-tokens`        | Admin Access Tokens     | ADMIN                  |
| `/admin/sessions`             | Admin Sessions          | ADMIN                  |

---

## Web UI Technical Stack

### Package Dependencies (`packages/web/package.json`)

| Category          | Library            | Version    | Purpose                                                                                           |
| ----------------- | ------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| **Framework**     | Next.js            | `16.2.6`   | App Router, RSC, API route proxying, middleware for auth redirect                                 |
| **Runtime**       | React              | `19.2.6`   | UI rendering, `use` hook for params                                                               |
| **Styling**       | Tailwind CSS       | `4.3.0`    | Utility-first CSS with CSS-first `@theme` configuration (v4)                                      |
| **UI Primitives** | Custom components  | —          | Bespoke "Workshop Telemetry" design system under `src/components/ui/` (Button, Card, Input, Modal, Stat, StatusBadge, PageHeader) — no Radix/shadcn |
| **Server State**  | TanStack Query     | `5.100.10` | Server-state caching, background refetch, optimistic updates for all Gateway API calls             |
| **Client State**  | Zustand            | `5.0.13`   | Lightweight client-side state (auth store, sidebar, theme preference)                             |
| **Auth**          | better-auth        | `1.6.11`   | Session cookie management; JWT bearer path still handled by the gateway's own auth plugin         |
| **DAG Canvas**    | @xyflow/react      | `12.10.2`  | React Flow canvas for read-only workflow DAG viewer and drag-edit template editor                 |
| **DAG Layout**    | dagre              | `0.8.5`    | Automatic layered graph layout for the DAG renderer (`src/lib/workflowLayout.ts`)                 |
| **Charts**        | Recharts           | `3.8.1`    | SVG charts for analytics KPI tiles and per-step failure rates                                     |
| **Validation**    | Zod                | `4.4.3`    | Schema validation shared with Gateway (spec schemas, form schemas)                                |
| **CSS helpers**   | clsx + tailwind-merge | `2.1.1` / `3.6.0` | Conditional class names with Tailwind deduplication                              |
| **Markdown**      | react-markdown + remark-gfm | `10.1.0` | Renders agent lesson content and PR body previews                               |

### Architecture Decisions

**App Router (Server Components by default):**

- List pages (`/workflows`, `/teams`, `/repositories`) use RSC with `fetch()` for initial data, hydrated client-side by TanStack Query for refetch/mutations.
- Interactive components (`DataTable`, `TeamSelector`, modals) are `"use client"` components.

**API Communication Pattern:**

- All Gateway calls go through a shared `api` client module (`src/lib/api.ts`) that wraps `fetch` with the JWT `Authorization` header, base URL, and error handling.
- TanStack Query hooks (`useWorkflows`, `useTeams`, `useRepositories`) encapsulate query keys, stale times, and refetch intervals.
- Mutations use TanStack Query's `useMutation` with optimistic updates and automatic cache invalidation.

**Auth Flow:**

- Next.js middleware (`middleware.ts`) checks for a valid JWT cookie on every request. Redirects to `/login` if missing/expired.
- JWT + refresh token stored in `httpOnly` cookies (not localStorage) for XSS protection.
- Refresh token rotation handled transparently by the `api` client — 401 responses trigger a refresh before retrying.

**Component Structure:**

```text
packages/web/src/
├── app/                      # Next.js App Router
│   ├── layout.tsx            # Root layout (sidebar, top bar, team selector)
│   ├── page.tsx              # Dashboard Home
│   ├── login/page.tsx
│   ├── workflows/
│   │   ├── page.tsx          # Workflow List
│   │   └── [id]/
│   │       ├── page.tsx      # Workflow Detail
│   │       └── context/page.tsx  # Context Inspector
│   ├── teams/
│   │   ├── page.tsx          # Teams List
│   │   └── [id]/page.tsx     # Team Detail
│   ├── epics/
│   │   ├── page.tsx          # Epic List
│   │   └── [id]/page.tsx     # Epic Visualizer
│   ├── repositories/page.tsx
│   ├── users/page.tsx
│   ├── lessons/page.tsx
│   └── settings/page.tsx
├── components/
│   ├── ui/                   # shadcn/ui components (Button, Dialog, Table, Select, etc.)
│   ├── layout/               # Sidebar, TopBar, TeamSelector, UserMenu
│   ├── workflows/            # WorkflowTable, WorkflowTimeline, StatusBadge
│   ├── teams/                # TeamCard, MemberTable, AddMemberModal
│   └── shared/               # DataTable, ConfirmDialog, EmptyState, Pagination
├── hooks/                    # TanStack Query hooks (useWorkflows, useTeams, etc.)
├── lib/
│   ├── api.ts                # Fetch wrapper with auth, base URL, error handling
│   ├── auth.ts               # JWT cookie helpers, refresh logic
│   └── utils.ts              # cn() helper (clsx + tailwind-merge), formatters
├── stores/                   # Zustand stores (team-selector.ts, ui-preferences.ts)
└── middleware.ts              # Auth redirect middleware
```

**shadcn/ui Components Used:**

The following shadcn/ui components cover the wireframe requirements:

| Component                | Used In                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `Button`                 | All action buttons (Submit, Retry CI, Terminate, Save, etc.)  |
| `Dialog` / `AlertDialog` | Modals (New Request, Onboard Repo, Add Member, confirmations) |
| `Table`                  | Workflow List, Members table, Users table                     |
| `Select`                 | Role dropdowns, Status filter, Team filter, Repository filter |
| `Card`                   | Dashboard status cards, Repo cards, Team cards                |
| `Badge`                  | Status badges (IMPLEMENTING, FAILED, etc.), role badges       |
| `Input` / `Textarea`     | Form fields in modals and settings                            |
| `DropdownMenu`           | User menu, bulk actions                                       |
| `Tabs`                   | Workflow Detail sections                                      |
| `Tooltip`                | Truncated text, icon-only buttons                             |
| `Skeleton`               | Loading states for all data-fetching pages                    |
| `Sonner` (toast)         | Success/error notifications after mutations                   |
| `Command`                | Combobox search (Add Member user search)                      |
| `Sidebar`                | App sidebar navigation (shadcn/ui sidebar component)          |

**Recharts Usage:**

| Chart Type      | Used In                              | Data Source                                      |
| --------------- | ------------------------------------ | ------------------------------------------------ |
| `BarChart`      | Dashboard — workflows per day/week   | `GET /api/v1/workflows` (aggregated client-side) |
| `PieChart`      | Dashboard — status distribution      | `GET /api/v1/workflows` (grouped by status)      |
| Custom timeline | Workflow Detail — lifecycle timeline | `GET /api/v1/workflows/:id` (status timestamps)  |
