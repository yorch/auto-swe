/**
 * `mergeBranches` against real git. The activity used to run the repository's setup command and
 * then a plain `git merge origin/<source>` and `git push origin <branch>`: whatever the setup code
 * committed (a workflow file, a file holding the setup secrets) was pushed with the merge, and
 * nothing read it. It now skips the setup command, merges the shas it recorded with the
 * hooks-off merge the resolver uses, and pushes the tracked sha.
 */
import { execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ setupRan: 0, ws: undefined as unknown }));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
      findUniqueOrThrow: vi.fn(async () => ({
        defaultBranch: 'main',
        githubUrl: 'https://github.com',
        id: 'repo-1',
        organizationName: 'acme',
        repoName: 'svc',
      })),
    },
    workflowRun: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('../lib/effectLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/effectLedger.js')>()),
  recordGitPush: vi.fn(async (_b: string, _s: unknown, push: () => unknown) => push()),
}));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  putArtifact: vi.fn().mockResolvedValue({ id: 'art-1' }),
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
vi.mock('./workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace.js')>()),
  createWorkspace: vi.fn(() => state.ws),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: vi.fn(async () => ({ authedCloneUrl: 'x', cloneUrl: 'x', token: 't' })),
  }),
  toRepoRef: (repo: Record<string, unknown>) => repo,
}));

import { mergeBranches } from './decomposition.js';

let dir: string;
let repo: string;
const env = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'a@a',
  GIT_AUTHOR_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@a',
  GIT_COMMITTER_NAME: 'a',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const sh = (cwd: string, cmd: string): string =>
  execSync(cmd, {
    cwd,
    encoding: 'utf8',
    env,
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'merge-branches-'));
  sh(
    dir,
    `git init -q --bare -b epic remote.git && git init -q -b epic seed && cd seed &&
     git config user.name t && git config user.email t@t &&
     echo base > c.txt && git add . && git commit -qm base &&
     git checkout -qb src1 && echo one > one.txt && git add . && git commit -qm s1 &&
     git checkout -q epic && git push -q ../remote.git epic src1 &&
     git clone -q ../remote.git ../ws`
  );
  repo = path.join(dir, 'ws');
  // What the repository's setup command does: commit files of its own.
  writeFileSync(
    path.join(dir, 'setup.sh'),
    'mkdir -p .github/workflows; echo "on: push" > .github/workflows/x.yml; ' +
      'echo "$SETUP_SECRET" > leak.txt; git add -A; git commit -qm deps\n'
  );
  chmodSync(path.join(dir, 'setup.sh'), 0o755);
  state.setupRan = 0;
  state.ws = {
    containerId: 'ws',
    destroy: async () => {},
    exec: async (cmd: string) => sh(repo, cmd),
    gitAuthed: async (sub: string) => sh(repo, `git ${sub}`),
    gitIdentity: {
      author: { email: 'a@a', name: 'a' },
      committer: { email: 'a@a', name: 'a' },
    },
    runSetup: async () => {
      state.setupRan++;
      sh(repo, `SETUP_SECRET=npm_ABCDEFsecretvalue sh ${path.join(dir, 'setup.sh')}`);
      return null;
    },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('mergeBranches against real git', () => {
  it('pushes the merge of the recorded tips and nothing the repository setup code committed', async () => {
    const result = await mergeBranches({
      request: { repoId: 'repo-1' } as never,
      sourceBranches: ['src1'],
      targetBranch: 'epic',
    });
    expect(result.passed).toBe(true);
    expect(state.setupRan).toBe(0);
    const files = sh(dir, 'git --git-dir=remote.git ls-tree -r --name-only epic')
      .split('\n')
      .filter(Boolean);
    expect(files).toEqual(['c.txt', 'one.txt']);
    expect(sh(dir, 'git --git-dir=remote.git rev-parse epic').trim()).toBe(result.headSha);
  });

  it('control: the setup command is what commits the workflow file and the secret', async () => {
    await (state.ws as { runSetup: () => Promise<unknown> }).runSetup();
    expect(sh(repo, 'git ls-tree -r --name-only HEAD')).toContain('.github/workflows/x.yml');
    expect(sh(repo, 'cat leak.txt')).toContain('npm_ABCDEFsecretvalue');
  });

  it('reports a source branch that does not exist as unmerged and pushes nothing', async () => {
    const before = sh(dir, 'git --git-dir=remote.git rev-parse epic').trim();
    const result = await mergeBranches({
      request: { repoId: 'repo-1' } as never,
      sourceBranches: ['src1', 'missing'],
      targetBranch: 'epic',
    });
    expect(result.passed).toBe(false);
    expect(result.mergedBranches).toEqual(['src1']);
    expect(result.unmergedBranches).toEqual(['missing']);
    expect(sh(dir, 'git --git-dir=remote.git rev-parse epic').trim()).toBe(before);
  });
});
