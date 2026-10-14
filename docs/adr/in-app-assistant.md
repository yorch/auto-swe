# In-app assistant — decision log

A chat assistant in the web dashboard that can answer how the platform works, author and run
workflows, troubleshoot failed runs and configuration, and take any other action the invoking user
could take — as that user, never more.

## D1 — 2026-10-14 — Scope: act as the invoking user

**Status**: Accepted
**Decision**: The assistant acts with the invoking user's identity and permissions. Every action is a
call to the same gateway route the dashboard calls, so the route's role gate, visibility filter,
tenant guard, rate limit and audit apply unchanged. The assistant can never do what the user cannot.
**Reason**: Parity by construction. A parallel permission model for the assistant would drift from
the routes' own checks, and the MCP bridge (`lib/mcp/bridge.ts`) already proves the in-process
`app.inject()` pattern.
**Alternatives considered**: A service identity with its own grants. Rejected: it either over-grants
(sees what the user cannot) or needs a second copy of every visibility rule.

## D2 — 2026-10-14 — Every write is confirmed by the user

**Status**: Accepted
**Decision**: Reads run freely. Every write (any non-GET route) is proposed as an action card in the
chat — method, route, a human-readable summary, and the request body — and runs only after the user
clicks Confirm. The confirmation is enforced by the gateway, not the model: the user's click goes to
the gateway on the user's own session and records a one-time grant bound to the conversation and a
digest of `method + path + body`; the assistant's write is accepted only with a matching, unused,
unexpired grant.
**Reason**: Prompt injection. Run errors, ticket text, docs and tool output all reach the model, and
any of them can carry instructions. With a gateway-enforced grant, an injected instruction can at most
propose an action the user sees and declines; a compromised prompt or worker cannot write alone.
**Alternatives considered**: Confirming only risky writes (requires classifying ~200 routes by risk
and still lets injected low-risk writes through); no confirmation (any injected text acts as the user).

## D3 — 2026-10-14 — Actions the assistant never takes

**Status**: Accepted
**Decision**: Even when the user may, the assistant may not:
- answer, approve or reject a human step (HITL gates exist so a person decides);
- read, create, rotate or delete secrets and credentials — provider credentials, GitHub/Slack/tracker
  secrets, webhook and callback secrets, personal access tokens, service-principal keys;
- manage users, roles, team/org membership or config permission grants;
- call any `DELETE` route.

The assistant explains how to do these in the UI and links the page instead.
**Reason**: Each removes a human from a decision the platform deliberately leaves to one, or exposes
material whose leak cannot be undone.

## D4 — 2026-10-14 — Every route declares its assistant policy

**Status**: Accepted
**Decision**: Each gateway route declares `config.assistant: 'read' | 'confirm' | 'never'`.
`requireAuth` refuses an assistant credential on a route that declares `never` or declares nothing, and
on a `confirm` route without a matching grant (D2). A `DELETE` route is `never` whatever it declares.
A unit test walks the registered routes and fails on any route without a policy, any non-GET route
declared `read`, and any route in the D3 categories not declared `never`.
**Reason**: Default-closed. A route added later is unreachable by the assistant until someone decides
its policy, and the test makes that decision part of adding the route. Enforcing in `requireAuth`
rather than in the tool means the model's tool layer is not the control.
**Alternatives considered**: Default-allow with a denylist. Rejected: a new secrets route that forgets
the tag would be silently exposed.

## D5 — 2026-10-14 — Tool design: curated plus a generic API tool

**Status**: Accepted
**Decision**: Curated tools for the common jobs, plus one generic tool over the gateway's OpenAPI
document for everything else.

| Tool | Kind | Purpose |
|---|---|---|
| `searchDocs` | read | Search the living docs (D7) |
| `getPageContext` | read | What the user is looking at (D8) |
| `findRuns`, `getRunDiagnosis` | read | Locate runs; return status, failed steps, step errors and trace excerpts as fenced untrusted data |
| `checkConfigHealth` | read | Readiness: integrations, models, credentials present (never their values), worker health |
| `listTemplates`, `explainTemplate` | read | Find and describe workflow templates |
| `generateWorkflow`, `refineWorkflow` | confirm | Existing workflow-author path; saves a DRAFT |
| `runTemplate` | confirm | Start a run of a chosen template with its inputs |
| `describeApi` | read | Search the OpenAPI catalog filtered to routes the policy admits |
| `callApi` | read / confirm | Call any admitted route; a non-GET becomes an action card |

**Reason**: Full parity without writing ~345 tools, while the frequent tasks get tools shaped for the
model rather than raw route output.

## D6 — 2026-10-14 — Where it runs

**Status**: Accepted
**Decision**: Each conversation is a Temporal workflow (`AssistantConversationWorkflow`); each turn is
an activity in the worker running a Mastra loop with the `appAssistant` agent resolved through
`resolveAgent`. A pending action card is a workflow wait on a `confirm` / `decline` signal. Tools call
the gateway over HTTP with a short-lived **assistant delegation token** the gateway mints per turn,
bound to `(userId, conversationId)`, refused once the user is deactivated or the conversation closed.
**Reason**: The gateway never calls an LLM — models bind in the worker. Temporal gives durable waits
for confirmation and survives worker restarts mid-turn.
**Alternatives considered**: Running the loop in the gateway (breaks the model-binding boundary);
reusing MCP OAuth tokens (they require a browser consent flow and are scoped to opted-in routes).

