import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
      findUniqueOrThrow: vi.fn(),
    },
    trustedKnowledgeEvidence: { createMany: vi.fn(), findUnique: vi.fn() },
    workflowArtifact: { findFirst: vi.fn() },
  },
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ attempt: 3 }),
  heartbeat: () => {},
}));

const { fixSessionMock } = vi.hoisted(() => ({ fixSessionMock: vi.fn() }));
vi.mock('./implementerSession.js', () => ({ runImplementerFixSession: fixSessionMock }));

const { fakeWorkspace } = vi.hoisted(() => ({
  fakeWorkspace: {
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async () => ''),
    execCapture: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
    gitAuthed: vi.fn(async () => ''),
  },
}));
vi.mock('./workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace.js')>()),
  createWorkspace: vi.fn(async () => fakeWorkspace),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('../lib/activityContext.js', () => ({
  currentRunningWorkflowRunId: vi.fn(async () => 'db-run'),
  currentTemporalRunId: vi.fn(() => 'temporal-run'),
  currentWorkflowRunId: vi.fn(async () => 'db-run'),
}));
vi.mock('../lib/artifactStore.js', () => ({
  putArtifact: vi.fn(async () => ({ id: 'artifact-1' })),
}));
vi.mock('../lib/evalCapture.js', () => ({ recordGateEval: vi.fn(async () => {}) }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: async () => ({ authedCloneUrl: 'https://github.com/acme/r.git' }),
  }),
  toRepoRef: (r: unknown) => r,
}));

import { prisma } from '@auto-swe/shared/db';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { runWithActivityNodeTag } from '../lib/activityNodeTag.js';
import { putArtifact } from '../lib/artifactStore.js';
import {
  DEFAULT_COMMANDS,
  executeGateFixImplementation,
  resolveCommand,
  runLint,
  runPerfBench,
  truncate,
} from './qualityGates.js';

const baseRequest: RepoWorkRequest = {
  description: 'test',
  externalTicketId: 'TICK-1',
  repoId: 'repo-1',
  ticketSource: 'JIRA' as never,
  workRequestId: 'wr-1',
} as unknown as RepoWorkRequest;

const mockedFindUnique = vi.mocked(prisma.connection.findUniqueOrThrow);

afterEach(() => {
  mockedFindUnique.mockReset();
});

describe('resolveCommand precedence', () => {
  beforeEach(() => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
  });

  it('uses the step config override when present (highest precedence)', async () => {
    mockedFindUnique.mockResolvedValue({
      gateCommands: { runLint: 'repo-level-lint' },
    } as never);
    const cmd = await resolveCommand('runLint', baseRequest, 'step-level-lint');
    expect(cmd).toBe('step-level-lint');
  });

  it('falls back to Repository.gateCommands when no step override', async () => {
    mockedFindUnique.mockResolvedValue({
      gateCommands: { runTests: 'pytest -xvs' },
    } as never);
    const cmd = await resolveCommand('runTests', baseRequest, undefined);
    expect(cmd).toBe('pytest -xvs');
  });

  it('falls back to the built-in default when neither override is set', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await resolveCommand('runLint', baseRequest, undefined);
    expect(cmd).toBe(DEFAULT_COMMANDS.runLint);
  });

  it('returns null for gates with no built-in default (runPerfBench)', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await resolveCommand('runPerfBench', baseRequest, undefined);
    expect(cmd).toBeNull();
  });

  it('treats an empty step-config override as missing and falls back', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await resolveCommand('runLint', baseRequest, '   ');
    expect(cmd).toBe(DEFAULT_COMMANDS.runLint);
  });
});

describe('truncate', () => {
  it('returns the input untouched when below the limit', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates with a marker when over the limit', () => {
    const big = 'x'.repeat(1000);
    const out = truncate(big, 200);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated');
  });
});

