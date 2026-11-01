# GitHub App setup

auto-swe supports two GitHub authentication modes:

- **PAT (Personal Access Token)** — the original mode; a single long-lived token stored encrypted in the DB.
- **GitHub App installation token** — short-lived (1 hour), scoped to specific repositories, fully auditable per-installation. Recommended for production.

The two modes are controlled by the **Auth mode** field in Admin → Integrations → GitHub. When set to `auto` (the default), the system uses the App if all four App fields are configured, otherwise it falls back to the PAT.

---

## Why GitHub App over PAT

| Concern | PAT | GitHub App |
|---|---|---|
| Token lifetime | Never expires (until revoked) | 1 hour |
| Scope | All repos the user can access | Only repos the installation covers |
| Audit trail | Shows as a user action | Shows as the App's name |
| User dependency | Tied to a personal account | Tied to an org/installation |
| Rate limits | Per-user | Higher per-installation limits |

---

## Creating the GitHub App

### github.com

1. Go to your organization settings: `https://github.com/organizations/<org>/settings/apps`
   (or for a personal account: `https://github.com/settings/apps`)
2. Click **New GitHub App**.
3. Fill in the form:
   - **GitHub App name**: `auto-swe` (or any unique name)
   - **Homepage URL**: your auto-swe dashboard URL
   - **Webhook URL**: `<your-gateway-url>/api/v1/webhooks/git`
     (add a second webhook or use the same URL for CI events at `/api/v1/webhooks/ci`)
     These routes have their own per-address request ceiling (`WEBHOOK_RATE_LIMIT_MAX`, default 6000 per window); size it above the App's peak delivery rate, because GitHub does not retry a `429` (see [deployment.md](./deployment.md#limitations)).
   - **Webhook secret**: any random string — save it; you will also enter it in the PAT/webhook card
