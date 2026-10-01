# Per-user GitHub credentials

By default the platform reaches GitHub with one credential an admin configures — a PAT or a GitHub
App, at `/studio/integrations`. A user can instead save **their own** GitHub token for a
repository, and runs they launch against that repository clone, push and open pull requests as
that token.

This is what lets a team work against GitHub or GitHub Enterprise repositories when no admin has
configured a platform credential for them, and it attributes the pull requests a user's runs open
to that user.

The feature is off by default, and an admin decides both whether it is on and which hosts a token
may be sent to.

---

## 1. Whose token a run uses

A run resolves its credential in this order:

1. The token **the user who launched this execution** saved for the repository, when it is
   usable (see §3).
2. The platform credential — the repository's GitHub App installation, or the PAT.
3. Neither: the run fails with a non-retryable configuration error.

**A saved token is used only for executions its owner launched.** Never for anyone else's run, and
never for a run nobody launched. This is the property the rest of this document exists to keep.

"Launched" means started *this execution*, which is not the same as having asked for the work:

| Launch path | Launched by |
|---|---|
| `POST /work-requests` | the caller |
| `POST /work-requests/:id/retry` | **the caller of the retry**, not the original requester |
| `POST /workflow-templates/:id/runs` | the caller |
| `POST /epics` | the caller; each per-repository child run inherits it |
| `POST /prd-runs` | the caller; each story the PRD becomes inherits it |
| Scheduled work requests — cron fire or `POST /scheduled-work-requests/:id/fire` | nobody |
| Webhooks, the issue-tracker auto-trigger | nobody |
| Slack — the `/auto-swe run` modal and channel-assistant code tasks | nobody |

A run launched by nobody uses only the platform credential.

### How the launcher is recorded

The launch path puts the authenticated caller's id on the workflow's input (`launchedById`), and the
run's first activity writes it to `WorkflowRun.launchedById` together with Temporal's run id for
that execution (`WorkflowRun.temporalRunId`). Every later activity that needs a GitHub token reads
the launcher back from that row — and trusts it only when the row's `temporalRunId` is its own.

The run-id check matters because the row is keyed by workflow id and never rewritten, and Temporal
lets a workflow id be started again once its earlier execution closes. A later execution that
lands on an earlier execution's row finds a run id that is not its own, and so gets no user
credential rather than the earlier launcher's.

It is deliberately not `RunInput.requestedById`. A re-run reuses the original request, so reading
the requester would let anyone who can re-run someone's work act as them.

---

## 2. Configuration

Two settings, both `ADMIN`-only and deployment-wide, at `/govern/platform-settings`:

| Setting | Default | Meaning |
|---|---|---|
| `github.userCredentialsEnabled` | `false` | Whether saved tokens may be used. Off, every saved token is inert — kept, so turning it back on needs no re-entry. Users can still remove theirs. |
| `github.userCredentialHosts` | `github.com` | Hosts a token may be sent to, as `host` or `host:port`. Both the repository's web URL and its API URL must be listed. `github.com` also covers `api.github.com`. |

The host list is how an admin permits a GitHub Enterprise server, including one on a private
network: listing it by name is the same explicit opt-in the tracker and knowledge-base connectors
require for a private address. Matching is exact — no wildcards and no suffix matching — and only
over HTTPS.

---

## 3. When a saved token is usable

A token is used only when all of these hold at the moment it is needed:

- `github.userCredentialsEnabled` is on;
- its owner is active, and still a member of the repository's team (platform `ADMIN`s pass this,
  as they do every repository check);
- both of the repository's current URLs — web and API — are on `github.userCredentialHosts`;
- both URLs still have the origins the token was verified against when it was saved.

The last condition binds a token to where its owner confirmed it. A team lead can repoint a
repository's `githubUrl` or `githubApiUrl`; when that happens, saved tokens stop being used rather
than following the repository to a new host, and their owners save them again.

When any condition fails, the run falls back to the platform credential. It never falls back to
another user's token.

---

## 4. Saving a token

