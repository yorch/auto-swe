import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { activeWorkflow: { findMany } } }));

import { allocateTicketWorkflowId } from './workflowIdAllocation.js';

const REPO = {
  externalTicketId: 'X-1',
  id: 'abcdef12-3456-7890-abcd-ef1234567890',
  organizationName: 'acme',
  repoName: 'payments-api',
};
const BASE = 'eng-acme-payments-api-X-1';

beforeEach(() => {
  findMany.mockReset();
});

describe('allocateTicketWorkflowId', () => {
  it('uses the base ID when nothing holds it', async () => {
    findMany.mockResolvedValue([]);
    await expect(allocateTicketWorkflowId(REPO)).resolves.toEqual({
      isRerun: false,
      workflowId: BASE,
    });
    // Reads both the base family and the disambiguated one.
    const where = findMany.mock.calls[0]?.[0].where;
    expect(where.OR).toContainEqual({ temporalWorkflowId: BASE });
    expect(where.OR).toContainEqual({ temporalWorkflowId: `${BASE}-xabcdef12` });
  });

  it("moves to the disambiguated family when another repository's run holds the base", async () => {
    // `acme-payments` / `api` / `X-1` builds the same string.
    findMany.mockResolvedValue([
      {
        currentStatus: 'RUNNING',
        repoId: 'other-repo',
        temporalWorkflowId: BASE,
        workRequest: { externalTicketId: 'X-1' },
      },
    ]);
    await expect(allocateTicketWorkflowId(REPO)).resolves.toEqual({
      isRerun: false,
      workflowId: `${BASE}-xabcdef12`,
    });
  });

  it('reports a conflict when this ticket is still running in this repository', async () => {
    findMany.mockResolvedValue([
      {
        currentStatus: 'RUNNING',
        repoId: REPO.id,
        temporalWorkflowId: BASE,
        workRequest: { externalTicketId: 'X-1' },
      },
    ]);
    await expect(allocateTicketWorkflowId(REPO)).resolves.toEqual({ conflictWorkflowId: BASE });
  });

  it('gives a finished ticket a rerun ID', async () => {
    findMany.mockResolvedValue([
      {
        currentStatus: 'COMPLETED',
        repoId: REPO.id,
        temporalWorkflowId: BASE,
        workRequest: { externalTicketId: 'X-1' },
      },
    ]);
    await expect(allocateTicketWorkflowId(REPO)).resolves.toEqual({
      isRerun: true,
      workflowId: `${BASE}-r1`,
    });
  });
});
