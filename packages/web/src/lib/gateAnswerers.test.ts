import { describe, expect, it } from 'vitest';
import {
  distinctTeamNames,
  runControlWho,
  WHO_UNKNOWN,
  WHO_UNKNOWN_MANY,
  whoCanAnswer,
} from './gateAnswerers';

describe('whoCanAnswer', () => {
  it('names the team and qualifies repository access by enforcement', () => {
    expect(whoCanAnswer('Payments')).toBe(
      'Answerers include members of Payments (with repository access when GitHub access is enforced), the launcher and platform admins.'
    );
  });

  it.each([null, undefined, '', '  ', [null, ' ']])('claims nothing for %j', (name) => {
    expect(whoCanAnswer(name)).toBe(WHO_UNKNOWN);
    expect(whoCanAnswer(name, true)).toBe(WHO_UNKNOWN_MANY);
  });

  it('lists distinct teams once', () => {
    expect(distinctTeamNames(['A', 'B', 'A', ' ', null])).toEqual(['A', 'B']);
    expect(whoCanAnswer(['A', 'B', 'C'])).toContain('members of A, B or C (');
  });

  it('stays short enough to describe a button', () => {
    expect(`You cannot answer this step. ${whoCanAnswer('Payments')}`.length).toBeLessThanOrEqual(
      160
    );
  });
});

describe('runControlWho', () => {
  it('says the rule includes the team, the launcher and admins', () => {
    expect(runControlWho('Payments', 'cancel')).toBe(
      'Who can cancel this run includes members of Payments (with repository access when GitHub access is enforced), the launcher and platform admins.'
    );
    expect(runControlWho(null, 're-run')).toContain('members of the owning team (');
  });
});
