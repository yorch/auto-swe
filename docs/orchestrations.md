# Orchestrated agent runs

An orchestration is a durable conversation between a person and an `orchestrator` agent that splits a
task between library agents. The person says what they want ("find why retries double-charge, then fix
the two places that need it") and watches the work happen: the orchestrator starts sub-agents, hears
what each one found, asks the person for a repository when it needs one, and reports back. A person can
steer the orchestrator or any running sub-agent at any time.

The orchestrator never reads a file, runs a command or calls the platform. Its four tools only **record
intents**. Fixed gateway code validates every intent and applies it through the same launch path a
person would use, **as the person who launched the orchestration**. Each sub-agent is an ordinary
[agent run](./agent-runs.md) that returns exactly one structured result. That result, fenced and
screened, is the only thing from a sub-agent that enters the orchestrator's context: no tool call, retry
or reasoning crosses back.

Orchestrations are off until an administrator turns on `orchestration.enabled` (section 10).

| | Agent run | Orchestration | Channel assistant |
|---|---|---|---|
| What it is | One library agent, one repository, one prompt | A conversation with an orchestrator that starts, steers and collects agent runs | One shared assistant resident in a Slack channel |
| Who starts further agent runs | Nobody | The orchestrator, by recorded intent, applied by gateway code as the launcher | Its `delegateTask` tool records an intent for one task run or workflow draft ([channel-assistant.md](./channel-assistant.md)) |
| Repository | Required | Optional. Without one it is read-only; a person can attach one, once | None of its own |
| Conversation | None; the prompt is the whole input | Durable; the person and the orchestrator exchange messages, and the person can message a running child | A Slack thread |
| Delivery | `none`, `branch` or `draft_pr` | Per writer child: one branch and one draft pull request each, under declared path scopes | Through the runs it delegates |
| Human decisions | None while it runs | Attaching a repository and approving MCP writes, both launcher-only | Slack buttons on HITL steps |

---

## 1. Launching one

| Surface | Call |
|---|---|
| API | `POST /api/v1/orchestrations` |
| CLI | `auto-swe orchestrate start "<task>" [--agent=<key> ...] [--repo=<org/name> \| --team=<slug>] [--connection=<id> ...] [--budget-tier=STANDARD\|LARGE\|EPIC] [--deliver=none\|branch\|draft_pr] [--idempotency-key=KEY] [--wait]` |
| Dashboard | **Orchestrate agents** in **Start work** (`/start`); the list is at `/orchestrations` |
| MCP | `orchestrations_launch` (section 9) |

Request body:

| Field | Meaning |
|---|---|
| `task` | What to get done. 1 to 20,000 characters, no control characters. The first line (80 characters) becomes the title |
| `allowlist` | Optional. The agents the orchestrator may start: up to 20 references, each `key` or `key@version`. Omitted or empty, the platform default applies. See below |
| `repoId` | Optional. A `git_repo` connection to start with. The orchestration is then repository-bound from the first message |
| `teamId` | The team the orchestration is named for. Required without `repoId`. With `repoId` it must be the repository's owning team |
| `connectionIds` | Optional. Up to 10 MCP connections the children may use. Fixed at launch |
| `budgetTier` | `STANDARD` (default), `LARGE` or `EPIC`, as for any run |
| `deliveryDefault` | `none` (default), `branch` or `draft_pr`. Shown on the repository confirmation card (section 5); it is a recorded preference, and a writer's delivery mode is chosen per child (section 3) |

```bash
curl -X POST "$API/api/v1/orchestrations" \
  -H "Authorization: Bearer $AUTO_SWE_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6b0e5c2a-7d1f-4e55-9a41-3f2f7b9d8c10' \
  -d '{
        "task": "Find why retries double-charge, then fix the retry wrapper and its tests.",
        "allowlist": ["docsMaintainer", "contentWriter"],
        "repoId": "<connection-uuid>",
        "budgetTier": "STANDARD",
        "deliveryDefault": "draft_pr"
      }'
# 201 { "data": { "orchestrationId": "…", "status": "ACTIVE", "workflowId": "orch-…" } }
```

```bash
# Repository-bound
auto-swe orchestrate start "Find why retries double-charge" --repo=acme/payments \
  --agent=docsMaintainer --agent=contentWriter --budget-tier=LARGE --wait

# Repo-less: read-only, owned by a team
auto-swe orchestrate start "Summarise last week's incidents" --team=payments --agent=contentWriter
```

### Who may launch

An any signed-in user. The decision depends on the mode:

| Mode | Authority |
|---|---|
| Repository-bound | The agent-run launch decision, unchanged: membership of the repository's owning team or of a team it is shared with, GitHub permission under the repository access gate, the organisation's monthly cap, the agent-run kill switch. The named team is the repository's owning team (`400 TEAM_REPO_MISMATCH` otherwise) |
| Repo-less | The caller belongs to the named team and its organisation (an ADMIN bypasses membership, not the caps), and neither the organisation's nor the team's monthly cap is spent. A team the caller is not in answers `404 TEAM_NOT_FOUND`, as one that does not exist |

Both modes also need the kill switches on: `orchestration.enabled` (`403 ORCHESTRATION_DISABLED`; `503
ORCHESTRATION_UNAVAILABLE` when it cannot be read) and the agent-run limits `workspace.agentRunMaxConcurrentGlobal`
and `workspace.agentRunMaxConcurrentPerTeam` (a value of 0 disables agent runs: `403 AGENT_RUNS_DISABLED`).

### Repo-bound and repo-less

A **repository-bound** orchestration can start readers and writers. A **repo-less** one is read-only by
construction: it has no workspace and no delivery, a writer spawn is refused (`REPO_REQUIRED`), and its
children are repo-less readers (section 3). Either can have a repository attached later by the launcher
(section 5), but only if it started without one.

### The allowlist

The allowlist is the complete list of agents the orchestrator can start. Every entry must be launchable
(not on the platform's non-launchable list, which includes `orchestrator` itself) and exist at GLOBAL or
the organisation's scope; a `key@version` pin selects a GLOBAL version and is refused when an
organisation override shadows it. The refusals are `400 AGENT_NOT_LAUNCHABLE`, `404 AGENT_NOT_FOUND` and
`400 AGENT_PIN_SHADOWED`. A spawn must name an entry **exactly as written** on the list: `key` and
`key@3` are different entries.

The launcher may leave the allowlist out. The gateway then applies `orchestration.defaultAllowlist`
(section 10), read at the named team's organisation and then GLOBAL, and reduced to the agents that exist
and are launchable there now, so an entry that was deleted since the operator wrote it shrinks the default
instead of failing the launch. The default is curated: read-oriented investigators and reviewers, plus the
`implementer`, the one default agent that can change files by the worker's definition (it grants
`writeFile` or `bash`), so that writers are possible without any setup. An organisation override of a
default agent can make it write-capable too: the launch response and `GET /api/v1/orchestrations/defaults`
carry `writeCapable`, the entries of the applied list whose effective (organisation-resolved) agent can
change files, and the dashboard form and the CLI's `Agents:` line mark them "can change files". The
form marks only the agents of the default list, not others the person ticks. When nothing is left the launch
is refused as `400 ALLOWLIST_REQUIRED`, and the launcher passes an allowlist. An explicit allowlist is
used exactly as given, with every refusal above, and the default is not merged into it.

The launch response and the detail view carry the allowlist that was **applied**, whichever way it was
chosen. The dashboard form pre-selects the default (`GET /api/v1/orchestrations/defaults?teamId=`) and
sends whatever the person leaves checked; its review step shows the list and says when it is the default.
A replayed `Idempotency-Key` is answered before any allowlist is resolved: it returns the orchestration the
first launch created, with the allowlist that launch applied, even when the default has since been emptied
or its agents removed (a first launch under the same default is still refused). The key's request digest
covers what the caller sent, so a changed default never turns a retry into a mismatch.

The agents' own definitions bound what a child can do, so list, or configure as the default, only agents
whose tools and MCP connection the launcher is willing to expose to a model that follows the task.

### Connections

`connectionIds` is the complete MCP set. Each must be an active `mcp` connection owned by the named team
(`400 CONNECTION_NOT_OWNED`). A child whose agent is bound to an MCP connection outside the set is
refused (`CONNECTION_NOT_IN_SET`); an agent with no MCP connection is unaffected. `GET
/api/v1/orchestrations/connections?teamId=` lists the team's connections by name, for the launch form.
Every MCP tool call a child makes goes through launcher approval when it is not provably read-only
(section 6).

### Budget tier and delivery default

The tier is the orchestration's tier: the orchestrator's own ledger row carries it, and each child run is
launched with it, so every run has the tier's token caps on its own. The orchestrator also stops taking
turns when its model price or the organisation's USD cap says so (section 2). `deliveryDefault` is stored
with the orchestration and shown on the attach card. The orchestrator chooses `branch` or `draft_pr` in
each writer spawn, and the launcher's push permission (for a person; section 1, Service principals, for a
principal) and the path scopes bound what the writer can do.
For an orchestration launched through MCP, `deliveryDefault` is also a ceiling: a writer's delivery must
be allowed by the live setting `mcp.agentRunAllowedDeliverModes` and cannot exceed the launch's
`deliveryDefault` (`none` allows no writer, `branch` allows `branch`, `draft_pr` allows both).

