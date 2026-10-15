# A `callWorkflow` node — design

> **Not built, and not a description of the system.** This is a design for a node type that does not
> exist, kept here because the constraints it has to satisfy are mostly already decided by the code
> around it — three separate child-launch mechanisms, each having solved part of the same problem.
> Read `docs/architecture.md` and the code for what the platform does today; the "What exists" section
> below names where each constraint comes from.
>
> Status: **proposal.** The open questions in §7 are decisions for a maintainer, not for this
> document.

---

## 1. The gap

A workflow spec cannot start another workflow. That is a capability gap with three separate
workarounds already in the codebase, each implementing part of what a composition primitive needs:

| Path | What launches | How it decides |
|---|---|---|
| `EpicOrchestratorWorkflow` (`worker/src/workflows/epicOrchestrator.ts`) | One `RunnableWorkflow` per repository in an epic | Event-driven: a repo starts once its dependencies finished, and a repo that fails skips its dependents |
| `submitPrdWorkRequests` (`worker/src/activities/prdWorkflow.ts`) | One run per approved PRD story | Fix forward from a step: the activity creates the child `RunInput` rows and starts them |
| The channel assistant's `delegateTask` (`worker/src/workflows/channelAssistant.ts`) | One thread-bound task run | The model records an intent; fixed workflow code starts a child under `REJECT_DUPLICATE` |

Each carries its own answer to: what the child's workflow id is, which template version it gets, who
it acts as, what budget it runs under, what happens to it when the parent ends, and how its outcome
gets back. A fourth path would invent a fourth answer. That is the argument for one node — not
elegance, but that the answers should be written down once.

## 2. Why a node type rather than a step

A `step` node has one outgoing edge, so a synchronous call needs a `set` to record the child's status
and a `cond` to branch on it — precisely the five-node idiom that already exists around the CI wait,
and that this design should not reproduce.

`callWorkflow` with `wait: true` therefore has three edges (`onSuccess`, `onFailure`, `onTimeout`)
and must be a node type. That is a real cost, and §6 lists it.

## 3. The contract

```jsonc
{
  "type": "callWorkflow",
  "title": "Implement the sibling change",

  // Which template. Either a name resolved when the run reaches this node, or a
  // pinned version. A name is resolved by an activity — the workflow isolate
  // cannot read the database — and the version it resolves to is captured for
  // this child only, so a later edit cannot move it.
  "template": { "name": "hotfix" },          // or { "templateId": "...", "version": 7 }

  // What the child is asked to do. Bound like any node's inputs, so it can carry
  // this run's findings into the next one.
  "inputs": { "ticketId": { "from": "context.siblingTicket" } },
  "connectionRef": { "from": "context.workspace.connectionId" },

  // Whether to wait. Synchronous (default) hands the child's structured result
  // to onSuccess and takes onFailure/onTimeout from its terminal status.
  "wait": true,
  "timeout": "7d",

  // What happens to the child when this run ends, and how the child's failure is
  // treated when not waiting.
  "onParentClose": "cancel",                 // or "continue"
  "onChildFail": "warn",                     // or "block" (barrier semantics, as fanOut has)

  "onSuccess": "recordSiblingResult",
  "onFailure": "flagSiblingFailure",
  "onTimeout": "flagSiblingTimeout"
}
```

The node binds the child's `WorkflowResult` — the same shape `EpicOrchestratorWorkflow` reads today —
at `nodes.<id>.output`. Nothing else crosses back: **the child's transcript, tool calls and reasoning
never enter the parent's context**, which is the standing delegation boundary in `AGENTS.md` §6. A
sibling that needs to hand something back does it through its own `terminate.result`.

## 4. What exists, per constraint

**Child identity is deterministic and parent-scoped.** The epic builds
`${epicWorkflowId}-${repoId}` and explains why: the id is scoped to *this* execution, so retrying the
epic (which gets a new id) does not collide with the previous attempt, and siblings stay
distinguishable. The channel path uses a per-thread id under `REJECT_DUPLICATE` so one thread cannot
run two tasks at once. A `callWorkflow` id should be the same shape — parent workflow id + the node's
recording id — started under `REJECT_DUPLICATE`, which makes the id itself the idempotency story: a
retried parent re-derives the same id and is refused rather than launching a second child.

