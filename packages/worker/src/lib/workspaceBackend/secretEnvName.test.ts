import { describe, expect, it } from 'vitest';
import { assertSecretEnvName, secretEnvFlags } from './secretEnvName.js';

describe('assertSecretEnvName', () => {
  it('accepts plain identifiers', () => {
    expect(() => assertSecretEnvName('ANTHROPIC_API_KEY')).not.toThrow();
    expect(() => assertSecretEnvName('_x1')).not.toThrow();
  });

  it('refuses anything else', () => {
    for (const name of ['A=b', '1BAD', 'BAD NAME', '', 'A\nB', 'A;B']) {
      expect(() => assertSecretEnvName(name)).toThrow(/invalid secret environment name/);
    }
  });
});

describe('secretEnvFlags', () => {
  it('names each secret without its value', () => {
    expect(secretEnvFlags({ A: 'x', B: 'y' })).toEqual(['-e', 'A', '-e', 'B']);
    expect(secretEnvFlags(undefined)).toEqual([]);
  });

  it('refuses a name that would set a literal value', () => {
    expect(() => secretEnvFlags({ 'A=b': 'x' })).toThrow(/invalid secret environment name/);
  });
});
