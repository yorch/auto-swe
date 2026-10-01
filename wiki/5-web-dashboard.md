# @auto-swe/web — Next.js Dashboard

> Indexed at commit `147d054a` on 2026-09-30 · [view on GitHub](https://github.com/yorch/auto-swe/tree/147d054a)

## Relevant source files

- [packages/web/package.json](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/package.json)
- [packages/web/next.config.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/next.config.ts)
- [packages/web/src/proxy.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts)
- [packages/web/src/app/layout.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx)
- [packages/web/src/app/page.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/page.tsx)
- [packages/web/src/app/globals.css](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/globals.css)
- [packages/web/src/app/govern/layout.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/govern/layout.tsx)
- [packages/web/src/app/studio/layout.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/studio/layout.tsx)
- [packages/web/src/components/Providers.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/Providers.tsx)
- [packages/web/src/components/AppConfigScript.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/AppConfigScript.tsx)
- [packages/web/src/components/layout/AppShell.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/layout/AppShell.tsx)
- [packages/web/src/components/auth/RoleLayout.tsx](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/auth/RoleLayout.tsx)
- [packages/web/src/lib/config.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts)
- [packages/web/src/lib/api.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts)
- [packages/web/src/lib/env.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/env.ts)
- [packages/web/src/lib/auth.server.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/auth.server.ts)
- [packages/web/src/lib/networkErrors.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/networkErrors.ts)
- [packages/web/src/lib/palette.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/palette.ts)
- [packages/web/src/lib/docs.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/docs.ts)
- [packages/web/src/hooks/useListQuery.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useListQuery.ts)
- [packages/web/src/hooks/useRuns.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useRuns.ts)
- [packages/web/src/hooks/useApprovals.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useApprovals.ts)
- [packages/web/src/hooks/useUserPreferences.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useUserPreferences.ts)
- [packages/web/src/stores/authStore.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts)
- [packages/web/src/stores/teamStore.ts](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/teamStore.ts)
- [packages/web/postcss.config.mjs](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/postcss.config.mjs)
- [packages/web/tsconfig.json](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/tsconfig.json)
- [packages/web/Dockerfile](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile)
- [scripts/check-invariants.mjs](https://github.com/yorch/auto-swe/blob/147d054a/scripts/check-invariants.mjs)

## Overview

`@auto-swe/web` is the operator-facing dashboard: a Next.js 16 App Router application that renders workflow runs, approval queues, the workflow library, agent and skill configuration, and platform governance screens. It is a separate deployable from the gateway, served by `next start` in development and by the standalone Node server in the container image ([packages/web/package.json:L5-L10](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/package.json#L5-L10), [packages/web/Dockerfile:L94-L105](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile#L94-L105)).

The package holds no business logic of its own. Every domain type it renders is imported from `@auto-swe/shared/types/api`, and every read or write goes over the gateway's REST API. The application layer is therefore thin: 50 `page.tsx` route files, 19 layout files, 111 non-test components, 29 hooks, and 2 Zustand stores. React 19.2.8 with the App Router is the rendering model; almost every page is a Client Component, with Server Components reserved for role guards, redirects and filesystem-backed documentation ([packages/web/package.json:L11-L27](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/package.json#L11-L27)).

One thing the manifest does not say: `@auto-swe/shared` is not in `dependencies`. 63 files under `packages/web/src` import it (58 source files and 5 tests), most of them for `types/api` and a few at runtime, such as `roleMeets` in the server-side guard and the workflow spec parser in the editor. It resolves because Yarn's `node-modules` linker hoists the workspace into the root `node_modules`, and the Dockerfile builds `@auto-swe/shared` before `@auto-swe/web` ([packages/web/package.json:L11-L27](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/package.json#L11-L27), [packages/web/Dockerfile:L48-L67](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile#L48-L67)). Nothing in the manifest would stop a standalone install of the package from failing at the first import.

Sources: [packages/web/package.json:L1-L40](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/package.json#L1-L40) [packages/web/Dockerfile:L48-L67](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile#L48-L67) [packages/web/src/lib/auth.server.ts:L1-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/auth.server.ts#L1-L6)

## Architecture

```mermaid
flowchart LR
    Proxy["src/proxy.ts<br/>cookie auth gate"] --> Layout["app/layout.tsx<br/>root layout (RSC, force-dynamic)"]
    Layout --> ConfigScript["AppConfigScript<br/>window.__APP_CONFIG__"]
    Layout --> Providers["Providers<br/>QueryClientProvider"]
    Layout --> Shell["AppShell<br/>Sidebar + TopBar"]
    Shell --> Pages["app/**/page.tsx"]
    Pages --> Hooks["src/hooks/*<br/>TanStack Query"]
    Pages --> Components["src/components/*"]
    Hooks --> ApiClient["lib/api.ts<br/>ApiClient"]
    ApiClient --> Gateway(("Fastify gateway"))
    Guards["lib/auth.server.ts<br/>requireRole"] --> Gateway
    ConfigScript -.writes.-> Config["lib/config.ts<br/>API_BASE"]
    ApiClient -.reads.-> Config
    AuthStore["stores/authStore.ts"] -.bearer token.-> ApiClient
```

Requests enter through `proxy.ts`, which decides only whether the visitor is signed in. The root layout then renders on every request, injects runtime configuration into the HTML, mounts the TanStack Query client, and wraps the page in the sidebar chrome. Pages call hooks, hooks call the shared `ApiClient` singleton, and the client issues a cross-origin `fetch` to the gateway. Server Component guards are the one path that talks to the gateway from inside the web container rather than from the browser.

Sources: [packages/web/src/proxy.ts:L31-L52](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L31-L52) [packages/web/src/app/layout.tsx:L28-L68](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L28-L68) [packages/web/src/lib/api.ts:L48-L114](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L48-L114)

## Module Layout

| Module | Path | Responsibility |
| ------ | ---- | -------------- |
| Route tree | `packages/web/src/app/` | App Router pages, section layouts, `globals.css`, the `/health` route handler |
| Proxy | `packages/web/src/proxy.ts` | Next 16 proxy (the renamed middleware): cookie-presence auth gate and `x-pathname` injection |
| Components | `packages/web/src/components/` | 17 feature folders plus a 24-file `ui/` primitive set |
| Hooks | `packages/web/src/hooks/` | One file per API domain; TanStack Query wrappers over `ApiClient` |
| Stores | `packages/web/src/stores/` | `authStore` (session and sign-in flows), `teamStore` (selected team) |
| Lib | `packages/web/src/lib/` | API client, runtime config, formatting, chart and DAG layout helpers, server-side auth |
| Test helpers | `packages/web/src/test/rtl-helpers.tsx` | React Testing Library render wrapper for component tests |

Path alias `@/*` maps to `packages/web/src/*`, so every internal import in the package is written as `@/lib/...` or `@/components/...` ([packages/web/tsconfig.json:L12-L14](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/tsconfig.json#L12-L14)). The admin surface lives in two route trees, `/govern` for the governance screens and `/studio` for authoring and integration screens, each guarded by its own layout.

Sources: [packages/web/tsconfig.json:L1-L33](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/tsconfig.json#L1-L33) [packages/web/src/proxy.ts:L1-L52](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L1-L52)

## Key Components

### Root layout and providers

`RootLayout` is a Server Component. It loads the Inter and IBM Plex Mono fonts through `next/font/google`, exposes them as the `--font-inter` and `--font-ibm-plex-mono` CSS variables on `<html>`, and nests three wrappers around the page: `Providers`, `ErrorBoundary`, and `AppShell` ([packages/web/src/app/layout.tsx:L9-L21](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L9-L21), [packages/web/src/app/layout.tsx:L60-L66](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L60-L66)).

`Providers` constructs one `QueryClient` per browser session inside `useState`, with `retry: 1` and a 30-second `staleTime` as the defaults every hook inherits. It also fires `authStore.checkAuth()` once on mount, which reconciles the in-memory identity with whatever credentials the browser actually holds ([packages/web/src/components/Providers.tsx:L7-L26](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/Providers.tsx#L7-L26)).

`AppShell` renders the two-column chrome — a 234px `Sidebar` and a `TopBar` — and drops it entirely on `/login` and `/reset-password`. Run detail and template diff routes are matched by regular expression and given a non-scrolling full-height `main` instead of the centred 1280px column. The approvals SSE subscription is mounted in the inner `Chrome` component rather than `AppShell` itself, so the single `EventSource` opens only on chromed routes ([packages/web/src/components/layout/AppShell.tsx:L8-L50](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/layout/AppShell.tsx#L8-L50)).

Sources: [packages/web/src/app/layout.tsx:L1-L69](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L1-L69) [packages/web/src/components/Providers.tsx:L1-L27](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/Providers.tsx#L1-L27) [packages/web/src/components/layout/AppShell.tsx:L1-L50](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/layout/AppShell.tsx#L1-L50)

### How the browser reaches the gateway

There is no rewrite, proxy route, or API forwarding layer. `next.config.ts` declares `allowedDevOrigins`, an `env` block carrying only `NEXT_PUBLIC_APP_VERSION`, an `experimental.useTypeScriptCli` flag, `output: 'standalone'`, and `reactStrictMode`; it has no `rewrites`, `redirects` or `headers` entry ([packages/web/next.config.ts:L21-L34](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/next.config.ts#L21-L34)). The browser calls the Fastify gateway directly, cross-origin, at `API_BASE`.

**What changed.** The root layout now exports `dynamic = 'force-dynamic'`, so it renders on every request rather than once at `next build` ([packages/web/src/app/layout.tsx:L28-L32](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L28-L32)). The layout reads `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_TEMPORAL_UI_URL` from `process.env` to build the config blob. With no dynamic API in the layout, Next treated it as static and prerendered it during the image build, where neither variable is set, so the `http://localhost:8080` fallback was written into the HTML of every page and the variables on the running container were never read. A published image could then only reach a gateway on `localhost:8080`. A source invariant now guards this: `checkLayoutRendersPerRequest` fails `yarn invariants:check` if `layout.tsx` matches `process.env.NEXT_PUBLIC_*` without the `force-dynamic` export ([scripts/check-invariants.mjs:L204-L228](https://github.com/yorch/auto-swe/blob/147d054a/scripts/check-invariants.mjs#L204-L228), [scripts/check-invariants.mjs:L234](https://github.com/yorch/auto-swe/blob/147d054a/scripts/check-invariants.mjs#L234)).

The path from environment variable to browser is now:

1. `RootLayout` serialises `{ apiUrl, temporalUiUrl }` into a JSON string, using `NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'` and `NEXT_PUBLIC_TEMPORAL_UI_URL` (falling back to `http://localhost:8233` outside production and `''` in production). It escapes `<`, `>` and `&` as `<`, `>` and `&` so the value cannot close the script element ([packages/web/src/app/layout.tsx:L35-L43](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L35-L43)).
2. `AppConfigScript` hands that string to `useServerInsertedHTML`, which writes `<script id="__APP_CONFIG__">window.__APP_CONFIG__=…;</script>` into `<head>` once per render ([packages/web/src/components/AppConfigScript.tsx:L10-L23](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/AppConfigScript.tsx#L10-L23), [packages/web/src/app/layout.tsx:L52](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L52)).
3. `lib/config.ts` resolves `API_BASE` at module load as `windowConfig().apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'`. `windowConfig()` returns `{}` during server rendering, where `window` is undefined, so in the browser the injected value wins and the build-time `NEXT_PUBLIC_API_URL`, which Next inlines into the client bundle, is only a fallback ([packages/web/src/lib/config.ts:L7-L14](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L7-L14), [packages/web/src/lib/config.ts:L25-L26](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L25-L26)). `TEMPORAL_UI_URL` follows the same three-step order ([packages/web/src/lib/config.ts:L31-L34](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L31-L34)).

Server-side fetches use a different address. `apiInternalUrl()` reads `API_INTERNAL_URL` first and falls back to `NEXT_PUBLIC_API_URL`, because the browser-facing URL is frequently `http://localhost:8080`, which inside the web container points at the container's own loopback rather than the gateway. It is read only from Server Components such as `getSession`, and is never serialised into the page ([packages/web/src/lib/env.ts:L11-L21](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/env.ts#L11-L21), [packages/web/src/lib/auth.server.ts:L23-L29](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/auth.server.ts#L23-L29)).

Two comments in the tree still describe the pre-restructure layout: `config.ts` and `proxy.ts` mention an `/admin` layout, which no longer exists. The role checks now live in `/govern` and `/studio` ([packages/web/src/lib/config.ts:L21-L23](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L21-L23), [packages/web/src/proxy.ts:L21-L24](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L21-L24)).

Sources: [packages/web/next.config.ts:L1-L36](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/next.config.ts#L1-L36) [packages/web/src/app/layout.tsx:L28-L52](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L28-L52) [packages/web/src/components/AppConfigScript.tsx:L1-L26](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/AppConfigScript.tsx#L1-L26) [packages/web/src/lib/config.ts:L1-L34](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L1-L34) [packages/web/src/lib/env.ts:L1-L21](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/env.ts#L1-L21) [scripts/check-invariants.mjs:L204-L234](https://github.com/yorch/auto-swe/blob/147d054a/scripts/check-invariants.mjs#L204-L234)

### The API client

`ApiClient` is a single exported instance holding an in-memory bearer token, and it is the only place in the package that calls `fetch` against the gateway's `/api/v1/*` surface ([packages/web/src/lib/api.ts:L8-L11](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L8-L11), [packages/web/src/lib/api.ts:L217](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L217)). Every request sends `credentials: 'include'` so the better-auth session cookie travels cross-origin, and adds an `Authorization` header when a token is held — the gateway tries the header first and falls back to the cookie, so both auth modes work without per-call branching ([packages/web/src/lib/api.ts:L61-L71](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L61-L71)).

Four details in `fetch` exist because their absence broke something. A `Content-Type` header is attached only when a body exists, because Fastify rejects a JSON content type with an empty body and every dashboard `DELETE` failed ([packages/web/src/lib/api.ts:L51-L56](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L51-L56)). A `204` or zero-length response returns `undefined` rather than throwing inside `res.json()`, which would have rejected a mutation the server had already applied and skipped the caller's cache invalidation ([packages/web/src/lib/api.ts:L116-L127](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L116-L127)). A `401` on a request that carried a token triggers one refresh against `POST /api/v1/auth/session-token`, deduplicated through a shared `refreshPromise` and guarded by a `tokenGeneration` counter so a concurrent logout or fresh login is not overwritten ([packages/web/src/lib/api.ts:L150-L194](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L150-L194)). A network-level `TypeError` is rewrapped by `gatewayUnreachableMessage` into a message naming the actual `API_BASE` and the `CORS_ORIGIN` setting, since "failed to fetch" and "wrong credentials" need opposite remediations ([packages/web/src/lib/networkErrors.ts:L14-L32](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/networkErrors.ts#L14-L32)).

Sources: [packages/web/src/lib/api.ts:L1-L217](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L1-L217) [packages/web/src/lib/networkErrors.ts:L1-L50](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/networkErrors.ts#L1-L50)

### Route protection: proxy gate plus server-side role guard

`proxy.ts` is Next 16's proxy convention, the successor to `middleware.ts`, and its matcher covers everything except `_next/static`, `_next/image`, and `favicon.ico` ([packages/web/src/proxy.ts:L50-L52](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L50-L52)). It performs a presence check only: either the legacy `accessToken` JWT cookie or the `web-session-active` marker that `authStore` drops after a magic-link or social sign-in lets the request through, and neither is validated. The real better-auth session cookie lives on the gateway origin and is invisible here, so validation stays with the gateway's `requireAuth` on every `/api/v1/*` call. Paths under `/login`, `/api`, `/reset-password` and `/health` skip the check; requests to anything else without either cookie are redirected to `/login` with the original path as a `redirect` query parameter ([packages/web/src/proxy.ts:L5](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L5), [packages/web/src/proxy.ts:L31-L48](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L31-L48)).

The proxy's second job is to copy the matched pathname into an `x-pathname` request header, because layouts have no access to the URL ([packages/web/src/proxy.ts:L25-L29](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L25-L29), [packages/web/src/lib/config.ts:L21-L23](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L21-L23)). Authorisation itself is enforced by Server Component layouts: `RoleLayout` awaits `requireRole`, which reads the token cookie, calls `GET /api/v1/auth/me` over `API_INTERNAL_URL` with `cache: 'no-store'`, and redirects to `/` unless the user is active and `roleMeets` accepts their role ([packages/web/src/components/auth/RoleLayout.tsx:L10-L13](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/auth/RoleLayout.tsx#L10-L13), [packages/web/src/lib/auth.server.ts:L15-L53](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/auth.server.ts#L15-L53)). The `/govern` tree admits ENGINEER, LEAD and ADMIN, `/govern/organizations` narrows that to LEAD and ADMIN, and `/studio` is ADMIN-only ([packages/web/src/app/govern/layout.tsx:L4-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/govern/layout.tsx#L4-L6), [packages/web/src/app/govern/organizations/layout.tsx:L4-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/govern/organizations/layout.tsx#L4-L6), [packages/web/src/app/studio/layout.tsx:L4-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/studio/layout.tsx#L4-L6)).

Sources: [packages/web/src/proxy.ts:L1-L52](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L1-L52) [packages/web/src/lib/auth.server.ts:L1-L53](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/auth.server.ts#L1-L53) [packages/web/src/components/auth/RoleLayout.tsx:L1-L13](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/components/auth/RoleLayout.tsx#L1-L13) [packages/web/src/app/govern/layout.tsx:L1-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/govern/layout.tsx#L1-L6) [packages/web/src/app/studio/layout.tsx:L1-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/studio/layout.tsx#L1-L6)

### Query hooks

Hooks are organised one file per API domain and follow a fixed shape: `'use client'`, domain types imported from `@auto-swe/shared/types/api`, a `useQuery` whose `queryFn` unwraps the gateway's `{ data }` envelope, and a `queryKey` array whose first element is the domain name ([packages/web/src/hooks/useRuns.ts:L1-L31](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useRuns.ts#L1-L31)). Freshness is expressed per hook through `refetchInterval` rather than through global settings, and the interval can be a function of the current data — a workflow run polls every 3 seconds while `RUNNING` and every 30 seconds once it is not, and does not poll at all when full trace payloads were requested ([packages/web/src/hooks/useRuns.ts:L51-L57](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useRuns.ts#L51-L57)).

Paginated endpoints go through `useListQuery`, which returns the rows as `data` and the pagination block as `meta`. A hook that unwrapped `data` alone would silently discard the total and render "N total" for the current page rather than the table ([packages/web/src/hooks/useListQuery.ts:L35-L49](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useListQuery.ts#L35-L49)). Its companion `listUrl` appends `limit` and `offset` while preserving an existing query string ([packages/web/src/hooks/useListQuery.ts:L22-L33](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useListQuery.ts#L22-L33)). Mutations invalidate by key prefix in `onSuccess`; responding to an approval invalidates both `['approvals']` and `['workflow-run']` ([packages/web/src/hooks/useApprovals.ts:L73-L83](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useApprovals.ts#L73-L83)).

Live updates use one server-sent-events subscription. `useApprovalsStream` opens a single `EventSource` against `/api/v1/human-steps/stream` and invalidates the approvals key on each `change` event; the 30-second poll in `useApprovals` stays as the fallback. Mounting it once in `AppShell` replaced three long-lived connections per page, one per consumer ([packages/web/src/hooks/useApprovals.ts:L44-L65](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useApprovals.ts#L44-L65)).

Sources: [packages/web/src/hooks/useListQuery.ts:L1-L49](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useListQuery.ts#L1-L49) [packages/web/src/hooks/useRuns.ts:L1-L75](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useRuns.ts#L1-L75) [packages/web/src/hooks/useApprovals.ts:L1-L83](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useApprovals.ts#L1-L83)

### Zustand stores

Client state is deliberately small. `teamStore` is eleven lines holding the selected team id ([packages/web/src/stores/teamStore.ts:L1-L11](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/teamStore.ts#L1-L11)). `authStore` is the substantial one: it owns the current user, the `isAuthenticated` flag, and every sign-in flow — email and password, magic link, password reset, and the social providers `github`, `google`, and `okta` ([packages/web/src/stores/authStore.ts:L14-L63](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts#L14-L63)).

The store talks to the gateway's better-auth routes under `/api/auth/*` rather than through `ApiClient`, wrapping them in a `betterAuthPost` helper that folds gateway-unreachable messages, the server's own `message` field, and a caller fallback into one error path. Responses are parsed with Zod schemas so a shape change surfaces as a validation error rather than an undefined read ([packages/web/src/stores/authStore.ts:L88-L140](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts#L88-L140)). Social sign-in is a fetch-then-navigate dance: the provider URL comes back as JSON, the browser navigates to it, and the round trip lands on `/login?bridge=1`, where `hydrateFromSession` resolves the session ([packages/web/src/stores/authStore.ts:L33-L43](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts#L33-L43), [packages/web/src/stores/authStore.ts:L142-L165](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts#L142-L165)). The store also writes the `web-session-active` marker cookie the proxy reads, and clears both cookies on logout ([packages/web/src/stores/authStore.ts:L65-L86](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts#L65-L86)).

Per-user UI preferences are not kept in a store at all. `useUserPreferences` persists them on the server through `/api/v1/me/preferences` with optimistic updates, and validates the stored value on read because the column is free-form JSON older clients may have written ([packages/web/src/hooks/useUserPreferences.ts:L22-L63](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useUserPreferences.ts#L22-L63)).

Sources: [packages/web/src/stores/authStore.ts:L1-L165](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/authStore.ts#L1-L165) [packages/web/src/stores/teamStore.ts:L1-L11](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/stores/teamStore.ts#L1-L11) [packages/web/src/hooks/useUserPreferences.ts:L1-L63](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/hooks/useUserPreferences.ts#L1-L63)

### Styling

Tailwind CSS 4 is configured entirely in CSS. There is no `tailwind.config.js`: `globals.css` opens with `@import 'tailwindcss'` and two explicit `@source` globs, added because v4 scans relative to the stylesheet and the monorepo working directory made the default scan unreliable ([packages/web/src/app/globals.css:L1-L6](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/globals.css#L1-L6)). The PostCSS config loads the single `@tailwindcss/postcss` plugin ([packages/web/postcss.config.mjs:L1-L8](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/postcss.config.mjs#L1-L8)).

The design tokens live in an `@theme` block: an ink ramp for surfaces, a paper ramp for text, violet `ember` as the primary accent, teal as the secondary, status colours, three font families, and a tight radius scale topping out at 4px ([packages/web/src/app/globals.css:L12-L66](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/globals.css#L12-L66)). A `@layer base` block re-exports them as semantic aliases such as `--background` and `--primary` so older call sites keep working, and an `@layer utilities` block holds shared classes such as `.kicker` ([packages/web/src/app/globals.css:L68-L80](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/globals.css#L68-L80), [packages/web/src/app/globals.css:L163-L166](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/globals.css#L163-L166)).

Two surfaces cannot use CSS variables at all. Recharts passes `tick={{ fill }}` straight onto an SVG `<text>` as a presentation attribute, and React Flow does the same with an edge marker colour — and presentation attributes do not resolve `var()`. `lib/palette.ts` holds the literal hex values for those call sites in one place, with a `TOKEN_CSS_VAR` map naming the custom property each one mirrors, and `palette.test.ts` parses `globals.css` and fails if any entry drifts ([packages/web/src/lib/palette.ts:L1-L20](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/palette.ts#L1-L20), [packages/web/src/lib/palette.ts:L37-L54](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/palette.ts#L37-L54)). A second source-reading test, `themeClasses.test.ts`, fails the build when a colour class names a token the theme does not define; see [Components and state](./5.2-components-and-state.md) for the shared-primitives convention it backs.

Sources: [packages/web/src/app/globals.css:L1-L80](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/globals.css#L1-L80) [packages/web/src/lib/palette.ts:L1-L54](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/palette.ts#L1-L54) [packages/web/postcss.config.mjs:L1-L8](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/postcss.config.mjs#L1-L8)

## Data Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant P as proxy.ts
    participant L as Root layout (RSC, per request)
    participant H as Query hook
    participant A as ApiClient
    participant G as Gateway

    B->>P: GET /runs/abc
    P->>P: accessToken or web-session-active cookie?
    P-->>B: redirect /login?redirect=/runs/abc (neither)
    P->>L: next() with x-pathname header
    L-->>B: HTML with window.__APP_CONFIG__ (env read at request time)
    B->>H: mount page, useWorkflowRun(id)
    H->>A: api.get('/api/v1/workflow-runs/abc')
    A->>G: fetch API_BASE + path, credentials include
    G-->>A: 401
    A->>G: POST /api/v1/auth/session-token
    G-->>A: { data: { accessToken } }
    A->>G: retry with Authorization: Bearer
    G-->>A: { data: WorkflowRunDetail }
    A-->>H: parsed body
```

The refresh leg runs at most once per request, and a `401` on the retry calls `expireSession`, which clears the token and navigates to `/login` ([packages/web/src/lib/api.ts:L82-L107](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L82-L107)).

Sources: [packages/web/src/lib/api.ts:L48-L135](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/api.ts#L48-L135) [packages/web/src/proxy.ts:L31-L48](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/proxy.ts#L31-L48) [packages/web/src/app/layout.tsx:L28-L43](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/app/layout.tsx#L28-L43)

## Configuration & Extension Points

| Setting | Type | Default | Purpose |
| ------- | ---- | ------- | ------- |
| `NEXT_PUBLIC_API_URL` | `string` | `http://localhost:8080` | Gateway URL the browser calls; read from the container environment on every request and serialised into `window.__APP_CONFIG__` |
| `API_INTERNAL_URL` | `string` | falls back to `NEXT_PUBLIC_API_URL` | Gateway address for Server Component fetches inside the container network; never sent to the browser |
| `NEXT_PUBLIC_TEMPORAL_UI_URL` | `string` | `http://localhost:8233` in dev, `''` in prod | Temporal UI link, injected the same way; empty hides the link rather than pointing at a dead URL |
| `NEXT_PUBLIC_GRAFANA_URL` | `string` | `''` | Grafana dashboard link |
| `ALLOWED_DEV_ORIGINS` | `string` (comma-separated hosts) | `localhost,127.0.0.1` | Extra `next dev` origins so a Tailscale or LAN address can load `_next/static` and hydrate |
| `NEXT_PUBLIC_APP_VERSION` | `string` | package version | Build constant injected from `package.json` through `next.config.ts` |

The container build is a two-stage Dockerfile. The builder installs a `yarn` shim resolved from `yarnPath` because `node:26` ships no Corepack, focuses the install on the root, shared, and web workspaces, generates the Prisma client before building `@auto-swe/shared`, and copies only the top level of `docs/` — the full tree added roughly 1.4 MB of frozen history to the traced standalone bundle. The runtime stage copies the `standalone` output plus `.next/static`, runs as the `node` user, and probes `/health` ([packages/web/Dockerfile:L26-L68](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile#L26-L68), [packages/web/Dockerfile:L94-L105](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile#L94-L105)). That documentation tree is read at request time by `lib/docs.ts`, which resolves `../../docs` from the working directory and serves only its top-level `.md` files ([packages/web/src/lib/docs.ts:L15-L22](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/docs.ts#L15-L22)).

Sources: [packages/web/next.config.ts:L11-L34](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/next.config.ts#L11-L34) [packages/web/src/lib/config.ts:L25-L34](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/config.ts#L25-L34) [packages/web/src/lib/env.ts:L1-L21](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/env.ts#L1-L21) [packages/web/Dockerfile:L1-L105](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/Dockerfile#L1-L105) [packages/web/src/lib/docs.ts:L1-L40](https://github.com/yorch/auto-swe/blob/147d054a/packages/web/src/lib/docs.ts#L1-L40)

## Child Pages

**[App routes and pages](./5.1-app-routes-and-pages.md)** walks the 50-route App Router tree and its 19 layouts: the dashboard home with its approvals inbox and status charts, the `/runs` and `/workflows` operational surfaces, the ADMIN-only `/studio` section covering agents, skills, models, MCP connections, bundles, integrations and GitHub installations, the `/govern` section covering approvals, audit, budgets, policies, scanner patterns, teams, users, usage and platform settings, and the public `/login`, `/reset-password`, `/docs` and `/health` routes. It also covers how nearly every page opens with the shared `PageHeader`, the section layouts that apply role guards, and the dynamic segments such as `/runs/[id]` and `/workflows/library/[id]/diff`.

**[Components and state](./5.2-components-and-state.md)** covers the component library and the client state layer in depth: the 24-file `ui/` primitive set including `QueryBoundary`, `Table`, `Modal`, `PageHeader` and `StatusBadge`, the 17 feature folders led by the `workflow/` set that renders the React Flow DAG, the Recharts wrappers under `charts/`, the formatting and layout helpers in `lib/utils.ts`, `lib/chartUtils.ts` and `lib/workflowLayout.ts`, the rule that a treatment appearing on more than one page becomes a shared primitive rather than a class string, and the testing setup built on Vitest with jsdom and the `rtl-helpers` render wrapper.

## Related Pages

- Gateway API: [@auto-swe/gateway](./3-gateway-api.md) — the REST surface every hook calls
- Shared library: [@auto-swe/shared](./2-shared-library.md) — source of `types/api` and the `Role` permission helpers
- Temporal worker: [@auto-swe/worker](./4-temporal-worker.md) — produces the runs and traces this dashboard renders
- Repository structure: [Repository Structure](./1-repository-structure.md)
- CLI: [@auto-swe/cli](./6-cli.md) — the headless alternative to this dashboard
- Bundle SDK: [@auto-swe/sdk](./7-bundle-sdk.md)
