import { describe, expect, it } from 'vitest';
import { refusalMessage } from './refusalMessage';

describe('refusalMessage', () => {
  it('words a team-or-org refusal with role labels and the catalog description', () => {
    const out = refusalMessage(
      "Requires LEAD in this team or ADMIN in the team's organization",
      'team.automations.manage'
    );
    expect(out).toMatch(
      /^Needs a Team lead in this team or an Org admin in the team's organization\./
    );
    expect(out).toContain('Covers: create, change and delete event automations.');
    expect(out).not.toContain('LEAD');
  });
  it('omits the description for an unknown key', () => {
    expect(refusalMessage('Requires ADMIN in this team', 'nope.nope')).toBe(
      'Needs a Team admin in this team.'
    );
  });
  it('keeps the original for text it cannot parse', () => {
    expect(refusalMessage('Requires platform admin', 'x')).toBe('Requires platform admin');
    expect(refusalMessage('The team is deactivated')).toBe('The team is deactivated');
    expect(refusalMessage('Requires ADMIN role, or LEAD membership')).toBe(
      'Requires ADMIN role, or LEAD membership'
    );
  });
});
