import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'ghs_supersecrettoken1234567890';
const CLONE_URL = `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`;

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    // Read by the setting registry when it resolves `workspace.gitHelperImage`;
    // no rows means every setting falls back to its registered default.
    configSetting: { findMany: vi.fn().mockResolvedValue([]) },
    connection: { findUniqueOrThrow: vi.fn() },
  },
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
// Resolving `workspace.gitHelperImage` scopes the read to the calling run, which
// otherwise reaches Temporal's activity context and the database.
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({}),
}));
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
import { putArtifact } from '../lib/artifactStore.js';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { execShellAsync } from '../lib/execUtils.js';
import { getScmProvider } from '../lib/scm/index.js';
import { runShellStep } from './shellStep.js';
import { shellQuote } from './workspace.js';

const findUniqueOrThrow = vi.mocked(prisma.connection.findUniqueOrThrow);
const mockedExec = vi.mocked(execShellAsync);
const mockedRunEphemeral = vi.mocked(runEphemeralContainer);
const mockedGetScmProvider = vi.mocked(getScmProvider);
const mockedPutArtifact = vi.mocked(putArtifact);

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
  // git prints on a push failure. Match on `push origin` rather than
  // `git push origin`: the push is issued as
  // `git -c http.extraheader=… push origin …`.
  mockedExec.mockImplementation(async (command: string) => {
    if (command.includes('push origin')) {
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

  it('does not put the raw token into the persisted artifact body', async () => {
    // `cloneIntoVolume` scrubs the credential out of `origin`, so a real
    // `git remote -v` no longer prints it. This asserts the defense-in-depth
    // layer: if a token reaches stdout by any route, it must never reach the
    // stored artifact, even though the command itself succeeds.
    mockedRunEphemeral.mockResolvedValue({
      exitCode: 0,
      signal: undefined,
      stderr: '',
      stdout: `origin\t${CLONE_URL} (fetch)\norigin\t${CLONE_URL} (push)`,
    } as never);

    const result = await runShellStep({
      command: 'git remote -v',
      image: 'alpine/git:latest',
      request: REQUEST,
    });

    expect(result.passed).toBe(true);
    expect(mockedPutArtifact).toHaveBeenCalledTimes(1);
    const call = mockedPutArtifact.mock.calls[0]?.[0] as { body: string };
    expect(call.body).not.toContain(TOKEN);
    expect(call.body).not.toContain(CLONE_URL);
  });

  it('fully redacts a token that straddles the 4000-byte truncation boundary', async () => {
    // truncate() keeps the first `half` (2000) bytes and the last `half`
    // bytes, dropping the middle. Place the token so it starts 10 bytes
    // before that cut — if redaction ran on the already-truncated string
    // (the pre-fix order), only the first 10 chars of the token would
    // survive into `head`, unredacted, because the full 30-char pattern no
    // longer appears intact anywhere in the truncated text.
    const half = 2000;
    const prefix = 'A'.repeat(half - 10);
    const suffix = 'B'.repeat(4000); // pushes total well past 4000 so truncation fires
    const straddlingStderr = `${prefix}${TOKEN}${suffix}`;

    mockedRunEphemeral.mockResolvedValue({
      exitCode: 1,
      signal: undefined,
      stderr: straddlingStderr,
      stdout: '',
    } as never);

    const result = await runShellStep({
      command: 'some-failing-command',
      image: 'alpine/git:latest',
      request: REQUEST,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).not.toContain(TOKEN);
    // The specific leaked fragment the pre-fix ordering would have left
    // behind: the first 10 characters of the token, unredacted.
    expect(result.summary).not.toContain(TOKEN.slice(0, 10));
  });

  it('redacts the raw command string on err.cmd from a failed docker exec', async () => {
    mockedExec.mockImplementation(async (command: string) => {
      if (command.includes('git clone')) {
        const err = new Error('fatal: authentication failed') as Error & {
          cmd?: string;
          stdout?: string;
          stderr?: string;
        };
        // Node's promisify(exec) rejection carries the full command,
        // credential URL included, on `.cmd`.
        err.cmd = `docker run --rm -v vol:/workspace:rw --entrypoint sh alpine/git:latest -c "git clone ${CLONE_URL} /workspace/repo"`;
        err.stdout = '';
        err.stderr = 'fatal: authentication failed';
        throw err;
      }
      return '';
    });

    await expect(
      runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST })
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { cmd?: unknown };
      return typeof e.cmd === 'string' && !e.cmd.includes(TOKEN);
    });
  });
});

/**
 * The redaction suite above is defense in depth; these tests cover the actual
 * containment. The workspace volume is bind-mounted into the container that
 * runs the AUTHOR-SUPPLIED command with `/workspace/repo` as cwd, so a token
 * left in `.git/config` is live data inside the sandbox — and sink redaction
 * (exact-substring) is defeated by `base64`/`rev`/`tr`. The credential must
 * therefore never be persisted in the volume at all.
 */
