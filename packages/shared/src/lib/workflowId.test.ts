import { describe, expect, it } from 'vitest';
import {
  chooseWorkflowId,
  disambiguatedWorkflowIdBase,
  generateBranchName,
  generateWorkflowId,
  workflowIdFamilyBases,
} from './workflowId.js';

const REPO_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPO_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('generateWorkflowId / generateBranchName', () => {
  it('keeps the historical ID format', () => {
    expect(generateWorkflowId('X-1', 'acme', 'payments-api')).toBe('eng-acme-payments-api-X-1');
  });

  it('is ambiguous across hyphenated names — which is why allocation checks ownership', () => {
    expect(generateWorkflowId('X-1', 'acme', 'payments-api')).toBe(
      generateWorkflowId('X-1', 'acme-payments', 'api')
    );
  });

  it('takes the branch prefix from the caller, never the environment', () => {
    process.env.BRANCH_PREFIX = 'from-env';
    try {
      expect(generateBranchName('X-1', 'resolved')).toBe('resolved/X-1');
    } finally {
      delete process.env.BRANCH_PREFIX;
    }
  });
});

describe('chooseWorkflowId', () => {
  const base = 'eng-acme-payments-api-X-1';

  it('uses the base ID for a first submission', () => {
    expect(chooseWorkflowId(base, [], { repoId: REPO_A })).toEqual({
      isRerun: false,
      workflowId: base,
    });
  });

  it('conflicts while our own execution is still running', () => {
    const rows = [{ currentStatus: 'IMPLEMENTING', repoId: REPO_A, temporalWorkflowId: base }];
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({ conflictWorkflowId: base });
  });

  it('allocates the next -rN once our previous executions are over', () => {
    const rows = [
      { currentStatus: 'COMPLETED', repoId: REPO_A, temporalWorkflowId: base },
      { currentStatus: 'FAILED', repoId: REPO_A, temporalWorkflowId: `${base}-r1` },
    ];
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({
      isRerun: true,
      workflowId: `${base}-r2`,
    });
  });

  it('does not 409 on another tenant’s running workflow that merely shares the string', () => {
    // acme-payments/api X-1 is running; acme/payments-api X-1 is a new ticket.
    const rows = [{ currentStatus: 'IMPLEMENTING', repoId: REPO_B, temporalWorkflowId: base }];
    const alt = disambiguatedWorkflowIdBase(base, REPO_A);
    expect(alt).toBe(`${base}-x11111111`);
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({
      isRerun: false,
      workflowId: alt,
    });
  });

  it('keeps reruns of a disambiguated ticket in its own family', () => {
    const alt = disambiguatedWorkflowIdBase(base, REPO_A);
    const rows = [
      { currentStatus: 'COMPLETED', repoId: REPO_B, temporalWorkflowId: base },
      { currentStatus: 'COMPLETED', repoId: REPO_A, temporalWorkflowId: alt },
    ];
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({
      isRerun: true,
      workflowId: `${alt}-r1`,
    });
    // And the other tenant still reruns in the base family.
    expect(chooseWorkflowId(base, rows, { repoId: REPO_B })).toEqual({
      isRerun: true,
      workflowId: `${base}-r1`,
    });
  });

  it('does not treat a different ticket that ends in -rN as our rerun', () => {
    // Ticket "X-1-r1" in the same repo produces `${base}-r1`.
    const rows = [
      {
        currentStatus: 'IMPLEMENTING',
        externalTicketId: 'X-1-r1',
        repoId: REPO_A,
        temporalWorkflowId: `${base}-r1`,
      },
    ];
    const res = chooseWorkflowId(base, rows, { externalTicketId: 'X-1', repoId: REPO_A });
    expect('conflictWorkflowId' in res).toBe(false);
  });

  it('treats rows with no recorded repository as ours (conservative)', () => {
    const rows = [{ currentStatus: 'IMPLEMENTING', repoId: null, temporalWorkflowId: base }];
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({ conflictWorkflowId: base });
  });

  it('without an owner behaves as before: every row is ours', () => {
    const rows = [{ currentStatus: 'IMPLEMENTING', repoId: REPO_B, temporalWorkflowId: base }];
    expect(chooseWorkflowId(base, rows)).toEqual({ conflictWorkflowId: base });
    expect(workflowIdFamilyBases(base)).toEqual([base]);
  });

  it('ignores IDs that only share a prefix', () => {
    const rows = [
      { currentStatus: 'IMPLEMENTING', repoId: REPO_A, temporalWorkflowId: `${base}0` },
      { currentStatus: 'IMPLEMENTING', repoId: REPO_A, temporalWorkflowId: `${base}-rx` },
    ];
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({
      isRerun: false,
      workflowId: base,
    });
  });
});