### Idempotency

`Idempotency-Key` (up to 255 characters) is optional on the API and required through MCP. The
orchestration id is derived from the key and the caller, so a retried launch with the same key answers
`200` with the orchestration it already made, and no second one starts. A key already used by a different
caller or principal answers `409 RUN_CONFLICT`, and the same key with a different body answers
`422 IDEMPOTENCY_KEY_MISMATCH`. Without a key, every launch is a new orchestration.

### Service principals

A team's [service principal](./service-principals.md) whose token carries `runs:agent` may launch a
repository-bound orchestration. It acts as no person: `launchedById` is null and the orchestration carries
the principal's id as `serviceId`. That principal, and only it, is the launcher: it can message the
orchestrator or a child, cancel a child, cancel the orchestration and end it, and read its own
orchestrations (section 7). Nobody can approve a tool call or attach a repository for it, since both are a
person's acts, so any MCP write its agents attempt is denied and it works on the repository it was
launched with. A writer child is allowed when the repository is on the principal's allowlist and the
principal's team owns it or has it shared; there is no GitHub push permission to ask about, and each child
spawn takes the same launch guard as a direct service-principal agent run (the daily and in-flight
limits). The push policy, the path scopes and the security gate still bound the delivery. The principal's
`Idempotency-Key` is scoped to the principal. A principal cannot launch without a repository
(`400 REPO_REQUIRED`).

**The repository allowlist is the governance.** A principal-launched orchestration has no human behind
it, so its writers run with no `launchedById`: the worker uses the platform credential, never a
person's saved token, and no person's push permission is asked. What bounds them is the principal's
repository allowlist and its team's reach to that repository (re-checked at every child spawn and every
revive), the principal's own limits, the push policy, the path scopes and the security gate. Grant a
repository to a principal only when its token holder may change files there. `deliveryDefault` is a
ceiling only for MCP launches; a principal launches through REST, so it does not limit a principal's
writer, and a principal that launches without naming an `allowlist` gets the default list, which
includes the `implementer` (a writer-capable agent). A principal that must not run writers passes an
explicit allowlist of read-only agents.

**Waking or reviving one.** A message that starts a new orchestrator execution (a `WAITING` orchestration
woken, or a `COMPLETED` one revived) takes the same launch guard as a direct principal launch, in the
same transaction that reopens the orchestrator's ledger row: the principal must still be enabled with an
active team, the repository must still be on its allowlist and its team's, and it must be under its
in-flight and daily limits. A refusal answers like a launch refusal (`403`/`429` with the
`SERVICE_…` code), writes nothing and leaves the orchestration as it was.

**Stopping a runaway one.** Disabling the principal (or revoking its `runs:agent` tokens) stops new
spawns and ends the orchestration's authority to act, but it does not stop children that are already
running. To stop one now, an ADMIN cancels or ends the orchestration
(`POST /api/v1/orchestrations/:id/cancel` or `…/end`), which cancels its running children. That is open
to an ADMIN only for an orchestration no person launched (`serviceId` set, `launchedById` null); a
person's orchestration stays its launcher's alone. The audit entry carries the ADMIN as actor and
`adminStop: true` with `targetServiceId` naming the principal.

---

## 2. The conversation

The orchestration is a Temporal workflow, `orch-<orchestrationId>`, started by the launch with a
`signalWithStart` that carries the task as the first message. It is shaped like the in-app assistant's
conversation: a signal queue, one turn activity per batch of events, and `continueAsNew`.

### The orchestrator

`orchestrator` is a seeded, model-backed agent (default `anthropic/claude-opus-5-5`) with no workspace
tools and no MCP binding. It is not launchable as an agent run. Its four tools are bound in code, each
validates its input's shape and records the intent, and none holds a credential, a database handle or a
network client:

| Tool | Records |
|---|---|
| `spawnAgent` | A child to start: `agent`, `task`, `label`, `role` (`reader` or `writer`), and for a writer `deliver` and `pathScopes`. Optionally `maxSteps` |
| `messageAgent` | A steering message for a running child, by `childId` |
| `cancelAgent` | A cancel for a running child |
| `requestRepo` | A request that the launcher attach a repository: a `reason`, and optionally a `candidate` repository |

A turn takes at most 12 tool steps and records at most 16 intents; a second `requestRepo` in a turn is
refused. When the model stops calling tools, its text is posted as an `ORCHESTRATOR` message, and fixed
workflow code applies the recorded intents in order: a spawn, message or cancel is a call to the gateway
with the orchestration token (section 8), and a repository request becomes a confirmation card (section
5). A refusal is never retried; it becomes a `SYSTEM` notice carrying the gateway's code, and the
orchestrator is woken once to read it (at most three consecutive wakes that only a refusal caused).

### What the orchestrator reads

Each turn is one fresh message, assembled in fixed code, so its size is bounded however long the
conversation runs:

- the conversation: the newest 60 messages (hidden bookkeeping rows excluded), always including the
  launcher's first message, within 40,000 characters; child results are not repeated here;
- a state block: the title, the allowlist, the repository state (none, requested, attached), and the 40
  newest children with id, agent, role, status, label, and the path scopes a running writer holds;
- the finished children's results (section 3), within 24,000 characters;
- the new events, then fixed instructions.

### Events and turns

Signals feed one queue: a person's message, a child finishing, a repository decision, a write approval
decision, and an internal wake for refusal notices. Events that arrive together are **batched into one
turn**, and a child reported twice (by signal and by the backstop) is one event. A message that arrives
while a turn runs waits for the next one.

The turn and apply activities make a single attempt, because a retry would answer the same events twice
or start a child twice. A turn that fails writes a notice (`BUDGET_EXCEEDED`, `MODEL_UNPRICED`,
`MODEL_PRICE_UNAVAILABLE` or `TURN_FAILED`); a turn that cannot run at all (a timeout, a worker that died
past its heartbeat) writes `TURN_LOST`. Three failed turns in a row write `TURNS_FAILING`, after which
only a person's event starts another turn, so a failing turn cannot loop.

### Lifetimes

| Condition | Outcome |
|---|---|
| A child is running or an approval is pending | The workflow stays up and wakes every minute to reconcile children whose finish signal was lost |
| 30 minutes with nothing in flight and no event | The status becomes `WAITING` and the workflow ends. A later message from the launcher starts it again |
| `orchestration.maxWallClockSeconds` from launch | `COMPLETED` with a `LIFETIME_REACHED` notice; running children are cancelled, pushed branches stay |
| `orchestration.maxTurns` turns | `COMPLETED` with a `TURN_LIMIT_REACHED` notice, the same cleanup |
| The launcher cancels | `CANCELLED`; running children are cancelled |
| The launcher ends it | `COMPLETED`; a later message from the launcher starts it again |
| 50 turns in one execution | `continueAsNew`, carrying the queue and the counters |

