import { describe, expect, it } from 'vitest';
import {
  grantableTeamRoles,
  holdsAccess,
  holdsCapability,
  isPlatformAdminAnswer,
  mayHoldViaOrg,
  orgCanConfer,
  orgIdsHolding,
  type Permissions,
  teamIdsHolding,
} from './capabilities';

const held = (authority: string, ...keys: string[]) => keys.map((key) => ({ authority, key }));

const perms = (p: Partial<Permissions>): Permissions =>
  ({ organizations: [], platformCapabilities: [], platformRole: 'USER', teams: [], ...p }) as never;

const ADMIN = perms({ platformCapabilities: ['platform.users.manage'] as never });

const LEAD = perms({
  organizations: [
    { capabilities: held('org-member', 'org.read'), name: 'A', orgId: 'o1', role: 'MEMBER' },
  ] as never,
  teams: [
    {
      capabilities: held('team-role', 'team.members.manage', 'team.repos.manage'),
      name: 'T',
      orgId: 'o1',
      role: 'LEAD',
      slug: 't',
      teamId: 't1',
    },
  ] as never,
});

describe('holdsCapability', () => {
  it('is false without an answer', () => {
    expect(holdsCapability(null, 'team.read', { teamId: 't1' })).toBe(false);
    expect(holdsCapability(undefined, 'platform.users.manage')).toBe(false);
  });

  it('is true for everything for a platform admin', () => {
    expect(isPlatformAdminAnswer(ADMIN)).toBe(true);
    expect(holdsCapability(ADMIN, 'team.secrets.manage', { teamId: 'any' })).toBe(true);
    expect(holdsCapability(ADMIN, 'org.budget.manage', { orgId: 'any' })).toBe(true);
  });

  it('reads a team entry, and an unknown team is not held', () => {
    expect(holdsCapability(LEAD, 'team.repos.manage', { teamId: 't1' })).toBe(true);
    expect(holdsCapability(LEAD, 'team.secrets.manage', { teamId: 't1' })).toBe(false);
    expect(holdsCapability(LEAD, 'team.repos.manage', { teamId: 'elsewhere' })).toBe(false);
  });

  it('consults the narrowed answer only for the team it describes', () => {
    const narrowed = perms({
      teams: [
        {
          capabilities: held('org-admin', 'team.repos.manage'),
          name: 'X',
          orgId: 'o1',
          role: null,
          slug: 'x',
          teamId: 'tx',
        },
      ] as never,
    });
    expect(holdsCapability(LEAD, 'team.repos.manage', { teamId: 'tx' }, narrowed)).toBe(true);
    expect(holdsCapability(LEAD, 'team.repos.manage', { teamId: 'ty' }, narrowed)).toBe(false);
  });

  it('reads platform keys from the platform capabilities only', () => {
    expect(holdsCapability(LEAD, 'platform.users.directory.read')).toBe(false);
    const directory = perms({ platformCapabilities: ['platform.users.directory.read'] as never });
    expect(holdsCapability(directory, 'platform.users.directory.read')).toBe(true);
    expect(isPlatformAdminAnswer(directory)).toBe(false);
  });

  it('reads an organization key per organization, or anywhere without an id', () => {
    expect(holdsCapability(LEAD, 'org.read', { orgId: 'o1' })).toBe(true);
    expect(holdsCapability(LEAD, 'org.read', { orgId: 'o2' })).toBe(false);
    expect(holdsCapability(LEAD, 'org.read')).toBe(true);
    expect(holdsCapability(LEAD, 'org.budget.manage')).toBe(false);
  });

  it('reads a team key without an id as "on any team"', () => {
    expect(holdsCapability(LEAD, 'team.members.manage')).toBe(true);
    expect(holdsCapability(LEAD, 'team.secrets.manage')).toBe(false);
  });
});

describe('holdsAccess', () => {
  it('lets everyone through "any", even before the answer loads', () => {
    expect(holdsAccess(null, 'any')).toBe(true);
  });

  it('asks a platform admin for "platform-admin"', () => {
    expect(holdsAccess(ADMIN, 'platform-admin')).toBe(true);
    expect(holdsAccess(LEAD, 'platform-admin')).toBe(false);
    expect(holdsAccess(null, 'platform-admin')).toBe(false);
  });

  it('asks a capability anywhere', () => {
    expect(holdsAccess(LEAD, 'team.repos.manage')).toBe(true);
    expect(holdsAccess(LEAD, 'org.baselines.read')).toBe(false);
  });
});

describe('lists', () => {
  it('lists the teams and organizations holding a key', () => {
    expect(teamIdsHolding(LEAD, 'team.repos.manage')).toEqual(['t1']);
    expect(teamIdsHolding(LEAD, 'team.secrets.manage')).toEqual([]);
    expect(orgIdsHolding(LEAD, 'org.read')).toEqual(['o1']);
    expect(teamIdsHolding(null, 'team.read')).toEqual([]);
  });
});

describe('mayHoldViaOrg', () => {
  it('needs a membership of the named organization, or any when none is named', () => {
    expect(mayHoldViaOrg(LEAD, 'o1')).toBe(true);
    expect(mayHoldViaOrg(LEAD, 'o2')).toBe(false);
    expect(mayHoldViaOrg(LEAD, null)).toBe(true);
    expect(mayHoldViaOrg(perms({}), null)).toBe(false);
    expect(mayHoldViaOrg(null, 'o1')).toBe(false);
  });
});

describe('orgCanConfer', () => {
  it('is true for governance capabilities and false for operation and sensitive ones', () => {
    expect(orgCanConfer('team.members.manage')).toBe(true);
    expect(orgCanConfer('team.repos.manage')).toBe(true);
    expect(orgCanConfer('team.secrets.manage')).toBe(false);
    expect(orgCanConfer('team.templates.write')).toBe(false);
  });
});

describe('grantableTeamRoles', () => {
  it('stops at the caller’s own team role', () => {
    expect(grantableTeamRoles(LEAD, 't1')).toEqual(['MEMBER', 'LEAD']);
  });

  it('offers nothing without team.members.manage', () => {
    expect(grantableTeamRoles(LEAD, 'elsewhere')).toEqual([]);
    expect(grantableTeamRoles(null, 't1')).toEqual([]);
  });

  it('offers every role to platform or organization authority', () => {
    expect(grantableTeamRoles(ADMIN, 'any')).toEqual(['MEMBER', 'LEAD', 'ADMIN']);
    const narrowed = perms({
      teams: [
        {
          capabilities: held('org-admin', 'team.members.manage'),
          name: 'X',
          orgId: 'o1',
          role: 'MEMBER',
          slug: 'x',
          teamId: 'tx',
        },
      ] as never,
    });
    // Being a plain member as well never narrows what org authority allows.
    expect(grantableTeamRoles(perms({}), 'tx', narrowed)).toEqual(['MEMBER', 'LEAD', 'ADMIN']);
  });
});
