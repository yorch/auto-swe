# Repository access gating

Which repositories a user may reach is decided by **team membership**. When the GitHub permission
gate is enabled, the source-control host has to agree as well.

The two conditions are ANDed, never substituted. A GitHub permission can only ever take access
away: nobody reaches a repository whose team they do not belong to, whatever GitHub says. Team
scoping still carries budgets, templates, agent configuration, and the tenant guard.

Both conditions are checked in one place, and which place depends on what the caller needs to be
told. A **listing** filters in the query, through `reachableConnections`. A **route acting on named
repositories** loads them first and calls `decideRepoAccess`, so a refusal can say which
repositories were refused and why — filtering there would turn a legitimate mistake into "no such
repository". Neither form can check membership without also asking GitHub, which is the point:
they were separate checks once, and six launch paths shipped with the first and without the
second.

---

## 1. Why the gate exists

A `Connection` (repository) belongs to exactly one `Team` and may be shared with further teams in
the same organization (see [repositories.md](./repositories.md)); a user reaches it by holding a
`TeamMembership` in the owning team or a shared one. Nothing in that chain consults GitHub. The platform clones and pushes
with one installation credential per GitHub organization, so a user in the right team can drive an
agent against a repository they personally cannot open on github.com.

The gate closes that divergence by asking GitHub, with the platform's own credential, what the
user's GitHub account may do with the repository.

---

## 2. How a user is identified to GitHub

`users.github_login` holds the GitHub username, captured at OAuth account-link time by a
`account.create.after` hook in `packages/gateway/src/lib/betterAuth.ts`.

The login is taken then because it is the only moment it is in hand: better-auth records the
provider's numeric id on `accounts.account_id`, and GitHub exposes no supported REST route from a
numeric id back to a login. The hook hangs off account creation rather than user creation so that
linking GitHub to an existing email or Google user is covered — that path creates no user row.

`users.github_login` is unique. A login already held by another user is reported and left alone
rather than moved; taking it would hand that user's repository access to whoever signed in last.

`users.github_login_account_id` records the `accounts.account_id` the login was read from (`{host}:{id}`,
or a bare github.com id), and is written and cleared together with the login. A user may link several
GitHub accounts, and a login is only comparable with the id space of the host that issued it, so the
ownership check verifies against that one account. A recorded account that is no longer linked leaves
the login with nothing behind it, and it is cleared as an unlinked login.

Accounts linked before the column existed are covered by
`packages/gateway/src/scripts/backfillGithubLogins.ts`. Run it before enabling enforcement:

```bash
yarn workspace @auto-swe/gateway exec tsx src/scripts/backfillGithubLogins.ts
```

---

## 3. Asking GitHub

`fetchRepoPermission` in `@auto-swe/shared/lib/githubPermission` calls GitHub's collaborator
permission endpoint with the installation credential and a username. Both processes share it: the
worker through a `repoPermission` method on the `ScmProvider` seam, the gateway through
`lookupRepoPermission`.

Because the platform asks on the user's behalf, the gate itself needs no per-user GitHub token.

