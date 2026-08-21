import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock, findManyMock, depFindFirstMock, depCreateMock, depUpdateMock } = vi.hoisted(
  () => ({
    depCreateMock: vi.fn(),
    depFindFirstMock: vi.fn(),
    depUpdateMock: vi.fn(),
    findManyMock: vi.fn(),
    findUniqueMock: vi.fn(),
  })
);
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findMany: findManyMock, findUnique: findUniqueMock },
    repoDependency: { create: depCreateMock, findFirst: depFindFirstMock, update: depUpdateMock },
  },
}));

const { resolveSettingMock } = vi.hoisted(() => ({ resolveSettingMock: vi.fn() }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: resolveSettingMock }));

const { scanSkillContentMock } = vi.hoisted(() => ({ scanSkillContentMock: vi.fn() }));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent: scanSkillContentMock }));

vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));

const { fakeSpec } = vi.hoisted(() => ({ fakeSpec: { agentKey: 'repoDependencyInferrer' } }));
const { resolveAgentSpecMock } = vi.hoisted(() => ({
  resolveAgentSpecMock: vi.fn().mockResolvedValue({ agentKey: 'repoDependencyInferrer' }),
}));
vi.mock('../lib/config/agentSpec.js', () => ({ resolveAgentSpec: resolveAgentSpecMock }));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({ orgId: 'org-1' }),
}));

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('./runAgent.js', () => ({ runAgent: runAgentMock }));

import { AgentTracer } from '../lib/agentTracer.js';
import { inferRepoDependencies } from './inferRepoDependencies.js';

const SUBJECT = {
  description: 'The subject repo',
  id: 'repo-subject',
  isActive: true,
  language: 'TypeScript',
  organizationName: 'acme',
  packageNames: ['@acme/subject'],
  repoName: 'subject',
  team: { orgId: 'org-1' },
  type: 'git_repo',
};

const CANDIDATE = {
  description: 'A candidate repo',
  id: 'repo-candidate',
  language: 'TypeScript',
  organizationName: 'acme',
  packageNames: ['@acme/candidate'],
  repoName: 'candidate',
};

function edge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    confidence: 0.6,
    kind: 'code',
    rationale: 'shares a package',
    toRepoId: CANDIDATE.id,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue(SUBJECT);
  findManyMock.mockResolvedValue([CANDIDATE]);
  resolveSettingMock.mockResolvedValue(0.9);
  scanSkillContentMock.mockResolvedValue({ safe: true, warnings: [] });
  resolveAgentSpecMock.mockResolvedValue(fakeSpec);
  depFindFirstMock.mockResolvedValue(null);
  depCreateMock.mockResolvedValue({ id: 'edge-1' });
  depUpdateMock.mockResolvedValue({ id: 'edge-1' });
});

