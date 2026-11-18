import { describe, expect, it } from 'vitest';
import { actingRank, decide, decideWith } from './can.js';
import type { CapabilityKey } from './catalog/index.js';
import type {
  Actor,
  Authority,
  CapabilityDef,
  OrgRank,
  Resource,
  Standing,
  TeamRank,
} from './types.js';

const USER: Actor = { id: 'u1', kind: 'user', role: 'USER' };
const ADMIN: Actor = { id: 'admin', kind: 'user', role: 'ADMIN' };
const KEY: CapabilityKey = 'team.read';

interface World {
  actor?: Actor;
  /** The actor's rank in team `t1` (and whether it is active). */
  team?: TeamRank | null;
  active?: boolean;
  /** The actor's rank in the organization `o1`, which owns `t1`. */
  org?: OrgRank | null;
}

function standing(world: World = {}): Standing {
  const actor = world.actor ?? USER;
  const teams = new Map([
    [
      't1',
      {
        isActive: world.active ?? true,
        orgId: 'o1',
        rank: world.team ?? null,
        storedRole: null,
        teamId: 't1',
      },
    ],
  ]);
  const orgs = new Map([['o1', { orgId: 'o1', rank: world.org ?? null }]]);
  return {
    actor,
    orgs,
    platformAdmin: actor.kind === 'user' && actor.role === 'ADMIN',
    teams,
  };
}

const T1: Resource = { teamId: 't1' };

function authorityOf(d: ReturnType<typeof decideWith>): Authority | 'denied' {
  return d.allowed ? d.authority : 'denied';
}

const team = (cls: CapabilityDef['class'], extra: Partial<CapabilityDef> = {}): CapabilityDef => ({
  class: cls,
  description: 'x',
  scope: 'team',
  ...extra,
});

