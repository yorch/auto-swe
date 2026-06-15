import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
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
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => {
    throw new Error('activity context is not available');
  },
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

// Clone URL + token resolution moved from env-var/githubAuth call sites into
// the ScmProvider seam (lib/scm).
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: vi.fn(async () => ({
      authedCloneUrl: 'https://x-access-token:fake-token@github.com/acme/svc.git',
      cloneUrl: 'https://github.com/acme/svc.git',
      token: 'fake-token',
    })),
  }),
  toRepoRef: (repo: Record<string, unknown>) => repo,
}));

const generateMock = vi.fn();
vi.mock('../agents/implementer.js', () => ({
  createImplementerAgent: vi.fn(() => ({
    agent: { generate: generateMock },
    mastra: {},
    promptSuffix: '',
  })),
}));

vi.mock('../lib/config/agentSkills.js', () => ({
  loadAgentSkills: vi.fn().mockResolvedValue([]),
  loadAgentToolConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../lib/costTracking.js', () => ({
  recordLlmUsage: vi.fn(),
}));

vi.mock('./commitToMemory.js', () => ({
  recordLessonBackground: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { recordLessonBackground } from './commitToMemory.js';
import { mergeBranches, resolveMergeConflict, subtaskBranchName } from './decomposition.js';

const baseRequest = {
  description: 'test',
  externalTicketId: 'TICK-1',
  repoId: 'repo-1',
  workRequestId: 'wr-1',
} as unknown as RepoWorkRequest;

const mockedFindUnique = vi.mocked(prisma.connection.findUniqueOrThrow);

const mockedRecordLesson = vi.mocked(recordLessonBackground);

afterEach(() => {
  mockedFindUnique.mockReset();
  fakeWorkspace.exec.mockReset();
  (fakeWorkspace.destroy as ReturnType<typeof vi.fn>).mockReset();
  generateMock.mockReset();
  mockedRecordLesson.mockReset();
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
    expect(result.unmergedBranches).toEqual([]);
    // No workspace provisioned in the no-op path.
    expect(fakeWorkspace.exec).not.toHaveBeenCalled();
  });

  it('merges every source branch on the happy path and pushes the target', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse HEAD')) {
        return 'abc123\n';
      }
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
      if (cmd.includes('git rev-parse HEAD')) {
        return 'sha\n';
      }
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
    // Conflicted branch + every queued source becomes the unmerged tail so
    // a downstream resolveMergeConflict step can pick up where merge failed.
    expect(result.unmergedBranches).toEqual(['auto/TICK-1/db', 'auto/TICK-1/api']);

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

describe('resolveMergeConflict', () => {
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
    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: [],
      targetBranch: 'auto/TICK-1',
    });
    expect(result.passed).toBe(true);
    expect(result.unmergedBranches).toEqual([]);
    expect(fakeWorkspace.exec).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('skips the resolver when all branches merge cleanly', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse HEAD')) {
        return 'abc\n';
      }
      return '';
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(result.mergedBranches).toEqual(['auto/TICK-1/db']);
    expect(result.unmergedBranches).toEqual([]);
    expect(generateMock).not.toHaveBeenCalled();
    const cmds = fakeWorkspace.exec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.startsWith('git push origin'))).toBe(true);
  });

  it('invokes the implementer agent on conflicts, then commits + pushes when resolved', async () => {
    primeRepo();
    let conflictResolved = false;
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge --no-ff') && !conflictResolved) {
        const err = new Error('CONFLICT') as Error & { stdout: string; stderr: string };
        err.stdout = 'CONFLICT (content): Merge conflict in foo.ts';
        err.stderr = '';
        throw err;
      }
      if (cmd.startsWith('git diff --name-only --diff-filter=U')) {
        return conflictResolved ? '' : 'foo.ts\n';
      }
      if (cmd.startsWith('git diff --check')) {
        if (conflictResolved) {
          return '';
        }
        const err = new Error('markers present');
        throw err;
      }
      if (cmd.startsWith('cat ')) {
        return 'before\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>>\nafter\n';
      }
      if (cmd === 'git add -A') {
        return '';
      }
      if (cmd.startsWith('git commit')) {
        return 'committed';
      }
      if (cmd.includes('git rev-parse HEAD')) {
        return 'resolved-sha\n';
      }
      return '';
    });

    generateMock.mockImplementation(async () => {
      // Simulate the agent successfully resolving the conflict.
      conflictResolved = true;
      return { usage: { totalTokens: 100 } };
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(result.mergedBranches).toEqual(['auto/TICK-1/db']);
    expect(generateMock).toHaveBeenCalledTimes(1);
    const cmds = fakeWorkspace.exec.mock.calls.map((c) => c[0] as string);
    expect(cmds).toContain('git add -A');
    expect(cmds.some((c) => c.startsWith('git push origin'))).toBe(true);
  });

  it('coerces non-finite maxAttemptsPerBranch back to the default of 1', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge --no-ff')) {
        const err = new Error('CONFLICT') as Error & { stdout: string; stderr: string };
        err.stdout = 'CONFLICT';
        err.stderr = '';
        throw err;
      }
      if (cmd.startsWith('git diff --name-only --diff-filter=U')) {
        return 'foo.ts\n';
      }
      if (cmd.startsWith('git diff --check')) {
        throw new Error('markers present');
      }
      if (cmd.startsWith('cat ')) {
        return '<<<<<<<\nA\n=======\nB\n>>>>>>>';
      }
      return '';
    });
    generateMock.mockResolvedValue({ usage: { totalTokens: 50 } });

    const result = await resolveMergeConflict({
      // NaN would otherwise propagate through Math.max and skip the loop entirely.
      maxAttemptsPerBranch: Number.NaN,
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(false);
    // Default of 1 attempt → resolver ran exactly once.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('fires the MERGE_CONFLICT memory hook after a successful resolution', async () => {
    primeRepo();
    let conflictResolved = false;
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge --no-ff') && !conflictResolved) {
        const err = new Error('CONFLICT') as Error & { stdout: string; stderr: string };
        err.stdout = 'CONFLICT (content): Merge conflict in foo.ts';
        err.stderr = '';
        throw err;
      }
      if (cmd.startsWith('git diff --name-only --diff-filter=U')) {
        return conflictResolved ? '' : 'foo.ts\n';
      }
      if (cmd.startsWith('git diff --check')) {
        if (conflictResolved) {
          return '';
        }
        throw new Error('markers present');
      }
      if (cmd.startsWith('cat ')) {
        return '<<<<<<<\nA\n=======\nB\n>>>>>>>';
      }
      if (cmd === 'git add -A') {
        return '';
      }
      if (cmd.startsWith('git commit')) {
        return '';
      }
      if (cmd.includes('git rev-parse HEAD')) {
        return 'sha\n';
      }
      return '';
    });
    generateMock.mockImplementation(async () => {
      conflictResolved = true;
      return { usage: { totalTokens: 50 } };
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(mockedRecordLesson).toHaveBeenCalledOnce();
    expect(mockedRecordLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        failureType: 'MERGE_CONFLICT',
        repoId: 'repo-1',
      })
    );
  });

  it('does not fire the memory hook when resolution fails', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge --no-ff')) {
        const err = new Error('CONFLICT') as Error & { stdout: string; stderr: string };
        err.stdout = 'CONFLICT';
        err.stderr = '';
        throw err;
      }
      if (cmd.startsWith('git diff --name-only --diff-filter=U')) {
        return 'foo.ts\n';
      }
      if (cmd.startsWith('git diff --check')) {
        throw new Error('markers present');
      }
      if (cmd.startsWith('cat ')) {
        return '<<<<<<<\nA\n=======\nB\n>>>>>>>';
      }
      return '';
    });
    generateMock.mockResolvedValue({ usage: { totalTokens: 50 } });

    const result = await resolveMergeConflict({
      maxAttemptsPerBranch: 1,
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(false);
    expect(mockedRecordLesson).not.toHaveBeenCalled();
  });

  it('surfaces remaining conflict + unmerged tail when the resolver cannot finish in maxAttempts', async () => {
    primeRepo();
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge --no-ff')) {
        const err = new Error('CONFLICT') as Error & { stdout: string; stderr: string };
        err.stdout = 'CONFLICT';
        err.stderr = '';
        throw err;
      }
      if (cmd.startsWith('git diff --name-only --diff-filter=U')) {
        return 'foo.ts\n';
      }
      if (cmd.startsWith('git diff --check')) {
        throw new Error('still has markers');
      }
      if (cmd.startsWith('cat ')) {
        return '<<<<<<<\nA\n=======\nB\n>>>>>>>';
      }
      if (cmd.includes('git rev-parse HEAD')) {
        return 'sha\n';
      }
      return '';
    });
    // Resolver call returns without actually fixing the file.
    generateMock.mockResolvedValue({ usage: { totalTokens: 50 } });

    const result = await resolveMergeConflict({
      maxAttemptsPerBranch: 1,
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db', 'auto/TICK-1/api'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(false);
    expect(result.mergedBranches).toEqual([]);
    expect(result.conflicts.length).toBe(1);
    expect(result.unmergedBranches).toEqual(['auto/TICK-1/db', 'auto/TICK-1/api']);
    // No push on failure.
    const cmds = fakeWorkspace.exec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.startsWith('git push origin'))).toBe(false);
  });
});
