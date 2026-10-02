import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  fakeVerifierDeps,
  makeSigningKey,
  mintToken,
  TEST_CLIENT,
  TEST_ISSUER,
  TEST_RESOURCE,
  TEST_USER,
} from '../test/mcpTokens.js';
import { MCP_JWKS_MIN_REFRESH_MS } from './mcpOAuth.js';
import {
  createMcpTokenVerifier,
  type McpTokenRejection,
  type McpVerifierDeps,
} from './mcpTokenVerifier.js';

const key = await makeSigningKey('key-1');
const otherKey = await makeSigningKey('key-1'); // same kid, different material

type Outcome = {
  reason?: McpTokenRejection;
  info?: Awaited<ReturnType<OAuthTokenVerifier['verifyAccessToken']>>;
  error?: unknown;
};

/** A verifier (one key cache) that reports why it refused a token. */
function verifierFor(deps: McpVerifierDeps, clock?: { now: number }) {
  let reason: McpTokenRejection | undefined;
  const verifier = createMcpTokenVerifier({
    ...deps,
    now: clock ? () => clock.now : undefined,
    onReject: (r) => {
      reason = r;
    },
  });
  return async (token: string): Promise<Outcome> => {
    reason = undefined;
    try {
      return { info: await verifier.verifyAccessToken(token) };
    } catch (error) {
      return { error, reason };
    }
  };
}

/** One token through a fresh verifier. */
async function run(token: string, deps = fakeVerifierDeps([key])): Promise<Outcome> {
  return verifierFor(deps)(token);
}

