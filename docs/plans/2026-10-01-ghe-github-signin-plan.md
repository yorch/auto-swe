# GitHub Enterprise Server sign-in — Implementation Plan

Spec: docs/specs/2026-10-01-ghe-github-signin.md
Workspace: worktree: .claude/worktrees/ghe-oauth-signin (branch feat/ghe-oauth-signin)
Jira: N/A

## Progress

<!-- The machine-readable task tracker. s1-eng-implement checks each box and
     appends the task's commit SHA as it lands; s1-eng-resume reads this list
     (and cross-checks it against git) to find where to pick up. -->

- [x] Task 1: Fetch and map a GHE profile into a better-auth user — `aad6076`
- [x] Task 2: Build the GHE sign-in provider and prove the authorize URL — `c46f900`
- [x] Task 3: Wire GHE sign-in into the gateway — `1a2a417`
- [x] Task 4: Document GHE sign-in in the OAuth setup guide — `ecd6c18`

## Tasks

### Task 1: Fetch and map a GHE profile into a better-auth user

**What**: Create `packages/gateway/src/lib/githubEnterpriseAuth.ts` with
`fetchGhesUserInfo(accessToken, apiUrl, host)`. It calls `GET {api}/user` and `GET {api}/user/emails`
with `Authorization: Bearer <token>`, picks the email that is both `primary` and `verified`, and
returns `{ id, name, email, emailVerified: true, image }`. `id` is `{host}:{numeric id}`, `name`
falls back to `login`, `image` is `avatar_url`. It returns `null` when either request fails or no
entry is both primary and verified, so better-auth refuses the sign-in. Never uses the public
`email` on `/user`. Takes `fetch` from the global, so tests stub it.
**Files**: `packages/gateway/src/lib/githubEnterpriseAuth.ts` (new),
`packages/gateway/src/lib/githubEnterpriseAuth.test.ts` (new)
**Depends on**: none
**Verify**: `yarn vitest run packages/gateway/src/lib/githubEnterpriseAuth.test.ts` passes tests
that fail first (RED) for: both requests carry the Bearer header (AC 4); a primary+verified email is
chosen over a non-primary one and over the public profile email, with `emailVerified: true` and the
name/image fallbacks (AC 5); no primary+verified entry returns `null` (AC 6); an empty list and a
non-OK `/user` or `/user/emails` response return `null`; the id is `ghe.example.com:42`, not `42`
(AC 7).
**Parallelizable**: yes — does not share files with Task 4

### Task 2: Build the GHE sign-in provider and prove the authorize URL

**What**: In the same module add `isGithubEnterprise(baseUrl)`, URL normalisation (trailing slash
stripped; only `http:`/`https:`), API URL derivation (`{base}/api/v3` when the API URL is still
`https://api.github.com`), `githubEnterpriseOAuth({ baseUrl, apiUrl, clientId, clientSecret })`
returning the `genericOAuth` config (`providerId: 'github'`, `authorizationUrl` and `tokenUrl` under
`{base}/login/oauth/`, `scopes: ['read:user', 'user:email']`, `pkce: false`, `getUserInfo` from
Task 1), and `resolveGithubSignIn(config)` returning `{ mode: 'none' | 'builtin' | 'ghe', ... }`:
`none` for missing credentials or an invalid URL (logs the reason, never throws), `builtin` for
github.com or unset, `ghe` otherwise. Add an integration test that builds a minimal better-auth
instance with `memoryAdapter` and `genericOAuth({ config: [githubEnterpriseOAuth(...)] })`, calls
`/api/auth/sign-in/social`, and parses the returned URL.
**Files**: `packages/gateway/src/lib/githubEnterpriseAuth.ts`,
`packages/gateway/src/lib/githubEnterpriseAuth.test.ts`
**Depends on**: Task 1
**Verify**: `yarn vitest run packages/gateway/src/lib/githubEnterpriseAuth.test.ts` — the
integration test sees an authorize URL on the GHE origin at `/login/oauth/authorize` with
`client_id`, `redirect_uri` = `{BETTER_AUTH_URL}/api/auth/callback/github`, `read:user user:email`
and `state` (AC 1); the token endpoint in the config is `{base}/login/oauth/access_token` (AC 3);
`resolveGithubSignIn` returns `builtin` for `https://github.com` and for unset (AC 2), derives
`{base}/api/v3` (AC 8), strips `//` (AC 9), and returns `none` for `ftp://x` and `not a url` without
throwing (AC 10).

### Task 3: Wire GHE sign-in into the gateway

**What**: In `betterAuth.ts`, keep the resolved `baseUrl` and `apiUrl` beside the client credentials
in `initAuth`. Replace the inline `socialProviders.github` with `resolveGithubSignIn(...)`: register
the built-in provider only for `builtin`. Build one `genericOAuth({ config: [...] })` from a list
holding the `ghe` config and/or Okta's, built inline in `buildAuth`, and omit the plugin when the list is empty.
The post-sign-in GitHub login sync uses the API URL that sign-in resolved (`apiUrl` on the `ghe` result), so a
GHE access token is never sent to api.github.com. Leave
`trustedProviders`, the `refreshGithubLogin` hook and `configuredProviders()` semantics unchanged
(`github` still means a client ID and secret are set). No behaviour change when Base URL is
github.com or unset.
**Files**: `packages/gateway/src/lib/betterAuth.ts`, `packages/gateway/src/lib/githubEnterpriseAuth.ts`,
`packages/gateway/src/lib/betterAuth.githubSignIn.test.ts` (new)
**Depends on**: Task 2
**Verify**: `yarn typecheck` and `yarn vitest run packages/gateway` pass with no regression; a
wiring test (the real `betterAuth.ts` under mocked config) shows GHE plus Okta yield one
`generic-oauth` plugin holding both, Okta alone is unchanged (AC 12), and `configuredProviders().github`
is true in both modes when credentials are set and the Base URL is valid (AC 10, 11). `yarn invariants:check` and `yarn biome check` on the CI path set pass.

### Task 4: Document GHE sign-in in the OAuth setup guide

**What**: Add a short GitHub Enterprise subsection to the GitHub section of `docs/oauth-setup.md`:
register the OAuth app on the GHE instance, set the Base URL (and API URL) on the GitHub tab, the
callback URL is the same, a gateway restart is needed, only a primary verified email can sign in,
and GHE sign-in replaces github.com sign-in. Present tense, no status prose.
**Files**: `docs/oauth-setup.md`
**Depends on**: none
**Verify**: `node scripts/check-doc-drift.mjs` exits 0 (no forbidden status prose, no broken links).
**Parallelizable**: yes — does not share files with Task 1
