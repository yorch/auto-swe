# Autonomy Policies

> How a run decides whether it may act on its own or must stop and ask a person. Policies are
> resolved per run, cascade from template to team to global, and fail closed. For the human-facing
> side of a stop see [hitl-workflows.md](./hitl-workflows.md); for where the setting lives see
> [configuration.md](./configuration.md).

---

## 1. What a policy decides

Approval gates in a workflow answer "should a person see this?" by being placed in the DAG. An
autonomy policy answers the same question **without** the workflow author having to decide in
advance, by classifying the *kind* of thing the run is about to do and looking up what that class
requires.

A policy is a map from **risk class** to a rule:

```json
{
  "internal_read":          { "action": "auto" },
  "internal_write":         { "action": "auto" },
  "external_communication": { "action": "require_approval" },
  "mass_communication":     { "action": "require_approval", "approverCount": 2 }
}
```

`action` is one of `auto` or `require_approval` — those two values are the whole vocabulary.
`approverCount` raises the bar to a number of **distinct** approvers; it defaults to one.

Risk classes are free-form strings, not an enum. The four above are the shipped fallback set; a
deployment may use whatever names its workflows publish. A class nobody has written a rule for
resolves to `require_approval`, so adding a new class is safe by construction — it starts closed
and an operator opens it deliberately.

---

## 2. Resolution

`resolveAutonomyPolicy` (`packages/worker/src/lib/resolveAutonomyPolicy.ts`) walks from the most
specific scope to the least:

```
template override  →  team default  →  global default  →  built-in fallback
```

Each level re-checks that the row it found really has the shape of that scope — a template policy
must have a `templateId`, no `teamId`, and `isDefault: false` — so a row edited into an ambiguous
state cannot be silently read as a broader default than it is.

Two things make this different from the config cascades elsewhere in the platform:

- **There is no "no policy" outcome.** The built-in fallback in
  `packages/shared/src/lib/autonomyPolicy.ts` is the floor, so a deployment that has configured
  nothing still requires approval for external and mass communication.
- **Ambiguity fails closed, loudly.** If more than one row matches a scope, resolution returns a
  policy literally named `ambiguous policy scope` whose rule for the requested class is
  `require_approval`. The run stops and the reason names the problem, rather than a coin toss
  deciding whether a message goes out.

---

## 3. Failing closed

`getSafeAutonomyRules` validates stored rules against `AutonomyRulesSchema` on every read. Stored
JSON that no longer parses — an older shape, a hand-edited row, a bad import — does not throw and
does not pass through:

| Stored rules | Result |
|---|---|
| Valid | Used as written |
| `null` or absent | The built-in fallback set |
| Malformed | The fallback set, **plus** `require_approval` forced for the class being asked about |

The last row is the one that matters. A run asking "may I send this external message?" against a
corrupt policy gets `require_approval` for exactly that question, not a generic default that might
happen to allow it.

---

## 4. Where it is enforced

Two call sites resolve a policy, and both are activities rather than workflow code, because the
policy lives in the database and workflow code cannot read it:

| Call site | What it gates |
|---|---|
| `packages/worker/src/activities/publishOutcome.ts` | A run about to publish an outcome — post a message, file a ticket, notify a channel |
| `packages/worker/src/activities/runEvalNode.ts` | An `eval` node carrying a `policy` scorer, which evaluates a risk class as part of scoring |

The `policy` scorer is one of the `eval` node's scorer kinds and takes a `riskClass`. It lets a
workflow assert that a given class would be allowed under current policy, without performing the
action.

A `require_approval` decision does not fail the run. It converts the step into a wait, which the
inbox and the Slack teammate both surface the same way any other human gate is surfaced.

---

## 5. The decision log

Every evaluation writes an `AutonomyDecision` row against the run: the `event`
(`publish`, `approve`, `reject`, `approve_partial`), the actor where there is one, the resolved
`policyName`, the `riskClass`, and the `requiredApprovers` in force at that moment.

The record is deliberately a point-in-time snapshot. Editing a policy afterwards does not rewrite
what a past run was held to, which is what makes the log answerable in an audit: it says what the
rule *was*, not what it is now.

Browse it at `/govern/policies/decisions`, or read it over the API.

---

## 6. Managing policies

| Surface | Where |
|---|---|
| Policy list and editor | `/govern/policies` |
| Decision log | `/govern/policies/decisions` |
| API | `GET`/`POST` `/api/v1/admin/autonomy-policies`, `DELETE /api/v1/admin/autonomy-policies/:id`, `GET /api/v1/admin/autonomy-decisions` |

The same routes are mounted under `/api/v1/platform` as well as `/api/v1/admin`.

Policies are stored in `autonomy_policies` (`AutonomyPolicy`), keyed by an optional `teamId` and an
optional `templateId` plus an `isDefault` flag, which together encode the scope the resolver
expects.

---

## Limitations

- **Two actions only.** `auto` and `require_approval` are the entire vocabulary. There is no "deny
  outright", no time-boxed auto-approval, and no escalation path — a class is either open or it
  waits for a person.
- **`approverCount` is a count, not a list.** A rule can demand two distinct approvers; it cannot
  demand a *particular* person, a role, or a group. Who is allowed to approve is whatever the run's
  team membership and RBAC already permit.
- **Risk classes are unvalidated strings.** Nothing checks that a class a workflow publishes matches
  a class a policy names. A typo does not error; it silently lands on the unknown-class default and
  requires approval, which is safe but is not the rule the author thought they wrote.
- **Scope is template or team, never channel or organization.** The other config cascades in this
  platform resolve through five levels; this one has three, and a channel-resident run inherits its
  template's or team's policy with no channel-level override.
- **The decision log records outcomes, not deliberation.** It captures what was decided and under
  which policy, not the diff, the message, or whatever the approver actually looked at before
  deciding.
- **Editing a policy does not disturb waiting runs.** A run already parked at a gate keeps the
  approver count it was given. Loosening a policy will not release it, and tightening one will not
  raise its bar.