describe('executeGateFixImplementation re-run', () => {
  const previousCodeResult = {
    branch: 'auto/T-1',
    diff: '',
    filesChanged: [],
    headSha: 'x',
    implementationNotes: '',
    testResults: { duration_ms: 0, failing: 0, passed: true, passing: 1, stdout: '', total: 1 },
  } as CodeResult;

  async function rerunCommandFor(gateOutput: Record<string, unknown>): Promise<string> {
    fixSessionMock.mockResolvedValue({});
    await executeGateFixImplementation({
      gateName: 'runTests',
      gateOutput: { exitCode: 1, passed: false, summary: 'boom', ...gateOutput },
      previousCodeResult,
    });
    const session = fixSessionMock.mock.calls.at(-1)?.[0] as {
      afterGenerate: (ws: unknown, repo: { id: string }) => Promise<string | null>;
    };
    const afterGenerate = session.afterGenerate;
    const execCapture = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' }));
    await afterGenerate({ execCapture }, { id: 'repo-1' });
    return (execCapture.mock.calls[0] as unknown as [string])[0];
  }

  it('re-runs the command the failed gate ran, including a step-level override', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: { runTests: 'repo-tests' } } as never);
    await expect(rerunCommandFor({ command: 'make test-integration' })).resolves.toBe(
      'make test-integration'
    );
  });

  it('falls back to repo → default resolution for a gate result without a command', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: { runTests: 'repo-tests' } } as never);
    await expect(rerunCommandFor({})).resolves.toBe('repo-tests');
  });
});

