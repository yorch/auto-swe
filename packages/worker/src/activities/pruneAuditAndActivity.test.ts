import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  createdAt: Date;
  entityType?: string;
  /** The row's run is under transcript legal hold. */
  held?: boolean;
}
const db = vi.hoisted(() => ({
  activity: [] as Array<{ id: string; createdAt: Date }>,
  audit: [] as Array<{ id: string; createdAt: Date; entityType?: string }>,
  created: [] as Array<{ data: Record<string, unknown> }>,
  effects: [] as Array<{ id: string; createdAt: Date; held?: boolean }>,
  failCreate: false,
  settings: {} as Record<string, unknown>,
  wheres: [] as Array<Record<string, unknown>>,
}));

type Where = {
  createdAt: { lt: Date };
  entityType?: { notIn: string[] };
  id?: { in: string[] };
  OR?: unknown[];
};

function table(key: 'audit' | 'activity' | 'effects') {
  const matches = (r: Row, where: Where) =>
    r.createdAt < where.createdAt.lt &&
    !where.entityType?.notIn.includes(r.entityType ?? '') &&
    // Only the legal-hold `OR` the sweep sends for run effects is modelled.
    (!where.OR || !r.held) &&
    (!where.id || where.id.in.includes(r.id));
  return {
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = db[key].length;
      db[key] = db[key].filter((r) => !matches(r, where));
      return { count: before - db[key].length };
    }),
    findMany: vi.fn(async ({ take, where }: { take: number; where: Where }) => {
      db.wheres.push(where as never);
      return db[key]
        .filter((r) => matches(r, where))
        .slice(0, take)
        .map((r) => ({ id: r.id }));
    }),
  };
}

// The real settings resolver and registry run; only the database underneath them is faked, so a
// stored value is judged by the real definition's schema.
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    configAuditLog: {
      ...table('audit'),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (db.failCreate) {
          throw new Error('db down');
        }
        db.created.push(args);
        return {};
      }),
    },
    configSetting: {
      findMany: vi.fn(async () =>
        Object.entries(db.settings).map(([key, value]) => ({ key, scope: 'GLOBAL', value }))
      ),
    },
    runEffect: table('effects'),
    userActivityEvent: table('activity'),
  },
}));
vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('./pruneAutomationDecisions.js', () => ({ PRUNE_BATCH: 2, PRUNE_MAX_BATCHES: 2 }));

import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { logWarn } from '../lib/activityLog.js';
import { pruneAuditAndActivity } from './pruneAuditAndActivity.js';

