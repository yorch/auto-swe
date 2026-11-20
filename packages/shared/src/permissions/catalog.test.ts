import { describe, expect, it } from 'vitest';
import { orgRuleApplies, platformAdminHolds } from './can.js';
import { CATALOG, CATALOG_PARTS } from './catalog/index.js';
import { CONSTRAINTS } from './constraints.js';
import type { CapabilityDef } from './types.js';

const entries = Object.entries(CATALOG) as Array<[string, CapabilityDef]>;

describe('the capability catalog', () => {
  it('declares every key once across the domain files', () => {
    const declared = Object.values(CATALOG_PARTS).flatMap((part) => Object.keys(part));
    expect(declared.length).toBe(new Set(declared).size);
    expect(Object.keys(CATALOG).length).toBe(declared.length);
  });

  it('names every key <scope>.<noun>[.<noun>…] in lower-case kebab case, scope first', () => {
    const shape = /^(platform|org|team)(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$/;
    for (const [key, def] of entries) {
      expect(key, key).toMatch(shape);
      expect(key.split('.').length, key).toBeGreaterThanOrEqual(2);
      // A key's prefix is its scope, except a platform-level lookup that team leads also hold.
      if (!def.team || def.scope === 'team') {
        expect(key.split('.')[0], key).toBe(def.scope);
      }
    }
  });

  it('describes every capability', () => {
    for (const [key, def] of entries) {
      expect(def.description.trim().length, key).toBeGreaterThan(10);
      expect(def.description, key).not.toMatch(/\bTODO\b/);
    }
  });

  it('lets no organization role reach a team-scoped operation or sensitive capability', () => {
    const offenders = entries
      .filter(([, d]) => d.scope === 'team' && (d.class === 'operation' || d.class === 'sensitive'))
      .filter(([, d]) => d.org !== undefined)
      .map(([k]) => k);
    expect(offenders).toEqual([]);
    for (const [key, def] of entries) {
      if (def.scope === 'team' && (def.class === 'operation' || def.class === 'sensitive')) {
        expect(orgRuleApplies({ ...def, org: 'ADMIN' }), key).toBe(false);
      }
    }
  });

  it('can be held by someone', () => {
    for (const [key, def] of entries) {
      const holders = [platformAdminHolds(def), def.team !== undefined, def.org !== undefined];
      expect(holders.some(Boolean), key).toBe(true);
    }
  });

  it('keeps platform-scoped capabilities free of an organization rule', () => {
    for (const [key, def] of entries) {
      if (def.scope === 'platform') {
        expect(def.org, key).toBeUndefined();
      }
    }
  });

  it('gives an org-scoped capability an organization rule and no team rule', () => {
    for (const [key, def] of entries) {
      if (def.scope === 'org') {
        expect(def.org, key).toBeDefined();
        expect(def.team, key).toBeUndefined();
      }
    }
  });

  it('only sets requiresActiveTeam on team-scoped capabilities or team lookups', () => {
    for (const [key, def] of entries) {
      if (def.requiresActiveTeam !== undefined) {
        expect(def.scope === 'team' || def.team !== undefined, key).toBe(true);
      }
    }
  });

  it('keeps the spec decisions', () => {
    expect(CATALOG['org.teams.create']).toMatchObject({
      class: 'governance',
      org: 'ADMIN',
      scope: 'org',
    });
    expect(CATALOG['team.sandbox-policy.manage']).toMatchObject({
      class: 'sensitive',
      scope: 'team',
    });
    expect(CATALOG['team.sandbox-policy.manage']).not.toHaveProperty('team');
    expect(CATALOG['team.sandbox-policy.manage']).not.toHaveProperty('org');
    expect(CATALOG['org.baselines.manage']).toMatchObject({ org: 'ADMIN', scope: 'org' });
    expect(CATALOG['platform.callbacks.private-network'].scope).toBe('platform');
    // Service principals and callbacks stay LEAD, as today.
    expect(CATALOG['team.service-principals.manage']).toMatchObject({
      class: 'sensitive',
      team: 'LEAD',
    });
    expect(CATALOG['team.callbacks.manage']).toMatchObject({ class: 'sensitive', team: 'LEAD' });
  });

  it('lists the team directory and join requests without widening team management', () => {
    expect(CATALOG['platform.team-directory.read']).toMatchObject({
      class: 'read',
      scope: 'platform',
      team: 'MEMBER',
    });
    expect(CATALOG['team.join-requests.create']).toMatchObject({
      class: 'operation',
      scope: 'team',
    });
    // Deciding a request reuses the membership capabilities, so who decides is who manages.
    expect(CATALOG['team.members.manage']).toMatchObject({ org: 'ADMIN', team: 'LEAD' });
    expect(CATALOG['org.members.manage']).toMatchObject({ org: 'ADMIN', scope: 'org' });
  });

  it('lists constraints only beside capabilities that exist', () => {
    for (const constraint of CONSTRAINTS) {
      expect(constraint.accompanies.length, constraint.name).toBeGreaterThan(0);
      for (const key of constraint.accompanies) {
        expect(CATALOG, `${constraint.name} -> ${key}`).toHaveProperty(key);
      }
    }
  });
});