The bounds are read from the settings once, at launch, and frozen into the workflow input, so an edit
reaches only later orchestrations and a replay never takes a different path. The turn count is durable:
every turn writes a hidden marker row before the model runs, so tool-only and failed turns count after a
worker restart. A restarted workflow resumes from history and reports any finished child no turn has read.

A message from the launcher to a `COMPLETED` orchestration revives it on the dashboard or the CLI (through
MCP the same message is refused with `409`; reviving an ended orchestration is not an MCP act), but the lifetime and the turn limit are measured from
launch, so one that ended on a limit ends again as soon as the message is taken up. A `CANCELLED` or
`FAILED` orchestration takes no message.

---

## 3. Sub-agents

A child is one agent run started by an intent. It has a **role**, a **label**, an agent, and a status:
`STARTING` (the ledger row exists), `RUNNING` (the run exists), then `COMPLETED`, `FAILED` or `CANCELLED`.

| | Reader | Writer |
|---|---|---|
| Delivery | `none` | `branch` or `draft_pr` |
| Path scopes | None | 1 to 20, required |
| Repository | Optional | Required (attached) |
| Launcher's GitHub push permission | Not checked | Checked live at every spawn |
| Where it runs | With a repository: a clone of the default branch, delivering nothing. Without: no workspace at all | A clone of the default branch, then the agent-run delivery path |

A reader cannot change anything outside its own container. A **repo-less** reader has no workspace: it
has no workspace tool whatever its `toolKeys` say, it runs only on the Mastra loop (an agent configured
for Claude Code or Pi fails with `AGENT_RUN_NEEDS_WORKSPACE`), and its tools are what the agent's own
definition grants of MCP, knowledge search and the browser.

The browser is the one thing a repo-less reader may have a container for. When the agent grants
`browser`, the child gets a throwaway container with no clone, no git configuration and no credential
of any kind (no GitHub token, model credential or MCP credential), used only to drive the browser. It
is made before the loop starts, on the deployment's configured workspace image (which must carry the
browser, as for [UI validation](./ui-validation.md)), counts as part of the run's own agent-run slot,
and is removed when the child ends, however it ends.

- **Hosts.** The browser reaches the team's own egress allowlist entries and nothing else: the global
  baseline (`workspace.egressBaselineAllowlist`: a code host, package registries) is not added. The
  worker's egress proxy admits exactly that list and the browser driver navigates to exactly that list.
  A team with no entries gets no browser.
- **Network.** Egress is always `restricted`, whatever the run's own policy says short of `blocked`, and
  the container is locked to the proxy's address alone, so it cannot reach the model proxy, the registry
  proxy or anything else. A child that has both MCP and the browser is allowed for that reason.
- **Docker only.** On the Kubernetes workspace backend cluster DNS stays reachable under the lock (see
  `workspace.egressPolicy`), and script in a page can put data into a DNS lookup that never passes the
  proxy, so no scratch browser is made there.
- **Schemes.** `browser_navigate` opens `http` and `https` URLs, and `about:blank`. `file:`, `chrome:`,
  `view-source:`, `javascript:`, `ftp:`, `data:` and `blob:` are refused with a tool error before any
  navigation, and the browser driver refuses them again itself. In this container the driver also
  refuses `data:` and `blob:` page resources.

The trace records `agent.browser_egress` with the number of allowed hosts when the container is ready.
Where this cannot be enforced (the run's policy is `blocked`, the worker has no egress proxy, the team's
allowlist is empty, the workspace backend is Kubernetes, the network lock fails, the image has no
browser, or the container cannot be created) no container is made, the child runs without a browser and
the trace records `agent.browser_unavailable` with the reason. It never falls back to open egress.

### How a child starts

The worker's apply activity calls `POST /api/v1/orchestrations/:id/children` with a per-call orchestration
token and the intent. The gateway is the authority. It validates in this order and stops at the first refusal:

1. The orchestration is `ACTIVE` or `WAITING` and `orchestration.enabled` is on (`ORCHESTRATION_NOT_ACTIVE`).
   A retried spawn (the same turn key) is answered with the child its first attempt started, before any
   other check.
2. The agent is on the allowlist exactly as written and still launchable (`CHILD_NOT_ALLOWED`).
3. Role rules: a writer needs an attached repository (`REPO_REQUIRED`), `deliver` of `branch` or
   `draft_pr`, and valid scopes; a reader has neither (`ROLE_RULE_VIOLATED`).
4. Scopes (writers): the grammar below, then the shared-file rule, then the width limits, then overlap
   with running writers (`SCOPE_OVERLAP`).
5. Width, against the bounds frozen at launch: `orchestration.maxChildren` children in total, finished
   ones included; `orchestration.maxConcurrentChildren` starting or running at once;
   `orchestration.maxWriterChildren` writers in total (`CHILD_LIMIT`).
6. The agent's MCP connection, if any, is in the launch-time set (`CONNECTION_NOT_IN_SET`).
7. The agent-run launch path, as the launcher: repository authorisation, the push-permission check for a
   writer (`PUSH_PERMISSION_REQUIRED`), the agent-run ceilings (a `maxSteps` above the ceiling is clamped,
   not refused; the answer carries `clamped.maxSteps` and the worker writes a fixed `MAX_STEPS_CLAMPED`
   `SYSTEM` notice with that number, so the next turn knows), and the concurrency decision (`AGENT_RUN_CONCURRENCY_EXCEEDED`), charged to the
   repository's owning team once a repository is attached and to the named team before.
8. A transaction under a row lock on the orchestration repeats the width and overlap checks and writes the
   child, so two concurrent spawns cannot both pass. A start that fails leaves no child row.

A malformed intent is `422 INVALID_INTENT`. Every refusal writes an audit entry and, on the worker side,
a notice the next turn reads. A run an orchestration started cannot be re-run
(`409 ORCHESTRATION_CHILD_NO_RERUN`); the orchestrator starts another instead.

### The result contract

A finished child yields one `ChildResult`: `status` (`COMPLETED`, `FAILED` or `CANCELLED`), a redacted
`summary` (the agent's final text, up to 20,000 characters; a text that spilled to an artifact is read
back, bounded), `filesChanged` (path and line counts), `branch`, `prUrl` (an `https` URL only), the gate
verdict, `stoppedReason` and `costUsd`. It is stored on the child and a `CHILD_RESULT` message marks it in
the transcript. A run output that breaks the contract becomes a `FAILED` result that names the fields,
never the values, with a `CHILD_RESULT_INVALID` notice.

The orchestrator receives it **only as quoted data**:

- the result is rendered as text of at most 4,000 characters: the summary, then the branch, pull request,
  up to ten changed files, the gate verdict, the stop reason and the cost;
- the text is screened line by line with the memory guard's injection patterns. A matching line is
  replaced with a marker; a scan that cannot finish, or a match that spans lines, withholds the whole
  text. Either writes a `RESULT_SCREENED` notice once per child;
- the text is fenced in `<child-result id="…" agent="…" status="…">`, with every `<`, `>` and `&`
  written as an entity and control, invisible and bidi characters dropped, so nothing inside can close
  or reopen the fence.

Results are shown on every turn, because the orchestrator holds no state between turns. Results it has
not read come first, in full, oldest first, within the 24,000-character budget; the first is always shown
whole, so a turn always makes progress. One that does not fit becomes a one-line digest marked as
deferred and wakes the orchestrator again, so it comes in full on the next turn. Results already read
take what budget is left, newest first, and otherwise appear as a digest (status, branch, pull request).

### Path scopes

A writer's `pathScopes` are a small grammar, validated by one pure function in `@auto-swe/shared`:

| Form | Example | Covers |
|---|---|---|
| Subtree | `src/lib/**` | Everything under a directory. `**` is only allowed as the whole last segment, with a directory in front of it |
| Directory glob | `src/*.ts`, `src/*` | The files directly in one directory; the glob is `*` or `*.ext` (dotted suffixes allowed) |
| Exact file | `src/lib/retry.ts` | One file |