The exception is a user who has saved their own token for the repository and may use it (see
[user-github-credentials.md](./user-github-credentials.md)). On a launch path whose run acts as the
caller, the run acts as that token, so that is the identity the gate judges: it asks
`GET /repos/{owner}/{repo}` with the token and reads the owner's `permissions`, and needs no stored
login. Firing a schedule by hand (the run acts as the schedule's author) and steering a Slack
thread (the run was launched by someone else) are judged by the login whatever the caller saved.
The sweep and the webhook refresh prefer the token where it is usable
and fall back to the login-based lookup where it is not. A
token GitHub rejects, or that cannot see the repository, refuses a launch as
`user-credential-rejected` rather than falling back — the run would use that token and fail.

A repository is asked about with the platform credential of its own host: the instance's, or the
credentials an admin recorded for another approved host (see
[repositories.md](./repositories.md#per-host-credentials)). A repository on another host with none
recorded, or with web and API bases on different hosts, cannot be asked about at all. That lookup
fails as `host-mismatch`, and a launch is refused with the `host-mismatch` reason, whose message
names the remedies (add credentials for that host, set the GitHub integration's web and API URLs to
it, or save your own token) rather than suggesting a retry, which could never succeed. Advisory mode logs it and allows, as for every
other refusal; the projection writes nothing on any lookup failure.

The endpoint answers with a level, not a boolean, so one lookup serves two different questions:

| Level | May view a repository and its runs | May start a run |
|---|---|---|
| `admin` | yes | yes |
| `write` | yes | yes |
| `read` | yes | no |
| `none` | no | no |

Starting a run pushes a branch and opens a pull request, which is why read access is not enough.

**A failed lookup is never resolved to a verdict.** GitHub answering `none` is a fact about the
user; a 404, a rejected credential, a rate limit, or a timeout is the question going unanswered.
Recording those as the same value would make an outage indistinguishable from a real denial. A 404
is especially ambiguous — GitHub returns it both for "not a collaborator" and for "this credential
cannot see the repository", and the second is an operator error about the installation.

---

## 4. The projection

The collaborator endpoint answers for one user and one repository. Gating a listing inline would
mean up to a few hundred calls to render one page, so answers are materialised in `repo_access` and
the request path reads rows.

**`repo_access` is a cache of GitHub's answers, not a grant table.** The only writers are the sweep
and the webhook handler. A row edited by hand grants access GitHub does not back, until the next
refresh silently takes it away. To change someone's access, change it on GitHub.

Rows are refreshed three ways.

| Trigger | Covers | Latency |
|---|---|---|
| Live lookup at launch | the one pair being launched | immediate |
| Webhook (`POST /api/v1/webhooks/access`) | collaborator, team, org-membership and repository events | seconds |
| Scheduled sweep | every reachable pair, plus login-ownership verification | one sweep interval |

A detected takeover is recorded in the governance audit log against the affected user, with the
account id the login was recorded for and the one it resolves to now. It appears at `/govern/audit`
with no actor, because the system cleared it rather than a person. A log line was the only signal
before, and a log line is gone by the time anyone asks.

All three writers confirm the stored login still resolves to the account id it was recorded for
before using it — the sweep, the launch path and the webhook refresh. A check only one of the three
performed would not be a check: the other two would keep re-populating rows under a login that had
changed hands, between sweeps. The sweep and the webhook refresh verify once per user rather than
once per pair. GitHub releases a username on rename and lets anyone
re-register it, so a login recorded months ago can end up naming a different person — and the
projection would then record that person's access as this user's. The numeric account id cannot
change, which is what makes the check possible; a plain rename still resolves to the same id and is
left alone.

The ownership lookup asks the host the account's id belongs to. An id from the built-in `github`
sign-in provider is bare and github.com's; a GitHub Enterprise sign-in stores `{host}:{id}`, that
host's id space. Each is compared against the id that same host reports, with that host's own
platform credential: the instance's when the host is the instance's, otherwise the credentials
recorded for it. The instance's credential is never sent to another host, nor a host's to the
instance. Where no credential applies, a github.com account is asked unauthenticated
(rate-limited, so answers read as unverifiable and nothing is cleared) and any other host is not
asked: the login is reported as unverifiable and kept. The sweep logs the hosts that had no
credential. An App-only host or instance, with no PAT and no singleton installation, uses the first
active installation recorded for it to mint the lookup token.

The sweep's candidate set is each repository's owning-team and shared-team members, each once, not
every user times every repository, so its cost tracks real reachability rather than deployment size.
The webhook refresh walks the same set.

A failed lookup writes nothing at all — the existing row keeps its answer and its `checked_at`, so
it ages out through the staleness window instead of being overwritten.

---

## 5. Configuration

Two settings, both `ADMIN`-only and deployment-wide, and two environment variables. A per-team
override would let one team opt out of the check that keeps the platform's idea of access aligned
with GitHub's.

| Setting | Default | Meaning |
|---|---|---|
| `repoAccess.mode` | `off` | `off`, `advisory`, or `enforce` |
| `repoAccess.viewStaleAfterHours` | `72` | how old a cached answer may be and still count for viewing |

| Environment variable | Default | Meaning |
|---|---|---|
| `REPO_ACCESS_SYNC_ENABLED` | `false` | whether the scheduled sweep runs (`true` or `false`) |
| `REPO_ACCESS_SYNC_CRON` | `23 * * * *` | when it runs, five-field cron, UTC |

The sweep is an environment variable because the gateway creates its Temporal Schedule once, at
startup: a value saved in a form could not take effect without a restart. The gateway refuses to
start on a value it cannot use. Set it where the gateway runs; the "enforcing without a sweep"
warning reads the same variable wherever the gate is evaluated, so a deployment should share one
`.env` between the gateway and the worker.

Multiple GitHub organizations are reached through multiple App installations. `GitHubInstallation`
rows name them, each recorded for the GitHub host it lives on, and `connections.installation_id`
points a repository at one on the repository's own host. On the instance's host, null means the
singleton `GitHubConfig.appInstallationId`, so an existing single-org deployment needs no change;
another host's credential set has no singleton, so a null there uses that host's PAT (see
[repositories.md](./repositories.md)).

An installation can be marked **retired**, which refuses new launches against the repositories
pointing at it — with a distinct `INSTALLATION_RETIRED` code, because it is an operator-
configuration problem rather than a statement about the user. Clones, pushes, CI reads and runs
already in flight are deliberately unaffected.

GitHub's own lifecycle events set it too: an `installation` `deleted`, `suspend` or `unsuspend`
delivery to the App's webhook URL makes the platform ask GitHub for the installation's state, and the
state GitHub reports is applied (retired when deleted or suspended; reactivated only if a webhook
retired it). A retirement made by an admin is never
reversed by a webhook, and an admin's edit of the active flag replaces the webhook's. See
[repositories.md](./repositories.md).

It is enforced in two places, because not every run starts at the gateway. Every launch route
refuses one up front, which is what produces the error a caller sees. And the run's first activity
refuses again at run start, which is what covers the paths that never touch the gateway at all: a
scheduled work request's cron fire, the Slack channel assistant's code task, and any launch path
added later. Both sit at the beginning of new work, so neither can interrupt a run already under
way. Unlike the GitHub gate, this check reads no user, so the exemptions for callers without an
identity do not apply to it.

Installations are managed at `/studio/github-installations` in the dashboard, or over the API at
`/api/v1/platform/github-installations` — which the dashboard itself calls, and which is also
registered under `/api/v1/admin` like the other admin routes (list, create, update, delete),
and a repository is pointed at one through `installationId` on the repository create and update
routes. An installation's host is chosen when it is created and cannot be changed, and a repository
can only point at an installation on its own host. Both are ADMIN-only: the installation decides which GitHub account answers permission
questions about a repository, and every other credential-shaped knob in this codebase is
ADMIN-scoped. Deleting an installation still in use is refused with the repositories that hold it,
rather than surfacing a foreign-key error.

---

## 6. Rolling it out

1. Deploy. `repoAccess.mode` is `off`, so nothing changes.
2. Configure the GitHub App or PAT so it can see every configured repository. Add
   `GitHubInstallation` rows if repositories span more than one GitHub organization.
3. Ask users to link GitHub, then run the backfill script for accounts linked earlier.
4. Set `REPO_ACCESS_SYNC_ENABLED=true`, restart the gateway, and let one sweep populate
   `repo_access`.
5. Leave `REPO_ACCESS_SYNC_ENABLED` on. Enforcing with the sweep disabled filters every listing
   against a projection nothing refreshes and never re-verifies a stored GitHub login; the gateway
   warns when it sees that pairing, because the two knobs default opposite ways and it is easy to
   reach by accident.
6. Set `repoAccess.mode` to `advisory`. Watch the gateway logs for
   `repoAccess advisory: this launch would be refused under enforcement`.
7. When that log is quiet, set `repoAccess.mode` to `enforce`.

Add `POST /api/v1/webhooks/access` as a GitHub webhook delivering `member`, `team`, `membership`,
`organization`, and `repository` events, signed with the same secret as the other webhooks.

---

## 7. Failure behaviour

Launching and viewing deliberately fail in opposite directions.

**Launching fails closed.** A lookup that cannot be made is not permission to proceed. This is safe
because the failure is loud, immediate, and retryable by the person in front of it.

**Viewing serves the last known answer.** The projection is durable local state, so a GitHub outage
does not empty anyone's dashboard — rows keep their previous answers until they pass
`repoAccess.viewStaleAfterHours`. Beyond that they stop counting, so a repository whose answers
stopped refreshing disappears from listings rather than being served indefinitely from a cache
nobody is updating.

**An unreadable gate configuration does not silently disable the gate.** Each process remembers the
last configuration it read successfully and keeps applying it, so a database hiccup cannot turn
enforcement off underneath a running deployment. Only a process that has never managed to read the
configuration falls back to `off`, and such a process has nothing to enforce yet.

The Slack paths, and the Slack run modal, are the exception: they refuse. The gateway's fallback is safe because it decorates
every authenticated request and the routes downstream still check team membership, but a Slack
message arrives with no session at all, and the gate read is the only thing between an unidentified
workspace user and a push. "We could not check" must not read there as "there was nothing to check".
In practice a configuration store that cannot answer also cannot create the run a moment later, so
what this costs is a clear message in the thread rather than a failure further in. The run modal
refuses for the same reason and to keep the two consistent: a launch must never be more permissive
than a steer of the run it starts.

**Advisory means advisory on these paths too**, and it covers one more condition here than it does
on the gateway routes. Under `advisory` a Slack user with no linked account **and** a Slack user who
is not a member of the channel's team are both logged and allowed, and refused only under `enforce`.

The test for what belongs in that list is not what kind of condition it is — it is whether the path
applied it before the gate existed. Every gateway route checked team membership long before any of
this, so membership there is a pre-existing bound that advisory has no business relaxing. These two
Slack paths never did: a channel task resolves its repository from the **channel's** team binding and
never consulted the asker's membership, and a thread steer checked nothing at all. Both conditions
arrived together, so both observe together, or advisory refuses someone for a rule that did not exist
when the operator set the dial. A retired installation is refused in every mode when a
task is being **started**, because it already stopped channel code tasks at the run's first activity.

**A retired installation does not stop a steer.** Retirement stops new work and nothing else — that
is the doctrine everywhere else in this document, and a steer is not new work. Reaching the decision
at all requires the run to be in flight, so it necessarily started before the retirement, and it goes
on running either way; refusing the steer would take away its owner's control of it without stopping
anything. The two Slack paths pass what they are asking for **into** the decision, so it
removes that one condition and keeps every other. Converting the refusal afterwards would not be the
same thing: retirement is decided before the GitHub permission check, so an allow applied to its
answer would have skipped the check as well.

**And `off` is read first.** Everything the gate adds has failure modes of its own — a truncated
scan, a lookup that did not answer — and each of them refuses. A deployment that never asked for the
gate must not lose a steer to a database blip in a check it did not turn on, so the mode is read
before any of that apparatus runs rather than inside the decision at the end of it.

---

## 8. What is gated

Every path that carries a **user identity** is gated, not only the interactive one. Gating a single
route would leave the others as ways around it.

The paths that carry no user identity are not, and cannot be, gated on a user's GitHub permission —
there is nobody to ask GitHub about. They are listed under Limitations, and they are scoped some
other way: to the template's own team. A retired installation does stop all of them, because that
check reads no user.

The Slack channel assistant used to be in that list and no longer is. Its code task does carry a
requester — only the interactive turn can start one, and it knows who spoke — so once the gate is on
it takes the same decision as everything else.

**Steering counts as launching.** A reply in a thread with a running task is delivered to that run
as new instructions, and for a task deferred with `runAt` it is spliced into the run's description
before the run starts at all — which makes it indistinguishable from having asked for that work.
Gating the launch and leaving the steer open would let anyone who can type in the channel write the
second half of somebody else's task, so the steer takes the same decision, against the repository
the thread's task targets. The check is repository access, not authorship: two people who both have
write access steering each other's task is ordinary collaboration. A refusal is silent — the reply
is dropped as ordinary channel chatter rather than answered, because answering would confirm to
someone outside the repository that a task is running in that thread.

The decision is taken only when there is an open run to steer. Checking first costs one call to the
orchestrator; skipping it would mean asking GitHub who is speaking on every reply in any thread that
ever hosted a code task, for the life of the thread, because the run-input row that records it is
permanent and most thread replies are people talking to each other.

Which repository a thread is judged against is the part worth stating, because the obvious answer is
wrong twice over. A channel task files its run input under a deterministic ticket id built from the
channel and thread, which looks like the natural key — but a ticket id is free text taken from the
body of a work-request submission, and its validation permits every character that id uses. So the
lookup also requires the typed Slack columns and the channel-task payload marker, none of which any
API route writes. And it requires **every** repository the thread has tasked, not the most recent
one: a run input is written before its run starts, so a thread accumulates rows, and reading only the
newest would let a repo-less general task or a deliberately planted one decide in place of the task
actually being steered. Requiring all of them makes an extra row narrow who may steer rather than
widen it. The ceiling is counted in distinct repositories, not rows: every delegating turn writes a
row and they normally all name the same one, so counting rows would quietly cost a busy thread its
steering.

| Surface | Gated | Requires |
|---|---|---|
| `POST /work-requests` | yes | `write` |
| `POST /work-requests/:id/retry` | yes | `write` |
| `POST /epics` (per repository) | yes | `write` |
| `POST /workflow-templates/:id/runs` | yes | `write` |
| `POST /scheduled-work-requests` | yes | `write` |
| `POST /scheduled-work-requests/:id/fire` | yes | `write` |
| A scheduled work request's cron fire (decided for the schedule's acting user, in the run's first activity) | yes | `write` |
| `PATCH /scheduled-work-requests/:id` (re-activating, or changing what an active schedule runs) | yes | `write` |
| `POST /prd-runs` (per repository) | yes | `write` |
| Slack `/auto-swe run` modal | yes | `write` |
| `POST /human-steps/:id/respond` and the Slack HITL buttons | yes | `read` |
| `GET /repositories` | yes | `read` |
| `GET /workflows`, `GET /workflows/:id` | yes | `read` |
| `GET /runs` and the run viewer | yes | `read` |
| `GET /inbox` and human steps | yes | `read` |
| `GET /scheduled-work-requests` | yes | `read` |
| `GET /repo-dependencies` | yes | `read` |
| `GET /lessons` and lesson search | yes | `read` |
| `GET /epics` | yes | `read` |
| Slack run-status buttons (`canSeeRun`) | yes | `read` |
| Slack channel assistant code task | yes, when the gate is on | `write` |
| Slack thread steer of a running code task | yes, when the gate is on | `write` |

Platform `ADMIN`s bypass the gate, consistent with every other check in the gateway.

---

## Limitations

- **Advisory mode reports on launching, not on viewing.** A launch is one decision and logging it
  costs nothing; reporting what a listing would have hidden means running every listing twice, on
  every page render, for the whole rollout. An operator previewing the impact on listings has to
  read `repo_access` directly.
- **A user with no linked GitHub account cannot launch under enforcement.** There is no identity to
  ask GitHub about. They can still be found in advisory mode, which is what the advisory period is
  for, but under enforcement the refusal is absolute.
- **A re-registered GitHub username is detected on the next sweep, not immediately.** The sweep
  confirms each stored login still resolves to the GitHub account id it was recorded for, and
  clears it when it does not. A plain rename is harmless and is deliberately left alone, because
  GitHub redirects the old name to the same account id. The exposure window is one sweep interval,
  and a deployment with the sweep disabled has no detection at all.
- **A re-registered username is detected only where a credential can ask.** The check is made against
  the account's own host with that host's platform credential. An account on a host with none — a
  GitHub Enterprise sign-in account whose host has no credentials, which is the instance's own host
  unless the instance URL changed later — is reported as unverifiable. Nothing is cleared and no
  takeover is recorded for it. A github.com account is still asked without a credential then, which
  rate-limits. The lookup uses a host's standard API base (`/api/v3` on a GitHub Enterprise Server),
  not a per-repository override.
- **A login with no recorded source account is verified only when one account is linked.** A user
  whose login was written before the source account was recorded, and who has linked several GitHub
  accounts, is reported as unverifiable and kept; nothing is cleared. Signing in again, or the
  account's next update, records the source.
- **Revocation is not instant.** Webhooks make it seconds, but a missed or undelivered webhook
  leaves the previous answer in place until the next sweep, and a paused sweep extends that to
  `repoAccess.viewStaleAfterHours`. The launch path is unaffected, because it asks live.
- **The webhook refresh is capped at 200 pairs per event.** A bulk organization change emits many
  events, and without a cap one could spend the hour's API quota. The remainder is left to the
  scheduled sweep.
- **Runs already in flight are not re-checked.** The gate is a launch-time and read-time control. A
  run that started legitimately continues to completion even if GitHub access is revoked while it
  is waiting on CI or a human step.
- **The gate does not change which identity acts on GitHub.** Clones, pushes, and pull requests use
  the platform's installation credential unless the launching user has saved a usable token of
  their own, which is a separate, admin-enabled feature — see
  [user-github-credentials.md](./user-github-credentials.md). Webhook- and schedule-triggered runs
  have no launcher and always use the platform credential.
- **Retiring an installation stops new work, not work in flight.** A run already under way keeps
  cloning, pushing and reading CI through a retired installation, and so does the sweep. The mark
  says what may start next; pulling the credential out from under running work would make a
  bookkeeping toggle into an outage.
- **The retirement check at run start needs to know the run's repository.** It reads the run's own
  repository (an epic child) or its work request's connection. A run launched from a Slack slash
  command records its repository only on its ledger row, so that start is not refused by the mark;
  scheduled fires are, through the fire-time launch decision.
- **Team membership remains the outer bound.** The gate can only remove access. A user with GitHub
  admin rights on a repository still sees nothing unless they are a member of the owning team or a
  team it is shared with.
- **Non-git connections are exempt, necessarily.** A `Connection` is also how an MCP server and
  other non-git integrations are stored, and none of them can ever have a permission row — the
  sweep, the webhook refresh and the lookup all restrict to `git_repo`. They are therefore matched
  unconditionally. This is not a strictness the gate declines to apply; requiring a row would make
  every non-git connection vanish for every non-admin with no way to get it back.
- **The gate argument is required but nullable, on purpose.** Optional, it defaulted to "no gate",
  so a call site that forgot it compiled and ran ungated — which is how the Slack routes and the
  human-step resolver ended up outside the gate. Required, forgetting is a compile error and
  passing `undefined` is a decision someone made.
- **Pausing, renaming or deleting a schedule is not gated.** None of them causes a push, and
  refusing a pause or delete would strand a schedule its owner can no longer stop.
- **A cron fire acts for the schedule's acting user, and is decided again at every fire.** The run's first
  activity re-takes the launch decision for that user — team membership, the GitHub gate,
  installation retirement, org membership and the org's monthly cap — and refuses the fire with a
  non-retryable failure when any of them no longer holds; the next tick decides again, so restoring
  access resumes the schedule. A refused fire is logged by the worker and audited against the
  schedule (`config_audit_log`, entity `ScheduledWorkRequest`) at most once an hour per reason. One
  refusal is not an access decision: while a retry (or any other non-fire run) of the standing
  request is in flight, which can be days when it awaits a merge, every fire is skipped with reason
  `request-in-flight`. That is expected: each tick shows as a refused execution, the worker logs it at
  info, the audit row's `afterJson.event` is `fire-skipped` (its action is `UPDATE`, as for a refusal), and the schedule resumes on the first tick after the
  retry ends ([work-views.md](./work-views.md)). The
  acting user (`actsAsUserId`) is whoever last re-activated the schedule or changed what it runs —
  that edit takes the launch decision, so it also takes over the schedule — and their own saved
  token is the identity judged. A schedule from before that was recorded falls back to its creator,
  judged on the platform credential. A schedule with no active acting user or creator refuses every
  fire until someone re-activates it. An unreadable access
  policy refuses the fire rather than falling back to `off`: nobody is watching an unattended
  fire.
- **A template run started by a public or webhook caller is not GitHub-gated.** There is no
  authenticated user to ask GitHub about; those callers are scoped to the template's own team
  instead, which is the pre-existing behaviour. A retired installation still stops them.
- **The Slack channel assistant's code task is gated only once the gate is on.** With
  `repoAccess.mode` off it needs no linked account, which is the long-standing behaviour of an
  `@mention` and a deliberate one — the assistant's value is that you can talk to it without
  onboarding. Under `advisory` or `enforce` it resolves the Slack user to a platform user and takes
  the same decision every other launch path takes, so the conversational route stops being an
  easier way to do what `/auto-swe run` already checks. A Slack user with no linked account cannot
  start a code task under enforcement; they are told to link, and the conversational route keeps
  working. The **general** route needs no identity and is untouched in every mode.
- **A thread can be talked past the steer decision's ceilings, permanently, and on purpose.** The
  decision reads a bounded number of task rows and decides against a bounded number of repositories;
  exceeding either refuses. Run inputs are never deleted, so both ceilings are one-way doors. This is
  not only a capacity limit reached by accident in a long thread: anyone who can post in the channel
  can reach it deliberately, by driving enough delegating turns — or enough of them naming distinct
  repositories — and thereby end steering in that thread for everyone. There is no message and no way
  to clear it, and the ceiling is reached before any actor is considered, so a platform admin cannot
  steer past it either. Failing closed is the right answer for a decision taken on a truncated set;
  the silence and the permanence are the cost. **Starting a new thread is not a workaround for the
  person it happens to** — a running task cannot be moved to one, so their recourse is to let it
  finish unsteered and begin again.
- **Steering a thread can be narrowed by anyone who can start a task in it.** Because a steer
  requires access to every repository the thread has tasked, someone who asks for a code task in
  another person's thread against a repository only they can reach leaves a row behind that the
  thread's owner then fails. They lose the ability to steer their own task; they do not lose the
  task, and an `@mention` still works. That trade is deliberate — the alternative, ranking the rows
  and trusting the newest, turns the same move into a way to steer somebody else's run.
- **A deferred code task is decided when it is asked for, not when it runs.** A task scheduled with
  `runAt` takes the requester's decision at creation and nothing re-asks GitHub at the moment the
  run starts, so access lost in between does not stop it. A scheduled work request does not have
  this window — its owner is re-decided at every fire — but a deferred code task's run start does
  not re-take the requester's decision. A **retired installation** is re-read at the start of every
  run, because that check reads no user.
