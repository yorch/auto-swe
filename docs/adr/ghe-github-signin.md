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
