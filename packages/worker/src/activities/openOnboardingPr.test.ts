import { createHash } from 'node:crypto';
import { type OnboardingRequest, renderOnboardingFiles } from '@auto-swe/shared/lib/onboardingPr';
import type { OnboardingPrInput } from '@auto-swe/shared/lib/onboardingPrWorkflow';
import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  compareCommits: vi.fn(),
  connection: vi.fn(),
  createPr: vi.fn(),
  createWorkspace: vi.fn(),
  findBranchWork: vi.fn(),
  hostsAllowed: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: { connection: { findUnique: m.connection } } }));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: m.hostsAllowed,
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: m.persist }));
vi.mock('../lib/execUtils.js', () => ({ throwIfActivityCancelled: () => undefined }));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: async () => ({
      authedCloneUrl: 'https://x-access-token:SECRET-TOKEN@github.com/acme/api.git',
      cloneUrl: 'https://github.com/acme/api.git',
      token: 'SECRET-TOKEN',
    }),
    compareCommits: m.compareCommits,
    createOrUpdatePullRequest: m.createPr,
    findBranchWork: m.findBranchWork,
  }),
  toRepoRef: (repo: { id: string }) => ({ connectionId: repo.id }),
}));
vi.mock('./workspace.js', async (orig) => ({
  ...(await orig<typeof import('./workspace.js')>()),
  createWorkspace: m.createWorkspace,
}));

import { contentHashOf, onboardingPrBody, openOnboardingPr } from './openOnboardingPr.js';

const REQUEST: OnboardingRequest = {
  files: [{ kind: 'tools', tools: [{ key: 'node' }] }, { kind: 'prPolicy' }],
};
const RENDERED = renderOnboardingFiles(REQUEST);

function hashOf(files: readonly { path: string; content: string }[]): string {
  const canonical = files
    .map((f) => `${f.path}\0${f.content}`)
    .sort()
    .join('\0\0');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const TOOLS_ONLY_FILES = REQUEST.files.slice(0, 1);
const TOOLS_ONLY = renderOnboardingFiles({ files: TOOLS_ONLY_FILES });
const TOOLS_ONLY_INPUT: OnboardingPrInput = {
  ...{ connectionId: 'conn-12345678', proposedById: 'user-1' },
  contentHash: hashOf(TOOLS_ONLY),
  files: TOOLS_ONLY_FILES,
};

const INPUT: OnboardingPrInput = {
  connectionId: 'conn-12345678',
  contentHash: hashOf(RENDERED),
  files: REQUEST.files,
  proposedById: 'user-1',
};

/** File contents at the default branch's tip (`FETCH_HEAD`). */
let base: Record<string, string>;
/** File contents at the workspace's `HEAD`; the default branch's when unset. */
let head: Record<string, string> | undefined;
/** `git ls-tree` output for the fixed paths. */
let lsTree: string;
let dirIsSymlink: boolean;
let commands: string[];
let written: Record<string, string>;
let destroyed: number;
let failPush = false;
/** `git diff --name-status FETCH_HEAD...HEAD` output; derived from the rendered files when unset. */
let diffOverride: string | undefined;
let diffFiles: { path: string; content: string }[] = [];

function fakeWorkspace() {
  return {
    containerId: 'ws-1',
    destroy: async () => {
      destroyed += 1;
    },
    exec: async (cmd: string) => {
      commands.push(cmd);
      return cmd.includes('rev-parse HEAD') ? `${'a'.repeat(40)}\n` : '';
    },
    execCapture: async (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('ls-tree')) {
        return { exitCode: 0, stderr: '', stdout: lsTree };
      }
      if (cmd.startsWith('test -L')) {
        return { exitCode: dirIsSymlink ? 0 : 1, stderr: '', stdout: '' };
      }
      if (cmd.includes('diff --name-status')) {
        const derived = diffFiles
          .filter((f) => base[f.path] !== f.content)
          .map((f) => `${f.path in base ? 'M' : 'A'}\t${f.path}`);
        return { exitCode: 0, stderr: '', stdout: diffOverride ?? derived.join('\n') };
      }
      const tree = /FETCH_HEAD:/.test(cmd) ? base : (head ?? base);
      const hit = Object.entries(tree).find(([p]) => cmd.includes(`HEAD:${p}`));
      return hit
        ? { exitCode: 0, stderr: '', stdout: hit[1] }
        : { exitCode: 128, stderr: 'fatal', stdout: '' };
    },
    execStdin: async (cmd: string, stdin: string | Buffer) => {
      const target = /cat > '?([^' ]+)'?/.exec(cmd)?.[1] ?? '';
      written[target] = String(stdin);
      return '';
    },
    gitAuthed: async (cmd: string) => {
      commands.push(`AUTHED ${cmd}`);
      if (failPush) {
        throw new Error('remote: failure at https://x-access-token:SECRET-TOKEN@github.com/x');
      }
      return '';
    },
    gitIdentity: { coAuthorTrailer: undefined },
    readFile: async () => Buffer.from(''),
  };
}

