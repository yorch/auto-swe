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
    it('is NOT_FOUND for a person and fine for platform ADMIN (the handler 404s)', () => {
      const def = team('governance', { team: 'LEAD' });
      const s = standing();
      const d = decideWith(s, KEY, def, { teamId: 'missing' });
      expect(!d.allowed && d.code).toBe('NOT_FOUND');
      expect(
        authorityOf(decideWith(standing({ actor: ADMIN }), KEY, def, { teamId: 'missing' }))
      ).toBe('platform-admin');
    });
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
  it('ranks org and platform authority ADMIN with no membership', () => {
    const s = standing({ org: 'ADMIN' });
    expect(actingRank(s, 't1', 'org-admin')).toBe('ADMIN');
    expect(actingRank(standing({ actor: ADMIN }), 't1', 'platform-admin')).toBe('ADMIN');
  });
  it('ranks a team-role decision by the membership', () => {
    expect(actingRank(standing({ team: 'LEAD' }), 't1', 'team-role')).toBe('LEAD');
  });
  it('never narrows platform ADMIN, even through a lower membership', () => {
    expect(actingRank(standing({ actor: ADMIN, team: 'MEMBER' }), 't1', 'team-role')).toBe('ADMIN');
  });
});