From the dashboard: **Connections** → a repository → **My token**. Over the API:

| Route | Who | Does |
|---|---|---|
| `GET /api/v1/repositories/credentials/mine` | any signed-in user | The policy, and which repositories the caller has saved a token for. Never returns a token. |
| `PUT /api/v1/repositories/:id/credential` | a member of the repository's team | Save or replace the caller's token |
| `DELETE /api/v1/repositories/:id/credential` | the token's owner | Remove it — allowed with the feature off, and after leaving the team |

Every route acts on the caller's own token. There is no route that reads, lists or removes
another user's token, `ADMIN` included; deleting the user or the repository removes it.

Saving is refused unless the feature is on, the repository is an active `git_repo`, both of its
hosts are allowed, and GitHub confirms the token's owner has **write** access to the repository —
runs push a branch and open a pull request, so a read-only token would only fail later. The token
is checked with `GET /repos/{owner}/{repo}` and its `permissions`.

The token is stored AES-256-GCM encrypted (`connection_credentials`), is covered by
`yarn keys:rotate`, and only its last four characters are ever returned. Saves and removals are
written to the governance audit log as `ConnectionCredential`, without the token.

The narrowest token that works is a fine-grained token scoped to the one repository with
**Contents** and **Pull requests** write access.

---

## 5. Repository access gating

When [repository access gating](./repo-access-gating.md) is on, a launch whose run acts as the
caller — the paths in §1 that record a launcher — judges a caller with a usable saved token by that
token: GitHub is asked what the token's owner may do with the repository, rather than what the
stored GitHub login may do. That is the identity the run acts as, it needs no linked GitHub
account, and it works on a GitHub Enterprise host whose usernames the github.com login does not
name.

A launch whose run uses the platform credential — Slack, schedules — is judged by the login as it
always was, whatever the caller saved. Judging it by their token would refuse for a token the run
never touches, or admit someone on an identity the run does not act as.

The scheduled sweep and the webhook refresh prefer the token where one is usable, and fall back to
the login-based lookup where it is not. A token GitHub rejects, or that
cannot see the repository, refuses a launch with `user-credential-rejected` rather than retrying
against the login: the run would use that token and fail the same way. Saving a token records the
verification answer in `repo_access` like any other lookup.

---

## Limitations

- **Scheduled, webhook and Slack runs never use a saved token.** None of them carries an
  authenticated launcher: a cron fire has no user, a schedule's contents can be changed by others
  after it was created, and Slack identifies a person through a linked account rather than a
  session. Against a repository with no platform credential, those runs fail with a configuration
  error.
- **Other people can steer a run that acts as you.** A human step, a review comment fed to the
  review fixer, or a Slack thread steer can be answered by anyone the existing rules allow, and the
  run keeps acting with its launcher's token. This is the same exposure the platform credential
  always had; a personal token usually reaches more repositories than the one being worked on, so
  scope it to this one.
- **The access check reads the owner's role, not the token's scopes.** GitHub reports a
  fine-grained token's owner as `admin` even when the token itself can only read, so such a token
  passes both the save check and the access gate and then fails when the run pushes.
- **Webhooks still use the platform's secret.** The `signal` CI wait strategy needs GitHub to
  deliver webhooks signed with the platform's webhook secret, which a user cannot configure on a
  repository they connected themselves. A deployment whose repositories are reached through user
  tokens sets the CI wait strategy to `poll` at `/govern/workflow-defaults`; it is deployment-wide,
  not per repository.
- **A repository belongs to one team.** A user outside that team cannot save a token for it, and
  cannot onboard the same repository into their own team: `organizationName`/`repoName` are unique
  across the deployment, and that uniqueness does not include the host.
- **Runs in flight keep their identity.** Removing a token, or turning the feature off, takes
  effect on the next GitHub call; a call already made is not undone, and a pull request already
  opened stays attributed to the token's owner.
- **CI logs on another host are fetched with the platform credential.** A user token is sent only
  to the repository's own web and API origins; a log URL anywhere else gets the platform token
  where that origin is trusted, or no token at all.
