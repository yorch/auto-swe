import { describe, expect, it } from 'vitest';
import { redactExecError, redactSecrets, redactToken } from './redactToken.js';

describe('redactToken', () => {
  it('replaces every occurrence of the token', () => {
    expect(redactToken('a tok b tok', 'tok')).toBe('a *** b ***');
  });
  it('is a no-op without a token', () => {
    expect(redactToken('a tok b', null)).toBe('a tok b');
    expect(redactToken('a tok b', '')).toBe('a tok b');
  });
  it('stringifies non-strings', () => {
    expect(redactToken(42, 'x')).toBe('42');
  });
});

describe('redactSecrets', () => {
  it('scrubs several secrets, skipping empty ones', () => {
    expect(redactSecrets('raw=abc b64=YWJj', ['abc', undefined, '', 'YWJj'])).toBe(
      'raw=*** b64=***'
    );
  });
});

describe('redactExecError', () => {
  it('scrubs message, stdout, stderr and cmd in place', () => {
    const err = Object.assign(new Error('Command failed: git clone https://x:tok@h/r'), {
      cmd: 'git -c http.extraheader=b64tok clone',
      stderr: 'fatal: tok rejected',
      stdout: 'tok',
    });
    redactExecError(err, ['tok', 'b64tok']);
    expect(err.message).toBe('Command failed: git clone https://x:***@h/r');
    expect(err.cmd).toBe('git -c http.extraheader=*** clone');
    expect(err.stderr).toBe('fatal: *** rejected');
    expect(err.stdout).toBe('***');
  });

  it('tolerates non-object errors and empty secret lists', () => {
    expect(() => redactExecError('boom', ['tok'])).not.toThrow();
    expect(() => redactExecError(null, ['tok'])).not.toThrow();
    const err = new Error('tok');
    redactExecError(err, [undefined, null, '']);
    expect(err.message).toBe('tok');
  });
});
