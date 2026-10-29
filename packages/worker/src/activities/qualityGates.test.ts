import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
      findUniqueOrThrow: vi.fn(),
    },
    trustedKnowledgeEvidence: { createMany: vi.fn(), findUnique: vi.fn() },
    workflowArtifact: { findFirst: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
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
  resolveWorkspaceInfra: vi.fn(() => ({ stackImages: {} })),
}));
vi.mock('../lib/activityContext.js', () => ({
  currentRunningWorkflowRunId: vi.fn(async () => 'db-run'),
  currentTemporalRunId: vi.fn(() => 'temporal-run'),
  currentWorkflowId: vi.fn(() => 'wf-1'),
  currentWorkflowRunId: vi.fn(async () => 'db-run'),
}));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
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
import { putArtifact } from '@auto-swe/shared/lib/artifactStore';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { runWithActivityNodeTag } from '../lib/activityNodeTag.js';
import {
  DEFAULT_COMMANDS,
  executeGateFixImplementation,
  resolveCommand,
  runLint,
  runPerfBench,
  runQualityGates,
  runTests,
  truncate,
} from './qualityGates.js';
import { createWorkspace } from './workspace.js';

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

  describe('with a detected non-Node root', () => {
    const detectedStack = {
      components: [{ path: '', stacks: ['jvm'] }],
      evidence: ['pom.xml'],
      primary: 'jvm',
      stacks: ['jvm'],
    };

    it("uses the stack's command instead of a yarn one", async () => {
      mockedFindUnique.mockResolvedValue({ detectedStack, gateCommands: null } as never);
      expect(await resolveCommand('runTests', baseRequest, undefined)).toBe('mvn -B -ntp test');
    });

    it('uses the stack the run pinned, not the one a later scan stored', async () => {
      // The live row now says jvm (a scan landed mid-run); the run began on node.
      mockedFindUnique.mockResolvedValue({
        detectedStack,
        gateCommands: null,
        id: 'repo-1',
      } as never);
      vi.mocked(prisma.workflowRun.findUnique).mockResolvedValueOnce({
        pinnedDetections: {
          'repo-1': { components: [{ path: '', stacks: ['node'] }], evidence: ['package.json'] },
        },
      } as never);
      expect(await resolveCommand('runTests', baseRequest, undefined)).toBe(
        DEFAULT_COMMANDS.runTests
      );
    });

    it('resolves a gate the stack has no command for to null, never to yarn', async () => {
      mockedFindUnique.mockResolvedValue({ detectedStack, gateCommands: null } as never);
      expect(await resolveCommand('runLint', baseRequest, undefined)).toBeNull();
      expect(await resolveCommand('runVulnScan', baseRequest, undefined)).toBeNull();
    });

    it('lets step and repository overrides win over the stack default', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack,
        gateCommands: { runTests: 'mvn verify' },
      } as never);
      expect(await resolveCommand('runTests', baseRequest, undefined)).toBe('mvn verify');
      expect(await resolveCommand('runTests', baseRequest, 'step')).toBe('step');
    });

    it('uses npm commands, audit included, for a Node root on npm', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack: {
          components: [{ path: '', stacks: ['node'] }],
          evidence: ['package.json'],
          packageManager: 'npm',
        },
        gateCommands: null,
      } as never);
      expect(await resolveCommand('runVulnScan', baseRequest, undefined)).toBe(
        'npm audit --audit-level=high'
      );
      expect(await resolveCommand('runLint', baseRequest, undefined)).toBe('npm run lint');
    });

    it('runs a lone component’s commands in its directory, but not an override', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack: {
          components: [{ path: 'backend', stacks: ['jvm'] }],
          evidence: ['backend/pom.xml'],
        },
        gateCommands: { runLint: 'make lint' },
      } as never);
      expect(await resolveCommand('runTests', baseRequest, undefined)).toBe(
        "cd 'backend' && mvn -B -ntp test"
      );
      expect(await resolveCommand('runLint', baseRequest, undefined)).toBe('make lint');
      expect(await resolveCommand('runTests', baseRequest, 'step')).toBe('step');
    });

    it('runs a gate in every component when each has one, and leaves it unconfigured when one lacks it', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack: {
          components: [
            { path: 'api', stacks: ['jvm'] },
            { path: 'web', stacks: ['node'] },
          ],
          evidence: [],
        },
        gateCommands: null,
      } as never);
      // Both a JVM and a Node component have tests and a build: one command runs each in its dir.
      for (const gate of ['runTests', 'runBuild'] as const) {
        const cmd = await resolveCommand(gate, baseRequest, undefined);
        expect(cmd, gate).toContain("(cd 'api' &&");
        expect(cmd, gate).toContain("(cd 'web' &&");
        expect(cmd, gate).toMatch(/exit \$ur$/);
      }
      // The JVM component has no lint and no audit default, so those would verify only `web`.
      for (const gate of ['runLint', 'runVulnScan'] as const) {
        expect(await resolveCommand(gate, baseRequest, undefined), gate).toBeNull();
      }
    });

    it('leaves every gate unconfigured past eight components', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack: {
          components: Array.from({ length: 9 }, (_, i) => ({ path: `svc${i}`, stacks: ['go'] })),
          evidence: [],
        },
        gateCommands: null,
      } as never);
      for (const gate of ['runTests', 'runBuild', 'runLint'] as const) {
        expect(await resolveCommand(gate, baseRequest, undefined), gate).toBeNull();
      }
    });

    it('has no audit for Yarn Classic, rather than Berry’s command, which Yarn 1 lacks', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack: {
          components: [{ path: '', stacks: ['node'] }],
          evidence: ['package.json', 'yarn.lock'],
          packageManager: 'yarn',
          yarnFlavor: 'classic',
        },
        gateCommands: null,
      } as never);
      expect(await resolveCommand('runVulnScan', baseRequest, undefined)).toBeNull();
      expect(await resolveCommand('runTests', baseRequest, undefined)).toBe('yarn test');
    });

    it('keeps the yarn defaults for a Node root', async () => {
      mockedFindUnique.mockResolvedValue({
        detectedStack: { components: [{ path: '', stacks: ['node'] }], evidence: ['package.json'] },
        gateCommands: null,
      } as never);
      expect(await resolveCommand('runLint', baseRequest, undefined)).toBe(
        DEFAULT_COMMANDS.runLint
      );
    });
  });

  it('returns null for gates with no built-in default (runPerfBench)', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await resolveCommand('runPerfBench', baseRequest, undefined);
    expect(cmd).toBeNull();
  });

  it('fails a gate that has no command anywhere, rather than reporting a pass', async () => {
    // A requested benchmark that never ran must not read as green: a `cond`
    // branching on `nodes.<perf>.output.passed` would otherwise take the
    // success path. `onFail: 'warn'` on the node is the supported way to make
    // a gate optional.
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const result = await runPerfBench({ request: baseRequest });
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/no command configured/);
    expect(result.summary).toMatch(/onFail: 'warn'/);
    expect(fakeWorkspace.execCapture).not.toHaveBeenCalled();
  });

  it('treats an empty step-config override as missing and falls back', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await resolveCommand('runLint', baseRequest, '   ');
    expect(cmd).toBe(DEFAULT_COMMANDS.runLint);
  });

  it('treats a whitespace-only repository override as missing, not as a passing command', async () => {
    // `sh -c '   '` exits 0, so accepting this would leave the gate reporting a
    // pass for a command that ran nothing.
    mockedFindUnique.mockResolvedValue({ gateCommands: { runTests: '   ' } } as never);
    const cmd = await resolveCommand('runTests', baseRequest, undefined);
    expect(cmd).toBe(DEFAULT_COMMANDS.runTests);
  });

  it('treats a whitespace-only repository override as missing for runPerfBench too', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: { runPerfBench: '\t' } } as never);
    const cmd = await resolveCommand('runPerfBench', baseRequest, undefined);
    expect(cmd).toBeNull();
    const result = await runPerfBench({ request: baseRequest });
    expect(result.passed).toBe(false);
    expect(fakeWorkspace.execCapture).not.toHaveBeenCalled();
  });
});

