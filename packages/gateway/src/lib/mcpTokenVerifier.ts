import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import {
  MCP_CONSENT_SKEW_SECONDS,
  MCP_JWKS_CACHE_TTL_MS,
  MCP_JWKS_MIN_REFRESH_MS,
  MCP_SCOPE_READ,
  MCP_SCOPE_WRITE,
} from './mcpOAuth.js';

/**
 * The resource-server half of the MCP OAuth flow: turn a bearer token into the identity and
 * scopes a request may act with, or refuse it.
 *
 * One verifier, shared by every MCP entry point, so there is a single answer to "is this token
 * good". Everything it trusts is checked here and not inferred from the transport: the signature
 * (against the authorization server's own published keys, read in process), the token type, the
 * issuer, the audience, and then, per call, the database state that makes the token still valid
 * (consent not revoked or superseded, client not disabled, user active).
 */

/** Why a token was refused, for logs and tests. Never sent to the caller. */
export type McpTokenRejection =
  | 'not-a-jwt'
  | 'wrong-type'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'malformed-claims'
  | 'no-consent'
  | 'consent-superseded'
  | 'client-disabled'
  | 'user-inactive';

export interface McpGrant {
  /** The scopes the user consented to for this client. */
  consentScopes: string[];
  /** When the consent was last written; a token older than this predates it. */
  consentUpdatedAt: Date;
  consentId: string;
  /** False when the client no longer exists or is disabled. */
  clientActive: boolean;
}

