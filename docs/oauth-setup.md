# OAuth setup — GitHub & Google

Step-by-step for wiring **GitHub** and **Google** sign-in via better-auth. Magic-link works out of the box and needs no provider registration.

Both providers follow the same shape: register an OAuth app on the provider's developer console, copy the client id + secret into the admin dashboard at `/admin/integrations → OAuth tab`, restart the gateway, and the buttons appear on `/login` automatically. The login page reads `GET /api/v1/auth/providers` at load time and only renders buttons for providers whose credentials are present (in the DB or env).

> **Env var fallback.** `GITHUB_CLIENT_ID/SECRET` and `GOOGLE_CLIENT_ID/SECRET` are still accepted as environment variables for backwards compatibility, but the admin UI is the preferred path. If both are set, the DB row wins.

> **Gateway base URL.** Throughout this doc, `{BETTER_AUTH_URL}` is the URL the gateway is reachable at — typically `http://localhost:8080` in dev and your real domain in production. Set `BETTER_AUTH_URL` in `.env` accordingly; the OAuth callback URLs you register with the providers must match this base.

---

## GitHub

### 1. Register an OAuth app

1. Sign in to GitHub and open **Settings → Developer settings → OAuth Apps → New OAuth App**.
   Direct link: <https://github.com/settings/applications/new>
2. Fill in the form:

   | Field                      | Value                                                                 |
   | -------------------------- | --------------------------------------------------------------------- |
   | Application name           | `auto-swe` (or `auto-swe-dev` if you keep dev / prod apps separate)   |
   | Homepage URL               | `{BETTER_AUTH_URL}` — e.g. `http://localhost:8080` for dev            |
   | Authorization callback URL | `{BETTER_AUTH_URL}/api/auth/callback/github`                          |
   | Application description    | _(optional — anything)_                                               |

3. Click **Register application**.
4. On the next screen, click **Generate a new client secret** and copy both the **Client ID** and the **Client secret**.

### 2. Add credentials via the admin UI

1. Sign in as admin and go to `/admin/integrations → OAuth tab`.
2. Enter the **GitHub OAuth Client ID** and **GitHub OAuth Client Secret**.
3. Click **Save**.

> **Alternative (env var).** You can still set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env` — the gateway reads them as a fallback when no DB row exists. The admin UI is preferred for production deployments.

### 3. Restart the gateway

Because BetterAuth reads OAuth credentials once at startup, a gateway restart is required after saving.

```sh
yarn dev:gateway     # or yarn dev to bounce everything
```

The UI shows a yellow "restart required" banner after saving to remind you.

Refresh the login page. The **Continue with GitHub** button should now appear. Click it, authorize on GitHub, and you'll be returned to `/login?bridge=1` with a fresh better-auth session that's auto-exchanged for a JWT.

### Production-only extras

- **Public homepage**: GitHub requires a real homepage URL for apps used in production. Set `Homepage URL` to your real domain.
- **Privacy policy URL**: not strictly required, but submitting one makes the OAuth consent screen look more trustworthy.
- **Org-level apps**: if you want the app owned by an organization (so multiple maintainers can rotate the secret), create it under **Org settings → Developer settings → OAuth Apps** instead of your personal account.
- **GitHub App vs OAuth App**: this guide uses **OAuth App** (simpler). GitHub Apps are heavier — they're scoped to repos/installations and need a separate flow. Stick with OAuth App unless you need fine-grained per-repo access for something else.

---

## Google

### 1. Create / pick a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Pick an existing project from the top-bar dropdown, or click the dropdown → **New Project**, name it (e.g. `auto-swe`), and create.

### 2. Configure the OAuth consent screen (first time only per project)

1. **APIs & Services → OAuth consent screen** (left sidebar).
2. Choose **External** if you're not in a Google Workspace org. (Internal is for Workspace-only.)
3. Fill the required fields:

   | Field                       | Value                                                         |
   | --------------------------- | ------------------------------------------------------------- |
   | App name                    | `auto-swe`                                                    |
   | User support email          | your email                                                    |
   | App logo                    | _(optional)_                                                  |
   | App domain — Application home page | `{BETTER_AUTH_URL}` (or your real domain in prod)       |
   | Developer contact email     | your email                                                    |

4. **Scopes step**: leave at the default `.../auth/userinfo.email` + `.../auth/userinfo.profile` + `openid`. These are what better-auth requests.
5. **Test users step**: if you're staying in "Testing" publishing status (the default), add the email addresses you want to sign in with — only listed test users can sign in until you publish to production.
6. Save.

### 3. Create OAuth client credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type**: **Web application**.
3. **Name**: `auto-swe — dev` (or similar — names are private).
4. **Authorized JavaScript origins**: optional — only needed for client-side ID-token flows. Leave empty for the standard server-side flow we use.
5. **Authorized redirect URIs**: add:

   ```text
   {BETTER_AUTH_URL}/api/auth/callback/google
   ```

   Example for local dev: `http://localhost:8080/api/auth/callback/google`.

