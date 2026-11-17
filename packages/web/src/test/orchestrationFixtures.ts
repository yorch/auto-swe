import type {
  OrchestrationChildDto,
  OrchestrationDetailDto,
  OrchestrationMessageDto,
} from '@auto-swe/shared/lib/orchestrationApi';

export function child(overrides: Partial<OrchestrationChildDto> = {}): OrchestrationChildDto {
  return {
    agentKey: 'researcher',
    branch: null,
    costUsd: 0.42,
    createdAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    id: 'ch1',
    label: 'Find callers',
    pathScopes: [],
    prUrl: null,
    result: null,
    role: 'READER',
    runId: null,
    status: 'RUNNING',
    undeliveredSteering: 0,
    workRequestId: 'wr-ch1',
    ...overrides,
  };
}

export function detail(overrides: Partial<OrchestrationDetailDto> = {}): OrchestrationDetailDto {
  return {
    allowlist: ['researcher'],
    budgetTier: 'STANDARD',
    canControl: true,
    childCount: 1,
    children: [child()],
    connections: [],
    cost: { childrenUsd: 0.42, orchestratorUsd: 0.1, totalUsd: 0.52 },
    costUsd: 0.52,
    createdAt: '2026-01-01T00:00:00Z',
    id: 'o1',
    launchedById: 'u1',
    launchedByName: 'Ada',
    pendingApprovals: [],
    pendingAttach: null,
    repoAttachedAt: null,
    repoId: null,
    repoName: null,
    runningChildCount: 1,
    status: 'ACTIVE',
    teamId: 't1',
    teamName: 'Payments',
    title: 'Fix checkout',
    updatedAt: '2026-01-01T00:05:00Z',
    ...overrides,
  };
}

export function message(overrides: Partial<OrchestrationMessageDto> = {}): OrchestrationMessageDto {
  return {
    authorId: null,
    body: 'hello',
    childId: null,
    createdAt: '2026-01-01T00:00:01Z',
    id: 'm1',
    kind: 'TEXT',
    payload: null,
    role: 'ORCHESTRATOR',
    ...overrides,
  };
}