describe('team-scoped capabilities by class and authority', () => {
  // The team minimum is LEAD and the org minimum ADMIN wherever the def carries one, so the table
  // shows what each class lets through. A `{org}` def on operation/sensitive is a catalog slip the
  // resolver must refuse anyway.
  const classes: CapabilityDef['class'][] = ['governance', 'operation', 'sensitive', 'read'];
  const orgReaches = new Set<CapabilityDef['class']>(['governance', 'read']);

  for (const cls of classes) {
    describe(cls, () => {
      const def = team(cls, { org: 'ADMIN', team: 'LEAD' });

      it('lets a team LEAD in', () => {
        expect(authorityOf(decideWith(standing({ team: 'LEAD' }), KEY, def, T1))).toBe('team-role');
      });
      it('keeps a team MEMBER out', () => {
        expect(authorityOf(decideWith(standing({ team: 'MEMBER' }), KEY, def, T1))).toBe('denied');
      });
      it('keeps a non-member out', () => {
        expect(authorityOf(decideWith(standing(), KEY, def, T1))).toBe('denied');
      });
      it(`${orgReaches.has(cls) ? 'lets' : 'does not let'} an org ADMIN in`, () => {
        const got = authorityOf(decideWith(standing({ org: 'ADMIN' }), KEY, def, T1));
        expect(got).toBe(orgReaches.has(cls) ? 'org-admin' : 'denied');
      });
      it('keeps an org MEMBER out of an ADMIN-only org rule', () => {
        expect(authorityOf(decideWith(standing({ org: 'MEMBER' }), KEY, def, T1))).toBe('denied');
      });
      it('lets platform ADMIN in as platform-admin', () => {
        expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def, T1))).toBe(
          'platform-admin'
        );
      });
      it('does not let platform ADMIN in when the capability excludes them', () => {
        const noAdmin = { ...def, platformAdmin: false };
        expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, noAdmin, T1))).toBe(
          'denied'
        );
        expect(
          authorityOf(decideWith(standing({ actor: ADMIN, team: 'LEAD' }), KEY, noAdmin, T1))
        ).toBe('team-role');
      });
    });
  }

  describe('an inactive team', () => {
    const rules: Array<[CapabilityDef['class'], boolean | undefined, boolean]> = [
      // class, requiresActiveTeam override, whether a LEAD gets in
      ['governance', undefined, false],
      ['operation', undefined, false],
      ['sensitive', undefined, false],
      ['read', undefined, true],
      ['read', true, false],
      ['operation', false, true],
    ];
    for (const [cls, override, leadIn] of rules) {
      it(`${cls} (requiresActiveTeam ${override ?? 'default'}): LEAD ${leadIn ? 'in' : 'out'}`, () => {
        const def = team(cls, {
          team: 'LEAD',
          ...(override === undefined ? {} : { requiresActiveTeam: override }),
        });
        expect(
          authorityOf(decideWith(standing({ active: false, team: 'LEAD' }), KEY, def, T1))
        ).toBe(leadIn ? 'team-role' : 'denied');
      });
    }

    it('still admits platform ADMIN, and an inactive team confers no org authority', () => {
      const def = team('governance', { org: 'ADMIN', team: 'LEAD' });
      expect(authorityOf(decideWith(standing({ active: false, actor: ADMIN }), KEY, def, T1))).toBe(
        'platform-admin'
      );
      expect(authorityOf(decideWith(standing({ active: false, org: 'ADMIN' }), KEY, def, T1))).toBe(
        'denied'
      );
    });

    it('names the deactivation in the refusal', () => {
      const d = decideWith(
        standing({ active: false, team: 'ADMIN' }),
        KEY,
        team('operation', { team: 'LEAD' }),
        T1
      );
      expect(d.allowed).toBe(false);
      expect(!d.allowed && d.reason).toMatch(/deactivated/);
    });
  });

  describe('authority precedence', () => {
    const def = team('governance', { org: 'ADMIN', team: 'LEAD' });
    it('an org ADMIN who is also a team MEMBER acts as org-admin: membership never narrows it', () => {
      expect(
        authorityOf(decideWith(standing({ org: 'ADMIN', team: 'MEMBER' }), KEY, def, T1))
      ).toBe('org-admin');
    });
    it('a platform ADMIN who also leads the team is recorded under the team role', () => {
      expect(authorityOf(decideWith(standing({ actor: ADMIN, team: 'LEAD' }), KEY, def, T1))).toBe(
        'team-role'
      );
    });
    it('an org MEMBER who leads the team is a team-role decision on a read capability', () => {
      const read = team('read', { org: 'MEMBER', team: 'LEAD' });
      expect(
        authorityOf(decideWith(standing({ org: 'MEMBER', team: 'LEAD' }), KEY, read, T1))
      ).toBe('team-role');
      expect(authorityOf(decideWith(standing({ org: 'MEMBER' }), KEY, read, T1))).toBe(
        'org-member'
      );
    });
  });

  describe('a team that is not found', () => {
    const def = team('governance', { team: 'LEAD' });
    it('is refused exactly as a non-member of a real team, and fine for platform ADMIN', () => {
      const missing = decideWith(standing(), KEY, def, { teamId: 'missing' });
      const real = decideWith(standing(), KEY, def, T1);
      expect(missing).toEqual(real);
      expect(!missing.allowed && missing.code).toBe('FORBIDDEN');
      expect(
        authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def, { teamId: 'missing' }))
      ).toBe('platform-admin');
    });
    it('is refused alike for an org-scoped capability asked through a team', () => {
      const orgDef: CapabilityDef = {
        class: 'governance',
        description: 'x',
        org: 'ADMIN',
        scope: 'org',
      };
      expect(decideWith(standing(), KEY, orgDef, { teamId: 'missing' })).toEqual(
        decideWith(standing(), KEY, orgDef, T1)
      );
    });
    it('does not say "deactivated" to someone with no standing, but does to a member', () => {
      const outsider = decideWith(standing({ active: false }), KEY, def, T1);
      expect(!outsider.allowed && outsider.reason).not.toMatch(/deactivated/);
      expect(outsider).toEqual(decideWith(standing(), KEY, def, T1));
      const member = decideWith(standing({ active: false, team: 'LEAD' }), KEY, def, T1);
      expect(!member.allowed && member.reason).toMatch(/deactivated/);
    });
  });

  it('refuses an anyOf with every leg denied the same way whatever the order', () => {
    const def = team('operation', { team: 'LEAD' });
    const s = standing({ team: 'MEMBER' });
    const legs: Resource[] = [{ teamId: 't1' }, { teamId: 'missing' }, { teamId: 'other' }];
    const forward = decideWith(s, KEY, def, { anyOf: legs });
    const backward = decideWith(s, KEY, def, { anyOf: [...legs].reverse() });
    expect(forward).toEqual(backward);
    expect(!forward.allowed && forward.code).toBe('FORBIDDEN');
  });

  it('with no resource, a team capability is platform ADMIN only', () => {
    const def = team('operation', { team: 'LEAD' });
    expect(authorityOf(decideWith(standing({ team: 'ADMIN' }), KEY, def))).toBe('denied');
    expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def))).toBe('platform-admin');
  });

  it('a capability with no team or org rule is platform ADMIN only', () => {
    const def = team('sensitive');
    expect(authorityOf(decideWith(standing({ org: 'ADMIN', team: 'ADMIN' }), KEY, def, T1))).toBe(
      'denied'
    );
    expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def, T1))).toBe(
      'platform-admin'
    );
  });

  it('refuses with the missing capability and a reason', () => {
    const d = decide(standing({ team: 'MEMBER' }), 'team.settings.manage', T1);
    expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN', missing: 'team.settings.manage' });
    expect(!d.allowed && d.reason).toMatch(/LEAD/);
  });
});

