import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  ensure: vi.fn(),
  execution: { id: 'execution-1' },
  prisma: {
    connection: { findUnique: vi.fn() },
    knowledgeBase: { findMany: vi.fn() },
    knowledgeBaseLink: { findMany: vi.fn() },
    knowledgeBaseSnapshot: { findMany: vi.fn() },
    team: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
  },
  resolveRef: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: mocks.prisma }));
vi.mock('./activityContext.js', () => ({
  currentTemporalRunId: () => mocks.execution.id,
  currentWorkflowId: () => 'workflow',
}));
vi.mock('./activityLog.js', () => ({ logWarn: mocks.warn }));
vi.mock('./config/contextLookup.js', () => ({ currentRequestContext: async () => ({}) }));
vi.mock('./knowledgeBaseIndex.js', () => ({ ensureKnowledgeBaseSnapshot: mocks.ensure }));
vi.mock('./scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: mocks.credentials,
    defaultBranch: async () => 'main',
    resolveRef: mocks.resolveRef,
  }),
  toRepoRef: (row: unknown) => row,
}));

import { loadRunKnowledgeBases, RunKnowledgeBasePinSchema } from './runKnowledgeBases.js';

const sha = 'a'.repeat(40);
const base = (id: string, extra: Record<string, unknown> = {}) => ({
  connection: {
    defaultBranch: 'main',
    id: `connection-${id}`,
    installation: null,
    isActive: true,
    organizationName: 'owner',
    repoName: id,
    team: { orgId: 'org' },
    teamId: 'team',
    type: 'git_repo',
  },
  connectionId: `connection-${id}`,
  defaultRef: null,
  id,
  mountName: `mount-${id}`,
  orgId: 'org',
  path: 'docs',
  shares: [],
  status: 'OK',
  visibility: 'TEAM',
  ...extra,
});
const link = (id: string, scope = 'TEAM', extra: Record<string, unknown> = {}) => ({
  exclude: false,
  knowledgeBaseId: id,
  mandatory: false,
  mountName: null,
  ref: null,
  scope,
  ...extra,
});
let bases: ReturnType<typeof base>[];
let links: ReturnType<typeof link>[];
let snapshots: Array<{
  id: string;
  knowledgeBaseId: string;
  sha: string;
  path: string;
  flaggedFiles: unknown[];
}>;
let run: {
  id: string;
  connectionId: string;
  templateId: string;
  knowledgeSourceTeamId: string;
  knowledgeSourceOrgId: string;
  knowledgeBases: unknown;
  knowledgeBasesFor: string | null;
  knowledgeBaseOverrides: unknown;
};

function matches(value: unknown, where: unknown): boolean {
  if (where === null || typeof where !== 'object') {
    return value === where;
  }
  const row = value as Record<string, unknown>;
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') {
      return (expected as unknown[]).some((part) => matches(value, part));
    }
    if (key === 'in') {
      return (expected as unknown[]).includes(value);
    }
    if (key === 'some') {
      return Array.isArray(value) && value.some((item) => matches(item, expected));
    }
    return row != null && matches(row[key], expected);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.execution.id = 'execution-1';
  bases = [base('one')];
  links = [link('one')];
  snapshots = [];
  run = {
    connectionId: 'repo',
    id: 'run',
    knowledgeBaseOverrides: null,
    knowledgeBases: null,
    knowledgeBasesFor: null,
    knowledgeSourceOrgId: 'org',
    knowledgeSourceTeamId: 'team',
    templateId: 'global-template',
  };
  mocks.prisma.workflowRun.findUnique.mockImplementation(async () => run);
  mocks.prisma.workflowRun.findUniqueOrThrow.mockImplementation(async () => run);
  mocks.prisma.workflowRun.updateMany.mockImplementation(async ({ data }) => {
    Object.assign(run, data);
    return { count: 1 };
  });
  mocks.prisma.connection.findUnique.mockResolvedValue({ teamId: 'team' });
  mocks.prisma.team.findUnique.mockResolvedValue({ orgId: 'org' });
  mocks.prisma.knowledgeBaseLink.findMany.mockImplementation(async () => links);
  mocks.prisma.knowledgeBase.findMany.mockImplementation(async ({ where }) =>
    bases.filter((kb) => matches(kb, where))
  );
  mocks.prisma.knowledgeBaseSnapshot.findMany.mockImplementation(async ({ where }) =>
    snapshots.filter((snapshot) => where.id.in.includes(snapshot.id))
  );
  mocks.resolveRef.mockResolvedValue(sha);
  mocks.credentials.mockResolvedValue({ authedCloneUrl: 'https://x:secret@host/repo.git' });
  mocks.ensure.mockImplementation(async (id, resolvedSha) => {
    const snapshot = {
      flaggedFiles: [{ path: 'docs/bad.md', reason: 'injection' }],
      id: `snapshot-${id}`,
      knowledgeBaseId: id,
      path: 'docs',
      sha: resolvedSha,
    };
    snapshots.push(snapshot);
    return snapshot;
  });
});