4. Set **Repository permissions**:
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Checks: **Read**
   - Actions: **Read** — reading a failed workflow run's jobs and logs for
     [CI failure triage](./ci-failure-triggers.md). An installation created before this permission
     was added has to accept it (GitHub asks the installation owner) before those logs can be read
   - Issues: **Read and write** — issue-label automations read labels
     ([automations.md](./automations.md#31-issue-labels)); pull-request feedback posts its
     summary comment and command-triggered replies through issue comments
     ([pr-feedback.md](./pr-feedback.md)). An installation that only ever needed label reads
     carries the narrower **Issues: Read** until an admin re-accepts the wider permission
   - Metadata: **Read** (mandatory)
5. Set **Subscribe to events**:
   - Pull request
   - Check run
   - Workflow run — only needed for [CI-failure triggers](./ci-failure-triggers.md) (event
     [automations](./automations.md) of failed runs); a delivery for a
     repository with no trigger is acknowledged and ignored
   - Issues — only needed for [issue-label automations](./automations.md#31-issue-labels); a
     labelling on a repository with no matching automation is acknowledged and ignored
   - Pull request review, Pull request review comment and Issue comment — only needed for
     [pull-request feedback](./pr-feedback.md); a delivery on a repository with no matching
     automation is acknowledged and ignored

   GitHub delivers the App's `installation` events (`deleted`, `suspend`, `unsuspend`) to the webhook
   URL by default; they cannot be subscribed to or unsubscribed from. auto-swe treats a delivery only
   as a prompt: it asks GitHub (`GET /app/installations/{id}`, with the App JWT of the installation's
   own host) and applies the state GitHub reports, so a forged or replayed event that GitHub
   contradicts changes nothing, and a host with no App credentials, or a lookup that fails, changes
   nothing. Only installations an admin has recorded are touched: an uninstall or suspension retires
   the installation, a report of "active" reactivates one a webhook retired, and an account rename
   (`installation_target`, when GitHub sends it) updates the account login read from GitHub. Otherwise
   an admin updates the login by hand. Lookups on a
   GitHub Enterprise Server host go to `https://<host>/api/v3`; a host served over plain http or on a
   non-default API path gets no webhook-driven installation changes (the lookup fails and nothing
   changes). It never creates an installation, and never
   reverses a retirement an admin made. Each change is written to the audit log. The events are
   accepted at `/api/v1/webhooks/git` and at `/api/v1/webhooks/access`, and are verified and bound
   to a host like every other delivery; a delivery signed with the instance secret that names another
   enterprise host is ignored.
6. Under **Where can this GitHub App be installed?**, choose **Only on this account** for a private org app, or **Any account** if you want to share it.
7. Click **Create GitHub App**.
8. On the next page, note the **App ID** (shown at the top of the settings page).
9. Scroll down to **Client secrets** → **Generate a new client secret**. Save it immediately — it is shown only once.
10. Scroll down to **Private keys** → **Generate a private key**. A `.pem` file downloads automatically. Keep it safe.

### GitHub Enterprise Server

The same steps apply; navigate to your GHE instance's settings instead of github.com, and set the
instance's web and API URLs at `/admin/integrations → GitHub`.

**Webhook secret for an additional GHE host.** The webhook secret in the GitHub integration belongs
to the instance's own host. For a repository on a further GitHub Enterprise Server host, first list
that host in the `github.repositoryHosts` setting. Then, at `/admin/integrations → GitHub`, add a
**Per-host webhook secret** with the host exactly as that server sends it in
`X-GitHub-Enterprise-Host` (lowercase, with `:port` if it is not 443) and the secret configured on
that server's webhook. Deliveries naming that host are then verified with that secret alone; a
host without one uses the instance secret.

GitHub documents that header as a hostname, so a delivery matches the row for exactly its
`host[:port]` first and otherwise the one row with that hostname, whatever its port. The row's host
must stay approved (the integration's own host or listed in `github.repositoryHosts`): a row whose
host has lost its approval verifies nothing, and its deliveries are refused rather than checked
against the instance secret.

The secret also binds the delivery to its host: a delivery verified with a host's secret is acted
on only for repositories on that host, and one verified with the instance secret is not acted on
for repositories on a host that has a secret of its own. See [repositories.md](./repositories.md).

A repository's own GitHub URL and API URL are **host overrides**. They accept only a bare host (with
`/api/v3` allowed on the API URL), never a repository URL, and the host must be the configured
instance's or one an ADMIN listed under the `github.repositoryHosts` setting; any team lead may set
an approved host. A platform credential — a PAT, an App JWT, an installation token — is valid on one
GitHub host only and is **never** sent anywhere else: an App's id, private key and installations all
belong to the host it is registered on, so an installation cannot exist on another one. The
credentials in the GitHub integration belong to the instance's own host. A repository on a different
approved host is reached with credentials recorded for that host (below), or otherwise only with a
user's own saved token (bound to the origins it was verified on). The worker and the permission
lookups re-check the host before sending any credential, so a row that fails the check cannot receive
one however it was written.

### An App on another host

Each GitHub host has its own App registrations, so a host other than the instance's has its own App
(or PAT), recorded at `/admin/integrations → GitHub → Per-host credentials`:

1. List the host in `github.repositoryHosts`.
2. Register and install the App on that host, following the steps above on that host's settings.
3. Add **Per-host credentials** for the host: the App ID and the private key (and/or a PAT). Use the
   host as a family key — `ghe.corp`, `ghe.corp:8443`, `acme.ghe.com`, or `github.com` when the
   instance is not on github.com.
4. Record each installation at `/admin/github-installations` with the **Host** field set to that
   host. The same numeric installation id may exist on two hosts; the pair is the identity.
5. Point each repository on that host at its installation (an admin action). A repository cannot
   be pointed at an installation recorded for another host.

Tokens for that host are minted at that host's API with that host's App. There is no singleton
installation id for a host, so a repository with no installation of its own uses the host's PAT, and
a host with only an App needs an installation recorded for every repository on it. A data-residency
tenant (`<tenant>.ghe.com`) that is not the instance can have credentials too, though not a
per-host webhook secret.

---

## Installing the App on an org or repo

1. From your App's settings page, click **Install App** in the left sidebar.
2. Choose the organization (or personal account) and click **Install**.
3. Select **Only select repositories** and add the repos auto-swe will work on (or choose **All repositories**).
4. After installing, the URL in your browser changes to something like:
   `https://github.com/organizations/<org>/settings/installations/12345678`
   The number at the end is the **Installation ID**.

---

## Configuring in auto-swe

Go to **Admin → Integrations → GitHub → App authentication (optional)**.

| Field | Where to find it |
|---|---|
| App ID | App settings page, top section |
| Client ID | App settings page, next to App ID |
| Client secret | Generated in step 9 above |
| Private key (PEM) | Contents of the downloaded `.pem` file |
| Installation ID | URL after installing the App (see above) |
| Auth mode | `auto` uses the App when all fields are set; `app` forces App; `pat` forces PAT |

Paste the entire PEM contents (including the `-----BEGIN/END-----` lines) into the **Private key** textarea.

Click **Save**. The gateway encrypts and stores all fields using AES-256-GCM (same envelope as provider credentials).
Before it does, it refuses (400) an App ID that is not numeric, a private key that does not parse
as a PEM private key, and a personal access token that starts or ends with whitespace — the same
checks a per-host credential gets — so a credential that could never authenticate is not stored.

---

## Auth mode options

| Value | Behaviour |
|---|---|
| `auto` (default) | Uses App if App ID + private key + installation ID are all set; otherwise falls back to PAT |
| `app` | Always uses the GitHub App; throws at activity time if the App fields are not configured |
| `pat` | Always uses the PAT; ignores App fields even if configured |

---

## How installation tokens work

Installation tokens are minted by `resolveGitHubToken()` in `packages/shared/src/lib/githubInstallation.ts`, for the worker (git clone, fetch, push and Octokit calls) and for the gateway (webhook-time pull request and check-run reads, repository listing, the sign-in organization check, and permission lookups). The worker calls it through `requireGitHubToken()` in `packages/worker/src/lib/githubAuth.ts`, which converts a missing-config error, a host mismatch, or a repository the installation cannot see into a Temporal `ApplicationFailure.nonRetryable` so the workflow fails fast instead of retrying indefinitely:

1. Checks a module-level in-memory cache keyed by installation id, API host and the repositories the token is restricted to, and validated against a digest of the App id and private key. If a valid cached token exists, returns it immediately.
2. Otherwise, builds a GitHub App JWT (RS256 via `node:crypto`, 10-minute expiry) and calls `POST /app/installations/:id/access_tokens` on the GitHub API, with a `repositories` restriction when the caller named repositories (see below).
3. GitHub returns a token and its `expires_at` timestamp. The worker caches the token until 60 seconds before that expiry — so the effective TTL tracks GitHub's actual token lifetime (typically ~1 hour), not a hardcoded window.
4. On worker restart the cache is empty and a new token is fetched on the first activity call.

The connection test for App mode in the admin UI only validates that the fields are present and returns a descriptive message; a token is first minted when the gateway or the worker first needs one.

### Repository scope

An installation token is restricted, with the API's `repositories` parameter, to the repository the
work is for. Every token minted through a repository's `installationTargetFor(...)` target names that
one repository: the clone, fetch and push credential that enters an agent workspace, the worker's
Octokit calls (pull requests, comments, review threads, CI status and logs, permission lookups), and
the gateway's webhook-time pull-request and check-run reads. A compromised agent holding such a token
cannot use it against any other repository the App is installed on. The `permissions` of the token are
not narrowed: it carries the permissions the App was granted.

A run that checks out dependency repositories (`full_checkout`, up to four, under `/workspace/deps`)
gets one token per repository, not one token for the set, minted only for the dependencies it clones. Each dependency may belong to a different
installation, which a single token cannot span; and the dependency token is used only for its own
read-only clone, so it is never the credential the target repository's pushes use. A repository
whose token cannot be minted is simply not checked out.

Work that spans the installation is not narrowed: listing the installation's repositories, the
identity and organization-membership checks, skill-source imports, and fetching CI logs for a logs
URL that arrives without a repository mint an unrestricted token. The
cache keeps the two apart, so a narrow token is never served for a wider request or the reverse.

---

## Limitations

- A personal access token cannot be narrowed. A PAT (including a host's PAT credential and a user's
  own saved token) carries all the repositories its owner can reach, and a deployment that uses one
  gets none of the per-repository restriction above.
- Only the repository scope is narrowed. The token keeps all of the App's permissions on that
  repository.
- The repository is named by the name stored on its connection; no immutable GitHub repository id
  is stored. When GitHub reports that name as not accessible to the installation, the platform asks
  GitHub for the repository under that name (GitHub follows a rename), mints once more restricted
  to its id, and logs a warning naming the stale and the current name so an operator can update the
  connection. A renamed repository therefore keeps working, at the cost of one extra lookup (made with an
  unrestricted token that never leaves the minting function) the first time its token is minted.
  A repository that is not selected for the App, or a request that carries no owner, fails
  non-retryably: `REPO_NOT_VISIBLE_TO_INSTALLATION` on the worker, and `repo-not-found`
  (unanswered, so access checks fail closed) for a permission lookup. A `422` whose message does not
  say the repository is missing or inaccessible (GitHub also uses it for a throttled endpoint) is an
  ordinary, retryable failure. A repository GitHub reports under a different owner (a transfer) is
  treated as not visible. After a rename, the token scoped to the renamed repository stays cached
  under the old name for up to the token's lifetime, so a new repository created later under the old
  name and selected for the App gets a failing token until it expires; that fails closed.
- One token is minted per repository, so a run over several repositories makes one
  `access_tokens` request for each instead of sharing the installation's single cached token.
- The unrestricted tokens listed above still carry the installation's full repository scope; none of
  them is placed in an agent workspace.

---

## Rotating the private key

1. In the GitHub App settings, generate a new private key. GitHub lets you have multiple active keys.
2. In the admin UI, paste the new PEM into the Private key field and click Save.
3. Delete the old key from the GitHub App settings once you have confirmed the worker picks up the new one (watch the worker logs for a successful installation token request).

The in-process cache key includes a fingerprint of the private key, so the cache is automatically invalidated the next time any activity calls `requireGitHubToken()` after you save the new key — no worker restart required.