describe('org-scoped capabilities', () => {
  const def: CapabilityDef = { class: 'governance', description: 'x', org: 'ADMIN', scope: 'org' };

  it('lets an org ADMIN of that org in, not of another', () => {
    expect(authorityOf(decideWith(standing({ org: 'ADMIN' }), KEY, def, { orgId: 'o1' }))).toBe(
      'org-admin'
    );
    expect(authorityOf(decideWith(standing({ org: 'ADMIN' }), KEY, def, { orgId: 'o2' }))).toBe(
      'denied'
    );
  });
  it('keeps an org MEMBER out of an ADMIN capability and lets them into a MEMBER one', () => {
    expect(authorityOf(decideWith(standing({ org: 'MEMBER' }), KEY, def, { orgId: 'o1' }))).toBe(
      'denied'
    );
    const read = { ...def, class: 'read' as const, org: 'MEMBER' as const };
    expect(authorityOf(decideWith(standing({ org: 'MEMBER' }), KEY, read, { orgId: 'o1' }))).toBe(
      'org-member'
    );
  });
  it('lets platform ADMIN in', () => {
    expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def, { orgId: 'o1' }))).toBe(
      'platform-admin'
    );
  });
  it('resolves a team to its organization', () => {
    expect(authorityOf(decideWith(standing({ org: 'ADMIN' }), KEY, def, T1))).toBe('org-admin');
  });
  it('is platform-admin only with no resource', () => {
    expect(authorityOf(decideWith(standing({ org: 'ADMIN' }), KEY, def))).toBe('denied');
  });
});

describe('platform-scoped capabilities', () => {
  const def: CapabilityDef = { class: 'governance', description: 'x', scope: 'platform' };
  it('are platform ADMIN only', () => {
    expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def))).toBe('platform-admin');
    expect(authorityOf(decideWith(standing({ org: 'ADMIN', team: 'ADMIN' }), KEY, def))).toBe(
      'denied'
    );
  });
  it('a directory-style capability is held by a lead of any active team', () => {
    const dir: CapabilityDef = { ...def, class: 'read', requiresActiveTeam: true, team: 'LEAD' };
    const base = standing();
    const leads = (active: boolean, rank: TeamRank): Standing => ({
      ...base,
      memberships: [{ isActive: active, orgId: 'o1', rank, storedRole: null, teamId: 't1' }],
    });
    expect(authorityOf(decideWith(leads(true, 'LEAD'), KEY, dir, { anyTeam: true }))).toBe(
      'team-role'
    );
    expect(authorityOf(decideWith(leads(false, 'LEAD'), KEY, dir, { anyTeam: true }))).toBe(
      'denied'
    );
    expect(authorityOf(decideWith(leads(true, 'MEMBER'), KEY, dir, { anyTeam: true }))).toBe(
      'denied'
    );
    expect(authorityOf(decideWith(base, KEY, dir, { anyTeam: true }))).toBe('denied');
    expect(authorityOf(decideWith(standing({ actor: ADMIN }), KEY, dir, { anyTeam: true }))).toBe(
      'platform-admin'
    );
  });
});

