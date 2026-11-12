import { describe, expect, it } from 'vitest';
import { effectiveEgressAllowlist } from './egressPolicy.js';

describe('effective egress allowlist', () => {
  it('merges and deduplicates restricted baseline and team entries', () => {
    expect(
      effectiveEgressAllowlist(
        'restricted',
        ['EXAMPLE.com', 'team.test'],
        ['example.com', 'npm.test']
      )
    ).toEqual(['example.com', 'npm.test', 'team.test']);
  });
  it('merges open with a non-empty team list but never restricts open/empty', () => {
    expect(effectiveEgressAllowlist('open', ['team.test'], ['npm.test'])).toEqual([
      'npm.test',
      'team.test',
    ]);
    expect(effectiveEgressAllowlist('open', [], ['npm.test'])).toEqual([]);
  });
  it('supports empty restricted lists and ignores lists under blocked', () => {
    expect(effectiveEgressAllowlist('restricted', [], [])).toEqual([]);
    expect(effectiveEgressAllowlist('restricted', [], ['npm.test'])).toEqual(['npm.test']);
    expect(effectiveEgressAllowlist('blocked', ['team.test'], ['npm.test'])).toEqual([]);
  });
});