Refused: an empty scope, whitespace, a backslash, a leading `/`, an empty or `.` or `..` segment, a
drive-looking prefix, a wildcard outside the last segment, any other wildcard form, a control or invisible
character, more than 200 characters, more than 20 scopes. Scopes are normalised to Unicode NFC.

**Shared files have one owner.** A scope that names a lock file, the root `package.json` or an index
barrel (`index.ts`, `__init__.py`, `mod.rs` and the like) is accepted only while no other running writer
holds one (`SCOPE_OVERLAP`). A directory glob counts if it could match such a file (`src/*.ts` could
match `src/index.ts`); a subtree never does.

**Overlap is decided conservatively.** Two scopes overlap when one's directory is a prefix of the other's,
when two globs in a directory could match the same name, or when either cannot be classified. Comparison
folds case. A writer's own scopes must be disjoint from each other. Only writers in `STARTING` or
`RUNNING` reserve scopes, so a finished writer's paths are free for the next one. The state block shows
the orchestrator which paths are held.

**The push policy enforces them.** The deterministic push policy of the agent-run delivery
([agent-runs.md](./agent-runs.md#41-the-push-policy-and-the-gate)) runs a path-scope rule after the
sensitive-file and size rules and before the diff-size bound and the gate: any changed path outside the
run's scopes fails the run with `AGENT_RUN_PATH_OUT_OF_SCOPE`, deletions and both sides of a rename
included, and nothing is pushed. A path it cannot vouch for (not NFC, a control character, a backslash,
`..`) is out of scope. A delivering child with no scopes fails the same way. A run no orchestration
started and with no scopes is unaffected. A follow-up round on a writer's pull request keeps the scopes
and binds no MCP tool.

### One branch and one draft pull request per writer

Each writer is an ordinary delivering agent run: its own `agent-<id>` ticket, the branch
`<BRANCH_PREFIX>/agent-<id8>`, the gate, the push, and a draft pull request when `deliver` is `draft_pr`.
Writers do not share a branch and cannot see each other's changes, since each clones the default branch.
The orchestration page lists the pull requests together as a group, with each one's branch, link and CI
status when known. The platform never merges them, and conflicts between sibling pull requests are for
the people who review them.

### Concurrency and budgets

Three bounds apply to concurrency: `orchestration.maxConcurrentChildren` per orchestration, and the
agent-run limits `workspace.agentRunMaxConcurrentGlobal` and `workspace.agentRunMaxConcurrentPerTeam`
for the team the child bills. Each child has the agent-run step and wall-clock ceilings
(`workspace.agentRunMaxSteps`, `workspace.agentRunMaxWallClockSeconds`) and the tier's token caps on its
own ledger row.

The detail view's `budget` reports what the orchestration has used of its tier's token cap, the
orchestrator's own ledger row and every child's together: `tokens` (`used`, `cap` and `kind`, `input` or
`output`, whichever cap is nearer) and `percentUsed`, an integer. The input side counts what a run's own
cap counts, cache reads and writes at their cost-equivalent. `monthlyRemainingUsd` is the smallest amount
left under any monthly USD budget among the teams and organisations that bill the orchestration: the
named team and its organisation, and, once a repository is attached, the repository's owning team and its
organisation, because children bill them. It is month to date including runs in flight, floored at zero,
and null when none of them sets a budget. `remainingUsd` is deprecated and always null (it once carried
the tier's USD estimate); read `monthlyRemainingUsd`. The header reads "N% of the
Standard budget used" (the tier's name), with the exact token counts on hover, and "remaining $X this month" when
`monthlyRemainingUsd` is set.

### Split ownership after an attach

The orchestrator's own spend and settings stay with the named team. Every child started after a
repository is attached pins its settings, bills, and counts toward concurrency under the repository's
**owning** team. Readers started before the attach were repo-less and bill the named team.

---

## 4. Steering

Only the launcher steers. Every message is recorded in the transcript.

| Target | Path | Delivered |
|---|---|---|
| The orchestrator | `POST /api/v1/orchestrations/:id/messages` signals the workflow | At the next turn |
| A child, by the launcher | `POST /api/v1/orchestrations/:id/children/:childId/messages` writes a steering message for the run | At the child's next step (Mastra), tool batch (Claude Code) or turn (Pi) boundary |
| A child, by the orchestrator | `messageAgent` applies the same write through the gateway | At the child's next step (Mastra), tool batch (Claude Code) or turn (Pi) boundary |

A message to a child needs a child that is `STARTING` or `RUNNING` and has a run (`409
CHILD_NOT_ALLOWED` otherwise). When the launcher steers a child, the orchestrator is told, so its picture
stays coherent; a child's reply to a steer is its eventual single result.

**Delivery on the Mastra loop.** A hook before each step takes the run's undelivered messages, at most
20, appends them to the history as one block, marks exactly those delivered after they are in the
history, and records an `agent.steered` trace event. The block is a heading and one line per message:

```text
message 1 | from: launcher | text: "Skip the cache layer."
message 2 | from: orchestrator (not the launcher) | text: "Also check the retry budget."
```

The `from` label comes only from the stored author (a message with an author is the launcher's, one
without was written by the orchestrator's tool, which a prompt-injected model can drive). The body is a
JSON-quoted string on that one line, so it cannot start a line of its own. The quoted, escaped string is
capped at 2,000 characters (a body of control characters, which cost six characters each when escaped,
is cut sooner), and one drain takes at most 20 messages and 16,000 characters in all. When the caps
leave messages behind, the block ends with a `(+N more messages queued; ...)` line and they arrive at
the next boundary. The body is NFKC-normalised first, text that imitates the envelope or a provenance
label is replaced, and zero-width characters are written as `\uXXXX` escapes. That replacement is
defence in depth: the provenance rests on the quoted single-line envelope and on `from` coming from
the stored author.

**Delivery on Claude Code and Pi.** A harness child takes a message at a boundary, as the same block of
lines. Each records an `agent.steered` event. Steering text is data the model reads: it never reaches the
policy that decides each tool call.

Harness delivery is **at most once**. The rows are claimed with a per-row compare-and-set (`deliveredAt`
from null to now) and only the rows the claim won are handed over, so two processes, or a retried attempt
of the same activity, cannot both inject one message. The claim comes first, then the hand-over, so a
message is lost if the run ends before the model's next request. The dashboard's "delivered" means
handed to the harness, not that the model acted on it.

- **Claude Code** receives it as the `additionalContext` of the `PostToolBatch` hook, which fires once
  per batch of tool calls, after the last has resolved and before the next model request (parallel calls
  cannot race for it). A hook that fires inside a sub-agent the child started (`agent_id` set) takes
  nothing, so a message is never put into a sub-agent's context. A reply with no tool call has no batch,
  so it sees nothing until a later batch.
- **Pi** asks for steering messages after every turn, a text-only reply too, and its loop goes on while
  a message is pending, so the child answers it. Each such turn counts toward `maxTurns`: once the cap is
  reached Pi hands over nothing more and the run ends there, with any message still queued.

A message that arrives after the child's last boundary stays queued and is shown as not delivered, and
the launcher's remedy is to cancel the child.

---

## 5. Attaching a repository

A repo-less orchestration can ask for a repository, and only a person can attach one.

1. The orchestrator records `requestRepo` with a reason and optionally a candidate. The apply step checks
   that the orchestration has no repository, has a launching person, and has no request already waiting;
   it drops a candidate the launcher cannot reach (membership of the owning or a shared team), with no
   sign of why. It posts an `ATTACH_REQUEST` message.
2. The dashboard shows a confirmation card with the reason, the candidate's name and billing team (only
   if the viewer can reach that repository), and the delivery default.
3. The launcher answers with `POST /api/v1/orchestrations/:id/attach` and `{ "repoId": "…" }`, or declines
   with `POST /api/v1/orchestrations/:id/attach/decline`. The launcher may attach any repository they can
   launch against; it need not be the candidate.

The attach route is launcher-only, refuses the orchestration token and the in-app assistant, and runs the
**full agent-run launch authorisation at that moment** (membership, GitHub permission under the access
gate, organisation cap, approved repository host). The request is resolved exactly once: the request
message is locked, and the repository is set with a compare-and-set on a null `repoId`, in one
transaction. If the workflow cannot be told, the attach is undone so the person can try again, unless a
child is already running against the repository (then the attach stands and the route answers
`502 ATTACH_SIGNAL_FAILED`; the orchestrator sees the repository on its next refresh).

A repository is attached **at most once**: a second attach is `409 REPO_ALREADY_ATTACHED`, and an
orchestration launched with `repoId` is already attached. A declined request can be asked again. From the
attach on, writers become possible and split ownership applies (section 3).

---

## 6. MCP write approval

Children can use MCP tools, but a write never runs on the model's say-so.

**Classification.** A call is **read-only** only when the tool lists `readOnlyHint: true` on its own, on a
connection in the orchestration's fixed set. A missing, inherited or malformed annotation is a write, and
so is anything that cannot be read. A connection outside the set is refused whatever the tool says.

**The approval.** A write does not run until the launcher approves that one call:

1. The tool wrapper opens an approval (`PENDING`) with a **digest of the arguments** (names, types and
   sizes, never the values) and an `APPROVAL_REQUEST` message. The dashboard shows the tool, the
   connection and a countdown.
2. It waits, heartbeating, for a decision or for `orchestration.approvalTimeoutSeconds` (default 600).
3. The launcher approves or denies with `POST /api/v1/orchestrations/:id/approvals/:approvalId` and
   `{ "decision": "APPROVE" | "DENY" }`, or with `auto-swe orchestrate approve|deny`. The decision is a
   compare-and-set on a pending, unexpired approval (`409 APPROVAL_NOT_PENDING` otherwise).
4. A denial, an expiry, a run that stops while it waits, and any failure to find out all return a tool
   error to the agent and never run the call. The error tells the agent not to retry.

**Retries.** An approval names one call: the run, the tool, the canonical arguments and the call's ordinal
among identical ones. A retried activity finds its own decision instead of opening another. The call's
outcome is recorded with it, so a retry returns the recorded result and never executes an approved write
twice; if an earlier attempt died mid-call, the write is not run again.

**No approver.** An orchestration launched by a service principal has no person to approve, and a principal
cannot call the approval route, so every write is denied at once.

**Screening is forced on.** For an orchestration's agents, every MCP result is scanned for prompt
injection whatever the connection's own setting says, since a result is untrusted data entering a run that
can write. The same guard sits on the Mastra wrapper and on the relay Claude Code and Pi both call
through. The orchestrator has no MCP binding of its own. A child that continues a writer's pull request
after review feedback binds no MCP tool at all.

---

## 7. Identity and visibility

**Everything acts as the launcher.** The orchestration's `launchedById` is the launcher, and every child
run sets its launcher to that person: with `github.userCredentialsEnabled` on, their saved GitHub token
stands in for the platform credential, subject to the host allowlist
([user-github-credentials.md](./user-github-credentials.md)). A credential is never keyed on the request's
`requestedById`.

**Launcher-only acts.** Messaging the orchestrator or a child, attaching or declining a repository,
approving or denying a write, cancelling a child, cancelling the orchestration and ending it. Each
answers `403 NOT_LAUNCHER` to anyone else, an ADMIN included, with one exception: an ADMIN may cancel
or end an orchestration that has no human launcher, as an emergency stop (section 1, Service
principals). The in-app assistant may launch an
orchestration or send a message only behind the person's confirmation, and is refused the rest outright.

**A launching principal controls its own.** For an orchestration launched by a service principal the
launcher is that principal: a token with `runs:agent` whose principal id is the orchestration's
`serviceId` may message the orchestrator or a child, cancel a child, cancel the orchestration, end it,
and read the list, the detail, the transcript and `canControl` (true for it). Those routes declare
`serviceScopes: ['runs:agent']`, and the token is re-checked on every request (scope held, unrevoked,
unexpired with an expiry, principal enabled, team and organisation active). A principal sees only the
orchestrations whose `serviceId` is its own; another principal's, or a person's, is `404`, and a person
who is not the launcher gets `403 NOT_LAUNCHER` on a principal's orchestration. A principal's messages
have no author and its id is on the audit entry, with no actor; a steering message it sends a child
carries the principal's id, so the child reads it as the launcher's word (a steering row with neither an
author nor a principal id is the orchestrator's, which the child is told is not the launcher). A
principal reads repository-derived data of its own orchestration only while it still reaches the
repository (the repository on its allowlist and owned by, or shared for launching with, its team): once
that ends the data is redacted as for any viewer without reach. Attaching, declining, approving, the
event stream and the connection list refuse a principal (`401 SERVICE_TOKEN_NOT_ALLOWED`).

**Who can watch.** The launcher, the members of the named team and ADMINs; anyone else gets `404`. They
see the same page read-only.

**A repository can belong to another team.** After an attach, the repository's team need not be the named
team, so seeing the orchestration does not mean seeing the repository. For a viewer who is neither the
launcher nor an ADMIN and cannot reach the repository (membership of its owning or a shared team):

- every orchestrator message, and every system notice from the moment of the attach, is replaced with a
  fixed "withheld" body, because the orchestrator writes after reading full child results and a notice
  can quote repository data;
- a child's result, branch, pull request link and path scopes are withheld, and so is the repository's
  name and its owning team's name in the billing view;
- the launcher's and users' own words, and everything written before the attach, are served as written;
- per-turn bookkeeping rows are never served to anyone.

Children's own runs appear under the normal run-visibility rules.

**Audit.** Launch, spawn, spawn refusal, steer, attach, decline, approval, cancel and end each write an
audit-log entry on the `Orchestration` entity with the actor.

---

## 8. The orchestration token

The worker cannot be the launcher, so it presents a token of its own when it applies intents. The worker
mints a fresh token for **every** gateway call: it lives two minutes, and no token is ever placed in the
workflow's input, its carried state, an activity's input or result, or Temporal history. A token is
`orch_` + `base64url(payload)` + `.` + `base64url(HMAC-SHA256)`, so it is never mistaken for an API token,
a PAT or an assistant token. The HMAC key is an HKDF-SHA256 subkey of `CONFIG_ENCRYPTION_KEY` (purpose
`auto-swe/orchestration-token/v1`), the same construction as the transcript download links. The payload
carries the key version, the orchestration id, issue and expiry times and a random id, and nothing about a
person or a principal: the gateway derives who acts from the orchestration's row on every request.

Verification runs in this order: the prefix and shape; the key version the token names (a version the
process holds no key for is refused, and during a key rotation the previous key verifies tokens minted
under it); the HMAC, compared in constant time; the claims; the lifetime (a token whose own lifetime
exceeds five minutes, or whose expiry is more than five minutes ahead, is refused even when correctly
signed); then expiry. A refusal at any of these is `401`.

- **Three routes only.** `requireAuth` admits it on `POST …/children`, `POST …/children/:childId/messages`
  and `POST …/children/:childId/cancel`, and only for the orchestration named in the path. Anywhere else
  it answers `403 ORCHESTRATION_TOKEN_NOT_ALLOWED`. A person's session on the spawn route answers
  `403 ORCHESTRATION_TOKEN_REQUIRED`: children are started by the orchestrator. A token minted for one
  orchestration is refused for another.
- **Acts as the launcher** the orchestration's row names, with their *current* role, like any other
  credential. A deactivated person, or a principal that is disabled, whose team or organisation is
  inactive, or that no longer holds a live `runs:agent` token with an expiry, ends the orchestration's
  authority to act.
- **Revoked with the orchestration.** Every admission re-reads the status, so a token is refused the
  moment the orchestration is no longer `ACTIVE` or `WAITING`. Cancelling or ending the orchestration
  therefore revokes it at once; the gateway cancels children *before* flipping the status, while the token
  still works.
- **Never recorded.** A token is not logged, stored in the database, returned in a response or written to
  an audit row. The worker masks any `orch_` value in an error before it reaches a log or a notice.
- **Replay inside the window is not prevented.** The payload carries a random id (`jti`), but the gateway
  mints no record of it and checks none: a token captured in transit can be presented again, any number of
  times, until it expires. What a captured token can do in that window is what any token can: call the three
  routes above for **its one orchestration** while that orchestration is `ACTIVE` or `WAITING`, as the
  launcher's current standing allows (every spawn still passes the allowlist, caps and path-scope checks).
  It cannot reach another orchestration or any other route, and it dies with the orchestration. Its
  lifetime is two minutes as minted, and a token claiming more than five minutes is refused even when
  correctly signed, so five minutes is the hard cap on a capture's usefulness.
- **The signature has one spelling.** The gateway accepts only the exact canonical base64url of the 32-byte
  MAC (43 characters, no padding, no extra characters) and the exact canonical encoding of the payload, so
  one valid token has one valid form.

---

---

## 9. API reference

All routes need a signed-in user (a service principal holds no role and is admitted only where the table says
"or its principal"). Visibility is section 7. Orchestration refusals answer
`{ "code", "error": { "code", "message" }, "message" }`; other errors use the gateway's
`{ "error": { "code", "message" } }`.

| Route | Who | Notes |
|---|---|---|
| `POST /api/v1/orchestrations` | A person, or a principal with `runs:agent` | Section 1. `201`, or `200` for a replayed key. `403 ORCHESTRATION_DISABLED`, `400 TEAM_REPO_MISMATCH`, `400 CONNECTION_NOT_OWNED`, `409 RUN_CONFLICT`, `400 ALLOWLIST_REQUIRED`. The answer carries `allowlist`, the one applied |
| `GET /api/v1/orchestrations` | Viewers, or a principal (its own only) | `limit` (1 to 100, default 25), `offset`, `status`, `teamId`. The repository's name is withheld from a viewer who cannot reach it |
| `GET /api/v1/orchestrations/defaults?teamId=` | Members of the team | `{ "data": { "allowlist": [...] } }`: what a launch with no allowlist would apply for that team, filtered to launchable agents that exist |
| `GET /api/v1/orchestrations/connections?teamId=` | Members of the team | The team's active MCP connections, by id and name |
| `GET /api/v1/orchestrations/:id` | Viewers, or its principal | Status, allowlist, connections, children, pending approvals, the pending repository request, spend split, budget readout, and `canControl` |
| `GET /api/v1/orchestrations/:id/messages` | Viewers, or its principal | The transcript, oldest first. `after` (opaque cursor from `next`), `limit` (1 to 200, default 100) |
| `GET /api/v1/orchestrations/:id/events` | Viewers | A server-sent stream of `message`, `child` and `status` events, `: ping` heartbeats every 15 s. Polled server-side every 1.5 s; the viewer's access is re-checked every 60 s (`done` with reason `access`); ends after 16 minutes with a `done` event; at most 4 concurrent streams per user (`429 TOO_MANY_STREAMS`). Resumable: see Event ids and resuming (section 11) |
| `POST /api/v1/orchestrations/:id/messages` | Launcher, or its principal | `{ "body" }` (1 to 4,000 characters). `201`. `409 ORCHESTRATION_NOT_ACTIVE` once cancelled or failed |
| `POST /api/v1/orchestrations/:id/children/:childId/messages` | Launcher, its principal, or the orchestration token | Same body. `409 CHILD_NOT_ALLOWED` for a finished child or one with no run yet |
| `POST /api/v1/orchestrations/:id/children` | Orchestration token only | Body `{ "intent", "turnKey" }`. Section 3. `200` for a retried turn, `422 INVALID_INTENT`, `409` with a refusal code |
| `POST /api/v1/orchestrations/:id/children/:childId/cancel` | Launcher, its principal, or the orchestration token | `409 CHILD_NOT_ALLOWED` for a finished child; `502 TEMPORAL_CANCEL_FAILED` |
| `POST /api/v1/orchestrations/:id/attach` | Launcher | `{ "repoId" }`. Section 5. `409 NO_PENDING_ATTACH`, `409 REPO_ALREADY_ATTACHED`, `502 ATTACH_SIGNAL_FAILED` |
| `POST /api/v1/orchestrations/:id/attach/decline` | Launcher | `409 NO_PENDING_ATTACH` |
| `POST /api/v1/orchestrations/:id/approvals/:approvalId` | Launcher | `{ "decision": "APPROVE" \| "DENY" }`. Section 6. `409 APPROVAL_NOT_PENDING` |
| `POST /api/v1/orchestrations/:id/cancel` | Launcher, or its principal | Sets `CANCELLED`, cancels the running children and the workflow, and answers `{ childrenCancelled, failed, status }` |
| `POST /api/v1/orchestrations/:id/end` | Launcher, or its principal | Cancels the running children, then sets `COMPLETED`. If a child cannot be cancelled it answers `502 CHILD_CANCEL_FAILED` and leaves the status unchanged, so the orchestrator can still cancel the survivors |

Refusal codes the spawn, message, cancel and attach routes use: `CHILD_NOT_ALLOWED`, `CHILD_LIMIT`,
`SCOPE_OVERLAP`, `PUSH_PERMISSION_REQUIRED`, `REPO_REQUIRED`, `CONNECTION_NOT_IN_SET`,
`AGENT_RUN_CONCURRENCY_EXCEEDED`, `ORCHESTRATION_NOT_ACTIVE`, `ROLE_RULE_VIOLATED` and
`REPO_ALREADY_ATTACHED`. All answer `409`, the concurrency refusal included.

### MCP tools

Over the [MCP server](./mcp-server.md), as the signed-in user:

| Tool | Route |
|---|---|
| `orchestrations_list` | `GET /api/v1/orchestrations` |
| `orchestrations_get` | `GET /api/v1/orchestrations/:id` |
| `orchestrations_messages` | `GET /api/v1/orchestrations/:id/messages`, optionally waiting for a new message |
| `orchestrations_launch` | `POST /api/v1/orchestrations` |
| `orchestrations_message` | `POST /api/v1/orchestrations/:id/messages`, or the child route when `childId` is given |

The three reads return identifiers, enums, numbers and clipped text, never a payload, an approval's
argument digest, a run or workflow id, the allowlist or the connection set. The two writes take the MCP
write guards: `mcp.writeToolsEnabled`, the per-minute `mcp.writeCallsPerMinute`, and the in-flight cap
`mcp.maxConcurrentRuns`. A launch through MCP is always `STANDARD` tier, has no connection set (`connectionIds` is refused),
requires `idempotencyKey`, and is refused when `deliveryDefault` is outside
`mcp.agentRunAllowedDeliverModes`; its writers' delivery is held to that setting and to the launch's
`deliveryDefault` (section 1).

Children of an MCP-launched orchestration count against the launcher's `mcp.maxConcurrentRuns` cap. An
idle (`WAITING`) or ended orchestration is not an in-flight run for that cap or any other. A bridged
launch refuses `connectionIds`, so an MCP-launched orchestration has no MCP connection set. Three of the
seven routes that declare the MCP write scope across the platform are orchestration routes (launch,
message, child message). A message through MCP to a `COMPLETED` orchestration is refused (`409`). A message
through MCP to a `WAITING` orchestration starts its workflow again, so it takes the same cap as a launch: in
one transaction under the launcher's per-user lock the orchestrator's ledger row is reopened and the
launcher's runs in flight are counted, and at `mcp.maxConcurrentRuns` the message is refused (`429`
`MCP_RUN_CAP_REACHED`) with the row left closed; the signal is sent only after the transaction commits, and a
failed signal puts the row back. The reopen also re-reads the orchestration's status under its row lock, so
a concurrent cancel never leaves a cancelled orchestration holding a slot. Dashboard and CLI messages carry
no cap.

A message through MCP, to the orchestrator or to a child, is also held to the live
`mcp.agentRunAllowedDeliverModes`, whichever way the orchestration was launched: when its `deliveryDefault`
(none if unset) ranks above the highest mode that setting allows (order `none`, `branch`, `draft_pr`), the
message is refused with `403` `MCP_DELIVER_MODE_NOT_ALLOWED`. Reads are unaffected.

For a viewer who cannot reach the attached repository, an agent's label is shown as `Agent <n>` (its
creation order), because the orchestrator wrote it after reading the agent's full result.

**No MCP tool attaches or declines a repository, approves or denies a write, or cancels or ends an
orchestration.** Those are the launcher's acts on the dashboard and the CLI (`attach`, `decline`,
`approve`, `deny`, `cancel-agent`, `cancel`, `end`), and a test fails if a tool reaches one.

---

## 10. Settings

All are in the setting registry and ADMIN-only. All are GLOBAL only except `orchestration.defaultAllowlist`, which an organisation may override. None is run-pinned, because an orchestration
has no workflow run to pin on; the gateway freezes the bounds into the workflow input at launch instead.
[configuration.md](./configuration.md) lists them with their read points.

| Key | Default | Meaning |
|---|---|---|
| `orchestration.enabled` | off | Kill switch for launching, messaging and spawning. Turning it off does not stop children already running |
| `orchestration.defaultAllowlist` | `implementer`, `reviewer`, `planner`, `securityReviewer`, `domainLogicReviewer`, `performanceReviewer` | The agents a launch with no allowlist may start. Read at launch only; entries that are not launchable (the orchestrator included) are refused on save, and entries with no active agent at launch are dropped. `implementer` is the one seeded default that can change files (`writeFile` or `bash`); an organisation override of another default can make it write-capable, which `writeCapable` reports |
| `orchestration.maxChildren` | 12 | Children one orchestration may start over its lifetime, finished ones included |
| `orchestration.maxConcurrentChildren` | 4 | Children running at once in one orchestration |
| `orchestration.maxWriterChildren` | 4 | Writers per orchestration, finished ones included; each opens its own pull request |
| `orchestration.maxTurns` | 200 | Orchestrator turns per orchestration |
| `orchestration.maxWallClockSeconds` | 14,400 | Lifetime from launch, 60 to 14,400 |
| `orchestration.approvalTimeoutSeconds` | 600 | How long an MCP write waits for the launcher, 30 to 3,600; a timeout is a denial |

---

## 11. Observability

- **Transcript.** `GET /api/v1/orchestrations/:id/messages` serves the conversation: the launcher's and
  the orchestrator's messages, `CHILD_RESULT` markers, `ATTACH_REQUEST` and `APPROVAL_REQUEST` cards,
  and system notices with a stable code in their payload (refusals, `RESULT_SCREENED`, `TURN_FAILED`,
  `LIFETIME_REACHED` and the like).
- **Children.** Each child has its own run, run viewer, traces and transcripts, unchanged. The
  orchestration page links to it and shows a lane per child: agent, role, scopes, status, elapsed time,
  spend, undelivered steering, a message box and cancel.
- **Traces.** The orchestrator's turns are *runless* traces keyed by the workflow id (`llm.orchestrator`
  spans), as the in-app assistant's are; a runless transcript is readable by ADMIN only
  ([transcripts.md](./transcripts.md)). A child's trace carries `agent.steered`,
  `mcp.write_approved`, `mcp.write_denied` and
  `agent.browser_unavailable` events where they apply.