describe('run knowledge base resolution', () => {
  it('combines all scopes, pins sources and dropped entries, and returns ephemeral credentials', async () => {
    bases = ['one', 'two', 'three', 'four', 'five'].map((id) => base(id));
    links = [
      link('one', 'TEAM', { mandatory: true }),
      link('two', 'REPO'),
      link('three', 'TEMPLATE', { mountName: 'reference', ref: 'v1' }),
      link('five'),
    ];
    run.knowledgeBaseOverrides = { add: [{ knowledgeBaseId: 'four' }], exclude: ['one'] };
    const result = await loadRunKnowledgeBases();
    expect(result.snapshotIds).toEqual([
      'snapshot-one',
      'snapshot-four',
      'snapshot-three',
      'snapshot-two',
    ]);
    const pin = RunKnowledgeBasePinSchema.parse(run.knowledgeBases);
    expect(pin.selected.map((kb) => kb.source)).toEqual(['TEAM', 'RUN', 'TEMPLATE', 'REPO']);
    expect(pin.dropped[0].knowledgeBaseId).toBe('five');
    expect(pin.refusedExclusions).toEqual(['one']);
    expect(JSON.stringify(pin)).not.toContain('secret');
    expect(run.knowledgeBasesFor).toBe('execution-1');
    expect(result.checkouts[2]).toMatchObject({
      flaggedFiles: ['docs/bad.md'],
      mountName: 'reference',
      path: 'docs',
      sha,
    });
    expect(mocks.resolveRef.mock.calls.map((call) => call[1])).toEqual([
      'main',
      'main',
      'v1',
      'main',
    ]);
    expect(mocks.prisma.knowledgeBaseLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { scope: 'TEAM', teamId: 'team' },
            { repoId: 'repo', scope: 'REPO' },
            { scope: 'TEMPLATE', templateId: 'global-template' },
          ],
        }),
      })
    );
    expect(mocks.prisma.workflowRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'run',
          OR: [
            expect.objectContaining({ knowledgeBases: expect.anything() }),
            { knowledgeBasesFor: { not: 'execution-1' } },
          ],
        },
      })
    );
  });

  it('filters owner/shared/ORG attachability, inactive connections and cross-org sources before capping', async () => {
    const foreign = { ...base('shared').connection, teamId: 'other' };
    bases = [
      base('one'),
      base('shared', { connection: foreign, shares: [{ teamId: 'team' }], visibility: 'SHARED' }),
      base('org', { connection: foreign, visibility: 'ORG' }),
      base('private', { connection: foreign }),
      base('unshared', { connection: foreign, visibility: 'SHARED' }),
      base('inactive', { connection: { ...foreign, isActive: false }, visibility: 'ORG' }),
      base('disabled', { status: 'DISABLED' }),
      base('cross-org', { orgId: 'another' }),
      base('moved', { connection: { ...foreign, team: { orgId: 'another' } }, visibility: 'ORG' }),
    ];
    links = bases.map((kb) => link(kb.id));
    run.knowledgeBaseOverrides = { add: [{ knowledgeBaseId: 'private' }] };
    expect((await loadRunKnowledgeBases()).snapshotIds.sort()).toEqual([
      'snapshot-one',
      'snapshot-org',
      'snapshot-shared',
    ]);
    expect(RunKnowledgeBasePinSchema.parse(run.knowledgeBases).dropped).toEqual([]);
  });

  it('reuses the execution pin on retries even after refs, links and KB paths change', async () => {
    await loadRunKnowledgeBases();
    bases[0].path = 'changed';
    links = [];
    mocks.resolveRef.mockResolvedValue('b'.repeat(40));
    const result = await loadRunKnowledgeBases();
    expect(result.checkouts[0]).toMatchObject({ path: 'docs', sha });
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.workflowRun.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.credentials).toHaveBeenCalledTimes(2);
  });

  it('rechecks access on a later resolution without replacing the pin', async () => {
    await loadRunKnowledgeBases();
    bases[0].status = 'DISABLED';
    expect(await loadRunKnowledgeBases()).toEqual({ checkouts: [], snapshotIds: [] });
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
  });

  it('repins for a new Temporal execution', async () => {
    await loadRunKnowledgeBases();
    mocks.execution.id = 'execution-2';
    await loadRunKnowledgeBases();
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(run.knowledgeBasesFor).toBe('execution-2');
  });

  it('uses the compare-and-set winner when another activity pinned first', async () => {
    mocks.prisma.workflowRun.updateMany.mockImplementation(async ({ data }) => {
      run.knowledgeBases = { ...data.knowledgeBases, selected: [] };
      return { count: 0 };
    });
    expect(await loadRunKnowledgeBases()).toEqual({ checkouts: [], snapshotIds: [] });
  });

  it('resolves without pinning when no WorkflowRun row exists', async () => {
    mocks.prisma.workflowRun.findUnique.mockResolvedValue(null);
    expect(
      (await loadRunKnowledgeBases({ repoId: 'repo', templateId: 'global-template' })).snapshotIds
    ).toEqual(['snapshot-one']);
    expect(mocks.prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it('can return pinned snapshot ids for search without minting clone credentials', async () => {
    await loadRunKnowledgeBases();
    mocks.credentials.mockClear();
    expect(await loadRunKnowledgeBases({ checkoutCredentials: false })).toEqual({
      checkouts: [],
      snapshotIds: ['snapshot-one'],
    });
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it('does no resolution or pin reads when the step flag is off', async () => {
    expect(await loadRunKnowledgeBases({ knowledgeBases: false })).toEqual({
      checkouts: [],
      snapshotIds: [],
    });
    expect(mocks.prisma.workflowRun.findUnique).not.toHaveBeenCalled();
  });

  it('pins an empty set when there are no attachments', async () => {
    links = [];
    expect((await loadRunKnowledgeBases()).snapshotIds).toEqual([]);
    expect(RunKnowledgeBasePinSchema.parse(run.knowledgeBases).selected).toEqual([]);
  });

  it.each(['database', 'ref', 'index', 'credential', 'pin'])(
    'fails open with a fixed warning on %s errors',
    async (failure) => {
      if (failure === 'database') {
        mocks.prisma.knowledgeBaseLink.findMany.mockRejectedValue(new Error('secret'));
      }
      if (failure === 'ref') {
        mocks.resolveRef.mockResolvedValue(null);
      }
      if (failure === 'index') {
        mocks.ensure.mockRejectedValue(new Error('secret'));
      }
      if (failure === 'credential') {
        mocks.credentials.mockRejectedValue(new Error('secret'));
      }
      if (failure === 'pin') {
        mocks.prisma.workflowRun.updateMany.mockRejectedValue(new Error('secret'));
      }
      expect(await loadRunKnowledgeBases()).toEqual({ checkouts: [], snapshotIds: [] });
      expect(mocks.warn).toHaveBeenCalledWith(
        'knowledge base resolution failed; continuing without reference material'
      );
    }
  );

  it('does not reinterpret corrupt pins as permission to resolve a different set', async () => {
    run.knowledgeBases = { selected: 'invalid' };
    run.knowledgeBasesFor = mocks.execution.id;
    expect(await loadRunKnowledgeBases()).toEqual({ checkouts: [], snapshotIds: [] });
    expect(mocks.resolveRef).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
});