const NOW = new Date('2026-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

beforeEach(() => {
  invalidateSettingsCache();
  db.audit = [];
  db.activity = [];
  db.effects = [];
  db.created = [];
  db.wheres = [];
  db.failCreate = false;
  db.settings = {};
  vi.mocked(logWarn).mockClear();
});

describe('pruneAuditAndActivity', () => {
  it('keeps the audit log forever by default and prunes activity events past 90 days', async () => {
    db.audit = [{ createdAt: daysAgo(4000), id: 'a-ancient' }];
    db.activity = [
      { createdAt: daysAgo(91), id: 'e-old' },
      { createdAt: daysAgo(10), id: 'e-new' },
    ];
    const result = await pruneAuditAndActivity(NOW);
    expect(result).toMatchObject({ activityDeleted: 1, auditDeleted: 0, auditRetentionDays: 0 });
    expect(db.audit.map((r) => r.id)).toEqual(['a-ancient']);
    expect(db.activity.map((r) => r.id)).toEqual(['e-new']);
    expect(db.created).toEqual([]);
  });

  it('deletes audit rows past a set retention and records one summary row', async () => {
    db.settings['audit.configLogRetentionDays'] = 365;
    db.audit = [
      { createdAt: daysAgo(400), id: 'a-old-1' },
      { createdAt: daysAgo(500), id: 'a-old-2' },
      { createdAt: daysAgo(100), id: 'a-new' },
    ];
    const result = await pruneAuditAndActivity(NOW);
    expect(result.auditDeleted).toBe(2);
    expect(db.audit.map((r) => r.id)).toEqual(['a-new']);
    expect(db.created).toHaveLength(1);
    expect(db.created[0]?.data).toMatchObject({
      action: 'DELETE',
      actorId: null,
      afterJson: { cutoff: daysAgo(365).toISOString(), deleted: 2, retentionDays: 365 },
      entityType: 'AuditLogRetention',
    });
  });

  it('never deletes a retention summary row or a setting change, however old', async () => {
    db.settings['audit.configLogRetentionDays'] = 365;
    db.audit = [
      { createdAt: daysAgo(900), entityType: 'AuditLogRetention', id: 'a-summary' },
      { createdAt: daysAgo(900), entityType: 'ConfigSetting', id: 'a-setting' },
      { createdAt: daysAgo(900), entityType: 'Team', id: 'a-team' },
    ];
    const result = await pruneAuditAndActivity(NOW);
    expect(result.auditDeleted).toBe(1);
    expect(db.audit.map((r) => r.id).sort()).toEqual(['a-setting', 'a-summary']);
    // The exclusion is in the query itself, not a filter after the fact.
    expect(db.wheres[0]).toMatchObject({
      entityType: { notIn: expect.arrayContaining(['AuditLogRetention', 'ConfigSetting']) },
    });
  });

  it('deletes nothing from the audit log when the stored value is below the floor', async () => {
    // A value written before the floor existed, or by hand: the real schema rejects it, the read
    // degrades to the default (keep forever), and no audit row is touched.
    db.settings['audit.configLogRetentionDays'] = 30;
    db.audit = [{ createdAt: daysAgo(900), entityType: 'Team', id: 'a-old' }];
    const result = await pruneAuditAndActivity(NOW);
    expect(result).toMatchObject({ auditDeleted: 0, auditRetentionDays: 0 });
    expect(db.audit).toHaveLength(1);
    expect(db.created).toEqual([]);
  });

  it('stops at its batch limit, reports more, and continues on the next sweep', async () => {
    db.settings['audit.configLogRetentionDays'] = 365;
    db.audit = Array.from({ length: 5 }, (_, i) => ({
      createdAt: daysAgo(500 + i),
      entityType: 'Team',
      id: `a-${i}`,
    }));
    const first = await pruneAuditAndActivity(NOW);
    expect(first).toMatchObject({ auditDeleted: 4, more: true });
    expect(db.audit).toHaveLength(1);
    expect(vi.mocked(logWarn)).toHaveBeenCalled();
    const second = await pruneAuditAndActivity(NOW);
    expect(second).toMatchObject({ auditDeleted: 1, more: false });
  });

  it('logs, rather than throws, when the summary row cannot be written', async () => {
    db.settings['audit.configLogRetentionDays'] = 365;
    db.audit = [{ createdAt: daysAgo(500), entityType: 'Team', id: 'a-old' }];
    db.failCreate = true;
    const result = await pruneAuditAndActivity(NOW);
    expect(result.auditDeleted).toBe(1);
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
      expect.stringContaining('summary row'),
      expect.objectContaining({ deleted: 1 })
    );
  });

  it('writes no summary row when nothing was deleted', async () => {
    db.settings['audit.configLogRetentionDays'] = 365;
    db.audit = [{ createdAt: daysAgo(10), id: 'a-new' }];
    await pruneAuditAndActivity(NOW);
    expect(db.created).toEqual([]);
  });

  it('keeps run effects forever by default', async () => {
    db.effects = [{ createdAt: daysAgo(4000), id: 'f-ancient' }];
    const result = await pruneAuditAndActivity(NOW);
    expect(result).toMatchObject({ runEffectRetentionDays: 0, runEffectsDeleted: 0 });
    expect(db.effects).toHaveLength(1);
  });

  it('deletes run effects past a set retention, and only those', async () => {
    db.settings['audit.runEffectRetentionDays'] = 30;
    db.effects = [
      { createdAt: daysAgo(31), id: 'f-old' },
      { createdAt: daysAgo(5), id: 'f-new' },
    ];
    db.audit = [{ createdAt: daysAgo(900), id: 'a-old' }];
    const result = await pruneAuditAndActivity(NOW);
    expect(result).toMatchObject({ runEffectRetentionDays: 30, runEffectsDeleted: 1 });
    expect(db.effects.map((r) => r.id)).toEqual(['f-new']);
    expect(db.audit).toHaveLength(1);
  });

  it('keeps the effects of a run under legal hold, however old', async () => {
    db.settings['audit.runEffectRetentionDays'] = 30;
    db.effects = [
      { createdAt: daysAgo(400), held: true, id: 'f-held' },
      { createdAt: daysAgo(400), id: 'f-free' },
    ];
    const result = await pruneAuditAndActivity(NOW);
    expect(result).toMatchObject({ runEffectsDeleted: 1 });
    expect(db.effects.map((r) => r.id)).toEqual(['f-held']);
  });

  it('ignores a run-effect retention below the floor and keeps the rows', async () => {
    db.settings['audit.runEffectRetentionDays'] = 3;
    db.effects = [{ createdAt: daysAgo(100), id: 'f-old' }];
    const result = await pruneAuditAndActivity(NOW);
    expect(result).toMatchObject({ runEffectRetentionDays: 0, runEffectsDeleted: 0 });
    expect(db.effects).toHaveLength(1);
  });

  it('reports more when the run-effect half stops at its batch limit', async () => {
    db.settings['audit.runEffectRetentionDays'] = 30;
    db.effects = Array.from({ length: 5 }, (_, i) => ({
      createdAt: daysAgo(40 + i),
      id: `f-${i}`,
    }));
    const first = await pruneAuditAndActivity(NOW);
    expect(first).toMatchObject({ more: true, runEffectsDeleted: 4 });
  });
});
