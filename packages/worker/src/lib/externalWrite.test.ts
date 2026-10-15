import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredDecision {
  createdAt: Date;
  event: string;
  payload: unknown;
  policyName?: string;
  riskClass?: string;
  runId: string;
}

interface LedgerRow {
  /** Indexed so a row can be handed to the `where` matcher, as Prisma's own row types allow. */
  [key: string]: unknown;
  attempt: number;
  connectionId: string;
  nodeId: string;
  result: unknown;
  runId: string;
  state: string;
}

const RUN = 'run-1';
const CONNECTION = 'conn-1';
const KEY = { connectionId: CONNECTION, nodeId: 'do', runId: RUN };

let decisions: StoredDecision[] = [];
let ledger: LedgerRow[] = [];

/**
 * The subset of Prisma's `where` the guard uses, evaluated the way Postgres would — including the
 * JSON `path` filter. A mock that ignored `where` is how the approval bypass this file exists for
 * survived: every decision looked like the one being asked about.
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

/** The ledger's `where`, which is always the effect's key with an optional state. */
function ledgerMatches(row: LedgerRow, where: Record<string, unknown>): boolean {
  for (const field of ['connectionId', 'nodeId', 'runId', 'state'] as const) {
    if (where[field] !== undefined && row[field] !== where[field]) {
      return false;
    }
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
    workflowOutcomeReference: {
      create: async ({ data }: { data: LedgerRow }) => {
        if (ledger.some((row) => ledgerMatches(row, data))) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        ledger.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = ledger.length;
        ledger = ledger.filter((row) => !ledgerMatches(row, where));
        return { count: before - ledger.length };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        ledger.find((row) => ledgerMatches(row, where)) ?? null,
      updateMany: async ({
        data,
        where,
      }: {
        data: Partial<LedgerRow>;
        where: Record<string, unknown>;
      }) => {
        const hits = ledger.filter((row) => ledgerMatches(row, where));
        for (const row of hits) {
          Object.assign(row, data);
        }
        return { count: hits.length };
      },
    },
  },
}));

const { assertApprovalSatisfied, findRecordedOutcome, notSent, performOnce } = await import(
  './externalWrite.js'
);

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
  ledger = [];
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

describe('findRecordedOutcome', () => {
  it('returns what a completed attempt produced', async () => {
    ledger.push({ ...KEY, attempt: 1, result: { ok: 1 }, state: 'DONE' });

    await expect(findRecordedOutcome(KEY)).resolves.toEqual({ ok: 1 });
  });

  it('returns nothing for an effect nothing has recorded', async () => {
    await expect(findRecordedOutcome(KEY)).resolves.toBeUndefined();
  });

  it('refuses a claim whose outcome cannot be told', async () => {
    // The case the ledger could not see before: the provider may have acted, and the attempt that
    // called it recorded nothing. Repeating the call is how one effort becomes two.
    ledger.push({ ...KEY, attempt: 1, result: undefined, state: 'PENDING' });

    await expect(findRecordedOutcome(KEY)).rejects.toMatchObject({ type: 'OUTCOME_AMBIGUOUS' });
  });

  it('refuses a state it cannot read', async () => {
    // Fail closed: a row this code cannot interpret is not evidence that the effect completed.
    ledger.push({ ...KEY, attempt: 1, result: undefined, state: 'SOMETHING_NEW' });

    await expect(findRecordedOutcome(KEY)).rejects.toMatchObject({ type: 'OUTCOME_AMBIGUOUS' });
  });
});

describe('performOnce', () => {
  it('claims the effect before the call and completes it with the result', async () => {
    let stateDuringCall: string | undefined;
    const result = await performOnce({
      attempt: 1,
      dispatch: async () => {
        // The claim must be visible *while* the provider is being called, or a crash between the
        // call and the write leaves nothing behind to refuse the retry.
        stateDuringCall = ledger[0]?.state;
        return { ok: 1 };
      },
      key: KEY,
    });

    expect(stateDuringCall).toBe('PENDING');
    expect(result).toEqual({ ok: 1 });
    expect(ledger).toEqual([{ ...KEY, attempt: 1, result: { ok: 1 }, state: 'DONE' }]);
  });

  it('releases the claim when the connector refused before sending', async () => {
    // A refused call never reached the provider, so a retry may try again — leaving the claim would
    // turn a deterministic refusal into an ambiguity nobody can resolve.
    await expect(
      performOnce({
        attempt: 1,
        dispatch: async () => {
          throw notSent('the payload has no text');
        },
        key: KEY,
      })
    ).rejects.toThrow(/no text/);

    expect(ledger).toEqual([]);
  });

  it('keeps the claim when the outcome is unknown', async () => {
    await expect(
      performOnce({
        attempt: 1,
        dispatch: async () => {
          throw new Error('socket hang up');
        },
        key: KEY,
      })
    ).rejects.toThrow(/socket hang up/);

    expect(ledger.map((row) => row.state)).toEqual(['PENDING']);
  });

  it('refuses when another attempt already holds the claim', async () => {
    ledger.push({ ...KEY, attempt: 2, result: undefined, state: 'PENDING' });

    await expect(
      performOnce({ attempt: 1, dispatch: async () => ({ ok: 1 }), key: KEY })
    ).rejects.toMatchObject({ type: 'OUTCOME_AMBIGUOUS' });
  });
});
