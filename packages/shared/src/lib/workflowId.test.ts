import { describe, expect, it } from 'vitest';
import {
  chooseWorkflowId,
  disambiguatedWorkflowIdBase,
  generateBranchName,
  generateWorkflowId,
  legacyWorkflowIdBases,
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
    // Still a conflict, but its id is not shown: the row cannot be shown to be the caller's.
    expect(chooseWorkflowId(base, rows, { repoId: REPO_A })).toEqual({
      conflictOtherRow: true,
      conflictWorkflowId: base,
    });
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

describe('generateWorkflowId', () => {
  it('keeps the id it always had for a repository on the instance host', () => {
    // No override: nothing already running may change id.
    expect(generateWorkflowId('T-1', 'acme', 'api')).toBe('eng-acme-api-T-1');
    expect(generateWorkflowId('T-1', 'acme', 'api', null)).toBe('eng-acme-api-T-1');
  });

  it('separates the same owner/name on another GitHub host', () => {
    expect(generateWorkflowId('T-1', 'acme', 'api', 'https://ghe.corp')).toBe(
      'eng-ghe.corp-acme-api-T-1'
    );
    expect(generateWorkflowId('T-1', 'acme', 'api', 'https://GHE.corp:8443')).toBe(
      'eng-ghe.corp:8443-acme-api-T-1'
    );
  });
});

describe('chooseWorkflowId — the id from before repository ids carried a host', () => {
  const NEW = 'eng-ghe.corp-acme-api-T-1';
  const LEGACY = 'eng-acme-api-T-1';
  const ME = { externalTicketId: 'T-1', repoId: 'repo-mine' };
  const row = (id: string, status: string, repoId: string | null) => ({
    currentStatus: status,
    externalTicketId: 'T-1',
    repoId,
    temporalWorkflowId: id,
  });

  it('is blocked by this repository’s execution still running under it', () => {
    expect(chooseWorkflowId(NEW, [row(LEGACY, 'IMPLEMENTING', 'repo-mine')], ME, [LEGACY])).toEqual(
      {
        conflictWorkflowId: LEGACY,
      }
    );
    expect(
      chooseWorkflowId(NEW, [row(`${LEGACY}-r2`, 'IMPLEMENTING', 'repo-mine')], ME, [LEGACY])
    ).toEqual({ conflictWorkflowId: `${LEGACY}-r2` });
  });

  it('is not blocked once that execution has finished', () => {
    expect(chooseWorkflowId(NEW, [row(LEGACY, 'COMPLETED', 'repo-mine')], ME, [LEGACY])).toEqual({
      isRerun: false,
      workflowId: NEW,
    });
  });

  it('is not blocked by ANOTHER repository whose legacy id is the same string', () => {
    expect(
      chooseWorkflowId(NEW, [row(LEGACY, 'IMPLEMENTING', 'repo-someone-else')], ME, [LEGACY])
    ).toEqual({ isRerun: false, workflowId: NEW });
  });

  it('never lets legacy rows influence which id is chosen', () => {
    // A finished legacy run is not "ours in the base family": the new id is used as is.
    const result = chooseWorkflowId(NEW, [row(LEGACY, 'FAILED', 'repo-mine')], ME, [LEGACY]);
    expect(result).toEqual({ isRerun: false, workflowId: NEW });
  });

  it('adds the legacy base to the query families only when it differs', () => {
    expect(workflowIdFamilyBases(NEW, 'repo-mine', [LEGACY])).toContain(LEGACY);
    expect(workflowIdFamilyBases(LEGACY, 'repo-mine', [LEGACY])).not.toContain(undefined);
    expect(
      workflowIdFamilyBases(LEGACY, 'repo-mine', [LEGACY]).filter((b) => b === LEGACY)
    ).toHaveLength(1);
  });
});

describe('workflow ids are lowercase in owner and name', () => {
  it('lowercases owner and repository name but keeps the ticket id as given', () => {
    expect(generateWorkflowId('JIRA-7', 'Acme', 'Payments-API')).toBe(
      'eng-acme-payments-api-JIRA-7'
    );
    expect(generateWorkflowId('JIRA-7', 'Acme', 'Payments-API', 'https://GHE.corp')).toBe(
      'eng-ghe.corp-acme-payments-api-JIRA-7'
    );
  });

  it('gives case-only duplicate repositories the same id', () => {
    expect(generateWorkflowId('T-1', 'ACME', 'Api')).toBe(generateWorkflowId('T-1', 'acme', 'api'));
  });

  describe('legacy cased ids', () => {
    const NEW = 'eng-acme-api-T-1';
    const CASED = 'eng-Acme-Api-T-1';
    const ME = { externalTicketId: 'T-1', repoId: 'repo-mine' };
    const row = (id: string, status: string, repoId: string | null) => ({
      currentStatus: status,
      externalTicketId: 'T-1',
      repoId,
      temporalWorkflowId: id,
    });

    it('lists the stored-casing ids, with and without the host, and never the current one', () => {
      expect(legacyWorkflowIdBases('T-1', 'Acme', 'Api')).toEqual([CASED]);
      expect(legacyWorkflowIdBases('T-1', 'acme', 'api')).toEqual([]);
      expect(legacyWorkflowIdBases('T-1', 'Acme', 'Api', 'https://ghe.corp')).toEqual([
        'eng-ghe.corp-Acme-Api-T-1',
        CASED,
      ]);
      expect(legacyWorkflowIdBases('T-1', 'acme', 'api', 'https://ghe.corp')).toEqual([NEW]);
    });

    it('is blocked by this repository’s run still in flight under the cased id', () => {
      const legacy = legacyWorkflowIdBases('T-1', 'Acme', 'Api');
      expect(chooseWorkflowId(NEW, [row(CASED, 'IMPLEMENTING', 'repo-mine')], ME, legacy)).toEqual({
        conflictWorkflowId: CASED,
      });
      expect(
        chooseWorkflowId(NEW, [row(`${CASED}-r1`, 'IMPLEMENTING', 'repo-mine')], ME, legacy)
      ).toEqual({ conflictWorkflowId: `${CASED}-r1` });
      // Its disambiguated family counts too.
      const disambiguated = `${CASED}-xrepomine`;
      expect(
        chooseWorkflowId(NEW, [row(disambiguated, 'IMPLEMENTING', 'repo-mine')], ME, legacy)
      ).toEqual({ conflictWorkflowId: disambiguated });
    });

    it('is not blocked once the cased run finished, or by another repository’s', () => {
      const legacy = legacyWorkflowIdBases('T-1', 'Acme', 'Api');
      expect(chooseWorkflowId(NEW, [row(CASED, 'COMPLETED', 'repo-mine')], ME, legacy)).toEqual({
        isRerun: false,
        workflowId: NEW,
      });
      expect(chooseWorkflowId(NEW, [row(CASED, 'IMPLEMENTING', 'repo-other')], ME, legacy)).toEqual(
        { isRerun: false, workflowId: NEW }
      );
    });

    it('queries the legacy families alongside the current ones', () => {
      expect(workflowIdFamilyBases(NEW, 'repo-mine', [CASED])).toEqual([
        NEW,
        disambiguatedWorkflowIdBase(NEW, 'repo-mine'),
        CASED,
        disambiguatedWorkflowIdBase(CASED, 'repo-mine'),
      ]);
    });
  });
});

describe('chooseWorkflowId — rows of one repository under several ids', () => {
  const base = 'eng-acme-api-X-1';
  const owner = { externalTicketId: 'X-1', repoId: REPO_A, sameRepoIds: [REPO_A, REPO_B] };
  const row = (id: string, status: string, repoId: string) => ({
    currentStatus: status,
    externalTicketId: 'X-1',
    repoId,
    temporalWorkflowId: id,
  });

  it('conflicts with a run of a same-identity row', () => {
    expect(chooseWorkflowId(base, [row(base, 'IMPLEMENTING', REPO_B)], owner)).toMatchObject({
      conflictWorkflowId: base,
    });
  });

  it('flags a conflict with another row of the repository, but not with the same row', () => {
    expect(chooseWorkflowId(base, [row(base, 'IMPLEMENTING', REPO_B)], owner)).toEqual({
      conflictOtherRow: true,
      conflictWorkflowId: base,
    });
    expect(chooseWorkflowId(base, [row(base, 'IMPLEMENTING', REPO_A)], owner)).toEqual({
      conflictWorkflowId: base,
    });
  });

  it('flags a conflict with a legacy row that has no repository id', () => {
    const legacy = { ...row(base, 'IMPLEMENTING', REPO_A), repoId: null };
    expect(chooseWorkflowId(base, [legacy], owner)).toEqual({
      conflictOtherRow: true,
      conflictWorkflowId: base,
    });
  });

  it('conflicts with a run in the disambiguated family of a same-identity row', () => {
    const other = disambiguatedWorkflowIdBase(base, REPO_B);
    expect(chooseWorkflowId(base, [row(other, 'IMPLEMENTING', REPO_B)], owner)).toMatchObject({
      conflictWorkflowId: other,
    });
  });

  it('reruns in the base family once a same-identity run has finished', () => {
    expect(chooseWorkflowId(base, [row(base, 'COMPLETED', REPO_B)], owner)).toEqual({
      isRerun: true,
      workflowId: `${base}-r1`,
    });
  });

  it('keeps a row outside the identity foreign, so it still disambiguates', () => {
    expect(
      chooseWorkflowId(base, [row(base, 'IMPLEMENTING', REPO_B)], {
        externalTicketId: 'X-1',
        repoId: REPO_A,
      })
    ).toEqual({ isRerun: false, workflowId: disambiguatedWorkflowIdBase(base, REPO_A) });
  });

  it('lists every same-identity repository’s disambiguated family', () => {
    expect(workflowIdFamilyBases(base, [REPO_A, REPO_B])).toEqual([
      base,
      disambiguatedWorkflowIdBase(base, REPO_A),
      disambiguatedWorkflowIdBase(base, REPO_B),
    ]);
  });
});