beforeEach(() => {
  base = {};
  head = undefined;
  lsTree = '';
  dirIsSymlink = false;
  commands = [];
  written = {};
  destroyed = 0;
  failPush = false;
  diffOverride = undefined;
  diffFiles = RENDERED;
  for (const fn of Object.values(m)) {
    fn.mockReset();
  }
  m.connection.mockResolvedValue({
    defaultBranch: 'main',
    githubApiUrl: null,
    githubUrl: null,
    id: 'conn-12345678',
    installation: null,
    isActive: true,
    teamId: 'team-1',
    type: 'git_repo',
  });
  m.hostsAllowed.mockResolvedValue({ ok: true });
  m.findBranchWork.mockResolvedValue({ aheadBy: null, branchExists: false, openPr: null });
  m.compareCommits.mockResolvedValue(comparison(RENDERED.map((f) => ({ path: f.path }))));
  m.createPr.mockResolvedValue({ prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' });
  m.createWorkspace.mockImplementation(async () => fakeWorkspace());
  m.persist.mockResolvedValue(true);
});

type FileChange = { path: string; previousPath?: string; status?: string };

function comparison(changes: FileChange[]) {
  return {
    aheadBy: 1,
    behindBy: 0,
    files: changes.map((c) => ({
      path: c.path,
      previousPath: c.previousPath ?? null,
      status: c.status ?? 'added',
    })),
    paths: changes.flatMap((c) => (c.previousPath ? [c.path, c.previousPath] : [c.path])),
    status: 'ahead',
  };
}

/** Every recorded command: no force, no `+` refspec, and the push is exactly sha -> our branch. */
function expectOnlyAPlainPushOfTheBranch(push: string): void {
  expect(push).toMatch(
    new RegExp(`^AUTHED push origin '[0-9a-f]{40}:refs/heads/auto/onboard-${INPUT.contentHash}'$`)
  );
  // `add -f` is deliberate (the path may be git-ignored); no push or fetch may force or use `+`.
  for (const command of commands.filter((c) => /\s(push|fetch)\s/.test(c))) {
    expect(command).not.toMatch(/--force|--force-with-lease|(^|\s)-f(\s|$)/);
    expect(command).not.toMatch(/\s\+\S*:/);
  }
}

const rejected = async (input: OnboardingPrInput): Promise<ApplicationFailure> => {
  const err = await openOnboardingPr(input).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApplicationFailure);
  return err as ApplicationFailure;
};

describe('openOnboardingPr', () => {
  const onboardingFiles: OnboardingRequest['files'] = [
    { kind: 'setup', setup: { steps: [{ name: 'install', run: 'npm ci' }] } },
    { gateCommands: { runTests: 'npm test' }, kind: 'gates' },
    {
      kind: 'preview',
      previewConfig: {
        baseUrl: 'http://localhost:3000',
        readyTimeoutMs: 180000,
        readyUrl: 'http://localhost:3000/',
        start: 'npm start',
      },
    },
  ];
  const newRendered = renderOnboardingFiles({ files: onboardingFiles });
  const newInput = { ...INPUT, contentHash: contentHashOf(newRendered), files: onboardingFiles };

  it('hashes, guards and opens one PR containing the new configuration files', async () => {
    diffFiles = newRendered;
    const result = await openOnboardingPr(newInput);
    expect(result.changed).toEqual(newRendered.map((file) => file.path));
    expect(written).toEqual(
      Object.fromEntries(newRendered.map((file) => [file.path, file.content]))
    );
    expect(m.createWorkspace.mock.calls[0]?.[1]).toBe(`auto/onboard-${hashOf(newRendered)}`);
    expect(m.createPr.mock.calls[0]?.[0].body).toContain(
      'take effect unless a connection override wins'
    );
    expect(m.createPr.mock.calls[0]?.[0].body).not.toContain('does not enable anything');
    expect(destroyed).toBe(1);
  });

  it('includes every new kind in the hash, independent of rendered file order', () => {
    expect(contentHashOf(newRendered)).toBe(hashOf(newRendered));
    expect(contentHashOf([...newRendered].reverse())).toBe(contentHashOf(newRendered));
    for (const file of newRendered) {
      expect(
        contentHashOf(
          newRendered.map((entry) =>
            entry === file ? { ...entry, content: `${entry.content}\n` } : entry
          )
        )
      ).not.toBe(contentHashOf(newRendered));
    }
  });

  it.each(['.auto-swe/setup.yml', '.auto-swe/gates.yml', '.auto-swe/preview.yml'])(
    'rejects a nonregular new file: %s',
    async (path) => {
      lsTree = `120000 blob ${'a'.repeat(40)}\t${path}\n`;
      const error = await rejected(newInput);
      expect(error.type).toBe('ONBOARDING_PR_REFUSED');
      expect(m.createPr).not.toHaveBeenCalled();
    }
  );

  it('rejects extra paths in a new-kind delivery diff', async () => {
    diffFiles = newRendered;
    diffOverride = `${newRendered.map((file) => `A\t${file.path}`).join('\n')}\nA\tsrc/extra.ts`;
    expect((await rejected(newInput)).type).toBe('ONBOARDING_PR_REFUSED');
    expect(m.createPr).not.toHaveBeenCalled();
  });

  it('rejects an unexpected path on a pre-existing new-kind branch', async () => {
    m.findBranchWork.mockResolvedValue({
      aheadBy: 1,
      branchExists: true,
      openPr: { prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' },
    });
    m.compareCommits.mockResolvedValue(
      comparison([...newRendered.map((file) => ({ path: file.path })), { path: 'src/extra.ts' }])
    );
    expect((await rejected(newInput)).type).toBe('ONBOARDING_PR_REFUSED');
    expect(m.createWorkspace).not.toHaveBeenCalled();
  });

  it('keeps legacy tools and policy wording scoped when mixed with active configuration', () => {
    const body = onboardingPrBody([
      '.auto-swe/tools.yml',
      '.auto-swe/pr-policy.yml',
      '.auto-swe/setup.yml',
    ]);
    expect(body).toContain('take effect unless a connection override wins');
    expect(body).toContain('For tools and pull request policy configuration:');
    expect(body).toContain('does not enable anything');
    expect(body).toContain('toolsFileEnabled');
  });
  it('opens a pull request for new files and removes the workspace', async () => {
    const result = await openOnboardingPr(INPUT);
    expect(result).toEqual({
      changed: RENDERED.map((f) => f.path),
      pullRequestNumber: 7,
      pullRequestUrl: 'https://github.com/acme/api/pull/7',
      skipped: [],
      status: 'opened',
    });
    expect(written).toEqual(Object.fromEntries(RENDERED.map((f) => [f.path, f.content])));
    const args = m.createWorkspace.mock.calls[0] as unknown[];
    expect(args[1]).toBe(`auto/onboard-${INPUT.contentHash}`);
    expect(args[2]).toBe('main');
    expect(args[5]).toBe(false);
    expect(args[6]).toEqual({ teamId: 'team-1' });
    expect(commands.some((c) => c.includes('commit') && c.includes('chore: add auto-swe'))).toBe(
      true
    );
    expect(destroyed).toBe(1);
    expect(m.persist).toHaveBeenCalledTimes(1);
  });

  it('skips a file whose content is already identical', async () => {
    base[RENDERED[0]?.path ?? ''] = RENDERED[0]?.content ?? '';
    const result = await openOnboardingPr(INPUT);
    expect(result.skipped).toEqual([RENDERED[0]?.path]);
    expect(result.changed).toEqual([RENDERED[1]?.path]);
    expect(Object.keys(written)).toEqual([RENDERED[1]?.path]);
  });

  it('changes a differing existing file on the branch only', async () => {
    base[RENDERED[0]?.path ?? ''] = 'version: 1\ntools: []\n';
    const result = await openOnboardingPr(INPUT);
    expect(result.changed).toContain(RENDERED[0]?.path);
    const pushes = commands.filter((c) => c.startsWith('AUTHED push'));
    expect(pushes).toHaveLength(1);
    expectOnlyAPlainPushOfTheBranch(pushes[0] ?? '');
  });

  it('returns nothing_to_do without pushing or opening anything', async () => {
    for (const f of RENDERED) {
      base[f.path] = f.content;
    }
    const result = await openOnboardingPr(INPUT);
    expect(result).toEqual({
      changed: [],
      skipped: RENDERED.map((f) => f.path),
      status: 'nothing_to_do',
    });
    expect(commands.filter((c) => c.startsWith('AUTHED push'))).toEqual([]);
    expect(commands).toContain("AUTHED fetch --no-tags origin 'refs/heads/main'");
    expect(m.createPr).not.toHaveBeenCalled();
    expect(destroyed).toBe(1);
  });

  it('builds on an existing remote branch and never force-pushes', async () => {
    m.findBranchWork.mockResolvedValue({
      aheadBy: 1,
      branchExists: true,
      openPr: { prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' },
    });
    const result = await openOnboardingPr(INPUT);
    expect((m.createWorkspace.mock.calls[0] as unknown[])[5]).toBe(true);
    expect(result.status).toBe('updated');
    expectOnlyAPlainPushOfTheBranch(commands.find((c) => c.startsWith('AUTHED push')) ?? '');
  });

  describe('an existing onboarding branch', () => {
    const OPEN = { prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' };
    const existing = (openPr: typeof OPEN | null = OPEN) =>
      m.findBranchWork.mockResolvedValue({ aheadBy: 1, branchExists: true, openPr });

    it('refuses, before cloning, a branch that touches a path outside the repository config', async () => {
      existing();
      m.compareCommits.mockResolvedValue(
        comparison([{ path: '.auto-swe/tools.yml' }, { path: '.github/workflows/ci.yml' }])
      );
      const err = await rejected(INPUT);
      expect(err.nonRetryable).toBe(true);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(err.message).toContain('.github/workflows/ci.yml');
      expect(err.message).not.toContain('SECRET-TOKEN');
      expect(m.createWorkspace).not.toHaveBeenCalled();
      expect(m.createPr).not.toHaveBeenCalled();
    });

    it('refuses a branch that deletes the other fixed path', async () => {
      existing();
      m.compareCommits.mockResolvedValue(
        comparison([
          { path: '.auto-swe/tools.yml' },
          { path: '.auto-swe/pr-policy.yml', status: 'removed' },
        ])
      );
      const err = await rejected(TOOLS_ONLY_INPUT);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(m.createWorkspace).not.toHaveBeenCalled();
    });

    it('refuses a branch that renames a file into a fixed path', async () => {
      existing();
      m.compareCommits.mockResolvedValue(
        comparison([
          { path: '.auto-swe/tools.yml', previousPath: '.auto-swe/old.yml', status: 'renamed' },
        ])
      );
      const err = await rejected(TOOLS_ONLY_INPUT);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(m.createWorkspace).not.toHaveBeenCalled();
    });

    it('refuses a branch that changes a fixed path this request did not ask for', async () => {
      existing();
      m.compareCommits.mockResolvedValue(
        comparison([{ path: '.auto-swe/tools.yml' }, { path: '.auto-swe/pr-policy.yml' }])
      );
      const err = await rejected(TOOLS_ONLY_INPUT);
      expect(err.message).toContain('.auto-swe/pr-policy.yml');
      expect(m.createWorkspace).not.toHaveBeenCalled();
    });

    it('accepts a branch that modifies the requested path', async () => {
      existing();
      diffFiles = TOOLS_ONLY;
      m.compareCommits.mockResolvedValue(
        comparison([{ path: '.auto-swe/tools.yml', status: 'modified' }])
      );
      await expect(openOnboardingPr(TOOLS_ONLY_INPUT)).resolves.toMatchObject({
        status: 'updated',
      });
    });

    it('refuses, before pushing, when the post-commit diff lists an unexpected path', async () => {
      existing();
      diffOverride = `A\t.auto-swe/tools.yml\nA\t.auto-swe/pr-policy.yml\nA\t.github/workflows/ci.yml`;
      const err = await rejected(INPUT);
      expect(err.nonRetryable).toBe(true);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(commands.filter((c) => c.startsWith('AUTHED push'))).toEqual([]);
      expect(m.createPr).not.toHaveBeenCalled();
    });

    it.each([
      ['a deletion', 'D\t.auto-swe/pr-policy.yml'],
      ['a rename', 'R100\t.auto-swe/old.yml\t.auto-swe/pr-policy.yml'],
    ])('refuses, before pushing, when the post-commit diff holds %s', async (_n, line) => {
      existing();
      diffOverride = `A\t.auto-swe/tools.yml\n${line}`;
      const err = await rejected(INPUT);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(commands.filter((c) => c.startsWith('AUTHED push'))).toEqual([]);
    });

    it("updates the reused pull request's title and body to the platform's", async () => {
      existing();
      await openOnboardingPr(INPUT);
      const call = m.createPr.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(call.reuseExisting).toBe(true);
      expect(call.updateExisting).toBe(true);
      expect(call.title).toBe('chore: add auto-swe repository configuration');
      expect(call.body).toBe(onboardingPrBody(RENDERED.map((f) => f.path)));
    });

    it('refuses a branch whose changed-file list the host truncated', async () => {
      existing();
      m.compareCommits.mockResolvedValue({
        aheadBy: 400,
        behindBy: 0,
        files: null,
        paths: null,
        status: 'ahead',
      });
      expect((await rejected(INPUT)).type).toBe('ONBOARDING_PR_REFUSED');
      expect(m.createWorkspace).not.toHaveBeenCalled();
    });

    it('refuses a branch whose pull request was closed or merged, naming the branch', async () => {
      existing(null);
      const err = await rejected(INPUT);
      expect(err.nonRetryable).toBe(true);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(err.message).toContain(`auto/onboard-${INPUT.contentHash}`);
      expect(err.message).toMatch(/delete the branch/i);
      expect(m.createWorkspace).not.toHaveBeenCalled();
      expect(m.createPr).not.toHaveBeenCalled();
    });

    it('does not vet a branch that does not exist yet', async () => {
      await openOnboardingPr(INPUT);
      expect(m.compareCommits).not.toHaveBeenCalled();
    });

    it('returns the open pull request with nothing_to_do when it already carries the content', async () => {
      existing();
      head = Object.fromEntries(RENDERED.map((f) => [f.path, f.content]));
      const result = await openOnboardingPr(INPUT);
      expect(result.status).toBe('nothing_to_do');
      expect(result.pullRequestNumber).toBe(7);
      expect(result.pullRequestUrl).toBe('https://github.com/acme/api/pull/7');
      expect(commands.filter((c) => c.startsWith('AUTHED push'))).toEqual([]);
      expect(m.createPr).not.toHaveBeenCalled();
    });

    it('judges identical against the default branch, not the branch tip', async () => {
      existing();
      // The branch already holds the rendered files, the default branch does not: a merge would
      // still change the repository, so nothing is "already identical".
      head = Object.fromEntries(RENDERED.map((f) => [f.path, f.content]));
      const result = await openOnboardingPr(INPUT);
      expect(result.changed).toEqual(RENDERED.map((f) => f.path));
      expect(result.skipped).toEqual([]);
    });
  });

  it('nothing_to_do without an open pull request carries no pull request fields', async () => {
    for (const f of RENDERED) {
      base[f.path] = f.content;
    }
    const result = await openOnboardingPr(INPUT);
    expect(result).not.toHaveProperty('pullRequestUrl');
    expect(result).not.toHaveProperty('pullRequestNumber');
  });

  it('refuses a request that names a tool key twice, without retrying', async () => {
    const err = await rejected({
      ...INPUT,
      files: [{ kind: 'tools', tools: [{ key: 'jq' }, { key: 'jq', version: '1.7.1' }] }],
    });
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe('ONBOARDING_PR_REFUSED');
    expect(m.connection).not.toHaveBeenCalled();
  });

  describe('the layout of .auto-swe in the repository', () => {
    const entry = (mode: string, type: string, path: string) =>
      `${mode} ${type} ${'b'.repeat(40)}\t${path}`;

    it.each([
      ['.auto-swe is a symlink', entry('120000', 'blob', '.auto-swe')],
      ['.auto-swe is a regular file', entry('100644', 'blob', '.auto-swe')],
      ['.auto-swe is a submodule', entry('160000', 'commit', '.auto-swe')],
      [
        'tools.yml is a symlink',
        [entry('040000', 'tree', '.auto-swe'), entry('120000', 'blob', '.auto-swe/tools.yml')].join(
          '\n'
        ),
      ],
      [
        'pr-policy.yml is a directory',
        [
          entry('040000', 'tree', '.auto-swe'),
          entry('040000', 'tree', '.auto-swe/pr-policy.yml'),
        ].join('\n'),
      ],
    ])('refuses when %s, writing nothing', async (_name, listing) => {
      lsTree = listing;
      const err = await rejected(INPUT);
      expect(err.nonRetryable).toBe(true);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(written).toEqual({});
      expect(commands.filter((c) => c.startsWith('AUTHED push'))).toEqual([]);
      expect(destroyed).toBe(1);
    });

    it('refuses when .auto-swe is a symlink on disk', async () => {
      dirIsSymlink = true;
      const err = await rejected(INPUT);
      expect(err.type).toBe('ONBOARDING_PR_REFUSED');
      expect(written).toEqual({});
    });

    it('accepts a directory and regular files, and stages with -f', async () => {
      lsTree = [
        entry('040000', 'tree', '.auto-swe'),
        entry('100644', 'blob', '.auto-swe/tools.yml'),
        entry('100755', 'blob', '.auto-swe/pr-policy.yml'),
      ].join('\n');
      base['.auto-swe/tools.yml'] = 'version: 1\ntools: []\n';
      await expect(openOnboardingPr(INPUT)).resolves.toMatchObject({ status: 'opened' });
      const add = commands.find((c) => / add /.test(c)) ?? '';
      expect(add).toMatch(/ add -f -- /);
    });
  });

  it('opens a normal pull request that says merging enables nothing', async () => {
    await openOnboardingPr(INPUT);
    const call = m.createPr.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.draft).toBeUndefined();
    expect(call.baseBranch).toBe('main');
    expect(call.title).toBe('chore: add auto-swe repository configuration');
    const body = String(call.body);
    expect(body).toContain('does not enable anything');
    expect(body).toContain('toolsFileEnabled');
    expect(body).toContain('A person reviews and merges');
    expect(body).not.toContain('user-1');
    expect(onboardingPrBody(['.auto-swe/tools.yml'])).toContain('.auto-swe/tools.yml');
  });

  it('computes the same 16-hex content hash as the gateway (shared known vector)', () => {
    expect(contentHashOf([{ content: 'b', path: 'a' }])).toBe('59b271ae1bbcb1d3');
    expect(INPUT.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses an 8-hex content hash even when it matches the content prefix', async () => {
    const err = await rejected({ ...INPUT, contentHash: INPUT.contentHash.slice(0, 8) });
    expect(err.type).toBe('ONBOARDING_PR_REFUSED');
    expect(m.createWorkspace).not.toHaveBeenCalled();
  });

  it('refuses content that does not match its hash, before touching the repository', async () => {
    const err = await rejected({ ...INPUT, contentHash: '0000000000000000' });
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe('ONBOARDING_PR_REFUSED');
    expect(m.createWorkspace).not.toHaveBeenCalled();
    expect(m.connection).not.toHaveBeenCalled();
  });

  it('refuses an invalid request', async () => {
    const err = await rejected({ ...INPUT, files: [] });
    expect(err.type).toBe('ONBOARDING_PR_REFUSED');
  });

  it('refuses a host that is not approved', async () => {
    m.hostsAllowed.mockResolvedValue({ ok: false, url: 'https://evil.example' });
    const err = await rejected(INPUT);
    expect(err.nonRetryable).toBe(true);
    expect(err.message).not.toContain('evil.example');
    expect(m.createWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a connection that is not a git repository, or is inactive', async () => {
    m.connection.mockResolvedValueOnce({ id: 'c', isActive: true, type: 'mcp' });
    expect((await rejected(INPUT)).type).toBe('ONBOARDING_PR_REFUSED');
    m.connection.mockResolvedValueOnce({ id: 'c', isActive: false, type: 'git_repo' });
    expect((await rejected(INPUT)).type).toBe('ONBOARDING_PR_REFUSED');
    m.connection.mockResolvedValueOnce(null);
    expect((await rejected(INPUT)).type).toBe('ONBOARDING_PR_REFUSED');
    expect(m.createWorkspace).not.toHaveBeenCalled();
  });

  it('removes the workspace when the push fails and keeps the credential out of the error', async () => {
    failPush = true;
    const err = await openOnboardingPr(INPUT).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain('SECRET-TOKEN');
    expect(destroyed).toBe(1);
    expect(m.createPr).not.toHaveBeenCalled();
  });

  it('does not fail when the activity event cannot be recorded', async () => {
    m.persist.mockRejectedValue(new Error('no run context'));
    await expect(openOnboardingPr(INPUT)).resolves.toMatchObject({ status: 'opened' });
  });
});
