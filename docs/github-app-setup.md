# GitHub App Setup

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
   - **Webhook secret**: any random string — save it; you will also enter it in the PAT/webhook card
4. Set **Repository permissions**:
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Checks: **Read**
   - Metadata: **Read** (mandatory)
5. Set **Subscribe to events**:
   - Pull request
   - Check run
6. Under **Where can this GitHub App be installed?**, choose **Only on this account** for a private org app, or **Any account** if you want to share it.
7. Click **Create GitHub App**.
8. On the next page, note the **App ID** (shown at the top of the settings page).
9. Scroll down to **Client secrets** → **Generate a new client secret**. Save it immediately — it is shown only once.
10. Scroll down to **Private keys** → **Generate a private key**. A `.pem` file downloads automatically. Keep it safe.

### GitHub Enterprise Server

The same steps apply; navigate to your GHE instance's settings instead of github.com.

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

---

## Auth mode options

| Value | Behaviour |
|---|---|
| `auto` (default) | Uses App if App ID + private key + installation ID are all set; otherwise falls back to PAT |
| `app` | Always uses the GitHub App; throws at activity time if the App fields are not configured |
| `pat` | Always uses the PAT; ignores App fields even if configured |

---

## How installation tokens work

When the worker needs a GitHub token (for git clone or Octokit calls), it calls `requireGitHubToken()` in `packages/worker/src/lib/githubAuth.ts`, which delegates to `resolveGitHubToken()` and converts a missing-config error into a Temporal `ApplicationFailure.nonRetryable` so the workflow fails fast instead of retrying indefinitely:

1. Checks a module-level in-memory cache keyed by `appId | installationId | last-20-chars-of-privateKey`. If a valid cached token exists, returns it immediately.
2. Otherwise, builds a GitHub App JWT (RS256 via `node:crypto`, 10-minute expiry) and calls `POST /app/installations/:id/access_tokens` on the GitHub API.
3. GitHub returns a token and its `expires_at` timestamp. The worker caches the token until 60 seconds before that expiry — so the effective TTL tracks GitHub's actual token lifetime (typically ~1 hour), not a hardcoded window.
4. On worker restart the cache is empty and a new token is fetched on the first activity call.

The gateway does **not** generate installation tokens — the connection test for App mode simply validates that the fields are present and returns a descriptive message. Token generation is validated when the worker processes its first activity.

---

## Rotating the private key

1. In the GitHub App settings, generate a new private key. GitHub lets you have multiple active keys.
2. In the admin UI, paste the new PEM into the Private key field and click Save.
3. Delete the old key from the GitHub App settings once you have confirmed the worker picks up the new one (watch the worker logs for a successful installation token request).

The in-process cache key includes a fingerprint of the private key, so the cache is automatically invalidated the next time any activity calls `requireGitHubToken()` after you save the new key — no worker restart required.
