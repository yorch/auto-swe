import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from './github.js';

const SECRET = 'top-secret-webhook-key';

function sign(payload: string | Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('verifyGitHubSignature', () => {
  it('accepts a valid signature for a string payload', () => {
    const payload = JSON.stringify({ action: 'closed', number: 42 });
    expect(verifyGitHubSignature(payload, sign(payload, SECRET), SECRET)).toBe(true);
  });

  it('accepts a valid signature for a Buffer payload', () => {
    const payload = Buffer.from(JSON.stringify({ action: 'completed' }), 'utf8');
    expect(verifyGitHubSignature(payload, sign(payload, SECRET), SECRET)).toBe(true);
  });

  it('string and Buffer forms of the same payload produce the same signature', () => {
    const text = '{"a":1}';
    const sig = sign(text, SECRET);
    expect(verifyGitHubSignature(text, sig, SECRET)).toBe(true);
    expect(verifyGitHubSignature(Buffer.from(text, 'utf8'), sig, SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const payload = '{"hello":"world"}';
    const wrong = sign(payload, 'some-other-secret');
    expect(verifyGitHubSignature(payload, wrong, SECRET)).toBe(false);
  });

  it('rejects when the payload was tampered with after signing', () => {
    const sig = sign('{"merged":false}', SECRET);
    expect(verifyGitHubSignature('{"merged":true}', sig, SECRET)).toBe(false);
  });

  it('returns false (does not throw) for a malformed short signature', () => {
    // timingSafeEqual throws on length mismatch — the helper must guard it.
    expect(() => verifyGitHubSignature('{}', 'sha256=abc', SECRET)).not.toThrow();
    expect(verifyGitHubSignature('{}', 'sha256=abc', SECRET)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifyGitHubSignature('{}', '', SECRET)).toBe(false);
  });

  it('returns false for a signature missing the sha256= prefix', () => {
    const payload = '{"x":1}';
    const bare = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    expect(verifyGitHubSignature(payload, bare, SECRET)).toBe(false);
  });

  it('returns false for an over-long signature without throwing', () => {
    const payload = '{"x":1}';
    const tooLong = `${sign(payload, SECRET)}deadbeef`;
    expect(() => verifyGitHubSignature(payload, tooLong, SECRET)).not.toThrow();
    expect(verifyGitHubSignature(payload, tooLong, SECRET)).toBe(false);
  });
});