- **Spend.** The detail view splits spend into the orchestrator's own turns, its children, and the total,
  and names the team each part bills: the named team for the orchestrator, the repository's owning team
  for children once attached. Orchestrator turns debit the named team's ledger and the organisation's
  USD cap as any model call does; a model with no catalog price stops turns while a USD cap is set.
- **Budget.** The header shows the share of the tier's token cap used by the orchestrator and its
  children together, and the monthly USD left when the team or organisation has a budget (section 3).
- **Dashboard.** The orchestration page is two columns, Conversation and Agents, on a wide screen and
  two tabs on a narrow one. Only the launcher sees the message boxes, the attach card's buttons and
  the approval buttons. While the orchestration is live the page follows the event stream (below) and
  patches `child` events (cost included) straight into what it shows; it re-reads the detail only after
  a `status` event, a new child or a change of a child's status, run or result (once, debounced by 1.5 s),
  and otherwise at most once per 15 s while a number is moving. It shows how updates arrive, in words beside the status: `Live` (the stream delivers; the page re-reads
  only every 30 s as a safety net), `Connecting…` or `Reconnecting…` (re-reading every 3 s while the
  stream is rebuilt, with exponential backoff and jitter), or `Updating by polling` (the stream is
  unavailable; re-reading every 3 s). The indicator is not a live region, so a screen reader is not
  interrupted by connection changes. The page falls back to polling when the stream answers an HTTP
  error or a 429, when a proxy answers something other than `text/event-stream`, or when 45 s pass
  without a byte (the gateway pings every 15 s); it tries again later, and stops trying after three
  answers that are not an event stream until the tab is hidden and shown again. A hidden tab closes
  the stream (freeing one of the user's four slots) and a returning tab re-reads once and reconnects
  from the last event id. When the orchestration finishes the stream is closed and the transcript is
  read once more, so the closing messages are not missed.
- **CLI.** `orchestrate start --wait` and `orchestrate messages --follow` read the same stream and
  print what polling would: `role: body` lines, `[STATUS]` on stderr, pending requests once. They fall
  back to polling every 3 s when the stream is unavailable or has failed five times in a row without
  progress, continuing from the stream's cursor, so no message is printed twice or skipped. The first
  Ctrl-C closes the stream and exits 130, whether the CLI is reading, waiting out a reconnect backoff or
  fetching the detail. The web client and the CLI share one parser (`@auto-swe/shared/lib/sse`) that
  refuses a line over 256 KiB or an event over 1 MiB, which both treat as a failed connection.

### Event ids and resuming

The stream opens with `retry: 3000`. Every `message`, `child`, `status` and `done` event carries
`id:`, the transcript cursor at that point: the same opaque value `GET /:id/messages` returns as `next`.
A client resumes with the `Last-Event-ID` header (or `?after=` where it cannot set one; when both are
present the header wins, because an `EventSource` keeps its original URL on reconnect and adds the
header); the server replays only the messages after that cursor, in order, and an invalid cursor is `400 INVALID_CURSOR`
before any stream opens. Hidden marker rows move the cursor but are never sent, and redaction applies on
every poll, a resumed stream included. `child` and `status` are state rather than history: every new
stream, resumed or not, opens with the current snapshot of each, and a client folds them into what it
holds. A client that reconnects after the 16-minute `done` event resumes from that event's id; see the
cursor caveat under Limitations for when that is not gapless. Access is re-checked every 60 s while the
stream is open: a viewer who is no longer allowed to see the orchestration (removed from the team, say)
receives a final `done` event with `{"reason":"access"}` and the stream closes. A client that
disconnects while the stream is still opening is never given a slot or polled. A `429 TOO_MANY_STREAMS` is refused before any stream opens and counts nothing against
the user, so a client polls and tries again after a slot frees.

---

## Limitations

- **Starting a workflow is not enough to drive an orchestration.** The orchestration activities (begin, turn,
  apply, refresh, status, cancel-children) refuse, non-retryably, unless the workflow that scheduled them
  has the id `orch-<orchestrationId>` of the orchestration they name. Temporal start access on the task
  queue therefore no longer lets someone run an orchestration they chose, under an id of their choosing or
  another orchestration's id. The check lives in the activities, not the workflow, so replaying histories
  recorded under other ids stays deterministic. It does not stop someone who can start the workflow
  under the right id, which the gateway itself does, and an activity called outside any workflow is not
  judged.
- **A compromised worker can mint orchestration tokens.** The worker holds `CONFIG_ENCRYPTION_KEY`, which
  the token key derives from, so a compromised worker can mint a token for any orchestration. Such a token
  stays scoped to the child spawn, message and cancel routes, is refused unless that orchestration is
  `ACTIVE` or `WAITING` and its launcher is still allowed to act, and every spawn still passes the
  gateway's allowlist, caps and path-scope checks. The worker already holds the key that decrypts every
  stored provider credential, so the token adds no authority beyond what that process has.
- **A repo-less child's browser needs the egress proxy, restricted egress and the Docker backend.**
  Without the worker's egress proxy, with a `blocked` run policy, with an empty team allowlist or on the
  Kubernetes backend the child runs without a browser and records `agent.browser_unavailable`. It also
  needs the configured workspace image to carry the browser, and it has no app preview (there is no
  repository to start one from). Repo-less children run only on the Mastra loop.
- **A child with MCP and the browser can still place data in a URL.** The browser is held to the team's
  allowlist and to `http`/`https`, but data a child read through MCP can be put in a URL on a host the
  team allowlisted, which that host then receives, as with any allowlisted egress. The allowlist bounds
  where it can go, not what.
- **A child takes a steering message only at a boundary.** A Mastra child takes it at its next step, a
  Claude Code child after its next batch of tool calls and a Pi child after its next turn, never within
  one. Harness delivery is at most once: a message is lost if the run ends before the model's next
  request. A Pi child stops taking steering at its turn cap, and a message that arrives after the last
  boundary stays queued; the only remedy is to cancel the child.
- **The tier budget is a readout, not a pooled limit.** The percentage sums the orchestrator's and every
  child's ledger rows, but each child is stopped by the tier's caps on its own row, so an orchestration
  can pass 100% without being stopped as a whole. The pooled limits are the child and turn counts and the
  organisation's and team's USD caps. The percentage is absent when the tier has no cap or the defaults
  cannot be read, and `monthlyRemainingUsd` is null when none of the billing teams and organisations
  sets a monthly budget.
- **The transcript cursor can skip a message committed late.** The cursor orders messages by
  `(created_at, id)`, and `created_at` defaults to the start time of the transaction that wrote the row. A
  message committed after a stream or poll has already passed its timestamp is not returned to that
  reader. "No gap and no repeat on resume" holds only when messages commit in timestamp order; a
  reload of the transcript (a fresh read from the start) always shows it.
- **The default allowlist is not tuned per team.** An organisation can override it; a team cannot, and a
  launcher who wants fewer agents narrows the pre-selection in the form or passes `allowlist`.
- **GitHub push permission is checked per writer spawn for a person; direct agent runs do not check it.**
  A person's writer needs the launcher to hold push permission, live, at each spawn, with no ADMIN
  bypass. A principal-launched writer is authorised by the principal's allowlist and team instead. A direct agent
  run that delivers does not, and the repository's own push-triggered workflows are still reachable by a
  pushed branch ([agent-runs.md](./agent-runs.md#limitations)).
- **A principal's other tokens keep an orchestration alive.** The model records which principal launched
  an orchestration, not which of its tokens, so any unrevoked, unexpired `runs:agent` token of that
  principal keeps the orchestration's authority to act.
- **A principal cannot attach a repository or approve a call.** Those are a person's acts, so a
  principal-launched orchestration works only on the repository it was launched with and every MCP write
  its agents attempt is denied. A person who is not the launcher cannot control it either (`403
  NOT_LAUNCHER`); an ADMIN can read it. The event stream is a person's route: a principal polls the detail
  and the transcript.
- **Live updates need a streaming path.** A proxy that buffers responses, a user with four streams
  already open, or a gateway that cannot be held open leaves the dashboard and the CLI polling every 3 s,
  so a status change shows up to a few seconds late. Streamed `child` and `status` events carry no
  budget readout: while only a cost is moving, the page re-reads the detail at most once per 15 s to
  refresh it.
- **Sibling writer pull requests can conflict.** Disjoint path scopes keep two writers from touching the
  same files, not from depending on each other's changes (an interface one changes, a test the other
  breaks). Each writer starts from the default branch and cannot see the others' work. Reconciling
  conflicts or ordering is for the people who review them.
- **Merging is human.** The platform opens branches and draft pull requests and never merges them or
  combines writer diffs into one branch.
- **One repository per orchestration, attached once.** There is no multi-repository orchestration, no
  re-attaching, and no moving to another repository. A repository the orchestrator wants after the first
  must be a new orchestration.
- **MCP-launched orchestrations are `STANDARD` tier with no connection set,** so their children have no
  MCP connection. Their writers' delivery is held to `mcp.agentRunAllowedDeliverModes` and the launch's
  `deliveryDefault`, but a writer is still possible once the launcher confirms a repository in the
  dashboard and holds push permission on it.
- **`deliveryDefault` bounds a writer's delivery only for MCP-launched orchestrations.** Elsewhere it is
  shown on the attach card and is not applied to a writer or told to the orchestrator. An MCP message to
  any orchestration is additionally refused when its default is outside `mcp.agentRunAllowedDeliverModes`.
- **MCP audit rows keep a digest of short messages.** The audit record of an MCP write keeps a digest of
  the body, which is guessable for a very short message.
- **A notice may reach a viewer who cannot see the repository, on a repository-bound launch.** The
  redaction of notices starts at the recorded attach time, and an orchestration launched with a
  repository has none, so its notices are served as written to the named team's other members.
- **An ended orchestration can start again.** A `COMPLETED` orchestration (ended by the launcher, by
  idling or by a limit) takes a message and revives; a limit it ended on ends it again immediately.
- **A cancel can leave a child running.** Cancelling the orchestration flips the status first (so the
  token stops working) and then cancels the children with two sweeps; a child that still cannot be
  cancelled is reported in `failed` and is left to be cancelled as a run. Ending is stricter and
  refuses instead (section 9).
- **A repo-less orchestration is read-only for the length of its life.** If the launcher declines or
  never answers a repository request, the orchestrator can only read, and cannot be given one without
  asking again.
- **The orchestrator is a model.** It can ask for the wrong agent, an over-broad scope or an unneeded
  repository. The checks above bound what it can do, not whether what it asks is wise; the launcher is
  the control, and a prompt-injected orchestrator's most it can do is propose.

---

## Key files

| File | What it holds |
|---|---|
| `packages/shared/src/lib/orchestration.ts` | Intent and result schemas, the overlap and shared-file rules, `fenceChildResult`, the read-only classifier |
| `packages/shared/src/lib/pathScope.ts` | The path-scope grammar |
| `packages/shared/src/lib/orchestrationApi.ts` | The wire shapes of the API |
| `packages/gateway/src/routes/orchestrations.ts` | The routes |
| `packages/gateway/src/lib/orchestrationService.ts` | Views, redaction, width checks |
| `packages/gateway/src/lib/orchestrationAccess.ts` | The repo-less launch decision and the push-permission check |
| `packages/shared/src/lib/orchestrationTokenKey.ts` | Minting and verifying the per-call token |
| `packages/worker/src/lib/orchestrationGateway.ts` | The worker's gateway client, which mints a token per call |
| `packages/worker/src/lib/orchestrationIdentity.ts` | The check that the scheduling workflow's id is `orch-<id>` |
| `packages/worker/src/workflows/orchestration.ts` | The workflow |
| `packages/worker/src/activities/orchestrationTurn.ts` | The turn |
| `packages/worker/src/activities/orchestrationApply.ts` | Applying intents |
| `packages/worker/src/lib/orchestrationContext.ts` | What the orchestrator reads |
| `packages/worker/src/lib/orchestrationChildren.ts` | Child results and the finish signal |
| `packages/worker/src/lib/mcpApproval.ts` | The write approval guard |
| `packages/worker/src/lib/runSteering.ts` | Step- and tool-boundary steering |
| `packages/worker/src/activities/runRepolessAgentTask.ts` | The repo-less reader |
| `packages/worker/src/lib/scratchBrowserWorkspace.ts` | The throwaway, restricted-egress container behind a repo-less reader's browser |
| `packages/worker/src/activities/agentRunFinalize.ts` | The path-scope rule in the push policy |