6. Click **Create**. Copy the **Client ID** and **Client secret** from the modal.

### 4. Add credentials via the admin UI

1. Sign in as admin and go to `/admin/integrations → OAuth tab`.
2. Enter the **Google OAuth Client ID** and **Google OAuth Client Secret**.
3. Click **Save**.

> **Alternative (env var).** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` still work as a fallback.

### 5. Restart the gateway

```sh
yarn dev:gateway
```

The **Continue with Google** button now appears on `/login`.

### Production-only extras

- **Publish the consent screen**: by default new OAuth clients sit in "Testing" mode, which limits sign-in to the test-user allowlist and shows a scary "unverified app" warning. To remove both, hit **OAuth consent screen → Publish app**. For the basic email/profile/openid scopes we use, no Google review is required — clicking publish flips the status to "In production" immediately.
- **Custom domain in the consent screen**: requires verifying your domain via Google Search Console. Otherwise the consent screen shows the raw `accounts.google.com` URL only, which is fine for internal tools.
- **Refresh tokens**: better-auth handles refresh transparently. Nothing to configure on the Google side.

---

## Production checklist

Before flipping a deployment from dev to prod, confirm:

| Item                                       | Status                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `BETTER_AUTH_URL` matches the deployed URL | Required — used as the OAuth callback base                               |
| `BETTER_AUTH_SECRET` set, ≥ 32 chars       | Required — gateway throws at boot otherwise                              |
| `JWT_SECRET` (or key pair) set             | Required — gateway throws at boot otherwise                              |
| GitHub OAuth credentials configured        | Optional — button hides when absent. Set via `/admin/integrations → OAuth` or env var. |
| Google OAuth credentials configured        | Optional — button hides when absent. Set via `/admin/integrations → OAuth` or env var. |
| `RESEND_API_KEY` + `AUTH_FROM_EMAIL`       | Required if you want magic-link emails sent for real (else stdout-only)  |
| OAuth callbacks point at the prod URL      | GitHub + Google consoles must list the right callback URL                |
| Google consent screen published            | Else sign-ins are limited to the test-user list                          |

---

## Troubleshooting

**"redirect_uri_mismatch" on Google**
The redirect URI you registered doesn't match what better-auth is sending. Double-check the spelling — it must be `{BETTER_AUTH_URL}/api/auth/callback/google` exactly. No trailing slash, scheme must match (`http://` for dev, `https://` for prod).

**"The redirect_uri MUST match the registered callback URL" on GitHub**
Same issue as above. Note GitHub treats `http://localhost:8080` and `http://127.0.0.1:8080` as different — pick one consistently.

**Button doesn't appear on the login page**
Hit `GET /api/v1/auth/providers` directly:

```sh
curl http://localhost:8080/api/v1/auth/providers
```

You should see `{"github":true,"google":true,"magicLink":true}` for the providers whose credentials are configured. If a provider shows `false`, the gateway didn't pick up its credentials — confirm they're saved in `/admin/integrations → OAuth` tab, then restart `yarn dev:gateway` (a restart is always required for OAuth credential changes to take effect).

**"Access blocked: this app's request is invalid" (Google)**
Usually the consent screen is incomplete (missing support email, missing scopes, etc.) — finish the OAuth consent screen flow in step 2 above.

**"Sign in completed but no session was found"**
The OAuth callback succeeded but the gateway couldn't validate the resulting session cookie. Most common cause: the browser blocked the cookie because `BETTER_AUTH_URL` and the page origin don't match the cookie's SameSite policy. Check that `BETTER_AUTH_URL` in `.env` is exactly what the browser sees in the URL bar when it hits the gateway.

**Want to test without going to a provider?**
Skip OAuth and use magic-link instead — it works out of the box with no provider registration. In dev, the link prints to gateway stdout.