describe('runShellStep — clone credential is never persisted in the workspace volume', () => {
  const CLEAN_CLONE_URL = 'https://github.com/acme/widgets.git';
  const AUTH_HEADER = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;

  beforeEach(() => {
    // All docker invocations succeed here — these tests assert on the
    // *generated command sequence*, not on error handling.
    mockedExec.mockImplementation(async () => '');
  });

  const dockerCommands = (): string[] => mockedExec.mock.calls.map((c) => String(c[0]));

  const requireCommand = (label: string, match: (c: string) => boolean): string => {
    const found = dockerCommands().find(match);
    if (!found) {
      throw new Error(`no docker command matched ${label}; got:\n${dockerCommands().join('\n')}`);
    }
    return found;
  };

  /**
   * `runDocker` shell-quotes every docker argument, so the `sh -c` script
   * reaches `execShellAsync` with each inner `'` escaped as `'\''`. Escaping
   * is per-character and context-free, so a fragment escaped on its own is a
   * substring of the escaped whole — which lets these assertions be written
   * against the script as authored while still proving both quoting levels
   * survived intact.
   */
  const escaped = (fragment: string): string => shellQuote(fragment).slice(1, -1);

  it('resets origin to the credential-free URL in the same script as the clone', async () => {
    await runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST });

    const clone = requireCommand('git clone', (c) => c.includes('git clone'));
    // The scrub must be chained onto the clone itself, so there is no window
    // in which the volume holds a credential-bearing origin — and the URL it
    // installs must be shell-quoted like every other interpolated value.
    expect(clone).toContain(escaped(`git remote set-url origin ${shellQuote(CLEAN_CLONE_URL)}`));
    expect(clone.indexOf('git remote set-url origin')).toBeGreaterThan(clone.indexOf('git clone'));
  });

  it('leaves the token in the clone argument only, never in what origin keeps', async () => {
    await runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST });

    const clone = requireCommand('git clone', (c) => c.includes('git clone'));
    const scrubAt = clone.indexOf('git remote set-url origin');
    expect(scrubAt).toBeGreaterThan(-1);
    // Everything the clone leaves behind on disk — i.e. the origin URL it is
    // reset to — must be credential-free.
    expect(clone.slice(scrubAt)).not.toContain(TOKEN);
    // And the token must reach exactly one docker invocation: the clone that
    // genuinely needs it. Nothing else may carry it in the clear.
    expect(dockerCommands().filter((c) => c.includes(TOKEN))).toHaveLength(1);
  });

  it('scrubs origin on the default-branch fallback clone too', async () => {
    mockedExec.mockImplementation(async (command: string) => {
      if (command.includes(escaped(`-b ${shellQuote('auto/JIRA-1')}`))) {
        const err = new Error('fatal') as Error & { stderr?: string };
        err.stderr = 'Remote branch auto/JIRA-1 not found in upstream origin';
        throw err;
      }
      return '';
    });

    await runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST });

    const fallbackClone = requireCommand(
      'default-branch clone',
      (c) => c.includes('git clone') && c.includes(escaped(`-b ${shellQuote('main')}`))
    );
    expect(fallbackClone).toContain(
      escaped(`git remote set-url origin ${shellQuote(CLEAN_CLONE_URL)}`)
    );
  });

  it('authenticates the finalize push via http.extraheader rather than the origin URL', async () => {
    await runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST });

    const finalize = requireCommand('finalize push', (c) => c.includes('push origin'));
    expect(finalize).toContain(
      escaped(`git -c http.extraheader=${shellQuote(AUTH_HEADER)} push origin HEAD:`)
    );
    // The header carries the credential base64-encoded, so the raw token must
    // not appear — and the push must not fall back to a bare `git push` that
    // would rely on a credential-bearing remote.
    expect(finalize).not.toContain(TOKEN);
    expect(finalize).not.toContain('\ngit push origin');
  });

  it('shell-quotes the branch inside the header-authenticated push', async () => {
    const branch = "weird'; touch /pwned; #";
    await runShellStep({
      branch,
      command: 'echo hi',
      image: 'alpine/git:latest',
      request: REQUEST,
    });

    const finalize = requireCommand('finalize push', (c) => c.includes('push origin'));
    expect(finalize).toContain(
      escaped(
        `git -c http.extraheader=${shellQuote(AUTH_HEADER)} push origin HEAD:${shellQuote(branch)}`
      )
    );
  });

  it('falls back to a plain push when the provider hands back an unauthenticated URL', async () => {
    mockedGetScmProvider.mockReturnValue({
      cloneCredentials: vi
        .fn()
        .mockResolvedValue({ authedCloneUrl: CLEAN_CLONE_URL, token: TOKEN }),
    } as never);

    await runShellStep({ command: 'echo hi', image: 'alpine/git:latest', request: REQUEST });

    // The scrub is unconditional — it just installs the same URL back.
    const clone = requireCommand('git clone', (c) => c.includes('git clone'));
    expect(clone).toContain(escaped(`git remote set-url origin ${shellQuote(CLEAN_CLONE_URL)}`));
    // …and with nothing to inject, the push stays a plain `git push`.
    const finalize = requireCommand('finalize push', (c) => c.includes('push origin'));
    expect(finalize).toContain('\ngit push origin HEAD:');
    expect(finalize).not.toContain('http.extraheader');
  });
});
