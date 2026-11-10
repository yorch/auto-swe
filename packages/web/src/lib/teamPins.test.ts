import { describe, expect, it } from 'vitest';
import { canPinMore, togglePinnedTeam } from './teamPins';

const members = ['a', 'b', 'c'];

describe('togglePinnedTeam', () => {
  it('appends a new pin and keeps the order of the others', () => {
    expect(togglePinnedTeam(['c', 'a'], 'b', members)).toEqual(['c', 'a', 'b']);
  });
  it('removes a pin, down to an empty list for the last one', () => {
    expect(togglePinnedTeam(['a', 'b'], 'a', members)).toEqual(['b']);
    expect(togglePinnedTeam(['a'], 'a', members)).toEqual([]);
  });
  it('de-duplicates and drops slugs of teams the caller is not in', () => {
    expect(togglePinnedTeam(['a', 'a', 'gone'], 'b', members)).toEqual(['a', 'b']);
  });
  it('never pins a team the caller is not a member of', () => {
    expect(togglePinnedTeam(['a'], 'stranger', members)).toEqual(['a']);
  });
  it('refuses a pin past the limit of 20 and returns the list as it was', () => {
    const slugs = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const full = slugs.slice(0, 20);
    expect(togglePinnedTeam(full, 't20', slugs)).toBe(full);
    expect(canPinMore(full, slugs)).toBe(false);
    expect(togglePinnedTeam(full, 't3', slugs)).toHaveLength(19);
  });
});
