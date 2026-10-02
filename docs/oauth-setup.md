# OAuth setup

Step-by-step for wiring **GitHub**, **Google**, and **Okta** (enterprise SSO) sign-in via better-auth. Magic-link works out of the box and needs no provider registration.

This page also covers the opposite direction: the platform acting as an OAuth 2.1 authorization server for MCP clients ([below](#the-platform-as-an-oauth-server-for-mcp-clients)).

All three providers follow the same shape: register an OAuth app on the provider's developer console, put the client id + secret in the gateway's environment, restart the gateway, and the buttons appear on `/login` automatically. The login page reads `GET /api/v1/auth/providers` at load time and only renders buttons for providers whose credentials are present.

> **Environment only.** Sign-in credentials are read from `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, and `OKTA_ISSUER` / `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET`. There is no admin-UI form for them: better-auth reads them once at gateway startup, so an editable copy could never take effect without a restart anyway. See [`configuration.md`](./configuration.md) for where the line between environment and admin UI falls.

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

### 2. Set the credentials

Set the **OAuth App** client id and secret in the gateway's environment (not the GitHub App fields on `/studio/integrations → GitHub`, which are for repo access):

```sh
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

### 3. Restart the gateway

BetterAuth reads OAuth credentials once at startup, so restart the gateway after changing them.

```sh
yarn dev:gateway     # or yarn dev to bounce everything
```

Refresh the login page. The **Continue with GitHub** button should now appear. Click it, authorize on GitHub, and you'll be returned to `/login?bridge=1` with a fresh better-auth session cookie — subsequent API calls authenticate via that session.

### GitHub Enterprise

To sign in against a GitHub Enterprise (GHE) instance instead of github.com:

1. Register the OAuth app on the GHE instance itself (**Settings → Developer settings → OAuth Apps → New OAuth App**), using the same form values as above. The callback URL is unchanged: `{BETTER_AUTH_URL}/api/auth/callback/github`.
2. On `/studio/integrations → GitHub tab`, set the **Base URL** to the instance (for example `https://ghe.example.com`). Leave the **API URL** blank (or at `https://api.github.com`) and it is derived as `{Base URL}/api/v3`; set it explicitly only if the API lives elsewhere.
3. Set the GHE app's client ID and secret as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in the gateway's environment (not the GitHub App fields).
4. Restart the gateway. OAuth credentials and URLs are read once at startup.

When the saved Base URL's host is not github.com, **Continue with GitHub** behaves as follows:

| Step           | Endpoint                                              |
| -------------- | ----------------------------------------------------- |
| Authorize      | `{Base URL}/login/oauth/authorize`                    |
| Token exchange | `{Base URL}/login/oauth/access_token`                 |
| Profile        | `{API URL}/user`                                      |
| Emails         | `{API URL}/user/emails`                               |

Notes:

- **Primary verified email.** Sign-in is accepted only for an account whose primary email is verified.
- **Account identity.** The linked account is stored as `{host}:{id}`, so numeric ids from github.com and GHE never collide. Accounts created earlier under a bare numeric id are not migrated.
- **Switching hosts.** Accounts created while sign-in used github.com stay in the database but cannot sign in once GHE is active. A user signs in again with the same verified email, which links the new GHE account onto their existing user and replaces the stored GitHub username.
- **One GitHub provider.** GHE sign-in replaces github.com sign-in: both use the single `github` provider id and cannot coexist on one gateway.
- **Email linking.** A sign-in links onto an existing user with the same verified email, so enable GHE sign-in only for an instance whose email verification you trust.
- **Invalid Base URL.** A Base URL that is not an `http` or `https` URL registers no GitHub sign-in; the gateway logs the reason and the login page hides the button.

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

### 4. Set the credentials

```sh
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

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

### 3. Set the credentials

```sh
OKTA_ISSUER=https://dev-12345.okta.com/oauth2/default
OKTA_CLIENT_ID=...
OKTA_CLIENT_SECRET=...
```

All three are required — the login button stays hidden until every one is present, because a partially configured provider would fail at the callback rather than at startup. A trailing slash on the issuer is stripped.

> **The issuer must be public HTTPS.** The gateway fetches its discovery document server-side at boot, so it goes through the same SSRF guard as every other operator-supplied URL: `http://`, loopback, RFC1918, link-local and cloud-metadata addresses are refused. A refused issuer disables Okta sign-in and logs `Okta sign-in disabled: OKTA_ISSUER rejected (…)`; the gateway still boots and the other sign-in methods are unaffected.

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

## The platform as an OAuth server for MCP clients

Sign-in above is the platform *consuming* OAuth. The gateway is also an OAuth 2.1 authorization
server, so an MCP client (an editor, a coding agent) can obtain a token that names this
deployment's MCP resource. It is better-auth's `@better-auth/oauth-provider` plus its `jwt` plugin,
mounted under the same `/api/auth` prefix as sign-in, and off until an admin turns it on. The resource
server that accepts the tokens is described in [mcp-server.md](./mcp-server.md).

| Setting | Default | Effect |
|---|---|---|
| `mcp.enabled` | `false` | The OAuth endpoints listed below and the discovery document return 404 while it is off. |
| `mcp.writeToolsEnabled` | `false` | The `mcp:write` scope is refused at authorization while it is off. |

Both are ADMIN-only, GLOBAL-only registry settings read per request through the settings cache, so a
change applies on every replica within about 30 seconds and needs no restart.

Everything else derives from `BETTER_AUTH_URL` and the first `CORS_ORIGIN` entry, and is fixed when the
gateway starts:

| | Value |
|---|---|
| Issuer (`iss`) | `{BETTER_AUTH_URL}/api/auth` |
| Discovery (RFC 8414) | `{BETTER_AUTH_URL}/.well-known/oauth-authorization-server/api/auth` |
| Resource (RFC 8707) and token audience (`aud`) | `{BETTER_AUTH_URL}/api/v1/mcp` |
| Scopes | `mcp:read`, `mcp:write` (implies read), `offline_access` |
| Client registration | Dynamic (RFC 7591), anonymous, public clients only, PKCE `S256` required |
| Grants | `authorization_code` and `refresh_token` |
| Access token | JWT (`typ: at+jwt`, `EdDSA`), 10 minutes |
| Refresh token | Opaque, stored hashed, rotates on use, 14 days; issued only for `offline_access` |
| Login and consent pages | `{CORS_ORIGIN}/login` and `{CORS_ORIGIN}/oauth/consent` |

Policy is applied by one Fastify plugin (`mcpOAuthGate.ts`) in front of better-auth, not by better-auth
hooks:

- **Allowlist.** Only `authorize`, `consent`, `continue`, `token`, `register`, `revoke` and `public-client`
  under `/api/auth/oauth2/`, the RFC 8414 document (at the root path above only) and `/api/auth/jwks` are served. Every other path of the
  provider (client management, `introspect`, `userinfo`, `end-session`, consent management, the
  `/admin/oauth2/*` endpoints, the OIDC discovery document) and the `jwt` plugin's `GET /api/auth/token`
  are 404. A path is matched in its most generous reading (percent-decoded, case-folded, slashes
  collapsed) and served only on an exact allowlist match; a path that is not in canonical form is 400.
- **Authorization requests** must carry a `resource` that is exactly the MCP resource (otherwise
  `invalid_target`), must be for an active account, and may name `mcp:write` only while
  `mcp.writeToolsEnabled` is on (otherwise `invalid_scope`). With writes off a `scope` is required, because
  an absent one means the scopes the client registered. The gate checks the parameters the plugin will
  use: the body of a `POST` and the query of a `GET`. A `POST` that also carries `scope` or `resource` in its
  query, and any request that repeats either, is refused. The same checks run again on `consent` and
  `continue`, and on `resource` at the token endpoint.
- **Token issuance** is guarded where every audience-bound (JWT) access token is minted, because the
  plugin also resumes an authorization from a sign-in response, which no `/oauth2/*` rule sees. The
  plugin's opaque, audience-less tokens skip that hook, and are unreachable here: `resource` is
  required at authorize and at the token endpoint. On the code and the refresh grant
  alike, issuance is refused (`invalid_grant`) when the account is inactive, when `mcp.enabled` is off, or
  when the scope holds `mcp:write` while `mcp.writeToolsEnabled` is off. The refusal comes before any
  refresh token is stored or rotated, so a refused refresh leaves the client's refresh token usable. While
  `mcp.enabled` is off a sign-in that carries a pending `oauth_query` ignores it and just signs in.
- **Registration** is forced to a public client (`token_endpoint_auth_method` `none`; any other value is
  rejected), refuses a back-channel logout target, and defaults `application_type` to `native` when every
  redirect URI is a loopback `http` address or a private-use scheme (the plugin's default, `web`, rejects
  those). It is limited to 10 requests per minute per client IP.
- **No client management.** `clientPrivileges` and `resourcePrivileges` deny every action, so no signed-in
  user can create, change or delete a client or a resource through the plugin.
- **No session JWT.** The `jwt` plugin does not add a `set-auth-jwt` header to `/get-session`.

The `jwt` plugin signs with an `EdDSA` key stored in `jwks`, encrypted with `BETTER_AUTH_SECRET`. A key signs
for 30 days; it stays published for one more hour so a token signed in its last moments still verifies.

### Signing in, consenting and disconnecting

An authorization that reaches the gateway without a session sends the browser to the web app's
`/login` page with the authorization request in the query, signed by the server. The login page
sends the signed part of its own address back as `oauth_query` with a password or social sign-in.
What happens next depends on the method:

| Sign-in method | Continues the authorization? |
|---|---|
| Password | Yes. The server answers the sign-in with where it continues: the consent page, or the client's own redirect when that client already holds a consent that covers the request. |
| Social (GitHub, Google, Okta) | Yes. The request is kept across the provider round trip, and the callback sends the browser to the consent page. That page is reachable without the dashboard's session marker and establishes the session itself, so a browser that has never signed in to the dashboard works. |
| Magic link | No. The link is verified in a later request that has no memory of the authorization; see Limitations. |

A user who is already signed in goes straight to the consent page. If the consent page is opened with no
session, it offers a sign-in link that carries the signed request to `/login`, which resumes it. An
account that is still awaiting approval never leaves the login page. The login and consent pages send
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so neither can be framed.

The consent page (`/oauth/consent`) shows:

- the app's registered name, marked **unverified**: every client registers itself, and the name is
  whatever it chose;
- the host the user is sent back to, prominently, with a warning when it is a loopback address or an
  app's own URL scheme, which any program on the machine could also be listening on;
- what the app can do, in plain words. **Read** is seeing repositories, work requests, runs and pending
  approvals. **Write** appears only when the app asked for it and `mcp.writeToolsEnabled` is on, as a
  separate unticked choice that notes runs started this way use the user's own GitHub identity and appear
  as them. `offline_access` is described as staying connected for up to 14 days.

Approve sends `POST /api/auth/oauth2/consent` with a `scope` narrowed to what the user left ticked;
Deny sends `accept: false`, and the client receives `access_denied` with `iss`. The page reads the
app's name from `GET /api/auth/oauth2/public-client`, which needs the user's session.

**Settings → Connected apps** lists the signed-in user's grants (`GET /api/v1/me/mcp-grants`: client
name, redirect hosts, scopes, when it was granted) and disconnects one
(`DELETE /api/v1/me/mcp-grants/:clientId`, own grants only; another user's client id is a 404). Both are
ordinary REST routes for the ENGINEER role and work while `mcp.enabled` is off. The section is hidden when
MCP is off and nothing is connected.

Disconnecting is not deleting a consent row, because the refresh grant checks neither the consent nor the
account: a refresh token would outlive its consent, and a later consent by the same client would revive
every refresh token it was ever issued. The code grant does not look for a consent either, so an
authorization code issued before a disconnect and not yet exchanged would mint one afterwards.
`revokeMcpGrants` (`lib/mcpGrants.ts`) therefore deletes the consent rows, deletes the pair's pending
authorization codes (rows of better-auth's `verification` table) and marks every stored refresh and access
token of the user and client revoked, all in one transaction, together with an audit row (`McpGrant`, action `DELETE`, before-state the client and scopes). It is the only code
that deletes a consent: the plugin's own deletion endpoints are 404. Deactivating a user (`PATCH
/api/v1/users/:id` with `isActive: false`) revokes all of their grants the same way, in the same transaction
as the update; any such request revokes, so repeating it after a failure completes the job. When tokens or
codes remain but no consent row does, the audit row names the user as its entity (the client is in the
before-state). A consent that grants
access writes an audit row (`McpGrant`, `CREATE`) after the response; a failure to write it is logged and
does not fail the authorization. Both appear in the audit log with the user as actor, or the admin who
deactivated the account.

A refresh with a revoked token is `invalid_grant`, also after the user consents again. The provider treats
presenting a revoked refresh token as theft and then invalidates every refresh token of that user and
client, so a client that retries with its old token after the user has re-consented has to be authorised
once more.

### Limitations

- The only endpoint that accepts these tokens is the MCP endpoint ([mcp-server.md](./mcp-server.md)); the REST API refuses them.
- Open registration is an anonymous write endpoint. Clients are public, unverified and rate limited, but
  nothing removes expired clients, expired tokens or `oauth_client_assertions` rows, so those tables grow.
- A client that registers without `grant_types` receives only `authorization_code` (the RFC 7591 default) and
  cannot refresh; MCP clients register with both grants.
- Turning `mcp.writeToolsEnabled` off stops new tokens that carry `mcp:write`, on both grants. A token
  already issued keeps the scope until it expires (10 minutes), but the MCP endpoint's verifier drops it from
  the token's effective scopes at once.
- The discovery document is the provider's with introspection, back-channel logout and every client
  authentication method but `none` removed.
- A magic-link sign-in cannot continue an authorization: the link is verified in a later request that
  has no memory of it, so the user lands on the dashboard and the app has to be started again. The login
  page says so while an authorization is pending. Password and social sign-in continue it.
- Cookie-authenticated `POST`s to the provider, the consent decision included, are refused unless their
  `Origin` is a trusted origin (`advanced.disableOriginCheck` is pinned to `false`).
- The consent page and Connected apps work in the same topologies as the dashboard: the browser sends the
  session cookie cross-origin to the gateway. A deployment where that does not work cannot complete an
  authorization either.
- Revocation takes effect at the token endpoint at once. A JWT access token is not stored, so one already
  issued stays valid until it expires (10 minutes) or the resource server, which must require the consent to
  exist, rejects it.
- Rate limits are per gateway replica.

---

## Production checklist

Before flipping a deployment from dev to prod, confirm:

| Item                                       | Status                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `BETTER_AUTH_URL` matches the deployed URL | Required — used as the OAuth callback base                               |
| `BETTER_AUTH_SECRET` set, ≥ 32 chars       | Required — gateway throws at boot otherwise                              |
| `JWT_SECRET` (or key pair) set             | Required — gateway throws at boot otherwise                              |
| GitHub OAuth credentials configured        | Optional — button hides when absent. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. |
| Google OAuth credentials configured        | Optional — button hides when absent. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. |
| Okta issuer + credentials configured       | Optional — button hides unless all three are present. `OKTA_ISSUER` / `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET`. |
| `RESEND_API_KEY` + `AUTH_FROM_EMAIL`       | Required for magic-link emails outside development (dev prints to stdout) |
| OAuth callbacks point at the prod URL      | GitHub, Google, and Okta consoles must list the right callback URL       |
| Okta discovery URL reachable from the gateway | Fetched at boot; an unreachable issuer leaves Okta sign-in broken until the next restart |
| `BETTER_AUTH_URL` is the public HTTPS URL, if MCP clients will connect | The token issuer and audience derive from it; changing it invalidates every issued token and every registered client's resource link |
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

You should see `{"github":true,"google":true,"magicLink":true,"okta":true}` for the providers whose credentials are configured. If a provider shows `false`, the gateway didn't pick up its credentials — confirm the variables are set in the gateway's environment, then restart `yarn dev:gateway` (a restart is always required for OAuth credential changes to take effect). `okta` reports `false` unless the issuer, client id **and** client secret are all set.

**"Access blocked: this app's request is invalid" (Google)**
Usually the consent screen is incomplete (missing support email, missing scopes, etc.) — finish the OAuth consent screen flow in step 2 above.

**Okta button missing even though credentials are set**
All three Okta variables must be present. Check `GET /api/v1/auth/providers` — if `okta` is `false`, one of issuer / client id / client secret is blank, or the gateway hasn't been restarted since the change.

**Okta sign-in fails right after a gateway restart**
Look for a discovery error in the gateway log at boot. The most common causes are a typo'd issuer (use the Issuer URI from **Security → API → Authorization Servers**, not the org URL with a path guessed onto it) and the gateway being unable to reach Okta at startup. Confirm by opening `{issuer}/.well-known/openid-configuration` — it must return JSON.

**"The 'redirect_uri' parameter must be a Login redirect URI" (Okta)**
The Sign-in redirect URI registered on the Okta app doesn't match `{BETTER_AUTH_URL}/api/auth/callback/okta` exactly — scheme, host, port and path all have to match.

**"Sign in completed but no session was found"**
The OAuth callback succeeded but the gateway couldn't validate the resulting session cookie. Most common cause: the browser blocked the cookie because `BETTER_AUTH_URL` and the page origin don't match the cookie's SameSite policy. Check that `BETTER_AUTH_URL` in `.env` is exactly what the browser sees in the URL bar when it hits the gateway.

**Want to test without going to a provider?**
Skip OAuth and use magic-link instead — it works out of the box with no provider registration. In dev, the link prints to gateway stdout.
