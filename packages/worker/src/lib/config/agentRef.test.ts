import { describe, expect, it } from 'vitest';
import { formatAgentRef, parseAgentRef } from './agentRef.js';

describe('parseAgentRef', () => {
  it('floats when no version is given', () => {
    expect(parseAgentRef('reviewer')).toEqual({ key: 'reviewer' });
  });

  it('pins an explicit version', () => {
    expect(parseAgentRef('reviewer@3')).toEqual({ key: 'reviewer', version: 3 });
  });

  it('keeps the key intact when it contains other characters', () => {
    expect(parseAgentRef('my-custom.agent_v2')).toEqual({ key: 'my-custom.agent_v2' });
  });

  it.each([
    'reviewer@0',
    'reviewer@-1',
    'reviewer@1.5',
    'reviewer@',
    'reviewer@abc',
    '@2',
    '',
  ])('rejects the malformed ref %j', (ref) => {
    expect(() => parseAgentRef(ref)).toThrow(/Invalid agentRef/);
  });
});

describe('formatAgentRef', () => {
  it('round-trips a float and a pin', () => {
    expect(formatAgentRef({ key: 'reviewer' })).toBe('reviewer');
    expect(formatAgentRef({ key: 'reviewer', version: 3 })).toBe('reviewer@3');
  });
});