## D7 — 2026-10-14 — Product docs as knowledge

**Status**: Accepted
**Decision**: `searchDocs` reuses the dashboard's own docs search. The pure index and ranking in
`packages/web/src/lib/docSearch.ts` move to `@auto-swe/shared` so the web `/docs/search` route and the
worker share one implementation; the worker image ships the top level of `docs/` (the same set
`/docs` serves, so never `docs/history/`). A result returns the section text plus its
`/docs/<slug>#<anchor>` link, which the assistant cites. Docs are platform-wide, so they do not go
into the team-scoped governed knowledge store. Semantic search is an optimisation, not a requirement.
**Reason**: ~1 MB of docs does not fit a prompt; one search keeps the assistant's answers and the
docs page in agreement, and the docs version always matches the running code.
**Alternatives considered**: Calling the web's `/docs/search` route from the worker (couples the
worker to the web process being up); indexing the docs into the knowledge store (team-scoped, governed
lifecycle that platform docs do not need).

## D8 — 2026-10-14 — Surface and conversation model

**Status**: Accepted
**Decision**: A slide-out panel on every dashboard page. Each message carries the current route and
its entity id (run, template, repository), which `getPageContext` exposes. Conversations are private
to their user, persisted, listed in the panel, and retained for a configurable period (registry
setting, default 30 days). Replies stream; tool calls show as collapsible steps.
**Reason**: "Why did this fail?" on a run page should not require pasting an id.

## D9 — 2026-10-14 — Cost and limits

**Status**: Accepted
**Decision**: Turns are priced like any agent call and accrue to the user's organization monthly
budget; a refused budget answers in the chat. Registry settings: `assistant.enabled` (default off),
`assistant.maxStepsPerTurn`, `assistant.retentionDays`.

## D10 — 2026-10-14 — First-version surface

**Status**: Accepted
**Decision**: Web panel only. The Slack channel assistant and the MCP server keep their current tools.
**Reason**: A Slack channel is shared, so "act as the invoking user" needs its own design there (whose
identity, whose confirmation). The tool set from D5 can be bound to Slack later.

## D11 — 2026-10-14 — Delivery order

**Status**: Accepted
**Decision**: Five pull requests, in order. Each passes every quality gate on its own and leaves the
assistant off (`assistant.enabled` defaults to false), so `main` never carries a half-reachable
surface.

1. **Route policy and assistant credentials.** No model involved.
   - `config.assistant` on every gateway route; the route-walk test from D4.
   - The assistant delegation token: minted by the gateway, verified in `requireAuth`, refused on
     `never` and undeclared routes and on every `DELETE`.
   - Action grants: a Prisma model, the confirm/decline routes on the user's own session, and the
     one-time `method + path + body` digest check on `confirm` routes.
   - Registry settings `assistant.enabled`, `assistant.maxStepsPerTurn`, `assistant.retentionDays`.
   - Done when an assistant token can read what its user can, cannot write without a grant, and can
     never reach a D3 route, with tests for each.
2. **Read-only assistant, end to end.**
   - Conversation and message models; the `appAssistant` agent seeded in `syncBuiltins` (with the
     agent roster in `docs/agents.md` and `AGENTS.md`, which `yarn docs:check` enforces).
   - `AssistantConversationWorkflow`, the turn activity with `AgentTracer`, and a replay fixture.
   - Gateway routes to list, open and post to a conversation, with a streamed reply.
   - Tools `searchDocs` (with the shared docs index from D7), `getPageContext`, `describeApi`, and
     `callApi` for GET.
   - The web panel: open from any page, streamed reply, collapsible tool steps, conversation list.
   - Done when a user can ask how to configure an integration and get a cited answer.
3. **Troubleshooting and template tools.** `findRuns`, `getRunDiagnosis` (step errors and trace
   excerpts fenced as untrusted data), `checkConfigHealth`, `listTemplates`, `explainTemplate`.
   Done when "why did this run fail?" on a run page names the failed step and its error.
4. **Confirmed writes.** Action cards in the panel; the workflow waits on `confirm` / `decline`;
   `callApi` for non-GET routes, `runTemplate`, `generateWorkflow`, `refineWorkflow`. Done when a
   declined or forged action leaves no trace but an audit row, and a confirmed one runs exactly once.
5. **Operating it.** The retention sweep; budget refusal shown in the chat; security events for
   refused and forged actions; the living doc `docs/in-app-assistant.md` with its `## Limitations`
   and a site sidebar entry.

**Reason**: The access controls land first and are tested without a model in the loop, so every later
step builds on an enforced boundary rather than adding one at the end. Reads ship before writes, so
the injection surface grows only after the confirmation path exists.
