import { describe, expect, it, vi } from 'vitest';
import { createPrdChildRunInputInTransaction, prdChildSourceSnapshot } from './prdWorkflow.js';

type LedgerRow = { repoId: string; temporalWorkflowId: string; workRequestId: string };

/**
 * A transaction double backed by a real ledger map.
 *
 * `upsert` models the production rule the claim relies on — an existing row is never
 * rebound — so a test can assert what the ledger *holds* afterwards instead of the exact
 * arguments the implementation happened to pass.
 */
function makeTx(ledger = new Map<string, LedgerRow>()) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'row-1' }]),
    activeWorkflow: {
      findUnique: vi.fn(async ({ where }: { where: { temporalWorkflowId: string } }) => {
        const row = ledger.get(where.temporalWorkflowId);
        return row ? { workRequestId: row.workRequestId } : null;
      }),
      upsert: vi.fn(
        async ({
          create,
          update,
          where,
        }: {
          create: LedgerRow;
          update: Partial<LedgerRow>;
          where: { temporalWorkflowId: string };
        }) => {
          const existing = ledger.get(where.temporalWorkflowId);
          if (existing) {
            // What production passes as `update` is what decides whether an existing row is
            // rebound, so applying it here keeps the double faithful: an upsert that started
            // rewriting an existing claim would rebind this ledger and the refusal assertion
            // below would fail, instead of escaping unnoticed.
            ledger.set(where.temporalWorkflowId, { ...existing, ...update });
          } else {
            ledger.set(where.temporalWorkflowId, create);
          }
          return {};
        }
      ),
    },
    connection: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({
          shares: [],
          team: { orgId: 'org-b' },
          teamId: 'team-b',
        })
        .mockResolvedValueOnce({
          id: 'repo-a',
          isActive: true,
          shares: [],
          team: {
            id: 'team-b',
            isActive: true,
            memberships: [{ userId: 'launcher' }],
            organization: { isActive: true },
            orgId: 'org-b',
          },
          teamId: 'team-b',
          type: 'git_repo',
        }),
    },
    organizationMembership: { findUnique: vi.fn(async () => ({ userId: 'launcher' })) },
    runInput: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id })),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: 'launcher', isActive: true, role: 'ENGINEER' })),
    },
  };
  return { ledger, tx };
}

const CHILD = {
  data: {
    description: 'child request',
    externalTicketId: 'PRD-1',
    id: 'child-1',
    requestPayload: JSON.stringify({ connectionId: 'repo-a' }),
    templateId: 'template-1',
    templateVersion: 1,
  },
  expected: { orgId: 'org-a', repoId: 'repo-a', teamId: 'team-a' },
  repoId: 'repo-a',
  workflowId: 'eng-acme-api-PRD-1',
};

describe('PRD child source persistence', () => {
  it('persists UNKNOWN when ownership changes after the initial repository read', async () => {
    const { ledger, tx } = makeTx();

    const result = await createPrdChildRunInputInTransaction(tx as never, {
      actorId: 'launcher',
      ...CHILD,
    });

    expect(result).toEqual({ id: 'child-1' });
    // A fresh claim links the request and its repository under the workflow id it will
    // launch with. Asserted against the ledger's contents, not the call shape.
    expect(ledger.get('eng-acme-api-PRD-1')).toMatchObject({
      repoId: 'repo-a',
      temporalWorkflowId: 'eng-acme-api-PRD-1',
      workRequestId: 'child-1',
    });
    expect(tx.runInput.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        knowledgeSourceKind: 'UNKNOWN',
        knowledgeSourceOrgId: null,
        knowledgeSourceRepoId: null,
        knowledgeSourceTeamId: null,
      }),
    });
  });

  it('refuses to claim a workflow id another request already holds', async () => {
    const foreign: LedgerRow = {
      repoId: 'repo-other',
      temporalWorkflowId: 'eng-acme-api-PRD-1',
      workRequestId: 'someone-elses-request',
    };
    const { ledger, tx } = makeTx(new Map([['eng-acme-api-PRD-1', foreign]]));

    await expect(
      createPrdChildRunInputInTransaction(tx as never, { actorId: 'launcher', ...CHILD })
    ).rejects.toThrow(/already claimed by another work request/);
    // The existing claim is left exactly as it was, so the throw rolls the new request
    // back with it.
    expect(ledger.get('eng-acme-api-PRD-1')).toEqual(foreign);
  });
});

describe('prdChildSourceSnapshot', () => {
  const repo = {
    id: 'repo-a',
    isActive: true,
    team: { isActive: true, organization: { isActive: true }, orgId: 'org-a' },
    teamId: 'team-a',
  };

  it('uses the server-authored launch tuple, not a repo ID carried in requestPayload', () => {
    expect(
      prdChildSourceSnapshot([{ orgId: 'org-a', repoId: 'repo-a', teamId: 'team-a' }], repo)
    ).toEqual({
      knowledgeSourceKind: 'REPOSITORY',
      knowledgeSourceOrgId: 'org-a',
      knowledgeSourceRepoId: 'repo-a',
      knowledgeSourceTeamId: 'team-a',
    });
  });

  it('returns UNKNOWN when the repo moved after the authorized PRD launch', () => {
    expect(
      prdChildSourceSnapshot(
        [{ orgId: 'org-original', repoId: 'repo-a', teamId: 'team-original' }],
        repo
      )
    ).toEqual({
      knowledgeSourceKind: 'UNKNOWN',
      knowledgeSourceOrgId: null,
      knowledgeSourceRepoId: null,
      knowledgeSourceTeamId: null,
    });
  });

  it('returns UNKNOWN when a payload repo has no DB-authored launch tuple', () => {
    expect(prdChildSourceSnapshot([], repo)).toMatchObject({ knowledgeSourceKind: 'UNKNOWN' });
  });
});