describe('the test gate’s timeout', () => {
  const twoGo = {
    components: [
      { path: 'a', stacks: ['go'] },
      { path: 'b', stacks: ['go'] },
    ],
    evidence: [],
  };

  it('scales with the components a composite runs, as the TDD loop’s does', async () => {
    mockedFindUnique.mockResolvedValue({ detectedStack: twoGo, gateCommands: null } as never);
    await runTests({ request: baseRequest });
    expect(fakeWorkspace.execCapture).toHaveBeenLastCalledWith(
      expect.stringContaining("(cd 'a' &&"),
      { timeoutMs: 1_200_000 }
    );
  });

  it('is the usual ten minutes for a single command, and never changes another gate', async () => {
    mockedFindUnique.mockResolvedValue({ detectedStack: null, gateCommands: null } as never);
    await runTests({ request: baseRequest });
    expect(fakeWorkspace.execCapture).toHaveBeenLastCalledWith('yarn test', { timeoutMs: 600_000 });
    mockedFindUnique.mockResolvedValue({ detectedStack: twoGo, gateCommands: null } as never);
    await runLint({ command: 'yarn lint', request: baseRequest });
    expect(fakeWorkspace.execCapture).toHaveBeenLastCalledWith('yarn lint', {
      timeoutMs: undefined,
    });
  });

  it('lets a step’s own timeout win', async () => {
    mockedFindUnique.mockResolvedValue({ detectedStack: twoGo, gateCommands: null } as never);
    await runTests({ request: baseRequest, timeoutMs: 5_000 });
    expect(fakeWorkspace.execCapture).toHaveBeenLastCalledWith(expect.any(String), {
      timeoutMs: 5_000,
    });
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

  it('words the test outcome in the gate fix notes as passing, failing or not run', async () => {
    fixSessionMock.mockResolvedValue({});
    await executeGateFixImplementation({
      gateName: 'runTests',
      gateOutput: { exitCode: 1, passed: false, summary: 'boom' },
      previousCodeResult,
    });
    const session = fixSessionMock.mock.calls.at(-1)?.[0] as {
      notes: (t: Record<string, unknown>, extra: string | null) => string;
    };
    const notes = session.notes;
    expect(notes({ failing: 0, passed: true, total: 1 }, 'x')).toContain('Tests passing.');
    expect(notes({ failing: 1, passed: false, total: 1 }, 'x')).toContain('Tests failing.');
    expect(notes({ failing: 0, passed: false, total: 0 }, 'x')).toContain('Tests not run.');
  });

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
      where: { id: 'artifact-1', runId: 'db-run', status: 'ready' },
    });
  });

  it('does not record a failed, unconfigured, or artifact-less gate', async () => {
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

describe('runQualityGates', () => {
  // The step exists to stop a template that gates three times from cloning and
  // installing the repository three times, so the assertion that matters most is
  // how many workspaces were provisioned.
  // The file already mocks `createWorkspace`; count the calls instead of adding
  // a second mock (which would replace it for every test in the file).
  const provisioned = vi.mocked(createWorkspace);

  function gateWorkspace(exitFor: (command: string) => number) {
    return {
      destroy: vi.fn(async () => {}),
      exec: vi.fn(async () => ''),
      execCapture: vi.fn(async (command: string) => ({
        exitCode: exitFor(command),
        stderr: exitFor(command) === 0 ? '' : 'boom',
        stdout: exitFor(command) === 0 ? 'ok' : '',
      })),
      gitAuthed: vi.fn(async () => ''),
    };
  }

  beforeEach(() => {
    // `afterEach` resets this mock, so each test here re-establishes the
    // repository row the gate resolver and provisioning both read.
    mockedFindUnique.mockResolvedValue({ defaultBranch: 'main', gateCommands: null } as never);
    provisioned.mockReset();
    provisioned.mockResolvedValue(gateWorkspace(() => 0) as never);
  });

  it('provisions one workspace for every gate and reports each result', async () => {
    provisioned.mockResolvedValue(gateWorkspace((c) => (c === 'yarn lint' ? 1 : 0)) as never);

    const result = await runQualityGates({
      gates: [
        { name: 'runTypecheck' },
        { command: 'yarn lint', name: 'runLint' },
        { name: 'runTests' },
      ],
      request: baseRequest,
    });

    expect(provisioned).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.gates.runLint?.passed).toBe(false);
    expect(result.gates.runTypecheck?.passed).toBe(true);
    expect(result.gates.runTests?.passed).toBe(true);
    expect(result.summary).toContain('runLint');
    // Per-gate commands are resolved independently, so a step-level override
    // still wins for the gate it names.
    expect(result.gates.runLint?.command).toBe('yarn lint');
    expect(result.gates.runTests?.command).toBe(DEFAULT_COMMANDS.runTests);
  });

  it('stops after the first failure when asked to, and names what it skipped', async () => {
    provisioned.mockResolvedValue(gateWorkspace(() => 1) as never);

    const result = await runQualityGates({
      gates: [{ name: 'runLint' }, { name: 'runTests' }],
      request: baseRequest,
      stopOnFailure: true,
    });

    expect(result.gates.runLint?.passed).toBe(false);
    expect(result.gates.runTests).toBeUndefined();
    expect(result.skipped).toEqual(['runTests']);
    expect(result.passed).toBe(false);
  });

  it('fails a gate with no command without provisioning a workspace for it', async () => {
    const result = await runQualityGates({
      gates: [{ name: 'runPerfBench' }, { name: 'runLint' }],
      request: baseRequest,
    });

    expect(result.passed).toBe(false);
    expect(result.gates.runPerfBench?.summary).toMatch(/no command configured/);
    // The gate that cannot run does not cost a clone, but the one that can still
    // gets its workspace.
    expect(provisioned).toHaveBeenCalledTimes(1);
  });

  it('gives each gate its own workspace under per-gate isolation', async () => {
    const result = await runQualityGates({
      gates: [{ name: 'runLint' }, { name: 'runTests' }],
      isolation: 'per-gate',
      request: baseRequest,
    });

    expect(result.passed).toBe(true);
    expect(provisioned).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty gate list rather than reporting a pass', async () => {
    const result = await runQualityGates({ gates: [], request: baseRequest });
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/nothing was verified/);
  });
});
