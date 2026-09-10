# OAuth setup — GitHub, Google & Okta

Step-by-step for wiring **GitHub**, **Google**, and **Okta** (enterprise SSO) sign-in via better-auth. Magic-link works out of the box and needs no provider registration.

All three providers follow the same shape: register an OAuth app on the provider's developer console, copy the client id + secret into the admin dashboard at `/studio/integrations` (GitHub credentials on the **GitHub tab**, Google and Okta credentials on the **OAuth tab**), restart the gateway, and the buttons appear on `/login` automatically. The login page reads `GET /api/v1/auth/providers` at load time and only renders buttons for providers whose credentials are present (in the DB or env).

> **Env var fallback.** `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, and `OKTA_ISSUER` / `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET` are still accepted as environment variables for backwards compatibility, but the admin UI is the preferred path. If both are set, the DB row wins.

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

1. Sign in as admin and go to `/studio/integrations → GitHub tab`.
2. Enter the **OAuth App Client ID** and **OAuth App Client Secret** (in the OAuth section of the GitHub tab — not the GitHub App fields, which are for repo access).
3. Click **Save**. The tab also displays the exact callback URL to register, with a copy button.

> **Alternative (env var).** You can still set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env` — the gateway reads them as a fallback when no DB row exists. The admin UI is preferred for production deployments.

### 3. Restart the gateway

Because BetterAuth reads OAuth credentials once at startup, a gateway restart is required after saving.

```sh
yarn dev:gateway     # or yarn dev to bounce everything
```

The UI shows a yellow "restart required" banner after saving to remind you.

Refresh the login page. The **Continue with GitHub** button should now appear. Click it, authorize on GitHub, and you'll be returned to `/login?bridge=1` with a fresh better-auth session cookie — subsequent API calls authenticate via that session.

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

1. Sign in as admin and go to `/studio/integrations → OAuth tab`.
2. Enter the **Google OAuth Client ID** and **Google OAuth Client Secret**.
3. Click **Save**. The tab also displays the exact callback URL to register, with a copy button.

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

## Okta (enterprise SSO)

Okta is wired through better-auth's **generic-OAuth plugin**, using OIDC discovery rather than a hand-written endpoint list. The plugin registers Okta into the same provider list the built-ins live in, so sign-in, the callback, and account linking all use the ordinary `/api/auth/**` routes — `okta` is just another provider id.

### 1. Create an app integration in Okta

1. Sign in to the **Okta Admin Console** and open **Applications → Applications → Create App Integration**.
2. Choose **OIDC — OpenID Connect** as the sign-in method and **Web Application** as the application type, then **Next**.
3. Fill in the form:

   | Field                       | Value                                                                 |
   | --------------------------- | --------------------------------------------------------------------- |
   | App integration name        | `auto-swe`                                                            |
   | Grant type                  | **Authorization Code** (leave the default; refresh token is optional) |
   | Sign-in redirect URIs       | `{BETTER_AUTH_URL}/api/auth/callback/okta`                            |
   | Sign-out redirect URIs      | your web app origin, e.g. `http://localhost:3000` — optional          |
   | Assignments                 | the groups or users who should be able to sign in                     |

4. Click **Save**, then copy the **Client ID** and **Client secret** from the app's **General** tab.

### 2. Find the issuer URL

The issuer is the **authorization server**, not the org URL. In the Admin Console go to **Security → API → Authorization Servers** and copy the **Issuer URI** of the server you want to use — the built-in one is named `default`:

```
https://dev-12345.okta.com/oauth2/default
```

Confirm it is right by opening its discovery document in a browser — it must return JSON:

```
https://dev-12345.okta.com/oauth2/default/.well-known/openid-configuration
```

> **Org authorization server.** If your tenant uses the org-level server instead of a custom one, the issuer is the bare org URL (`https://dev-12345.okta.com`) and the discovery path is `/.well-known/openid-configuration` off that. Both forms work — paste whichever one the console shows.

### 3. Add credentials via the admin UI

1. Sign in as admin and go to `/studio/integrations → OAuth tab`.
2. In the **Sign in with Okta** card, enter the **Issuer URL**, **Client ID**, and **Client secret**.
3. Click **Save**. The card echoes back the discovery URL the gateway will fetch and the callback URL to register, each with a copy button.

All three fields are required — the login button stays hidden until every one is present, because a partially configured provider would fail at the callback rather than at save time.