describe('mcp token verifier', () => {
  it('accepts a token the authorization server issued, and returns who and what', async () => {
    const { info, error } = await run(await mintToken({ key }));
    expect(error).toBeUndefined();
    expect(info).toMatchObject({
      clientId: TEST_CLIENT,
      extra: { consentId: 'consent-1', role: 'ENGINEER', userId: TEST_USER },
      scopes: ['mcp:read'],
    });
    expect(info?.resource?.href).toBe(TEST_RESOURCE);
    expect(typeof info?.expiresAt).toBe('number');
  });

  describe('what the token must be', () => {
    it.each([
      ['an audience that is another resource', { aud: 'http://localhost:8080/api/v1/other' }],
      [
        'an audience list that also names another resource',
        { aud: [TEST_RESOURCE, 'https://x.test'] },
      ],
    ])('rejects %s', async (_name, claims) => {
      const r = await run(await mintToken({ claims, key }));
      expect(r.reason).toBe('wrong-audience');
    });

    it('rejects a token with no audience', async () => {
      const r = await run(await mintToken({ key, omit: ['aud'] }));
      expect(r.reason).toBe('wrong-audience');
    });

    it('rejects an opaque token', async () => {
      expect((await run('3k2j4h5g6f7d8s9a0q1w2e3r4t5y6u7i')).reason).toBe('not-a-jwt');
      expect((await run('ats_0123456789abcdef')).reason).toBe('not-a-jwt');
    });

    it('rejects a token from another issuer', async () => {
      const token = await new SignJWT({ aud: TEST_RESOURCE, azp: 'c', scope: 'mcp:read', sub: 'u' })
        .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'at+jwt' })
        .setIssuer('https://evil.test/api/auth')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(key.privateKey);
      expect((await run(token)).reason).toBe('wrong-issuer');
    });

    it('rejects a token with the right header and the wrong signature', async () => {
      const token = await mintToken({ key: otherKey });
      expect((await run(token)).reason).toBe('bad-signature');
    });

    it('rejects a token signed with another algorithm', async () => {
      const token = await new SignJWT({ aud: TEST_RESOURCE, azp: 'c', scope: 'mcp:read', sub: 'u' })
        .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'at+jwt' })
        .setIssuer('http://localhost:8080/api/auth')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
      expect((await run(token)).reason).toBe('bad-signature');
    });

    it('rejects an unsigned token as a bad signature', async () => {
      const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const token = `${part({ alg: 'none', kid: key.kid, typ: 'at+jwt' })}.${part({ aud: TEST_RESOURCE, sub: 'u' })}.`;
      expect((await run(token)).reason).toBe('bad-signature');
    });

    it('accepts only EdDSA, even when the published keys would verify another algorithm', async () => {
      // An RSA key in the published set verifies an RS256 token unless the algorithm is pinned.
      const rsa = await generateKeyPair('RS256', { extractable: true });
      const deps = fakeVerifierDeps([key]);
      deps.fetchJwks = async () => ({
        keys: [
          key.jwk,
          { ...(await exportJWK(rsa.publicKey)), alg: 'RS256', kid: 'rsa', use: 'sig' },
        ],
      });
      const token = await new SignJWT({
        aud: TEST_RESOURCE,
        azp: TEST_CLIENT,
        scope: 'mcp:read',
        sub: TEST_USER,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'rsa', typ: 'at+jwt' })
        .setIssuer(TEST_ISSUER)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(rsa.privateKey);
      expect((await run(token, deps)).reason).toBe('bad-signature');
    });

    it("asks the consent lookup about exactly the token's user and client", async () => {
      const deps = fakeVerifierDeps([key]);
      const token = await mintToken({
        claims: { azp: 'client-xyz', client_id: 'client-xyz', sub: 'user-xyz' },
        key,
      });
      expect((await run(token, deps)).info).toBeDefined();
      expect(deps.state.grantLookups).toEqual([['user-xyz', 'client-xyz']]);
    });

    it.each([
      ['no typ', null],
      ['typ JWT (the session-token JWT the jwt plugin mints)', 'JWT'],
    ])('rejects a token with %s', async (_name, typ) => {
      expect((await run(await mintToken({ key, typ }))).reason).toBe('wrong-type');
    });

    it('accepts the RFC 9068 spellings of the type', async () => {
      expect((await run(await mintToken({ key, typ: 'AT+JWT' }))).info).toBeDefined();
      expect((await run(await mintToken({ key, typ: 'application/at+jwt' }))).info).toBeDefined();
    });

    it('rejects a token with no kid', async () => {
      expect((await run(await mintToken({ key, kid: null }))).reason).toBe('bad-signature');
    });

    it('rejects an expired token', async () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const r = await run(await mintToken({ exp: past + 600, iat: past, key }));
      expect(r.reason).toBe('expired');
    });

    it.each(['sub', 'client_id'])('rejects a token with no %s', async (claim) => {
      const omit = claim === 'client_id' ? ['client_id', 'azp'] : [claim];
      expect((await run(await mintToken({ key, omit }))).reason).toMatch(/malformed-claims/);
    });

    it('takes the client from azp when client_id is absent', async () => {
      const r = await run(await mintToken({ key, omit: ['client_id'] }));
      expect(r.info?.clientId).toBe(TEST_CLIENT);
    });

    it('answers a verdict as an invalid_token error, never a server error', async () => {
      const r = await run('garbage');
      expect(r.error).toMatchObject({ code: 'invalid_token' });
    });
  });

  describe('the signing keys', () => {
    it('refreshes once on an unknown kid and accepts a token from a newly rotated key', async () => {
      const rotated = await makeSigningKey('key-2');
      const deps = fakeVerifierDeps([key]);
      const clock = { now: Date.now() };
      const verify = verifierFor(deps, clock);
      expect((await verify(await mintToken({ key }))).info).toBeDefined();
      expect(deps.state.jwksFetches?.count).toBe(1);
      // The authorization server rotates; the cache still holds only key-1.
      deps.setKeys([key, rotated]);
      expect((await verify(await mintToken({ key: rotated }))).info).toBeDefined();
      expect(deps.state.jwksFetches?.count).toBe(2);
    });

    it('does not turn a stream of unknown kids into a stream of key reads', async () => {
      const stranger = await makeSigningKey('stranger');
      const deps = fakeVerifierDeps([key]);
      const clock = { now: Date.now() };
      const verify = verifierFor(deps, clock);
      await verify(await mintToken({ key }));
      expect(deps.state.jwksFetches?.count).toBe(1);
      for (let i = 0; i < 5; i++) {
        expect((await verify(await mintToken({ key: stranger }))).reason).toBe('bad-signature');
      }
      // One forced read for the first, none for the rest.
      expect(deps.state.jwksFetches?.count).toBe(2);
      clock.now += MCP_JWKS_MIN_REFRESH_MS + 1;
      await verify(await mintToken({ key: stranger }));
      expect(deps.state.jwksFetches?.count).toBe(3);
    });

    it('still verifies a token signed by a key that is rotated out but still published', async () => {
      const retired = await makeSigningKey('retired');
      const deps = fakeVerifierDeps([retired, key]);
      expect((await run(await mintToken({ key: retired }), deps)).info).toBeDefined();
    });

    it('reports a failure to read the keys as a server fault, not a bad token', async () => {
      const deps = fakeVerifierDeps([key]);
      deps.fetchJwks = async () => {
        throw new Error('database down');
      };
      const r = await run(await mintToken({ key }), deps);
      expect(r.error).toMatchObject({ message: 'database down' });
      expect(r.reason).toBeUndefined();
    });
  });

  describe('what the database says', () => {
    it('rejects a token whose consent was revoked', async () => {
      const r = await run(await mintToken({ key }), fakeVerifierDeps([key], { grant: null }));
      expect(r.reason).toBe('no-consent');
    });

    it('rejects a token issued before the consent was last written, beyond the skew', async () => {
      const grant = {
        clientActive: true,
        consentId: 'c',
        consentScopes: ['mcp:read'],
        consentUpdatedAt: new Date(),
      };
      const iat = Math.floor(Date.now() / 1000) - 30;
      const r = await run(await mintToken({ iat, key }), fakeVerifierDeps([key], { grant }));
      expect(r.reason).toBe('consent-superseded');
    });

    it('tolerates clock skew between the replica that consented and the one that issued', async () => {
      const grant = {
        clientActive: true,
        consentId: 'c',
        consentScopes: ['mcp:read'],
        consentUpdatedAt: new Date(),
      };
      const iat = Math.floor(Date.now() / 1000) - 3;
      const r = await run(await mintToken({ iat, key }), fakeVerifierDeps([key], { grant }));
      expect(r.info).toBeDefined();
    });

    it('rejects a disabled or deleted client', async () => {
      const grant = {
        clientActive: false,
        consentId: 'c',
        consentScopes: ['mcp:read'],
        consentUpdatedAt: new Date(0),
      };
      const r = await run(await mintToken({ key }), fakeVerifierDeps([key], { grant }));
      expect(r.reason).toBe('client-disabled');
    });

    it.each([
      ['inactive', { isActive: false, role: 'ENGINEER' }],
      ['gone', null],
    ])('rejects a user who is %s', async (_name, user) => {
      const r = await run(await mintToken({ key }), fakeVerifierDeps([key], { user }));
      expect(r.reason).toBe('user-inactive');
    });
  });

  describe('effective scopes', () => {
    const both = { claims: { scope: 'mcp:read mcp:write offline_access' } };

    it('keeps only the MCP scopes the token carries', async () => {
      const r = await run(
        await mintToken({ key, ...both }),
        fakeVerifierDeps([key], { writeToolsEnabled: true })
      );
      expect(r.info?.scopes).toEqual(['mcp:read', 'mcp:write']);
    });

    it('drops write while writes are off, whatever the token and the consent say', async () => {
      const r = await run(
        await mintToken({ key, ...both }),
        fakeVerifierDeps([key], { writeToolsEnabled: false })
      );
      expect(r.info?.scopes).toEqual(['mcp:read']);
    });

    it('treats write as read', async () => {
      const r = await run(
        await mintToken({ claims: { scope: 'mcp:write' }, key }),
        fakeVerifierDeps([key], { writeToolsEnabled: true })
      );
      expect(r.info?.scopes).toEqual(['mcp:read', 'mcp:write']);
    });

    it('drops what the user did not consent to', async () => {
      const grant = {
        clientActive: true,
        consentId: 'c',
        consentScopes: ['mcp:read'],
        consentUpdatedAt: new Date(0),
      };
      const r = await run(
        await mintToken({ key, ...both }),
        fakeVerifierDeps([key], { grant, writeToolsEnabled: true })
      );
      expect(r.info?.scopes).toEqual(['mcp:read']);
    });

    it('returns no scopes for a token that carries none of ours', async () => {
      const r = await run(await mintToken({ claims: { scope: 'offline_access' }, key }));
      expect(r.info?.scopes).toEqual([]);
    });
  });
});
