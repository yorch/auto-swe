import { beforeEach, describe, expect, it } from 'vitest';
import { _resetKeyCacheForTests } from './crypto.js';
import {
  headerNameProblem,
  MAX_MCP_HEADERS,
  openMcpHeaders,
  sealMcpHeaders,
  validateMcpHeaders,
} from './mcpHeaders.js';

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  _resetKeyCacheForTests();
});

describe('header names', () => {
  it('accepts ordinary tokens and refuses hop-by-hop, transport-owned and malformed names', () => {
    expect(headerNameProblem('X-Api-Key')).toBeNull();
    expect(headerNameProblem('x_tenant.id')).toBeNull();
    for (const bad of [
      'Authorization',
      'PROXY-AUTHORIZATION',
      'Proxy-Anything',
      'Connection',
      'Keep-Alive',
      'TE',
      'Trailer',
      'Transfer-Encoding',
      'Upgrade',
      'Host',
      'Content-Length',
      'Cookie',
      '',
      'has space',
      'colon:',
      'new\nline',
    ]) {
      expect(headerNameProblem(bad), bad).not.toBeNull();
    }
  });
});

describe('header sets', () => {
  it('bounds the count, refuses duplicates in any case, and requires clean values', () => {
    expect(validateMcpHeaders([{ name: 'X-A', value: 'a b' }])).toBeNull();
    expect(
      validateMcpHeaders(
        Array.from({ length: MAX_MCP_HEADERS + 1 }, (_, i) => ({ name: `X-${i}`, value: 'v' }))
      )
    ).not.toBeNull();
    expect(
      validateMcpHeaders([
        { name: 'X-A', value: '1' },
        { name: 'x-a', value: '2' },
      ])
    ).not.toBeNull();
    for (const value of ['', ' lead', 'trail ', 'a\r\nInjected: 1', 'tab\there', 'é']) {
      expect(validateMcpHeaders([{ name: 'X-A', value }]), JSON.stringify(value)).not.toBeNull();
    }
  });
});

describe('sealed headers', () => {
  it('round-trips without the plaintext appearing in the columns', () => {
    const sealed = sealMcpHeaders([{ name: 'X-Api-Key', value: 'plain-secret-1' }]);
    expect(Buffer.from(sealed.headersCiphertext).toString('utf8')).not.toContain('plain-secret-1');
    expect(openMcpHeaders(sealed)).toEqual([{ name: 'X-Api-Key', value: 'plain-secret-1' }]);
  });

  it('opens to nothing when none is stored and throws a fixed error when unreadable', () => {
    expect(openMcpHeaders({})).toEqual([]);
    const sealed = sealMcpHeaders([{ name: 'X-A', value: 'v' }]);
    expect(() =>
      openMcpHeaders({
        ...sealed,
        headersCiphertext: new Uint8Array(sealed.headersCiphertext.length),
      })
    ).toThrow('stored MCP headers cannot be read');
  });

  it('refuses a stored set that holds a forbidden header', () => {
    const sealed = sealMcpHeaders([{ name: 'Host', value: 'evil.example' }]);
    expect(() => openMcpHeaders(sealed)).toThrow('stored MCP headers cannot be read');
  });
});