> **Issuer must be public HTTPS.** The gateway fetches the discovery document server-side, so the issuer goes through the same SSRF guard as every other operator-supplied URL: `http://`, loopback, RFC1918, link-local and cloud-metadata addresses are rejected with a 400.

> **Alternative (env var).** `OKTA_ISSUER`, `OKTA_CLIENT_ID`, and `OKTA_CLIENT_SECRET` in `.env` work as a fallback when no DB row exists.

### 4. Restart the gateway

```sh
yarn dev:gateway
```

The restart matters more here than for GitHub/Google: the OIDC discovery document is fetched **once at startup**, and that is when the authorization, token, userinfo and JWKS endpoints get resolved. The **Continue with Okta** button then appears on `/login`.

If Okta is unreachable at that moment, the gateway still boots — the discovery failure is logged, not thrown — but Okta sign-in stays broken until the gateway is restarted against a reachable issuer.

### Notes

- **Account linking.** Okta joins GitHub and Google in better-auth's trusted-provider set when configured, so a user who already exists under the same verified email is linked to that existing account rather than duplicated. Email+password deliberately stays untrusted.
- **Approval queue.** Okta sign-ups land with `isActive=false` like every other new user and wait for an admin to approve them at `/govern/users`. Group-based auto-approval is not implemented — Okta group claims are not read.
- **SAML.** Only OIDC is supported. Okta's SAML app type will not work; create an **OIDC — Web Application** integration.

---

## Production checklist

Before flipping a deployment from dev to prod, confirm:

| Item                                       | Status                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `BETTER_AUTH_URL` matches the deployed URL | Required — used as the OAuth callback base                               |
| `BETTER_AUTH_SECRET` set, ≥ 32 chars       | Required — gateway throws at boot otherwise                              |
| `JWT_SECRET` (or key pair) set             | Required — gateway throws at boot otherwise                              |
| GitHub OAuth credentials configured        | Optional — button hides when absent. Set via `/studio/integrations → GitHub` or env var. |
| Google OAuth credentials configured        | Optional — button hides when absent. Set via `/studio/integrations → OAuth` or env var. |
| Okta issuer + credentials configured       | Optional — button hides unless all three are present. Set via `/studio/integrations → OAuth` or env var. |
| `RESEND_API_KEY` + `AUTH_FROM_EMAIL`       | Required if you want magic-link emails sent for real (else stdout-only)  |
| OAuth callbacks point at the prod URL      | GitHub, Google, and Okta consoles must list the right callback URL       |
| Okta discovery URL reachable from the gateway | Fetched at boot; an unreachable issuer leaves Okta sign-in broken until the next restart |
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

You should see `{"github":true,"google":true,"magicLink":true,"okta":true}` for the providers whose credentials are configured. If a provider shows `false`, the gateway didn't pick up its credentials — confirm they're saved in `/studio/integrations` (GitHub tab for GitHub, OAuth tab for Google and Okta), then restart `yarn dev:gateway` (a restart is always required for OAuth credential changes to take effect). `okta` reports `false` unless the issuer, client id **and** client secret are all set.

**"Access blocked: this app's request is invalid" (Google)**
Usually the consent screen is incomplete (missing support email, missing scopes, etc.) — finish the OAuth consent screen flow in step 2 above.

**Okta button missing even though credentials are saved**
All three Okta fields must be present. Check `GET /api/v1/auth/providers` — if `okta` is `false`, one of issuer / client id / client secret is blank, or the gateway hasn't been restarted since the save.

**Okta sign-in fails right after a gateway restart**
Look for a discovery error in the gateway log at boot. The most common causes are a typo'd issuer (use the Issuer URI from **Security → API → Authorization Servers**, not the org URL with a path guessed onto it) and the gateway being unable to reach Okta at startup. Confirm by opening `{issuer}/.well-known/openid-configuration` — it must return JSON.

**"The 'redirect_uri' parameter must be a Login redirect URI" (Okta)**
The Sign-in redirect URI registered on the Okta app doesn't match `{BETTER_AUTH_URL}/api/auth/callback/okta` exactly — scheme, host, port and path all have to match.

**"Sign in completed but no session was found"**
The OAuth callback succeeded but the gateway couldn't validate the resulting session cookie. Most common cause: the browser blocked the cookie because `BETTER_AUTH_URL` and the page origin don't match the cookie's SameSite policy. Check that `BETTER_AUTH_URL` in `.env` is exactly what the browser sees in the URL bar when it hits the gateway.

**Want to test without going to a provider?**
Skip OAuth and use magic-link instead — it works out of the box with no provider registration. In dev, the link prints to gateway stdout.
