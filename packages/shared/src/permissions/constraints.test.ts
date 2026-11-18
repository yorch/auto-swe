import { describe, expect, it } from 'vitest';
import { isAssignee, isLauncher, notAuthor, notSelf } from './constraints.js';

describe('constraints', () => {
  it('notSelf refuses acting on yourself', () => {
    expect(notSelf('a', 'b')).toBe(true);
    expect(notSelf('a', 'a')).toBe(false);
  });
  it('isLauncher needs a recorded launcher who is the actor', () => {
    expect(isLauncher('a', 'a')).toBe(true);
    expect(isLauncher('a', 'b')).toBe(false);
    expect(isLauncher('a', null)).toBe(false);
    expect(isLauncher('a', undefined)).toBe(false);
  });
  it('notAuthor lets anyone review work with no recorded author, and not the author', () => {
    expect(notAuthor('a', 'b')).toBe(true);
    expect(notAuthor('a', 'a')).toBe(false);
    expect(notAuthor('a', null)).toBe(true);
  });
  it('isAssignee takes one assignee or a list', () => {
    expect(isAssignee('a', 'a')).toBe(true);
    expect(isAssignee('a', ['b', 'a'])).toBe(true);
    expect(isAssignee('a', ['b'])).toBe(false);
    expect(isAssignee('a', null)).toBe(false);
    expect(isAssignee('a', [])).toBe(false);
  });
  it('takes no role, so an administrator passes only as themselves', () => {
    // The signatures carry ids only: there is nothing a platform admin could present instead.
    expect(notSelf.length).toBe(2);
    expect(isLauncher.length).toBe(2);
  });
});
