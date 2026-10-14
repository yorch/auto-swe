import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './randomId';

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when the context provides it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000000' });
    expect(randomId()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('falls back to getRandomValues outside a secure context', () => {
    // Over plain http the browser leaves randomUUID undefined.
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => real.getRandomValues(a),
    });
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
