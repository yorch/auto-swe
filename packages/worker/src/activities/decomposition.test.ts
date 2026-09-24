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

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo: () => {
    throw new Error('activity context is not available');
  },
  heartbeat: vi.fn(),
}));

interface FakeWorkspace {
  containerId: string;
  destroy: () => void;
  exec: ReturnType<typeof vi.fn>;
  execCapture: ReturnType<typeof vi.fn>;
  gitAuthed: ReturnType<typeof vi.fn>;
}

const execMock = vi.fn();
// Mirrors the real gitAuthed: injects a (fake) credential header per-call and
// forwards to the same underlying exec recording, so existing `exec`-based
// mockImplementation matchers still control return values for these commands.
const gitAuthedMock = vi.fn((subcommand: string) =>
  execMock(`git -c http.extraheader='AUTHORIZATION: basic redacted' ${subcommand}`)
);

const fakeWorkspace: FakeWorkspace = {
  containerId: 'workspace-test',
  destroy: vi.fn(),
  exec: execMock,
  execCapture: vi.fn(),
  gitAuthed: gitAuthedMock,
};

vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(() => fakeWorkspace),
  fetchBranchesSubcommand: (branches: string[]) =>
    `fetch origin ${branches.map((b) => `'+refs/heads/${b}:refs/remotes/origin/${b}'`).join(' ')}`,
  shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
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
const buildImplementerMock = vi.fn(async (..._args: unknown[]) => ({
  agent: { generate: generateMock },
  maxSteps: 37,
  promptSuffix: '',
  skills: [],
  toolKeys: null,
}));
vi.mock('../agents/implementer.js', () => ({
  buildImplementerForActivity: (...args: unknown[]) => buildImplementerMock(...args),
}));

const scanSecurityMock = vi.fn(async (_diff: string) => ({
  findings: [] as unknown[],
  passed: true,
}));
vi.mock('../agents/securityReviewProcessor.js', () => ({
  scanDiffForSecurityIssues: (diff: string) => scanSecurityMock(diff),
}));

const scanCodeMock = vi.fn(async (_diff: string) => [] as unknown[]);
vi.mock('../lib/codeSecurityScanner.js', () => ({
  scanDiffForCodeIssues: (diff: string) => scanCodeMock(diff),
}));

vi.mock('../lib/llmOutputScan.js', () => ({
  recordSuspiciousLlmOutput: vi.fn(async () => {}),
}));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ teamId: 'team-1' })),
}));

vi.mock('../lib/config/agentSkills.js', () => ({
  loadAgentSkills: vi.fn().mockResolvedValue([]),
  loadAgentToolConfig: vi.fn().mockResolvedValue(null),
}));

// Per-role, like the real cascade — a mock that returns one prompt for every
// key cannot tell the resolver's own row from the implementer's.
vi.mock('../lib/models.js', () => ({
  getModel: vi.fn(),
  resolveSystemPrompt: vi.fn(async (role: string, fallback: string) =>
    role === 'mergeConflictResolver' ? 'RESOLVER ROW PROMPT' : fallback
  ),
}));

const recordLlmUsageMock = vi.fn(async (..._args: unknown[]) => ({
  costUsd: 0.01,
  inputTokens: 10,
  modelSpec: 'anthropic/claude-x',
  outputTokens: 5,
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: (...args: unknown[]) => recordLlmUsageMock(...args),
}));

vi.mock('./commitToMemory.js', () => ({
  recordLessonBackground: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { persistActivityTrace } from '../lib/activityContext.js';
import { recordLessonBackground } from './commitToMemory.js';
import {
  CONFLICT_MARKER_ERE,
  mergeBranches,
  resolveMergeConflict,
  subtaskBranchName,
} from './decomposition.js';

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
  fakeWorkspace.gitAuthed.mockClear();
  (fakeWorkspace.destroy as ReturnType<typeof vi.fn>).mockReset();
  fakeWorkspace.execCapture.mockReset();
  generateMock.mockReset();
  mockedRecordLesson.mockReset();
  buildImplementerMock.mockClear();
  recordLlmUsageMock.mockClear();
  scanSecurityMock.mockClear();
  scanCodeMock.mockClear();
  vi.mocked(persistActivityTrace).mockClear();
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
    // fetch + push now go through gitAuthed (credential injected per-call
    // rather than a plain `git fetch`/`git push`), so match on the
    // subcommand + args rather than a literal `git fetch`/`git push` prefix.
    expect(cmds.some((c) => c.includes('fetch origin') && c.includes('auto/TICK-1/auth'))).toBe(
      true
    );
    expect(cmds.some((c) => c.includes('git merge --no-ff'))).toBe(true);
    expect(cmds.some((c) => c.includes('push origin'))).toBe(true);
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
    expect(cmds.some((c) => c.includes('push origin'))).toBe(false);
  });
});

