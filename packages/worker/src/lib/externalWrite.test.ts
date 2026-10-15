import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredDecision {
  createdAt: Date;
  event: string;
  payload: unknown;
  policyName?: string;
  riskClass?: string;
  runId: string;
}

const RUN = 'run-1';
let decisions: StoredDecision[] = [];

/**
 * The subset of Prisma's `where` the guard uses, evaluated the way Postgres would — including the
 * JSON `path` filter, which is the rule the guard now leans on. A mock that ignored `where` is how
 * the bypass this file exists for survived: every decision looked like the one being asked about.
 */
function matches(row: StoredDecision, where: Record<string, unknown>): boolean {
  if (where.runId !== undefined && row.runId !== where.runId) {
    return false;
  }
  if (where.event !== undefined && row.event !== where.event) {
    return false;
  }
  const payload = where.payload as { equals?: unknown; path?: string[] } | undefined;
  if (payload?.path) {
    const value = payload.path.reduce<unknown>(
      (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
      row.payload
    );
    if (value !== payload.equals) {
      return false;
    }
  }
  const createdAt = where.createdAt as { gte?: Date } | undefined;
  if (createdAt?.gte && row.createdAt < createdAt.gte) {
    return false;
  }
  return true;
}

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyDecision: {
      findFirst: async ({
        orderBy,
        where,
      }: {
        orderBy?: { createdAt: 'asc' | 'desc' };
        where: Record<string, unknown>;
      }) => {
        const hits = decisions.filter((row) => matches(row, where));
        return (orderBy ? hits.at(-1) : hits[0]) ?? null;
      },
    },
  },
}));

const { assertApprovalSatisfied } = await import('./externalWrite.js');

/** Record a decision, one second after the previous one. */
function record(
  event: string,
  decision?: 'auto' | 'require_approval',
  over: { riskClass?: string } = {}
): void {
  decisions.push({
    createdAt: new Date(decisions.length * 1000),
    event,
    payload: decision ? { decision, reason: 'test' } : {},
    riskClass: over.riskClass ?? 'external_write',
    runId: RUN,
  });
}

beforeEach(() => {
  decisions = [];
});

describe('assertApprovalSatisfied', () => {
  it('does not gate a run that recorded no decision', async () => {
    // The documented opt-in: the policy exists where something asked for it.
    await expect(assertApprovalSatisfied(RUN)).resolves.toBeUndefined();
  });

  it('refuses while a requirement has no approval', async () => {
    record('publish', 'require_approval');

    await expect(assertApprovalSatisfied(RUN)).rejects.toThrow(/requires human approval/);
  });

  it('is not cleared by a later decision that would have allowed something else', async () => {
    // The bypass this rule exists for: publish a requirement, then publish a class the policy
    // auto-approves, then write — with the log still saying approval was required. The guard reads
    // the latest *requirement*, not the latest decision.
    record('publish', 'require_approval');
    record('publish', 'auto');

    await expect(assertApprovalSatisfied(RUN)).rejects.toThrow(/requires human approval/);
  });

  it('lets a mutation through once an approval follows the requirement', async () => {
    record('publish', 'require_approval');
    record('approve');

    await expect(assertApprovalSatisfied(RUN)).resolves.toBeUndefined();
  });

  it('ignores an approval recorded before the requirement', async () => {
    // An approval answers the requirement in force when it was given, not one raised afterwards.
    record('approve');
    record('publish', 'require_approval');

    await expect(assertApprovalSatisfied(RUN)).rejects.toThrow(/requires human approval/);
  });

  it('names the class and policy of the unmet requirement', async () => {
    record('publish', 'require_approval', { riskClass: 'mass_communication' });

    await expect(assertApprovalSatisfied(RUN)).rejects.toThrow(/mass_communication/);
  });
});