describe('resource sets', () => {
  const def = team('operation', { team: 'LEAD' });
  const world = (ranks: Record<string, TeamRank | null>, actor: Actor = USER): Standing => ({
    actor,
    orgs: new Map(),
    platformAdmin: actor.kind === 'user' && actor.role === 'ADMIN',
    teams: new Map(
      Object.entries(ranks).map(([id, rank]) => [
        id,
        { isActive: true, orgId: null, rank, storedRole: null, teamId: id },
      ])
    ),
  });

  it('anyOf needs one team', () => {
    const s = world({ a: 'MEMBER', b: 'LEAD' });
    expect(
      authorityOf(decideWith(s, KEY, def, { anyOf: [{ teamId: 'a' }, { teamId: 'b' }] }))
    ).toBe('team-role');
    expect(
      authorityOf(
        decideWith(world({ a: 'MEMBER', b: null }), KEY, def, {
          anyOf: [{ teamId: 'a' }, { teamId: 'b' }],
        })
      )
    ).toBe('denied');
  });
  it('anyOf reports the least exceptional way in', () => {
    const s = world({ a: null, b: 'LEAD' }, ADMIN);
    expect(
      authorityOf(decideWith(s, KEY, def, { anyOf: [{ teamId: 'a' }, { teamId: 'b' }] }))
    ).toBe('team-role');
  });
  it('allOf needs every team', () => {
    const s = world({ a: 'LEAD', b: 'LEAD' });
    expect(
      authorityOf(decideWith(s, KEY, def, { allOf: [{ teamId: 'a' }, { teamId: 'b' }] }))
    ).toBe('team-role');
    expect(
      authorityOf(
        decideWith(world({ a: 'LEAD', b: 'MEMBER' }), KEY, def, {
          allOf: [{ teamId: 'a' }, { teamId: 'b' }],
        })
      )
    ).toBe('denied');
  });
  it('allOf reports the most exceptional way in', () => {
    const s = world({ a: 'LEAD', b: null }, ADMIN);
    expect(
      authorityOf(decideWith(s, KEY, def, { allOf: [{ teamId: 'a' }, { teamId: 'b' }] }))
    ).toBe('platform-admin');
    const s1 = world({ a: 'LEAD', b: 'LEAD' }, ADMIN);
    expect(
      authorityOf(decideWith(s1, KEY, def, { allOf: [{ teamId: 'a' }, { teamId: 'b' }] }))
    ).toBe('team-role');
    const s2 = world({ a: null, b: null }, ADMIN);
    expect(
      authorityOf(decideWith(s2, KEY, def, { allOf: [{ teamId: 'a' }, { teamId: 'b' }] }))
    ).toBe('platform-admin');
  });
  it('empty sets are refused rather than vacuously true', () => {
    expect(authorityOf(decideWith(world({}), KEY, def, { anyOf: [] }))).toBe('denied');
    expect(authorityOf(decideWith(world({}, ADMIN), KEY, def, { allOf: [] }))).toBe('denied');
  });
  it('anyTeam on a team capability needs a qualifying membership', () => {
    const s: Standing = {
      ...world({}),
      memberships: [{ isActive: true, orgId: null, rank: 'LEAD', storedRole: null, teamId: 'a' }],
    };
    expect(authorityOf(decideWith(s, KEY, def, { anyTeam: true }))).toBe('team-role');
    expect(authorityOf(decideWith(world({}), KEY, def, { anyTeam: true }))).toBe('denied');
  });
});

describe('a service principal', () => {
  it('is refused everything, platform capabilities included', () => {
    const principal: Standing = {
      actor: { id: 'sp', kind: 'principal' },
      orgs: new Map(),
      platformAdmin: true, // even a malformed standing cannot let it through
      teams: new Map(),
    };
    for (const key of ['platform.users.manage', 'team.launch', 'org.read'] as const) {
      const d = decide(principal, key, { teamId: 't1' });
      expect(d).toMatchObject({ allowed: false, code: 'FORBIDDEN', missing: key });
    }
  });
});