/**
 * A stateful fake of the git index a conflicted merge leaves behind. Git keeps
 * a path in `git diff --diff-filter=U` until it is `git add`ed — rewriting the
 * file is not enough. The previous mocks cleared the unmerged list the moment
 * the agent ran, which is how a resolver that never staged anything passed
 * every test while failing every real run.
 */
interface FakeGit {
  files: Record<string, { content: string; unmerged: boolean }>;
  /** Merges that conflict (by source branch substring). */
  conflictOn: (source: string) => boolean;
}

const CONFLICTED = 'before\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> auto/TICK-1/db\nafter\n';
const RESOLVED = 'before\nA\nB\nafter\n';

function hasMarkers(content: string): boolean {
  return new RegExp(CONFLICT_MARKER_ERE, 'm').test(content);
}

function installFakeGit(git: FakeGit) {
  fakeWorkspace.exec.mockImplementation((cmd: string) => {
    if (cmd.startsWith('git merge --no-ff')) {
      if (git.conflictOn(cmd)) {
        for (const f of Object.values(git.files)) {
          f.unmerged = true;
          f.content = CONFLICTED;
        }
        const err = new Error('CONFLICT') as Error & { stdout: string; stderr: string };
        err.stdout = 'CONFLICT (content): Merge conflict in foo.ts';
        err.stderr = '';
        throw err;
      }
      return '';
    }
    if (cmd.startsWith('git diff --name-only')) {
      // Real git C-quotes unusual paths unless `-z` is passed; the fake only
      // answers the NUL-separated form the activity must ask for.
      if (!cmd.includes(' -z ')) {
        throw new Error('listConflictedFiles must use -z');
      }
      return Object.entries(git.files)
        .filter(([, f]) => f.unmerged)
        .map(([name]) => `${name}\0`)
        .join('');
    }
    if (cmd.startsWith('git diff --check')) {
      throw new Error('the resolver must not rely on git diff --check');
    }
    if (cmd.startsWith('git add -- ')) {
      for (const [name, f] of Object.entries(git.files)) {
        if (cmd.includes(`'${name}'`)) {
          f.unmerged = false;
        }
      }
      return '';
    }
    if (cmd.startsWith('git commit')) {
      if (Object.values(git.files).some((f) => f.unmerged)) {
        throw new Error('error: Committing is not possible because you have unmerged files.');
      }
      return 'committed';
    }
    if (cmd.startsWith('cat ')) {
      const name = Object.keys(git.files).find((n) => cmd.includes(`'${n}'`));
      return name ? git.files[name]?.content : '';
    }
    if (cmd.startsWith('git diff origin/')) {
      return 'diff --git a/EPIC b/EPIC\n+every subtask already on the epic';
    }
    if (cmd.startsWith("git diff 'resolved-sha^1' 'resolved-sha' -- ")) {
      return 'diff --git a/foo.ts b/foo.ts\n+A\n+B';
    }
    if (cmd.includes('git rev-parse HEAD')) {
      return 'resolved-sha\n';
    }
    return '';
  });
  fakeWorkspace.execCapture.mockImplementation(async (cmd: string) => {
    // `grep -qE <markers> -- <file>`: 0 = markers present, 1 = none.
    const name = Object.keys(git.files).find((n) => cmd.includes(`'${n}'`));
    const content = name ? (git.files[name]?.content ?? '') : '';
    return { exitCode: hasMarkers(content) ? 0 : 1, stderr: '', stdout: '' };
  });
}

/** The resolver agent rewrites the file (and does not run git — per its prompt). */
function resolverThatFixes(git: FakeGit) {
  generateMock.mockImplementation(async () => {
    for (const f of Object.values(git.files)) {
      f.content = RESOLVED;
    }
    return { text: 'resolved', usage: { inputTokens: 10, outputTokens: 5 } };
  });
}

