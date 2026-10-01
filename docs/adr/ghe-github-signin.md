# GitHub Enterprise sign-in — decision log

## D1 — 2026-10-01 — Task 1: Fetch and map a GHE profile into a better-auth user

**Status**: Accepted
**Decision**: The account id is `{host}:{numeric id}`, with the host lower-cased and any non-default port kept.
**Reason**: Accounts are keyed unique on `(issuer, accountId)`, not `(providerId, accountId)`. A generic-OAuth provider that declares no `accountIssuer` gets `local:oauth:<providerId>`, which for `github` is the same issuer the built-in github.com provider uses, so a bare numeric id from GHE could match a github.com account and sign the wrong person in.
**Alternatives considered**: Setting `accountIssuer` to the GHE origin would namespace the key natively and keep the id bare. Not taken: the column is `NOT NULL` and shared with every provider, the behaviour of an issuer that changes when an admin edits the Base URL is untested here, and the id prefix needs no schema or adapter assumptions.

## D2 — 2026-10-01 — Task 2: Build the GHE sign-in provider

**Status**: Accepted
**Decision**: A plain `http:` Base URL or API URL is allowed with a logged warning, and the API URL is not required to share the Base URL's host.
**Reason**: GHE is often internal and sometimes reached over http in development, and instances with subdomain isolation put the API on a different host (`api.ghe.example.com`), so rejecting either would break valid setups. Both are admin-controlled values, and `redirect: 'error'` keeps the bearer token on the host the admin named.
**Alternatives considered**: Rejecting `http:` outside loopback, or requiring `api.host === base.host`. Both fail real deployments.

## D3 — 2026-10-01 — Task 3: Wire GHE sign-in into the gateway

**Status**: Accepted
**Decision**: In GHE mode the post-sign-in GitHub login sync uses the API URL that sign-in resolved, not the saved API URL.
**Reason**: With only a Base URL saved, the stored API URL is still `https://api.github.com`. Sign-in derives `{base}/api/v3`, but the sync hook read the raw value, so it sent the user's GHE access token to api.github.com and never recorded the login.
**Alternatives considered**: Deriving the URL again inside the hook. Rejected: two copies of the derivation can drift; `resolveGithubSignIn` now exposes the one it used.

## D4 — 2026-10-01 — Design: how GHE sign-in is registered

**Status**: Accepted
**Decision**: When the saved Base URL's host is not `github.com`, GitHub sign-in is a `genericOAuth` provider with explicit GHE endpoints registered under the same id `github`, instead of better-auth's built-in provider. The mode comes from the Base URL/API URL already on the GitHub tab; there is no new setting. Both live in `resolveGithubSignIn` (`githubEnterpriseAuth.ts`), and GHE and Okta share the one `genericOAuth` plugin.
**Reason**: The built-in `github` provider hardcodes the authorize, token and user endpoints to github.com and exposes no option to change them. Reusing the id keeps the callback URL (`/api/auth/callback/github`), existing account rows, the post-sign-in username hook, the backfill script, the linking allowlist and the login/settings UI unchanged.
**Alternatives considered**: A separate `github-enterprise` id, which could coexist with github.com sign-in but needs a new callback URL and changes to the hook, backfill, linking allowlist, button and settings page. An explicit "use GHE for sign-in" toggle, which needs a new column, a migration and a UI field for a distinction no deployment has needed. The cost of the chosen design is that GHE replaces github.com sign-in; they cannot coexist under one id.

## D5 — 2026-10-01 — Design: what a GHE profile must prove

**Status**: Accepted
**Decision**: Only a `/user/emails` entry that is both `primary` and `verified` is accepted; the public `email` on `/user` is never used; with no such entry the sign-in is refused. Scopes are `read:user` and `user:email`. PKCE is off.
**Reason**: `github` is a trusted provider for account linking, so an address that is not verified could link a sign-in onto another person's user. The built-in provider does not use PKCE, GHE versions differ in their support for it, and the client is confidential (it holds a secret).
**Alternatives considered**: Accepting the public profile email, which carries no verification flag. Enabling PKCE, which risks breaking older GHE versions for a protection the client secret already provides at the token endpoint.

## D6 — 2026-10-01 — Review: GHE accounts and the other consumers of the stored account

**Status**: Accepted
**Decision**: The ownership sweep reports a host-namespaced account id (`{host}:{id}`) as unverifiable instead of comparing it with github.com, and the backfill script uses the same resolved API URL as sign-in (`resolveGithubApiUrl`, the one derivation).
**Reason**: Found by reviewing the branch as a whole, because both consumers live outside the three task diffs. The sweep compared the GHE account id with a github.com id, so a GHE user whose login also exists on github.com was cleared and a false takeover was audited. The backfill sent every stored token to the saved API URL, which is api.github.com when only a Base URL is saved.
**Alternatives considered**: Verifying GHE logins against the GHE host with the platform token. Rejected for now: it needs the host to be trusted from the id and a GHE-capable platform token in the sweep, a larger change to the access projection than this feature warrants. The gap is recorded under Limitations in `docs/repo-access-gating.md`.
