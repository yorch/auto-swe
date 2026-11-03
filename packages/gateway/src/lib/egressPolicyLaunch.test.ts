import { describe, expect, it, vi } from 'vitest';
import { egressPolicyForRerun, storedEgressPolicy } from './egressPolicyLaunch.js';

const ceiling = vi.hoisted(() => ({ value: 'open' as string }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => ceiling.value) }));

describe('storedEgressPolicy', () => {
  it('reads a valid policy from the recorded body', () => {
    expect(storedEgressPolicy('{"egressPolicy":"restricted"}')).toBe('restricted');
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['not json'],
    ['[]'],
    ['{"egressPolicy":"closed"}'],
    ['{"description":"x"}'],
  ])('ignores %s', (raw) => {
    expect(storedEgressPolicy(raw)).toBeUndefined();
  });
});

describe('egressPolicyForRerun', () => {
  it('follows the cascade when nothing was stored', async () => {
    ceiling.value = 'blocked';
    expect(await egressPolicyForRerun(undefined, {})).toBeUndefined();
  });

  it.each([
    ['open', 'restricted', 'restricted'],
    ['blocked', 'open', 'blocked'],
    ['open', 'blocked', 'blocked'],
  ])('with cascade %s and stored %s runs at %s', async (cascade, stored, expected) => {
    ceiling.value = cascade;
    expect(await egressPolicyForRerun(stored as 'open', {})).toBe(expected);
  });
});
