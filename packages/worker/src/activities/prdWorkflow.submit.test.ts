import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  create: vi.fn(async (_args: unknown) => ({})),
  start: vi.fn(async (_name: string, _opts: unknown) => ({})),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: {
      findMany: vi.fn(async () => [
        { githubUrl: null, id: 'repo-1', organizationName: 'acme', repoName: 'api', teamId: 't' },
      ]),
    },
    runInput: {
      create: m.create,
      findUniqueOrThrow: vi.fn(async () => ({
        requestPayload: JSON.stringify({ repoIds: ['repo-1'] }),
      })),
    },
  },
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_why: string, _models: string[], fn: () => unknown) => fn(),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: false })),
}));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/runLauncher.js', () => ({ currentRunLauncherId: vi.fn(async () => null) }));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { start: m.start } }),
}));
vi.mock('../lib/workflowIdAllocation.js', () => ({
  allocateTicketWorkflowId: vi.fn(async () => ({ workflowId: 'wf-story' })),
}));
vi.mock('./templates.js', () => ({
  resolveTemplateForRepo: vi.fn(async () => ({ templateId: 'tpl-1', templateVersion: 1 })),
}));
vi.mock('../lib/config/agentSpec.js', () => ({ resolveAgentSpec: vi.fn() }));
vi.mock('../lib/config/contextLookup.js', () => ({ currentRequestContext: vi.fn() }));
vi.mock('../lib/execUtils.js', () => ({ withHeartbeat: vi.fn() }));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { submitPrdWorkRequests } from './prdWorkflow.js';

const story = (title: string) => ({ acceptanceCriteria: [], description: title, title });

const created = () =>
  m.create.mock.calls.map(
    ([args]) => (args as { data: { externalTicketId: string; ticketIsSynthetic: boolean } }).data
  );

describe('submitPrdWorkRequests ticket ids', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags a generated PRD-<ts>-<n> id as synthetic and a tracker-assigned id as not', async () => {
    await submitPrdWorkRequests({ workRequestId: 'prd-1' } as never, {
      decomposition: {
        epics: [{ description: 'e', stories: [story('Tracked'), story('Untracked')], title: 'E' }],
        rationale: '',
      },
      trackerItems: {
        createdItems: [{ id: 'PROJ-12', title: 'Tracked', type: 'story', url: null }],
        failedCount: 0,
      },
    });

    const rows = created();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ externalTicketId: 'PROJ-12', ticketIsSynthetic: false });
    expect(rows[1]).toMatchObject({
      externalTicketId: expect.stringMatching(/^PRD-\d+-2$/),
      ticketIsSynthetic: true,
    });
  });
});
