# Repository access gating

Which repositories a user may reach is decided by **team membership**. When the GitHub permission
gate is enabled, the source-control host has to agree as well.

The two conditions are ANDed, never substituted. A GitHub permission can only ever take access
away: nobody reaches a repository whose team they do not belong to, whatever GitHub says. Team
scoping still carries budgets, templates, agent configuration, and the tenant guard.

---

## 1. Why the gate exists

A `Connection` (repository) belongs to exactly one `Team`, and a user reaches it by holding a
`TeamMembership` in that team. Nothing in that chain consults GitHub. The platform clones and pushes
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

Because the platform asks on the user's behalf, there are no per-user GitHub tokens to store,
refresh, expire, or encrypt.

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
| Scheduled sweep | every reachable pair | one sweep interval |

The sweep's candidate set is each repository's own team members, not every user times every
repository, so its cost tracks real reachability rather than deployment size.

A failed lookup writes nothing at all — the existing row keeps its answer and its `checked_at`, so
it ages out through the staleness window instead of being overwritten.

---

## 5. Configuration

Four settings, all `ADMIN`-only and deployment-wide. A per-team override would let one team opt out
of the check that keeps the platform's idea of access aligned with GitHub's.

| Setting | Default | Meaning |
|---|---|---|
| `repoAccess.mode` | `off` | `off`, `advisory`, or `enforce` |
| `repoAccess.syncEnabled` | `false` | whether the scheduled sweep runs |
| `repoAccess.syncCron` | `23 * * * *` | when it runs |
| `repoAccess.viewStaleAfterHours` | `72` | how old a cached answer may be and still count for viewing |

Multiple GitHub organizations are reached through multiple App installations. `GitHubInstallation`
rows name them and `connections.installation_id` points a repository at one; null means the
singleton `GitHubConfig.appInstallationId`, so an existing single-org deployment needs no change.

Installations are managed at `/api/v1/admin/github-installations` (list, create, update, delete),
and a repository is pointed at one through `installationId` on the repository create and update
routes. Both are ADMIN-only: the installation decides which GitHub account answers permission
questions about a repository, and every other credential-shaped knob in this codebase is
ADMIN-scoped. Deleting an installation still in use is refused with the repositories that hold it,
rather than surfacing a foreign-key error.

---

## 6. Rolling it out

1. Deploy. `repoAccess.mode` is `off`, so nothing changes.
2. Configure the GitHub App or PAT so it can see every configured repository. Add
   `GitHubInstallation` rows if repositories span more than one GitHub organization.
3. Ask users to link GitHub, then run the backfill script for accounts linked earlier.
4. Enable `repoAccess.syncEnabled` and let one sweep populate `repo_access`.
5. Set `repoAccess.mode` to `advisory`. Watch the gateway logs for
   `repoAccess advisory: this launch would be refused under enforcement`.
6. When that log is quiet, set `repoAccess.mode` to `enforce`.

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

---

## 8. What is gated

Every path that can cause a push is gated, not only the interactive one.
Gating a single route would leave the others as ways around it.

| Surface | Gated | Requires |
|---|---|---|
| `POST /work-requests` | yes | `write` |
| `POST /work-requests/:id/retry` | yes | `write` |
| `POST /epics` (per repository) | yes | `write` |
| `POST /workflow-templates/:id/runs` | yes | `write` |
| `POST /scheduled-work-requests` | yes | `write` |
| `POST /scheduled-work-requests/:id/fire` | yes | `write` |
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
- **A GitHub username change is not detected.** The login is captured at link time and refreshed
  only when the account is linked again. GitHub usernames are reusable after release, so a stale
  login could in principle name a different person. Re-linking fixes it; nothing detects it
  automatically.
- **Revocation is not instant.** Webhooks make it seconds, but a missed or undelivered webhook
  leaves the previous answer in place until the next sweep, and a paused sweep extends that to
  `repoAccess.viewStaleAfterHours`. The launch path is unaffected, because it asks live.
- **The webhook refresh is capped at 200 pairs per event.** A bulk organization change emits many
  events, and without a cap one could spend the hour's API quota. The remainder is left to the
  scheduled sweep.
- **Runs already in flight are not re-checked.** The gate is a launch-time and read-time control. A
  run that started legitimately continues to completion even if GitHub access is revoked while it
  is waiting on CI or a human step.
- **Nothing here changes which identity acts on GitHub.** Clones, pushes, and pull requests are
  still made with the platform's installation credential, not the user's, so pull requests are not
  attributed to the requester. Delegating execution to a user identity would need per-user token
  refresh and a service identity for webhook- and schedule-triggered runs, which have no user at
  all.
- **Team membership remains the outer bound.** The gate can only remove access. A user with GitHub
  admin rights on a repository still sees nothing unless they are a member of the owning team.
- **Non-git connections are exempt, necessarily.** A `Connection` is also how an MCP server and
  other non-git integrations are stored, and none of them can ever have a permission row — the
  sweep, the webhook refresh and the lookup all restrict to `git_repo`. They are therefore matched
  unconditionally. This is not a strictness the gate declines to apply; requiring a row would make
  every non-git connection vanish for every non-admin with no way to get it back.
- **The gate argument is required but nullable, on purpose.** Optional, it defaulted to "no gate",
  so a call site that forgot it compiled and ran ungated — which is how the Slack routes and the
  human-step resolver ended up outside the gate. Required, forgetting is a compile error and
  passing `undefined` is a decision someone made. This does not reach the JavaScript-side checks
  below.
- **Some repository-access decisions are made in JavaScript, not in a `where` clause.** Roughly a
  dozen call sites select membership rows and test the array length in code rather than filtering
  the query. Extending the shared predicate does not reach those, so each had to be gated by hand
  — which is exactly the shape of mistake that produced the gaps this change had to fix twice.
  Converting them to predicates would make the next such change safe by construction.
- **Editing or deleting a schedule is not gated.** Neither causes a push, and refusing a delete
  would strand a schedule its owner can no longer stop. A schedule created before access was
  revoked keeps firing until someone deletes it — the gate is checked when it is created and when
  it is fired by hand, not on each cron fire, which has no user to check.
- **A template run started by a public or webhook caller is not gated.** There is no authenticated
  user to ask GitHub about; those callers are scoped to the template's own team instead, which is
  the pre-existing behaviour.
