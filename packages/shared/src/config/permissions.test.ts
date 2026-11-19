import { describe, expect, it } from 'vitest';
import {
  type ConfigActor,
  type ConfigGrant,
  checkSettingWrite,
  keyPatternMatches,
} from './permissions.js';
import { SETTING_DEFINITIONS, SETTING_KEYS } from './registry.js';

const ORG = 'org-1';
const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';

/// The actor's role in each team, as the service loads it from memberships.
const leadOfTeam = new Map([[TEAM, 'LEAD']]);

const admin: ConfigActor = { id: 'u-admin', role: 'ADMIN' };
const lead: ConfigActor = { id: 'u-lead', role: 'LEAD' };
const engineer: ConfigActor = { id: 'u-eng', role: 'ENGINEER' };

function teamGrant(overrides: Partial<ConfigGrant> = {}): ConfigGrant {
  return {
    keyPattern: 'channel.*',
    orgId: null,
    role: 'LEAD',
    scope: 'TEAM',
    teamId: TEAM,
    userId: null,
    ...overrides,
  };
}

describe('keyPatternMatches', () => {
  it('matches everything under *', () => {
    expect(keyPatternMatches('*', 'channel.historyMessageLimit')).toBe(true);
  });

  it('matches a group prefix but not a group whose name merely starts the same', () => {
    expect(keyPatternMatches('channel.*', 'channel.historyMessageLimit')).toBe(true);
    expect(keyPatternMatches('channel.*', 'channelling.foo')).toBe(false);
  });

  it('matches an exact key only', () => {
    expect(keyPatternMatches('channel.historyMessageLimit', 'channel.historyMessageLimit')).toBe(
      true
    );
    expect(keyPatternMatches('channel.historyMessageLimit', 'channel.memoryContextItems')).toBe(
      false
    );
  });
});

