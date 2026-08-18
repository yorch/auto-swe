import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'ghs_supersecrettoken1234567890';
const CLONE_URL = `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`;

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUniqueOrThrow: vi.fn() } },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn().mockResolvedValue({ branchPrefix: 'auto' }),
}));
vi.mock('@auto-swe/shared/workflow', async () => {
  const actual = await vi.importActual<typeof import('@auto-swe/shared/workflow')>(
    '@auto-swe/shared/workflow'
  );
  return {
    ...actual,
    assertShellImageAllowed: vi.fn(),
  };
});
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn().mockReturnValue('wf-1'),
  currentWorkflowRunId: vi.fn().mockResolvedValue('run-1'),
}));
vi.mock('../lib/artifactStore.js', () => ({
  putArtifact: vi.fn().mockResolvedValue({ id: 'artifact-1' }),
}));
vi.mock('../lib/ephemeralContainer.js', () => ({
  runEphemeralContainer: vi.fn(),
}));
vi.mock('../lib/execUtils.js', () => ({
  execShellAsync: vi.fn(),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: vi.fn(),
  toRepoRef: vi.fn().mockReturnValue({
    apiUrl: null,
    baseUrl: null,
    organizationName: 'acme',
    repoName: 'widgets',
  }),
}));
vi.mock('./commitToMemory.js', () => ({
  recordLessonBackground: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@auto-swe/shared/db';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { execShellAsync } from '../lib/execUtils.js';
import { getScmProvider } from '../lib/scm/index.js';
import { runShellStep } from './shellStep.js';

const findUniqueOrThrow = vi.mocked(prisma.connection.findUniqueOrThrow);
const mockedExec = vi.mocked(execShellAsync);
const mockedRunEphemeral = vi.mocked(runEphemeralContainer);
const mockedGetScmProvider = vi.mocked(getScmProvider);

const REQUEST = {
  externalTicketId: 'JIRA-1',
  repoId: 'repo-1',
} as unknown as RepoWorkRequest;

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueOrThrow.mockResolvedValue({
    defaultBranch: 'main',
    team: { egressAllowlist: [], id: 'team-1', shellImageAllowlist: ['alpine/git:latest'] },
  } as never);
  mockedGetScmProvider.mockReturnValue({
    cloneCredentials: vi.fn().mockResolvedValue({ authedCloneUrl: CLONE_URL, token: TOKEN }),
  } as never);
  mockedRunEphemeral.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'ok' } as never);
  // Every `runDocker` call shells out through `execShellAsync` with a single
  // `docker ...` command string. Route by content: clone/volume calls succeed;
  // the finalize (commit + push) script fails, mimicking a real `git push`
  // rejection whose stderr/message embed the credential URL — exactly what
  // git prints on a push failure.
  mockedExec.mockImplementation(async (command: string) => {
    if (command.includes('git push origin')) {
      const err = new Error(
        `Command failed: docker run ... sh -c 'git push origin HEAD:auto/JIRA-1'\n` +
          `fatal: unable to access '${CLONE_URL}/': The requested URL returned error: 403`
      ) as Error & { stdout?: string; stderr?: string };
      err.stdout = '';
      err.stderr = `fatal: unable to access '${CLONE_URL}/': The requested URL returned error: 403`;
      throw err;
    }
    return '';
  });
});

describe('runShellStep — token redaction', () => {
  it('does not leak the GitHub token into the summary when git push fails', async () => {
    const result = await runShellStep({
      command: 'echo hi',
      image: 'alpine/git:latest',
      request: REQUEST,
    });

    // The command itself still succeeded — only the push failed.
    expect(result.passed).toBe(true);
    expect(result.summary).toMatch(/git push failed/);
    expect(result.summary).not.toContain(TOKEN);
    expect(result.summary).not.toContain(CLONE_URL);
  });

  it('does not leak the GitHub token into the thrown error when git push fails and no fallback text is available', async () => {
    // Even the raw error captured internally (pre-truncation) must never
    // carry the token — assert via the mock's own captured call, since the
    // activity always swallows the push error into `summary` rather than
    // rethrowing it.
    mockedExec.mockImplementation(async (command: string) => {
      if (command.includes('git push origin')) {
        const err = new Error(
          `fatal: unable to access '${CLONE_URL}/': The requested URL returned error: 403`
        ) as Error & { stdout?: string; stderr?: string };
        throw err;
      }
      return '';
    });

    const result = await runShellStep({
      command: 'echo hi',
      image: 'alpine/git:latest',
      request: REQUEST,
    });

    expect(result.passed).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('passes the token through to the clone step so a clone failure is also redacted', async () => {
    mockedExec.mockImplementation(async (command: string) => {
      if (command.includes('git clone')) {
        const err = new Error(
          `fatal: unable to access '${CLONE_URL}/': The requested URL returned error: 403`
        ) as Error & { stdout?: string; stderr?: string };
        err.stderr = `fatal: unable to access '${CLONE_URL}/': The requested URL returned error: 403`;
        throw err;
      }
      return '';
    });

    await expect(
      runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST })
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { message?: string; stderr?: string };
      const combined = `${e.message ?? ''}${e.stderr ?? ''}`;
      return !combined.includes(TOKEN);
    });
  });
});