function execCommands(): string[] {
  return fakeWorkspace.exec.mock.calls.map((c) => c[0] as string);
}

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

  function conflictingGit(): FakeGit {
    return {
      conflictOn: (cmd) => cmd.includes('auto/TICK-1/db'),
      files: { 'foo.ts': { content: 'base', unmerged: false } },
    };
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

  it('skips the resolver (and its scans) when all branches merge cleanly', async () => {
    primeRepo();
    installFakeGit({ conflictOn: () => false, files: {} });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(result.mergedBranches).toEqual(['auto/TICK-1/db']);
    expect(result.unmergedBranches).toEqual([]);
    expect(generateMock).not.toHaveBeenCalled();
    expect(scanSecurityMock).not.toHaveBeenCalled();
    expect(execCommands().some((c) => c.includes('push origin'))).toBe(true);
  });

  it('stages the resolved files itself, commits, and pushes', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    resolverThatFixes(git);

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(result.mergedBranches).toEqual(['auto/TICK-1/db']);
    expect(generateMock).toHaveBeenCalledTimes(1);
    const cmds = execCommands();
    // Only the conflicted path is staged — not `git add -A`, which would sweep
    // in anything else the agent touched.
    expect(cmds).toContain("git add -- 'foo.ts'");
    expect(cmds).not.toContain('git add -A');
    expect(cmds.some((c) => c.startsWith('git commit'))).toBe(true);
    expect(cmds.some((c) => c.includes('push origin'))).toBe(true);
    expect(git.files['foo.ts']?.unmerged).toBe(false);
  });

  it('accepts a resolved file with trailing whitespace (not a conflict)', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    generateMock.mockImplementation(async () => {
      git.files['foo.ts'] = { content: 'before  \nA\t\nafter\n', unmerged: true };
      return { usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });
    expect(result.passed).toBe(true);
  });

  it('runs as the mergeConflictResolver persona with its own prompt and the step budget', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    resolverThatFixes(git);

    await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(buildImplementerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'mergeConflictResolver'
    );
    const [messages, options] = generateMock.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      Record<string, unknown>,
    ];
    expect(messages.find((m) => m.role === 'system')?.content).toBe('RESOLVER ROW PROMPT');
    expect(options).toMatchObject({ maxSteps: 37, toolChoice: 'auto' });
    expect(recordLlmUsageMock.mock.calls[0]?.[1]).toBe('mergeConflictResolver');
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledWith(
      expect.anything(),
      'mergeConflictResolver'
    );
  });

  it('records the resolver LLM call on the trace', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    resolverThatFixes(git);

    await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    const tracer = vi.mocked(persistActivityTrace).mock.calls[0]?.[0] as unknown as {
      records: Array<{ type: string; role?: string | null; costUsd?: number | null }>;
    };
    const llm = tracer.records.filter((r) => r.type === 'llm_response');
    expect(llm).toHaveLength(1);
  });

  it('scans the resolved merge before pushing it', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    resolverThatFixes(git);

    await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    const diff = 'diff --git a/foo.ts b/foo.ts\n+A\n+B';
    expect(scanCodeMock).toHaveBeenCalledWith(diff);
    expect(scanSecurityMock).toHaveBeenCalledWith(diff);
    // Only the resolver's own delta: the committed merge against its target
    // parent, restricted to the conflicted paths — never the whole epic
    // against the default branch, and never the uncommitted working tree.
    const cmds = execCommands();
    expect(cmds).toContain("git diff 'resolved-sha^1' 'resolved-sha' -- 'foo.ts'");
    expect(cmds.some((c) => c.startsWith('git diff origin/'))).toBe(false);
    expect(cmds.some((c) => /^git diff(?! --name-only)(?! '\S+\^1')/.test(c))).toBe(false);
    // The scan runs on the committed resolution, so it follows the commit.
    const commitIdx = cmds.findIndex((c) => c.startsWith('git commit'));
    const scanIdx = cmds.findIndex((c) => c.startsWith("git diff 'resolved-sha^1'"));
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(scanIdx).toBeGreaterThan(commitIdx);
  });

  it('scans each resolver commit when several branches needed resolving', async () => {
    primeRepo();
    const git: FakeGit = {
      conflictOn: () => true,
      files: { 'foo.ts': { content: 'base', unmerged: false } },
    };
    installFakeGit(git);
    resolverThatFixes(git);
    let n = 0;
    const base = fakeWorkspace.exec.getMockImplementation() as (cmd: string) => unknown;
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse HEAD') {
        n += 1;
        return `sha-${n}\n`;
      }
      if (cmd.startsWith("git diff 'sha-")) {
        return `diff for ${cmd}`;
      }
      return base(cmd);
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db', 'auto/TICK-1/api'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    const cmds = execCommands();
    expect(cmds).toContain("git diff 'sha-1^1' 'sha-1' -- 'foo.ts'");
    expect(cmds).toContain("git diff 'sha-2^1' 'sha-2' -- 'foo.ts'");
    expect(scanSecurityMock).toHaveBeenCalledTimes(1);
    const scanned = scanSecurityMock.mock.calls[0]?.[0] as string;
    expect(scanned).toContain("'sha-1^1'");
    expect(scanned).toContain("'sha-2^1'");
  });

  it('treats a README whose setext heading is "=======" as resolved', async () => {
    primeRepo();
    const git: FakeGit = {
      conflictOn: (cmd) => cmd.includes('auto/TICK-1/db'),
      files: { 'README.md': { content: 'base', unmerged: false } },
    };
    installFakeGit(git);
    generateMock.mockImplementation(async () => {
      git.files['README.md'] = {
        content: '# svc\n\nUsage\n-----\n\nrun it\n\nLicense\n=======\n\nMIT\n',
        unmerged: true,
      };
      return { usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(execCommands()).toContain("git add -- 'README.md'");
  });

  it('reads NUL-separated conflicted paths verbatim, spaces and all', async () => {
    primeRepo();
    const git: FakeGit = {
      conflictOn: (cmd) => cmd.includes('auto/TICK-1/db'),
      files: {
        ' lead.md': { content: 'base', unmerged: false },
        'docs/café notes.md': { content: 'base', unmerged: false },
      },
    };
    installFakeGit(git);
    resolverThatFixes(git);

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(execCommands()).toContain("git add -- ' lead.md' 'docs/café notes.md'");
  });

  it('fails the branch instead of committing when git cannot list unmerged paths', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    const base = fakeWorkspace.exec.getMockImplementation() as (cmd: string) => unknown;
    fakeWorkspace.exec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git diff --name-only')) {
        throw new Error('fatal: index file corrupt');
      }
      return base(cmd);
    });

    const result = await resolveMergeConflict({
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(false);
    expect(generateMock).not.toHaveBeenCalled();
    const cmds = execCommands();
    expect(cmds.some((c) => c.startsWith('git commit'))).toBe(false);
    expect(cmds.some((c) => c.includes('push origin'))).toBe(false);
  });

  it('fails SECURITY_GATE_FAILURE and never pushes on a critical finding', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    resolverThatFixes(git);
    scanSecurityMock.mockResolvedValueOnce({
      findings: [
        { category: 'SECRET', description: 'hardcoded key', file: 'foo.ts', severity: 'CRITICAL' },
      ],
      passed: false,
    });

    await expect(
      resolveMergeConflict({
        request: baseRequest,
        sourceBranches: ['auto/TICK-1/db'],
        targetBranch: 'auto/TICK-1',
      })
    ).rejects.toMatchObject({ type: 'SECURITY_GATE_FAILURE' });
    expect(execCommands().some((c) => c.includes('push origin'))).toBe(false);
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalled();
  });

  it('coerces non-finite maxAttemptsPerBranch back to the default of 1', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    generateMock.mockResolvedValue({ usage: { inputTokens: 1, outputTokens: 1 } });

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

  it('retries while markers remain and succeeds once they are gone', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    let calls = 0;
    generateMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        git.files['foo.ts'] = { content: RESOLVED, unmerged: true };
      }
      return { usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const result = await resolveMergeConflict({
      maxAttemptsPerBranch: 3,
      request: baseRequest,
      sourceBranches: ['auto/TICK-1/db'],
      targetBranch: 'auto/TICK-1',
    });

    expect(result.passed).toBe(true);
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Nothing is staged while a marker is left, so the unmerged path survives
    // the failed attempt instead of being committed with markers in it.
    expect(execCommands().filter((c) => c.startsWith('git add --'))).toHaveLength(1);
  });

  it('fires the MERGE_CONFLICT memory hook after a successful resolution', async () => {
    primeRepo();
    const git = conflictingGit();
    installFakeGit(git);
    resolverThatFixes(git);

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
    installFakeGit(conflictingGit());
    generateMock.mockResolvedValue({ usage: { inputTokens: 1, outputTokens: 1 } });

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
    installFakeGit(conflictingGit());
    // Resolver call returns without actually fixing the file.
    generateMock.mockResolvedValue({ usage: { inputTokens: 1, outputTokens: 1 } });

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
    const cmds = execCommands();
    expect(cmds.some((c) => c.includes('push origin'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('git add'))).toBe(false);
    expect(cmds).toContain('git merge --abort');
  });
});

describe('CONFLICT_MARKER_ERE', () => {
  const re = new RegExp(CONFLICT_MARKER_ERE, 'm');

  it('matches every marker line git writes, including diff3 base markers', () => {
    expect(re.test('<<<<<<< HEAD')).toBe(true);
    expect(re.test('>>>>>>> feature/x')).toBe(true);
    expect(re.test('||||||| merged common ancestors')).toBe(true);
    expect(re.test('|||||||')).toBe(true);
    expect(re.test('<<<<<<<')).toBe(true);
  });

  it('does not match ordinary code or prose', () => {
    expect(re.test('const x = a <<<<<<< b;')).toBe(false);
    expect(re.test('========')).toBe(false);
    // A setext heading underline — Markdown and reStructuredText both.
    expect(re.test('License\n=======\n')).toBe(false);
    expect(re.test('=======')).toBe(false);
    expect(re.test('<<<<<<<<')).toBe(false);
    expect(re.test('>>>>>>>>> x')).toBe(false);
    expect(re.test('  =======')).toBe(false);
    expect(re.test('cat <<<EOF')).toBe(false);
    expect(re.test(RESOLVED)).toBe(false);
  });
});
