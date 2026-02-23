# Web Dashboard — ASCII Wireframes

> **Tech stack:** Next.js 14 + React + Tailwind CSS
> **API base:** `GET/POST/PATCH/DELETE /api/v1/*` (gateway on `:8080`)
> **Auth:** RS256 JWT in `Authorization: Bearer <token>` header
> **Roles:** `ADMIN > LEAD > ENGINEER` (numeric hierarchy 3 > 2 > 1)

---

## Table of Contents

1. [Global Layout](#1-global-layout)
2. [Dashboard Home `/`](#2-dashboard-home)
3. [Workflow List `/workflows`](#3-workflow-list)
4. [Workflow Detail `/workflows/:id`](#4-workflow-detail)
5. [Epic List `/epics`](#5-epic-list)
6. [Epic Visualizer `/epics/:id`](#6-epic-visualizer)
7. [Context Inspector `/workflows/:id/context`](#7-context-inspector)
8. [RBAC / Users `/users`](#8-rbac--users)
9. [Repositories `/repositories`](#9-repositories)
10. [Lessons Browser `/lessons`](#10-lessons-browser)
11. [Settings `/settings`](#11-settings)
12. [Login `/login`](#12-login)

---

## 1. Global Layout

Persistent chrome wrapping every authenticated page. Sidebar collapses on
mobile to a hamburger menu.

```
┌──────────────────────────────────────────────────────────────────────┐
│  TOP BAR                                                             │
│  ┌──────────┐                          ┌────────┐ ┌───────────────┐  │
│  │ ≡  Logo  │       auto-swe           │ ? Help │ │ ● J. Doe  ▾  │  │
│  └──────────┘                          └────────┘ └───────────────┘  │
├────────────┬─────────────────────────────────────────────────────────┤
│  SIDEBAR   │                                                         │
│            │                                                         │
│  Dashboard │              PAGE CONTENT AREA                          │
│  Workflows │              (scrollable)                               │
│  Epics     │                                                         │
│  Lessons   │                                                         │
│  ────────  │                                                         │
│  Repos ¹   │                                                         │
│  Users ¹   │                                                         │
│  ────────  │                                                         │
│  Settings  │                                                         │
│            │                                                         │
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
- User dropdown shows role badge: `[ADMIN]`, `[LEAD]`, or `[ENG]`.

---

## 2. Dashboard Home

**Route:** `/`
**RBAC:** `ENGINEER+`
**Data:** `GET /api/v1/workflows` (aggregated client-side)

```
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

```
┌──────────────────────────────────────────────────────────────────────┐
│  WORKFLOWS                                         [+ New Request]   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Filter: [Status ▾] [Repository ▾] [Search ticket ID...]      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──┬────────────┬──────────────┬──────────┬──────────┬──────────┐  │
│  │☐ │ Ticket     │ Repository   │ Status   │ Branch   │ Updated  │  │
│  ├──┼────────────┼──────────────┼──────────┼──────────┼──────────┤  │
│  │☐ │ JIRA-910   │ web-app      │ ● IMPL   │ auto/910 │ 2m ago   │  │
│  │☐ │ JIRA-892   │ payments-api │ ◉ FAIL   │ auto/892 │ 15m ago  │  │
│  │☐ │ JIRA-901   │ web-app      │ ○ MERGE  │ auto/901 │ 1h ago   │  │
│  │☐ │ JIRA-888   │ user-svc     │ ● REVIEW │ auto/888 │ 2h ago   │  │
│  │☐ │ JIRA-876   │ user-svc     │ ✕ TIMED  │ auto/876 │ 3h ago   │  │
│  │☐ │ JIRA-865   │ payments-api │ ✓ DONE   │ auto/865 │ 1d ago   │  │
│  └──┴────────────┴──────────────┴──────────┴──────────┴──────────┘  │
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

```
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

```
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

```
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

```
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

```
┌──────────────────────────────────────────────────────────────────────┐
│  USERS & ROLES                                       [+ Add User]    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Search: [Filter by email or Slack ID...]                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌───────────────────┬──────────┬───────────────┬────────┬────────┐  │
│  │ Email             │ Role     │ Slack ID      │ Active │ Action │  │
│  ├───────────────────┼──────────┼───────────────┼────────┼────────┤  │
│  │ alice@co.com      │ [ADMIN▾] │ U0123ALICE    │   ●    │ [Edit] │  │
│  │ bob@co.com        │ [LEAD ▾] │ U0456BOB      │   ●    │ [Edit] │  │
│  │ carol@co.com      │ [ENG  ▾] │ —             │   ●    │ [Edit] │  │
│  │ dave@co.com       │ [ENG  ▾] │ U0789DAVE     │   ○    │ [Edit] │  │
│  └───────────────────┴──────────┴───────────────┴────────┴────────┘  │
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

```
┌──────────────────────────────────────────────────────────────────────┐
│  REPOSITORIES                                    [+ Onboard Repo] ¹  │
│                                                                      │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐     │
│  │ 📦 payments-api  │ │ 📦 user-svc      │ │ 📦 web-app       │     │
│  │                  │ │                  │ │                  │     │
│  │ acme/payments    │ │ acme/user-svc    │ │ acme/web-app     │     │
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
  │  Default Branch:  [____main________________]                   │
  │  GitHub URL:      [________________________] (optional)        │
  │     Default: https://github.com (set for GHE instances)        │
  │  GitHub API URL:  [________________________] (optional)        │
  │     Default: https://api.github.com (GHE: <host>/api/v3)      │
  │  MCP Server Ref:  [________________________] (optional)        │
  │  Executor Image:  [____node:20-alpine______] (optional)        │
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

```
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

```
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

```
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

## Route Summary

| Route                      | Page               | Min Role   |
|----------------------------|--------------------|------------|
| `/login`                   | Login              | —          |
| `/`                        | Dashboard Home     | ENGINEER   |
| `/workflows`               | Workflow List      | ENGINEER   |
| `/workflows/:id`           | Workflow Detail    | ENGINEER   |
| `/workflows/:id/context`   | Context Inspector  | ENGINEER   |
| `/epics`                   | Epic List          | LEAD       |
| `/epics/:id`               | Epic Visualizer    | LEAD       |
| `/lessons`                 | Lessons Browser    | ENGINEER   |
| `/repositories`            | Repositories       | ENGINEER   |
| `/users`                   | RBAC / Users       | ADMIN      |
| `/settings`                | Settings           | ENGINEER   |
