import type { Prisma } from '@auto-swe/shared';
import { describe, expect, it } from 'vitest';
import {
  lockConnections,
  lockOrganizations,
  lockOrgThenTeam,
  lockTeams,
  lockUser,
} from './lockOrder.js';

/** A transaction that records each row lock as `<statement tail>|<id>` and finds every row but one. */
function recorder(missing: string[] = []) {
  const taken: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, id: string) => {
      taken.push(`${strings.join('?').replace(/\s+/g, ' ').trim()}|${id}`);
      return missing.includes(id) ? [] : [{ id }];
    },
  } as unknown as Prisma.TransactionClient;
  return { taken, tx };
}

describe('the lock helpers', () => {
  it('lock a user row without excluding the foreign key check of a membership insert', async () => {
    const { taken, tx } = recorder();
    expect(await lockUser(tx, 'u1')).toBe(true);
    // `FOR NO KEY UPDATE` conflicts with another writer of the row and not with the share lock
    // the foreign key of a membership or request insert takes (see the comment in lockOrder.ts).
    expect(taken).toEqual(['SELECT id FROM users WHERE id = ?::uuid FOR NO KEY UPDATE|u1']);
  });

  it('report a row that is gone instead of throwing', async () => {
    const { tx } = recorder(['gone']);
    expect(await lockUser(tx, 'gone')).toBe(false);
    expect(await lockTeams(tx, ['b', 'gone', 'a'])).toEqual(['a', 'b']);
  });

  it('take every level in ascending id order, once each', async () => {
    const { taken, tx } = recorder();
    await lockConnections(tx, ['c2', 'c1', 'c2']);
    await lockOrganizations(tx, ['o3', 'o1']);
    await lockTeams(tx, ['t9', 't2', 't9']);
    expect(taken.map((t) => t.split('|')[1])).toEqual(['c1', 'c2', 'o1', 'o3', 't2', 't9']);
  });

  it('take the organization before the team, and a share lock only when asked for one', async () => {
    const exclusive = recorder();
    await lockOrgThenTeam(exclusive.tx, 'o', 't');
    expect(exclusive.taken).toEqual([
      'SELECT id FROM organizations WHERE id = ?::uuid FOR UPDATE|o',
      'SELECT id FROM teams WHERE id = ?::uuid FOR UPDATE|t',
    ]);
    const shared = recorder();
    await lockOrgThenTeam(shared.tx, 'o', 't', 'share');
    expect(shared.taken).toEqual([
      'SELECT id FROM organizations WHERE id = ?::uuid FOR SHARE|o',
      'SELECT id FROM teams WHERE id = ?::uuid FOR SHARE|t',
    ]);
  });
});