describe('checkSettingWrite', () => {
  it('rejects a key the registry does not define', () => {
    const result = checkSettingWrite(admin, { key: 'made.up', scope: 'GLOBAL' }, []);
    expect(result).toMatchObject({ allowed: false, code: 'UNKNOWN_SETTING' });
  });

  it('rejects a scope the definition does not permit', () => {
    // github.userCredentialsEnabled is a security control: GLOBAL only, by design.
    const result = checkSettingWrite(
      admin,
      { key: 'github.userCredentialsEnabled', scope: 'TEAM', targetTeamId: TEAM },
      []
    );
    expect(result).toMatchObject({ allowed: false, code: 'SCOPE_NOT_ALLOWED' });
  });

  it('lets an admin write without any grant', () => {
    expect(
      checkSettingWrite(admin, { key: 'channel.historyMessageLimit', scope: 'GLOBAL' }, [])
    ).toEqual({ allowed: true });
  });

  it('refuses every non-admin on an admin-only key, whatever grant matches', () => {
    // Replaces the removed platform-role floor assertion: writeAccess 'admin' is
    // out of any grant's reach.
    expect(SETTING_DEFINITIONS['github.userCredentialsEnabled'].writeAccess).toBe('admin');
    const userGrant = teamGrant({
      keyPattern: '*',
      role: null,
      scope: 'GLOBAL',
      userId: engineer.id,
    });
    const result = checkSettingWrite(
      engineer,
      { key: 'github.userCredentialsEnabled', scope: 'GLOBAL' },
      [userGrant],
      leadOfTeam
    );
    expect(result).toMatchObject({ allowed: false, code: 'ROLE_TOO_LOW' });
    expect(
      checkSettingWrite(admin, { key: 'github.userCredentialsEnabled', scope: 'GLOBAL' }, [])
    ).toEqual({ allowed: true });
  });

  it('lets a user holding no platform role write a grantable key through a user grant', () => {
    const userGrant = teamGrant({ role: null, userId: engineer.id });
    expect(
      checkSettingWrite(
        engineer,
        { key: 'channel.historyMessageLimit', scope: 'TEAM', targetOrgId: ORG, targetTeamId: TEAM },
        [userGrant]
      )
    ).toEqual({ allowed: true });
  });

  it('denies a non-admin on a grantable key without a grant', () => {
    expect(
      checkSettingWrite(
        engineer,
        { key: 'channel.historyMessageLimit', scope: 'TEAM', targetOrgId: ORG, targetTeamId: TEAM },
        []
      )
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
  });

  it('requires platform ADMIN for the org-wide reporting opt-in despite an organization grant', () => {
    const orgGrant = teamGrant({
      keyPattern: 'analytics.orgWideReports',
      orgId: ORG,
      role: null,
      scope: 'ORGANIZATION',
      teamId: null,
      userId: lead.id,
    });
    const result = checkSettingWrite(
      lead,
      {
        key: 'analytics.orgWideReports',
        scope: 'ORGANIZATION',
        targetOrgId: ORG,
      },
      [orgGrant]
    );
    expect(result).toMatchObject({ allowed: false, code: 'ROLE_TOO_LOW' });
  });

  it('denies a lead with no grant', () => {
    const result = checkSettingWrite(
      lead,
      { key: 'channel.historyMessageLimit', scope: 'TEAM', targetOrgId: ORG, targetTeamId: TEAM },
      []
    );
    expect(result).toMatchObject({ allowed: false, code: 'NO_GRANT' });
  });

  it('allows a lead holding a role grant on that team', () => {
    expect(
      checkSettingWrite(
        lead,
        { key: 'channel.historyMessageLimit', scope: 'TEAM', targetOrgId: ORG, targetTeamId: TEAM },
        [teamGrant()],
        leadOfTeam
      )
    ).toEqual({ allowed: true });
  });

  it('does not let a team role grant match a role held in another team or a different role', () => {
    const target = {
      key: 'channel.historyMessageLimit',
      scope: 'TEAM' as const,
      targetOrgId: ORG,
      targetTeamId: TEAM,
    };
    expect(
      checkSettingWrite(lead, target, [teamGrant()], new Map([[OTHER_TEAM, 'LEAD']]))
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
    expect(
      checkSettingWrite(lead, target, [teamGrant()], new Map([[TEAM, 'ENGINEER']]))
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
    expect(checkSettingWrite(lead, target, [teamGrant()])).toMatchObject({
      allowed: false,
      code: 'NO_GRANT',
    });
  });

  it('ignores a role grant that is not TEAM-scoped with a team', () => {
    const target = {
      key: 'channel.historyMessageLimit',
      scope: 'TEAM' as const,
      targetOrgId: ORG,
      targetTeamId: TEAM,
    };
    const global = teamGrant({ scope: 'GLOBAL', teamId: null });
    expect(checkSettingWrite(lead, target, [global], leadOfTeam)).toMatchObject({
      allowed: false,
      code: 'NO_GRANT',
    });
  });

  it('does not let a team grant reach a different team', () => {
    const result = checkSettingWrite(
      lead,
      {
        key: 'channel.historyMessageLimit',
        scope: 'TEAM',
        targetOrgId: ORG,
        targetTeamId: OTHER_TEAM,
      },
      [teamGrant()],
      leadOfTeam
    );
    expect(result).toMatchObject({ allowed: false, code: 'NO_GRANT' });
  });

  it('does not let a team grant escalate to GLOBAL or ORGANIZATION', () => {
    expect(
      checkSettingWrite(lead, { key: 'channel.historyMessageLimit', scope: 'GLOBAL' }, [
        teamGrant(),
      ])
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
    expect(
      checkSettingWrite(
        lead,
        { key: 'channel.historyMessageLimit', scope: 'ORGANIZATION', targetOrgId: ORG },
        [teamGrant()]
      )
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
  });

  it('lets a team grant cover a channel inside that team', () => {
    expect(
      checkSettingWrite(
        lead,
        {
          key: 'channel.historyMessageLimit',
          scope: 'CHANNEL',
          targetOrgId: ORG,
          targetTeamId: TEAM,
        },
        [teamGrant()],
        leadOfTeam
      )
    ).toEqual({ allowed: true });
  });

  it('lets an org grant cover a team inside that org but not the GLOBAL row', () => {
    // A role grantee is only valid at TEAM scope now, so the org grant names the user.
    const orgGrant = teamGrant({
      orgId: ORG,
      role: null,
      scope: 'ORGANIZATION',
      teamId: null,
      userId: lead.id,
    });
    expect(
      checkSettingWrite(
        lead,
        { key: 'channel.historyMessageLimit', scope: 'TEAM', targetOrgId: ORG, targetTeamId: TEAM },
        [orgGrant]
      )
    ).toEqual({ allowed: true });
    expect(
      checkSettingWrite(lead, { key: 'channel.historyMessageLimit', scope: 'GLOBAL' }, [orgGrant])
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
  });

  it('matches a user grant by id rather than by role', () => {
    const userGrant = teamGrant({ role: null, userId: lead.id });
    const target = {
      key: 'channel.historyMessageLimit',
      scope: 'TEAM' as const,
      targetOrgId: ORG,
      targetTeamId: TEAM,
    };
    expect(checkSettingWrite(lead, target, [userGrant])).toEqual({ allowed: true });
    expect(
      checkSettingWrite({ id: 'someone-else', role: 'LEAD' }, target, [userGrant])
    ).toMatchObject({ allowed: false, code: 'NO_GRANT' });
  });
});

describe('registry integrity', () => {
  it('gives every definition a default its own schema accepts', () => {
    for (const key of SETTING_KEYS) {
      const definition = SETTING_DEFINITIONS[key];
      expect(definition.schema.safeParse(definition.defaultValue).success).toBe(true);
    }
  });

  it('names a group every key agrees with', () => {
    for (const key of SETTING_KEYS) {
      expect(key.startsWith(`${SETTING_DEFINITIONS[key].group}.`)).toBe(true);
    }
  });
});