export interface McpVerifierDeps {
  /** The `iss` every token carries. */
  issuer: string;
  /** The RFC 8707 resource: the only acceptable `aud`. */
  resource: string;
  /** The authorization server's published signing keys (read in process, no HTTP). */
  fetchJwks: () => Promise<JSONWebKeySet>;
  /** The latest consent for (user, client), or null when there is none. */
  loadGrant: (userId: string, clientId: string) => Promise<McpGrant | null>;
  /** The live user, or null when gone. */
  loadUser: (userId: string) => Promise<{ isActive: boolean; role: string } | null>;
  /** Read per call: write scope is honoured only while writes are on. */
  getWriteToolsEnabled: () => Promise<boolean>;
  onReject?: (reason: McpTokenRejection) => void;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * The signing keys, cached. A token naming a `kid` the cache lacks is the normal first sight of a
 * rotated key, so a miss forces one re-read (floored by `MCP_JWKS_MIN_REFRESH_MS`) instead of
 * rejecting.
 */
export function createJwksCache(
  fetchJwks: () => Promise<JSONWebKeySet>,
  now: () => number = Date.now
) {
  let cached: { keys: JSONWebKeySet; fetchedAt: number } | null = null;
  let lastForcedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<JSONWebKeySet> | null = null;

  function load(): Promise<JSONWebKeySet> {
    inflight ??= fetchJwks()
      .then((keys) => {
        cached = { fetchedAt: now(), keys };
        return keys;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async get(): Promise<JSONWebKeySet> {
      if (cached && now() - cached.fetchedAt < MCP_JWKS_CACHE_TTL_MS) {
        return cached.keys;
      }
      return load();
    },
    /**
     * Re-read now because a token named a key the cache lacks. One forced read per
     * `MCP_JWKS_MIN_REFRESH_MS`: after that the cache answers, however many unknown keys arrive.
     */
    async refresh(): Promise<JSONWebKeySet> {
      if (cached && now() - lastForcedAt < MCP_JWKS_MIN_REFRESH_MS) {
        return cached.keys;
      }
      lastForcedAt = now();
      return load();
    },
  };
}

function reject(deps: McpVerifierDeps, reason: McpTokenRejection): never {
  deps.onReject?.(reason);
  throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
}

/** RFC 9068 section 2.1: `at+jwt`, optionally with the `application/` prefix, case-insensitive. */
function isAccessTokenType(typ: unknown): boolean {
  if (typeof typ !== 'string') {
    return false;
  }
  const lowered = typ.toLowerCase();
  return lowered === 'at+jwt' || lowered === 'application/at+jwt';
}

function audiences(aud: JWTPayload['aud']): string[] {
  return aud === undefined ? [] : Array.isArray(aud) ? aud : [aud];
}

export function createMcpTokenVerifier(deps: McpVerifierDeps): OAuthTokenVerifier {
  const now = deps.now ?? Date.now;
  const jwks = createJwksCache(deps.fetchJwks, now);

  async function verifySignature(token: string): Promise<JWTPayload> {
    const options = {
      algorithms: ['EdDSA'],
      currentDate: new Date(now()),
      issuer: deps.issuer,
      requiredClaims: ['exp', 'iat', 'sub'],
    };
    try {
      try {
        return (await jwtVerify(token, createLocalJWKSet(await jwks.get()), options)).payload;
      } catch (err) {
        // A key the cache has not seen yet: re-read once and try again.
        if (!(err instanceof joseErrors.JWKSNoMatchingKey)) {
          throw err;
        }
        return (await jwtVerify(token, createLocalJWKSet(await jwks.refresh()), options)).payload;
      }
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        return reject(deps, 'expired');
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        return reject(deps, err.claim === 'iss' ? 'wrong-issuer' : 'malformed-claims');
      }
      if (err instanceof joseErrors.JOSEError) {
        return reject(deps, 'bad-signature');
      }
      // Not a verdict on the token (the keys could not be read): a server error, not a 401.
      throw err;
    }
  }

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // 1. Shape and type: an opaque token, or a JWT that is not an access token (an ID token, a
      // session token), is refused before any key is consulted.
      let header: ReturnType<typeof decodeProtectedHeader>;
      try {
        header = decodeProtectedHeader(token);
      } catch {
        return reject(deps, 'not-a-jwt');
      }
      if (!isAccessTokenType(header.typ)) {
        return reject(deps, 'wrong-type');
      }
      if (typeof header.kid !== 'string' || header.kid === '') {
        return reject(deps, 'bad-signature');
      }

      // 2. Signature, issuer, expiry.
      const claims = await verifySignature(token);

      // 3. Audience: issued specifically for this resource, and for nothing else.
      const aud = audiences(claims.aud);
      if (aud.length !== 1 || aud[0] !== deps.resource) {
        return reject(deps, 'wrong-audience');
      }

      // 4. The caller: who, through which client, with which scopes.
      const clientId = [claims.client_id, claims.azp].find(
        (v): v is string => typeof v === 'string' && v !== ''
      );
      const scopeClaim = claims.scope;
      if (
        typeof claims.sub !== 'string' ||
        !clientId ||
        typeof claims.exp !== 'number' ||
        typeof claims.iat !== 'number' ||
        (scopeClaim !== undefined && typeof scopeClaim !== 'string')
      ) {
        return reject(deps, 'malformed-claims');
      }
      const tokenScopes = new Set(
        (scopeClaim ?? '').split(' ').filter((s) => s === MCP_SCOPE_READ || s === MCP_SCOPE_WRITE)
      );

      // 5. Database state, per call. Revoking a consent, deactivating the user and disabling the
      // client all take effect on the next request, not when the token expires.
      const [grant, user, writeEnabled] = await Promise.all([
        deps.loadGrant(claims.sub, clientId),
        deps.loadUser(claims.sub),
        deps.getWriteToolsEnabled(),
      ]);
      if (!grant) {
        return reject(deps, 'no-consent');
      }
      if (!grant.clientActive) {
        return reject(deps, 'client-disabled');
      }
      // A re-consent (a step-up to write, say) supersedes the tokens issued before it.
      if (claims.iat * 1000 < grant.consentUpdatedAt.getTime() - MCP_CONSENT_SKEW_SECONDS * 1000) {
        return reject(deps, 'consent-superseded');
      }
      if (!user?.isActive) {
        return reject(deps, 'user-inactive');
      }

      // 6. Effective scopes: what the token says, what the user consented to, and what the
      // operator currently allows. `mcp:write` carries `mcp:read` with it.
      const consented = new Set(grant.consentScopes);
      const granted = [...tokenScopes].filter(
        (s) => consented.has(s) && (s !== MCP_SCOPE_WRITE || writeEnabled)
      );
      const scopes = granted.includes(MCP_SCOPE_WRITE)
        ? [MCP_SCOPE_READ, MCP_SCOPE_WRITE]
        : granted;

      return {
        clientId,
        expiresAt: claims.exp,
        extra: { consentId: grant.consentId, role: user.role, userId: claims.sub },
        resource: new URL(deps.resource),
        scopes,
        token,
      };
    },
  };
}