**Template resolution is an activity.** `resolveTemplateForRepo` exists for exactly this and returns
`{ templateId, templateVersion }`; the child is started with both, which is what pins it. A node that
names a template by name should resolve it the same way, in an activity, and refuse if the caller's
team cannot reach it.

**Budget does not transfer.** The child gets its own `RunInput` and its own budget tier; the parent's
cap does not cover it. The existing child paths take a tier from the parent or the request (the PRD
path defaults to the parent's, `templates.ts`). The design should do the same by default and let the
node override it, and it must be explicit in the docs that a fan-out of children multiplies cost —
the org's monthly cap still applies, per child.

**Access is checked at launch, per child.** A child touches a repository the parent may not have named
— the epic does this deliberately, resolving a template per repo and recording `connectionId` on each
child run for visibility. Launch admission therefore has to be re-applied for the child's own
connection, not inherited from the parent.

**The launcher is the interesting one.** `WorkflowRun.launchedById` is what decides whether a *user's
own* GitHub credential may be used, and the rule (`AGENTS.md` §6) is that it stands in only for runs
that user launched. A child started by a template is not something the parent's launcher asked for:
for a nightly parent, the user may not even be present. So a child must record its parent's launcher
for **attribution** while using the **platform** credential, unless the node opts in explicitly. This
is the one part of the contract where getting it wrong is a security bug rather than a wrong number,
and it should be decided deliberately. See §7.

**Cancellation and parent close are already a Temporal choice**: `PARENT_CLOSE_POLICY_REQUEST_CANCEL`
is what the epic uses, so cancelling an epic cancels its children. The node should expose that, and
the other policy for a follow-up that should outlive its parent.

## 5. What this must not do

- **Not replace `EpicOrchestratorWorkflow`.** It schedules on a dependency graph, skips dependents
  after a failure, and reconciles its own state; a node that starts one child is not a scheduler, and
  pretending otherwise would lose the skip-dependents behaviour.
- **Not promise that fire-and-forget covers the epic or PRD cases.** Both await their children and act
  on the outcome. A `wait: false` node exists for genuinely independent follow-ups.
- **Not become a second launch API.** A child run is an action with cost and access implications; it
  goes through the same admission checks a launch does, in an activity, not a bespoke side door.

## 6. Cost of adding a node type

Stated plainly, because it is the reason the assessment ranked this below the contract fixes:

- the "15 node types" claim in `docs/architecture.md` and `docs/product-overview.md`, which
  `yarn docs:check` counts;
- the exhaustive per-type maps in the web app (palette, tones, labels, canvas ports, the outline, the
  inspector's `HAS_CONFIG_SECTION`), each of which is a compile error until updated — that is the
  design working, not a problem;
- a `costEstimator` case (a child's cost is not statically knowable: report it as unpriced with a
  reason, alongside the container and external-call classes);
- the node-type list in the natural-language author prompt;
- the graph-traversal source of truth (`nodeEdges`), whose exhaustiveness sentinel makes a missing
  case a compile error;
- a replay fixture if the record/observe shape is a new control-flow shape.

A new `STEP` would avoid most of that, which is why `runQualityGates` is a step. A composition
primitive cannot be, for the reason in §2.

## 7. Open questions

These are decisions, and each changes the design:

1. **Does a child inherit the parent's visibility?** Today an epic child is reachable by the team of
   the repository it acts on, not by the epic's launcher alone. A `callWorkflow` child needs the same
   answer, and it interacts with the run viewer ("child runs" on the parent's page) which does not
   exist.
2. **Does a child inherit the parent's user-credential entitlement?** §4 argues no. If that is
   accepted, the node needs no opt-in at all, which is the safer default.
3. **Budget**: inherit the parent's tier, take the node's own, or (as now) default to the parent's and
   allow an override? And should a child in flight count against the org cap twice — it does today,
   since it has its own cost rows.
4. **Depth.** Nothing links a `WorkflowRun` to its parent in the schema today — the epic's
   association is by workflow-id convention and a per-child `connectionId`. A depth cap, or a ban on a
   template calling itself, needs a parent column (a migration) or an encoding in the workflow id.
   Without one, a mis-authored template that calls itself is a runaway that the interpreter's
   `maxTransitions` bound cannot see, because each child is its own run.
5. **Synchronous default?** §3 assumes `wait: true` is the default because a publish-then-poll
   follow-up is the case that needs justification; the alternative is that a call is a hand-off and
   waiting is opt-in.
