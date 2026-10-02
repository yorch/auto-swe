# MCP server

The gateway is a [Model Context Protocol](https://modelcontextprotocol.io) server. An MCP client (an
editor, a coding agent) connects to one URL, signs in through the platform's own OAuth 2.1
authorization server ([oauth-setup.md](./oauth-setup.md#the-platform-as-an-oauth-server-for-mcp-clients)),
and talks to the endpoint over Streamable HTTP. The server is a resource server in the OAuth sense: it
accepts only access tokens that the authorization server issued for it, and it re-checks on every
request that the grant behind the token still stands.

The server registers no tools, resources or prompts. An authenticated client can `initialize` and list
an empty tool set; it cannot read or change anything on the platform.

It is off until an admin turns on `mcp.enabled`.

## Endpoints

| URL | Purpose |
|---|---|
| `{BETTER_AUTH_URL}/api/v1/mcp` | The MCP endpoint (`POST`; `GET` and `DELETE` answer 405). It is also the RFC 8707 resource identifier and the `aud` of every access token. |
| `{BETTER_AUTH_URL}/.well-known/oauth-protected-resource/api/v1/mcp` | RFC 9728 protected resource metadata, at the path-inserted URL a client derives from the resource identifier. |
| `{BETTER_AUTH_URL}/.well-known/oauth-protected-resource` | The same document at the root. |
| `{BETTER_AUTH_URL}/.well-known/oauth-authorization-server/api/auth` | RFC 8414 metadata of the authorization server, which the protected resource metadata points at. |

The protected resource metadata names the resource, the authorization server's issuer, and the scopes
the server accepts now: `mcp:read` always, `mcp:write` only while `mcp.writeToolsEnabled` is on.
`offline_access` is not listed, as the MCP authorization specification asks.

## Connecting a client

A client needs only the endpoint URL. Without a token the endpoint answers 401 with a
`WWW-Authenticate` challenge that names the protected resource metadata and the default scope:

```
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header",
  scope="mcp:read", resource_metadata="https://auto-swe.example.com/.well-known/oauth-protected-resource/api/v1/mcp"
```

The client follows the metadata to the authorization server, registers itself (anonymous Dynamic Client
Registration, public client, PKCE `S256`), sends the user to sign in, and receives a JWT access token
and, when it asked for `offline_access`, a rotating refresh token. For Claude Code that is:

```bash
claude mcp add --transport http auto-swe https://auto-swe.example.com/api/v1/mcp
```

Other clients take the same URL and discover the rest. A client must send `resource` (the endpoint URL)
on its authorization and token requests; the authorization server refuses a request without it.

## How a request is authorized

Every request to the endpoint passes these checks, in this order, before the MCP protocol sees it:

1. **MCP is on.** Otherwise 404. The setting is read per request.
2. **Origin.** A request carrying an `Origin` header whose host is not a configured `CORS_ORIGIN` host
   or the gateway's own host is refused with 403. A request with no `Origin` (every non-browser client)
   passes.
3. **A bearer token.** The `Authorization: Bearer` header only. Missing, malformed or invalid: 401 with
   the challenge above.
4. **The token itself.** One verifier, shared by every entry point:
   - the header `typ` is `at+jwt` and names a `kid`; an opaque token, a personal access token (`ats_`),
     the REST API's JWT and the `jwt` plugin's session-to-JWT token are all refused here;
   - the signature is `EdDSA`, verified against the authorization server's published keys, read in
     process from the same database (no HTTP call). Keys are cached for five minutes. A token naming a
     key the cache has not seen triggers one re-read, and no more than one per ten seconds, so a key
     rotation does not fail tokens and a stream of random key ids does not become a stream of reads;
   - `iss` is `{BETTER_AUTH_URL}/api/auth`, `exp` has not passed, and `sub` and a client id are present;
   - `aud` is exactly the endpoint URL. A token with no audience, another audience, or this one among
     others is refused (RFC 8707: the server accepts tokens issued for it and for nothing else).
5. **The grant behind the token, per call, from the database.** The token's user has a consent for the
   token's client; the consent was not written after the token was issued (a re-consent supersedes the
   tokens before it, with five seconds of tolerance for clock skew between replicas); the client is not
   disabled or deleted; the user is active.
6. **Scopes.** The effective scopes are the token's MCP scopes, narrowed to what the user consented to,
   and `mcp:write` only while `mcp.writeToolsEnabled` is on. `mcp:write` carries `mcp:read` with it. A
   token left with no MCP scope is answered 403 `insufficient_scope`, with the same `scope="mcp:read"`
   and `resource_metadata` in the challenge.

A failure of the verifier's own dependencies (the keys or the database cannot be read) answers 500 and
is logged. It is never reported as a bad token, so a client does not discard a good one.

Because step 5 reads the database on every call, deleting a consent, disabling a client or deactivating
a user stops that token on its next request instead of when it expires. The user lookup is cached for
30 seconds per gateway process, as for the REST API.

## Transport

The endpoint is stateless: every request is served by a fresh server instance, nothing is kept between
requests, and there is no session id. It serves two protocol eras from one definition:

| Era | Recognised by | Response |
|---|---|---|
| Revision `2026-07-28` | A per-request `_meta` envelope naming the protocol version | A single `application/json` body |
| 2025-era (`initialize` handshake) | No envelope | A one-frame `text/event-stream` body, which is how the SDK's stateless fallback frames it |

- A `POST` whose body is not `application/json` is answered 415; a body that is not valid JSON, 400.
- `GET` and `DELETE`, the 2025-era session operations, are answered 405 once the caller is authenticated.
- `subscriptions/listen` is refused (JSON-RPC error `-32603`, not a stream). The server advertises no
  subscription capability and holds no connection open for a client.
- A notification is answered 202 with no body.

The transport is `@modelcontextprotocol/server` 2.0.0, mounted as a Fastify route. The route builds a web
`Request` from the body Fastify has already parsed, calls the SDK's `fetch` handler, and streams the
response back.

## Settings

Both are ADMIN-only, GLOBAL-only registry settings ([configuration.md](./configuration.md)) read per
request through the ~30 s settings cache, so a change applies on every replica within about 30 seconds
and needs no restart.

| Setting | Default | Effect here |
|---|---|---|
| `mcp.enabled` | `false` | Off, the endpoint and both protected resource metadata documents answer 404 (as the authorization server's endpoints do). If the setting cannot be read they answer 503: the server does not guess. |
| `mcp.writeToolsEnabled` | `false` | Off, `mcp:write` is dropped from every token's effective scopes and left out of the protected resource metadata. |

## Operations

- **Behind a proxy**, the gateway must receive `/api/v1/mcp` and `/.well-known/*`, and
  `BETTER_AUTH_URL` must be the public HTTPS URL. The protected resource metadata is refused with a 500
  (and a log line) when the issuer is neither HTTPS nor `localhost`.
- **Rate limit.** The gateway's global per-IP limit applies to the endpoint.
- **Cutting off one client or user** is a database fact, not a deploy: delete the consent, set the
  client's `disabled`, or deactivate the user. Each takes effect on the next request (a deactivation
  within 30 seconds on other replicas).

## Limitations

- No tools, resources or prompts are exposed, so a connected client can do nothing beyond connect.
- Only OAuth tokens are accepted. A personal access token cannot be used, so a headless agent with no
  browser has no way to connect.
- Browser-hosted MCP clients are not supported: the endpoint's `Origin` check admits only the
  deployment's own hosts.
- A token issued within five seconds before its consent was re-written survives that re-write until it
  expires (at most 10 minutes), because the generation check tolerates that much clock skew.
- The 2025-era leg answers with a one-frame event stream even though the response is a single message.
- Disabling MCP or the write setting takes up to 30 seconds to reach every replica, and a user's
  deactivation up to 30 seconds on a replica other than the one that handled it.
- The signing keys and consent are read per gateway process; per-replica caches are not shared.