describe('inferRepoDependencies', () => {
  it('writes a below-threshold edge as proposed', async () => {
    runAgentMock.mockResolvedValue({ object: { edges: [edge({ confidence: 0.6 })] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 1 });
    expect(depCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          confidence: 0.6,
          confirmedAt: undefined,
          fromRepoId: SUBJECT.id,
          kind: 'code',
          source: 'inferred',
          status: 'proposed',
          toRepoId: CANDIDATE.id,
        }),
      })
    );
  });

  it('auto-promotes an edge at/above the threshold, marking detail + confirmedAt', async () => {
    resolveSettingMock.mockResolvedValue(0.8);
    runAgentMock.mockResolvedValue({ object: { edges: [edge({ confidence: 0.95 })] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 1, proposed: 0 });
    const call = depCreateMock.mock.calls[0][0];
    expect(call.data.status).toBe('active');
    expect(call.data.confirmedAt).toBeInstanceOf(Date);
    expect(call.data.detail).toEqual({ autoPromoted: true, rationale: 'shares a package' });
  });

  it('drops an edge referencing a repo outside the candidate set (hallucinated)', async () => {
    runAgentMock.mockResolvedValue({
      object: { edges: [edge({ toRepoId: 'repo-not-a-candidate' })] },
    });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(depCreateMock).not.toHaveBeenCalled();
  });

  it('drops a self-edge', async () => {
    runAgentMock.mockResolvedValue({ object: { edges: [edge({ toRepoId: SUBJECT.id })] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(depCreateMock).not.toHaveBeenCalled();
  });

  it('drops an out-of-range confidence', async () => {
    runAgentMock.mockResolvedValue({
      object: { edges: [edge({ confidence: 1.4 }), edge({ confidence: -0.1 })] },
    });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(depCreateMock).not.toHaveBeenCalled();
  });

  it('drops an edge whose kind is not one of EDGE_KINDS', async () => {
    runAgentMock.mockResolvedValue({ object: { edges: [edge({ kind: 'made-up-kind' })] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(depCreateMock).not.toHaveBeenCalled();
  });

  it('never resurrects or overwrites a dismissed edge', async () => {
    depFindFirstMock.mockResolvedValue({ id: 'edge-existing', status: 'dismissed' });
    runAgentMock.mockResolvedValue({ object: { edges: [edge()] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(depCreateMock).not.toHaveBeenCalled();
    expect(depUpdateMock).not.toHaveBeenCalled();
  });

  it('is idempotent: re-running against an existing proposed edge refreshes it', async () => {
    depFindFirstMock.mockResolvedValue({ id: 'edge-existing', status: 'proposed' });
    runAgentMock.mockResolvedValue({ object: { edges: [edge({ confidence: 0.7 })] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(depCreateMock).not.toHaveBeenCalled();
    expect(depUpdateMock).toHaveBeenCalledWith({
      data: { confidence: 0.7, detail: { rationale: 'shares a package' } },
      where: { id: 'edge-existing' },
    });
  });

  it('never touches the status of an already-active (human-confirmed) inferred edge', async () => {
    depFindFirstMock.mockResolvedValue({ id: 'edge-existing', status: 'active' });
    runAgentMock.mockResolvedValue({ object: { edges: [edge({ confidence: 0.6 })] } });

    await inferRepoDependencies({ repoId: SUBJECT.id });

    const call = depUpdateMock.mock.calls[0][0];
    expect(call.data).not.toHaveProperty('status');
  });

  it('returns empty and never calls the agent when the repo has no org candidates', async () => {
    findManyMock.mockResolvedValue([]);

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 0 });
    expect(resolveAgentSpecMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('returns empty for a repo that is missing, inactive, or not a git_repo', async () => {
    findUniqueMock.mockResolvedValue(null);
    expect(await inferRepoDependencies({ repoId: 'nope' })).toEqual({
      autoPromoted: 0,
      proposed: 0,
    });

    findUniqueMock.mockResolvedValue({ ...SUBJECT, isActive: false });
    expect(await inferRepoDependencies({ repoId: SUBJECT.id })).toEqual({
      autoPromoted: 0,
      proposed: 0,
    });

    findUniqueMock.mockResolvedValue({ ...SUBJECT, type: 'mcp' });
    expect(await inferRepoDependencies({ repoId: SUBJECT.id })).toEqual({
      autoPromoted: 0,
      proposed: 0,
    });

    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('scopes the candidate query to the subject repo org (tenant filter)', async () => {
    runAgentMock.mockResolvedValue({ object: { edges: [] } });

    await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ team: { orgId: 'org-1' }, type: 'git_repo' }),
      })
    );
  });

  it('records an advisory event when the rationale scan flags suspicious content', async () => {
    scanSkillContentMock.mockResolvedValue({ safe: false, warnings: ['looks like exfiltration'] });
    runAgentMock.mockResolvedValue({ object: { edges: [edge()] } });
    const spy = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');

    await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'repoDependency.suspicious_inference',
        outputJson: { warnings: ['looks like exfiltration'] },
      })
    );
    spy.mockRestore();
  });

  it('never fails the activity when the rationale scan itself throws', async () => {
    scanSkillContentMock.mockRejectedValue(new Error('scanner db down'));
    runAgentMock.mockResolvedValue({ object: { edges: [edge()] } });

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 1 });
  });

  it('caps the number of accepted edges', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      edge({ confidence: 0.5, rationale: `r${i}`, toRepoId: CANDIDATE.id })
    );
    runAgentMock.mockResolvedValue({ object: { edges: many } });
    // Every accepted edge resolves against the same candidate + natural key, so
    // each iteration's findFirst must keep returning null to be counted as new.
    depFindFirstMock.mockResolvedValue(null);

    const result = await inferRepoDependencies({ repoId: SUBJECT.id });

    expect(result).toEqual({ autoPromoted: 0, proposed: 20 });
    expect(depCreateMock).toHaveBeenCalledTimes(20);
  });
});