describe('actingRank', () => {
  it('ranks an org ADMIN of the active team’s own org ADMIN, with no membership', () => {
    expect(actingRank(standing({ org: 'ADMIN' }), 't1')).toBe('ADMIN');
  });
  it('gives an org ADMIN of an inactive team’s org only the membership rank', () => {
    expect(actingRank(standing({ active: false, org: 'ADMIN' }), 't1')).toBeNull();
    expect(actingRank(standing({ active: false, org: 'ADMIN', team: 'LEAD' }), 't1')).toBe('LEAD');
  });
  it('ranks platform ADMIN ADMIN, even through a lower membership', () => {
    expect(actingRank(standing({ actor: ADMIN }), 't1')).toBe('ADMIN');
    expect(actingRank(standing({ actor: ADMIN, team: 'MEMBER' }), 't1')).toBe('ADMIN');
  });
  it('ranks a plain member by the membership, and a stranger null', () => {
    expect(actingRank(standing({ team: 'LEAD' }), 't1')).toBe('LEAD');
    expect(actingRank(standing(), 't1')).toBeNull();
    expect(actingRank(standing({ team: 'LEAD' }), 'missing')).toBeNull();
  });
  it('gives an org ADMIN of a DIFFERENT org no elevated rank', () => {
    const s = standing({ team: 'MEMBER' });
    // t1 belongs to o1; the actor administers o2 only.
    const other: Standing = {
      ...s,
      orgs: new Map([
        ['o1', { orgId: 'o1', rank: 'MEMBER' }],
        ['o2', { orgId: 'o2', rank: 'ADMIN' }],
      ]),
    };
    expect(actingRank(other, 't1')).toBe('MEMBER');
  });
  it('is not changed by the decisions made on other teams (the review’s sequence)', () => {
    // X: the actor leads it. Y: the actor administers its organization.
    const s: Standing = {
      actor: USER,
      orgs: new Map([
        ['ox', { orgId: 'ox', rank: null }],
        ['oy', { orgId: 'oy', rank: 'ADMIN' }],
      ]),
      platformAdmin: false,
      teams: new Map([
        ['x', { isActive: true, orgId: 'ox', rank: 'LEAD', storedRole: null, teamId: 'x' }],
        ['y', { isActive: true, orgId: 'oy', rank: null, storedRole: null, teamId: 'y' }],
      ]),
    };
    const first = decide(s, 'team.repos.manage', { teamId: 'x' });
    const second = decide(s, 'team.repos.manage', { teamId: 'y' });
    const again = decide(s, 'team.repos.manage', { teamId: 'x' });
    expect(first).toEqual({ allowed: true, authority: 'team-role' });
    expect(second).toEqual({ allowed: true, authority: 'org-admin' });
    expect(again).toEqual(first);
    expect(actingRank(s, 'x')).toBe('LEAD');
    expect(actingRank(s, 'y')).toBe('ADMIN');
  });
});

describe('anyTeam with organization authority', () => {
  const gov = team('governance', { org: 'ADMIN', team: 'LEAD' });
  const base = standing({ org: 'ADMIN' });
  const withTeams = (teams: Array<{ orgId: string; isActive: boolean }>): Standing => ({
    ...base,
    memberships: [],
    orgTeams: teams,
  });
  it('lets an org ADMIN in when the org has an active team', () => {
    expect(
      authorityOf(
        decideWith(withTeams([{ isActive: true, orgId: 'o1' }]), KEY, gov, { anyTeam: true })
      )
    ).toBe('org-admin');
  });
  it('refuses when the org has only inactive teams, or none, or another org’s', () => {
    for (const teams of [
      [{ isActive: false, orgId: 'o1' }],
      [],
      [{ isActive: true, orgId: 'o2' }],
    ]) {
      expect(authorityOf(decideWith(withTeams(teams), KEY, gov, { anyTeam: true }))).toBe('denied');
    }
  });
  it('counts an inactive team for a capability that does not need an active one', () => {
    const read = team('read', { org: 'ADMIN' });
    expect(
      authorityOf(
        decideWith(withTeams([{ isActive: false, orgId: 'o1' }]), KEY, read, { anyTeam: true })
      )
    ).toBe('org-admin');
  });
  it('never lets org authority reach an operation or sensitive capability', () => {
    const op = team('operation', { org: 'ADMIN', team: 'LEAD' });
    expect(
      authorityOf(
        decideWith(withTeams([{ isActive: true, orgId: 'o1' }]), KEY, op, { anyTeam: true })
      )
    ).toBe('denied');
  });
  it('ignores an inactive membership when the capability needs an active team', () => {
    const lead: Standing = {
      ...standing(),
      memberships: [{ isActive: false, orgId: 'o1', rank: 'LEAD', storedRole: null, teamId: 't1' }],
    };
    expect(
      authorityOf(decideWith(lead, KEY, team('operation', { team: 'LEAD' }), { anyTeam: true }))
    ).toBe('denied');
  });
});