describe('gate workspace provisioning', () => {
  beforeEach(() => {
    mockedFindUnique.mockResolvedValue({ defaultBranch: 'main', gateCommands: null } as never);
    fakeWorkspace.destroy.mockClear();
    fakeWorkspace.execCapture.mockClear();
    fakeWorkspace.gitAuthed.mockReset();
    fakeWorkspace.gitAuthed.mockResolvedValue('');
    fakeWorkspace.execCapture.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'ok' });
    vi.mocked(prisma.trustedKnowledgeEvidence.createMany).mockClear();
    vi.mocked(prisma.workflowArtifact.findFirst).mockClear();
    vi.mocked(putArtifact).mockReset();
    vi.mocked(putArtifact).mockResolvedValue({ id: 'artifact-1' } as never);
    vi.mocked(prisma.workflowArtifact.findFirst).mockResolvedValue({ id: 'artifact-1' } as never);
    vi.mocked(prisma.trustedKnowledgeEvidence.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.trustedKnowledgeEvidence.findUnique).mockReset();
  });

  it('fails the gate — never runs it on the default branch — when the change cannot be fetched', async () => {
    fakeWorkspace.gitAuthed.mockRejectedValue(new Error("fatal: couldn't find remote ref"));

    await expect(runLint({ request: baseRequest })).rejects.toThrow(
      /could not check out branch 'auto\/TICK-1'.*refusing to run it against 'main'/
    );
    // The command never ran against the wrong tree, and the container was removed.
    expect(fakeWorkspace.execCapture).not.toHaveBeenCalled();
    expect(fakeWorkspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('records passed configured gate with exact current execution and node attempt', async () => {
    const result = await runWithActivityNodeTag(
      { recordingId: 'fan[0]/tests', specNodeId: 'tests', stepAttempt: 2 },
      () => runLint({ command: 'yarn test', request: baseRequest })
    );
    expect(result).toMatchObject({
      activityAttempt: 3,
      artifactId: 'artifact-1',
      gateName: 'runLint',
      passed: true,
    });
    expect(result.evidenceCorrelation).toEqual(expect.any(String));
    expect(prisma.trustedKnowledgeEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          activityAttempt: 3,
          artifactId: 'artifact-1',
          evidenceCorrelation: result.evidenceCorrelation,
          gateName: 'runLint',
          outcome: 'PASSED',
          producer: 'QUALITY_GATE',
          recordingId: 'fan[0]/tests',
          runId: 'db-run',
          specNodeId: 'tests',
          stepAttempt: 2,
          summary: 'runLint passed (exit 0)',
          temporalRunId: 'temporal-run',
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.workflowArtifact.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: 'artifact-1', runId: 'db-run' },
    });
  });

  it('does not record failed, no-op, or missing-artifact gates', async () => {
    await runWithActivityNodeTag(
      { recordingId: 'tests', specNodeId: 'tests', stepAttempt: 1 },
      async () => {
        fakeWorkspace.execCapture.mockResolvedValueOnce({
          exitCode: 1,
          stderr: 'failed',
          stdout: '',
        });
        const failed = await runLint({ command: 'yarn test', request: baseRequest });
        expect(failed.passed).toBe(false);
        fakeWorkspace.execCapture.mockResolvedValueOnce({ exitCode: 0, stderr: '', stdout: 'ok' });
        vi.mocked(putArtifact).mockResolvedValueOnce(null as never);
        await runLint({ command: 'yarn test', request: baseRequest });
        await runPerfBench({ request: baseRequest });
      }
    );
    expect(prisma.trustedKnowledgeEvidence.createMany).not.toHaveBeenCalled();
    expect(prisma.workflowArtifact.findFirst).not.toHaveBeenCalled();
  });

  it('preserves the stored correlation on matching duplicate delivery', async () => {
    const tag = { recordingId: 'tests', specNodeId: 'tests', stepAttempt: 1 };
    const first = await runWithActivityNodeTag(tag, () =>
      runLint({ command: 'yarn test', request: baseRequest })
    );
    vi.mocked(prisma.trustedKnowledgeEvidence.createMany).mockResolvedValueOnce({
      count: 0,
    } as never);
    vi.mocked(prisma.trustedKnowledgeEvidence.findUnique).mockResolvedValueOnce({
      activityAttempt: 3,
      artifactId: 'artifact-1',
      evidenceCorrelation: first.evidenceCorrelation,
      gateName: 'runLint',
      outcome: 'PASSED',
      producer: 'QUALITY_GATE',
      recordingId: 'tests',
      runId: 'db-run',
      specNodeId: 'tests',
      stepAttempt: 1,
      summary: 'runLint passed (exit 0)',
      temporalRunId: 'temporal-run',
    } as never);
    const duplicate = await runWithActivityNodeTag(tag, () =>
      runLint({ command: 'yarn test', request: baseRequest })
    );
    expect(duplicate.evidenceCorrelation).toBe(first.evidenceCorrelation);
    expect(prisma.trustedKnowledgeEvidence.findUnique).toHaveBeenCalledWith({
      where: {
        runId_recordingId_stepAttempt_activityAttempt_producer_gateName: {
          activityAttempt: 3,
          gateName: 'runLint',
          producer: 'QUALITY_GATE',
          recordingId: 'tests',
          runId: 'db-run',
          stepAttempt: 1,
        },
      },
    });
  });

  it('withholds correlation when duplicate key belongs to a different artifact or correlation', async () => {
    const tag = { recordingId: 'tests', specNodeId: 'tests', stepAttempt: 1 };
    for (const mismatch of [
      { artifactId: 'other-artifact', evidenceCorrelation: 'same-correlation' },
      { artifactId: 'artifact-1', evidenceCorrelation: '' },
    ]) {
      vi.mocked(prisma.trustedKnowledgeEvidence.createMany).mockResolvedValueOnce({
        count: 0,
      } as never);
      vi.mocked(prisma.trustedKnowledgeEvidence.findUnique).mockResolvedValueOnce({
        activityAttempt: 3,
        ...mismatch,
        gateName: 'runLint',
        outcome: 'PASSED',
        producer: 'QUALITY_GATE',
        recordingId: 'tests',
        runId: 'db-run',
        specNodeId: 'tests',
        stepAttempt: 1,
        summary: 'runLint passed (exit 0)',
        temporalRunId: 'temporal-run',
      } as never);
      const result = await runWithActivityNodeTag(tag, () =>
        runLint({ command: 'yarn test', request: baseRequest })
      );
      expect(result).toMatchObject({ passed: true });
      expect(result.evidenceCorrelation).toBeUndefined();
      expect(result.activityAttempt).toBeUndefined();
    }
  });
});
