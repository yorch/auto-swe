import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    repository: {
      findUniqueOrThrow: vi.fn(),
    },
    workflowRun: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../lib/artifactStore.js', () => ({
  putArtifact: vi.fn().mockResolvedValue({ id: 'art-1' }),
}));

vi.mock('../lib/errors.js', () => ({
  getErrorMessage: vi.fn(),
  getExecErrorOutput: vi.fn(
    (err: unknown) =>
      (err as { stdout?: string; stderr?: string }).stdout ??
      (err as { stderr?: string }).stderr ??
      String(err)
  ),
  getExecErrorStdout: vi.fn(),
  requireEnv: vi.fn().mockReturnValue('fake-token'),
}));

vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn().mockReturnValue(undefined),
  currentWorkflowRunId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@temporalio/activity', () => ({
  heartbeat: vi.fn(),
}));

interface FakeWorkspace {
  containerId: string;
  destroy: () => void;
  exec: ReturnType<typeof vi.fn>;
  execCapture: () => never;
}

const fakeWorkspace: FakeWorkspace = {
  containerId: 'workspace-test',
  destroy: vi.fn(),
  exec: vi.fn(),
  execCapture: () => {
    throw new Error('not used');
  },
};

vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(() => fakeWorkspace),
  shellQuote: (s: string) => `'${s}'`,
}));

import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { mergeBranches, subtaskBranchName } from './decomposition.js';

const baseRequest = {
  description: 'test',
  externalTicketId: 'TICK-1',
  repoId: 'repo-1',
  workRequestId: 'wr-1',
} as unknown as RepoWorkRequest;

const mockedFindUnique = vi.mocked(prisma.repository.findUniqueOrThrow);

afterEach(() => {
  mockedFindUnique.mockReset();
  fakeWorkspace.exec.mockReset();
  (fakeWorkspace.destroy as ReturnType<typeof vi.fn>).mockReset();
});

describe('subtaskBranchName', () => {
  it('joins feature branch and subtask id with /', () => {
    expect(subtaskBranchName('auto/JIRA-1', { id: 'auth' })).toBe('auto/JIRA-1/auth');
  });
});

describe('mergeBranches', () => {
  function primeRepo() {
    mockedFindUnique.mockResolvedValue({
      defaultBranch: 'main',
      executorImage: 'node:24-alpine',
      githubUrl: 'https://github.com',
      id: 'repo-1',
      organizationName: 'acme',
      repoName: 'svc',
    } as never);
  }

  it('short-circuits when sourceBranches is empty', async () => {
    primeRepo();
    const result = await mergeBranches({
      request: baseRequest,
      sourceBranches: [],
      targetBranch: 'auto/TICK-1',
    });
    expect(result.passed).toBe(true);
    expect(result.mergedBranches).toEqual([]);
    // No workspace provisioned in the no-op path.
    expect(fakeWorkspace.exec).not.toHaveBeenCalled();
  });

  it('merges every source branch on the happy path and pushes the target', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse HEAD')) return 'abc123\n';
      return '';
    });

    const result = await mergeBranches({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/auth', 'auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(result.mergedBranches).toEqual(['auto/TICK-1/auth', 'auto/TICK-1/db']);
    expect(result.conflicts).toEqual([]);
    expect(result.headSha).toBe('abc123');

    const cmds = fakeWorkspace.exec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes('git fetch origin') && c.includes('auto/TICK-1/auth'))).toBe(
      true
    );
    expect(cmds.some((c) => c.includes('git merge --no-ff'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('git push origin'))).toBe(true);
  });

  it('aborts on the first conflict, reports the branch, and skips the push', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.includes(`git merge --no-ff --no-edit -m`) && cmd.includes('auto/TICK-1/db')) {
        const err = new Error('CONFLICT in db.ts') as Error & {
          stdout: string;
          stderr: string;
        };
        err.stdout = 'Auto-merging db.ts\nCONFLICT (content): Merge conflict in db.ts';
        err.stderr = '';
        throw err;
      }
      if (cmd.includes('git rev-parse HEAD')) return 'sha\n';
      return '';
    });

    const result = await mergeBranches({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/auth', 'auto/TICK-1/db', 'auto/TICK-1/api'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(false);
    expect(result.mergedBranches).toEqual(['auto/TICK-1/auth']);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]?.branch).toBe('auto/TICK-1/db');

    const cmds = fakeWorkspace.exec.mock.calls.map((c) => c[0] as string);
    // Conflict branch triggers `git merge --abort`, and we never reach the third source.
    expect(cmds.some((c) => c === 'git merge --abort')).toBe(true);
    expect(cmds.some((c) => c.includes('git merge --no-ff') && c.includes('auto/TICK-1/api'))).toBe(
      false
    );
    // No push on failure path.
    expect(cmds.some((c) => c.startsWith('git push origin'))).toBe(false);
  });
});
