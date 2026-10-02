import { exportJWK, generateKeyPair, type JSONWebKeySet, type JWK, SignJWT } from 'jose';
import type { McpGrant, McpVerifierDeps } from '../lib/mcpTokenVerifier.js';

/** A signing key the way the authorization server publishes it. */
export async function makeSigningKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid, use: 'sig' };
  return { jwk, kid, privateKey };
}
export type TestKey = Awaited<ReturnType<typeof makeSigningKey>>;

export const TEST_ISSUER = 'http://localhost:8080/api/auth';
export const TEST_RESOURCE = 'http://localhost:8080/api/v1/mcp';
export const TEST_USER = '11111111-1111-4111-8111-111111111111';
export const TEST_CLIENT = 'client-abc';

interface MintOptions {
  key: TestKey;
  /** Header `typ`; `null` omits it. */
  typ?: string | null;
  /** Header `kid`; `null` omits it. */
  kid?: string | null;
  claims?: Record<string, unknown>;
  /** Claims to drop from the default set. */
  omit?: string[];
  /** Seconds since epoch. */
  iat?: number;
  exp?: number;
}

/** An access token shaped like the ones the authorization server issues. */
export async function mintToken(o: MintOptions): Promise<string> {
  const iat = o.iat ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    aud: TEST_RESOURCE,
    azp: TEST_CLIENT,
    client_id: TEST_CLIENT,
    scope: 'mcp:read',
    sub: TEST_USER,
    ...o.claims,
  };
  for (const name of o.omit ?? []) {
    delete claims[name];
  }
  const header: Record<string, unknown> = { alg: 'EdDSA' };
  if (o.typ !== null) {
    header.typ = o.typ ?? 'at+jwt';
  }
  if (o.kid !== null) {
    header.kid = o.kid ?? o.key.kid;
  }
  return new SignJWT(claims)
    .setProtectedHeader(header as { alg: string })
    .setIssuer(TEST_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(o.exp ?? iat + 600)
    .sign(o.key.privateKey);
}

/** Verifier dependencies backed by plain values, for tests that do not need a database. */
export function fakeVerifierDeps(
  keys: TestKey[],
  state: {
    grant?: McpGrant | null;
    user?: { isActive: boolean; role: string } | null;
    writeToolsEnabled?: boolean;
    jwksFetches?: { count: number };
    /** Every `(userId, clientId)` the verifier asked the consent lookup about. */
    grantLookups?: Array<[string, string]>;
  } = {}
): McpVerifierDeps & { state: typeof state; setKeys: (next: TestKey[]) => void } {
  let current = keys;
  const grant: McpGrant | null =
    state.grant === undefined
      ? {
          clientActive: true,
          consentId: 'consent-1',
          consentScopes: ['mcp:read', 'mcp:write', 'offline_access'],
          consentUpdatedAt: new Date(Date.now() - 60_000),
        }
      : state.grant;
  state.grant = grant;
  state.user = state.user === undefined ? { isActive: true, role: 'ENGINEER' } : state.user;
  state.writeToolsEnabled ??= false;
  state.jwksFetches ??= { count: 0 };
  state.grantLookups ??= [];
  return {
    fetchJwks: async (): Promise<JSONWebKeySet> => {
      (state.jwksFetches as { count: number }).count++;
      return { keys: current.map((k) => k.jwk) };
    },
    getWriteToolsEnabled: async () => state.writeToolsEnabled as boolean,
    issuer: TEST_ISSUER,
    loadGrant: async (userId, clientId) => {
      state.grantLookups?.push([userId, clientId]);
      return state.grant ?? null;
    },
    loadUser: async () => state.user ?? null,
    resource: TEST_RESOURCE,
    setKeys: (next) => {
      current = next;
    },
    state,
  };
}
