import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../plugins/auth.js';
import { authorizeLaunch } from './launchAuthorization.js';
import { retryTemplateRequest } from './retryTemplateRequest.js';
import { validateRunConnection } from './runConnection.js';

vi.mock('./runConnection.js', () => ({ validateRunConnection: vi.fn() }));
vi.mock('./launchAuthorization.js', () => ({
  authorizeLaunch: vi.fn(),
  sendLaunchRefusal: (reply: { status: (code: number) => { send: (body: unknown) => unknown } }) =>
    reply.status(403).send({ error: { code: 'FORBIDDEN' } }),
}));
const input = {
  connectionId: null,
  description: 'Write the release notes',
  externalTicketId: 'NOTE-1',
  id: 'request-1',
  isCrossRepo: false,
  payload: { description: 'Write the release notes', pageId: 'page-1' },
  requestedById: 'original-requester',
  requestPayload: '{"label":"Release notes"}',
  templateId: 'template-1',
  templateVersion: 3,
};
async function harness(visible = true) {
  const app = Fastify();
  const prisma = {
    $transaction: vi.fn(async (writes: Promise<unknown>[]) => Promise.all(writes)),
    activeWorkflow: { create: vi.fn(async () => ({ id: 'ledger-1' })) },
    workflowRun: {
      findFirst: vi.fn(async (_query: unknown) => (visible ? { id: 'old-run' } : null)),
    },
    workflowTemplate: {
      findFirst: vi.fn(async () => ({ id: 'template-1', teamId: null, workspaceProvider: null })),
    },
  };
  const start = vi.fn(async () => {});
  app.decorate('prisma', prisma as never);
  app.decorate('temporal', { startRunnableWorkflow: start } as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'retry-caller' }),
  } as never);
  app.post('/retry', { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) }, (req, reply) =>
    retryTemplateRequest(app, req, reply, input as never, 'Include migration notes')
  );
  return { app, prisma, start };
}
const auth = { authorization: 'Bearer fake' };
beforeEach(() => {
  vi.mocked(validateRunConnection)
    .mockReset()
    .mockResolvedValue({ budgetCap: null, budgetOrgId: null, ok: true });
  vi.mocked(authorizeLaunch)
    .mockReset()
    .mockResolvedValue({ ok: true } as never);
});

describe('generic workflow retry', () => {
  it('retains the request and version, applies instructions only to the attempt, and acts as its caller', async () => {
    const { app, prisma, start } = await harness();
    const response = await app.inject({ headers: auth, method: 'POST', url: '/retry' });
    expect(response.statusCode).toBe(201);
    expect(start).toHaveBeenCalledWith(expect.stringMatching(/^wf-/), {
      request: expect.objectContaining({
        launchedById: 'retry-caller',
        payload: {
          description: expect.stringContaining('Include migration notes'),
          pageId: 'page-1',
        },
        workRequestId: input.id,
      }),
      templateId: input.templateId,
      templateVersion: 3,
    });
    expect(input.payload.description).toBe('Write the release notes');
    expect(prisma.activeWorkflow.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workRequestId: input.id }),
    });
    expect(prisma.workflowRun.findFirst.mock.calls[0][0]).toHaveProperty('where.AND');
    await app.close();
  });

  it('does not launch a request the caller cannot see', async () => {
    const { app, start } = await harness(false);
    expect((await app.inject({ headers: auth, method: 'POST', url: '/retry' })).statusCode).toBe(
      404
    );
    expect(validateRunConnection).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it('rechecks current connection access before launching', async () => {
    vi.mocked(validateRunConnection).mockImplementationOnce(async (_, reply) => {
      reply.status(403).send({ error: { code: 'FORBIDDEN' } });
      return { ok: false };
    });
    const { app, start } = await harness();
    expect((await app.inject({ headers: auth, method: 'POST', url: '/retry' })).statusCode).toBe(
      403
    );
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it('applies organization launch authorization to connection-free templates', async () => {
    const { app, prisma, start } = await harness();
    prisma.workflowTemplate.findFirst.mockResolvedValueOnce({
      id: 'template-1',
      team: { organization: { id: 'org-1', monthlyBudgetUsdCents: 100 } },
      teamId: 'team-1',
      workspaceProvider: null,
    } as never);
    vi.mocked(authorizeLaunch).mockResolvedValueOnce({ ok: false, refusal: {} } as never);
    expect((await app.inject({ headers: auth, method: 'POST', url: '/retry' })).statusCode).toBe(
      403
    );
    expect(authorizeLaunch).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ sub: 'retry-caller' }),
      expect.objectContaining({ orgs: [{ id: 'org-1', monthlyBudgetUsdCents: 100 }], repos: [] })
    );
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a template that is no longer active or visible to the caller, scoping the lookup like a fresh launch', async () => {
    const { app, prisma, start } = await harness();
    prisma.workflowTemplate.findFirst.mockResolvedValueOnce(null as never);
    const response = await app.inject({ headers: auth, method: 'POST', url: '/retry' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('TEMPLATE_NOT_FOUND');
    expect(prisma.workflowTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'template-1',
          OR: [{ teamId: null }, { team: expect.anything() }],
          status: 'ACTIVE',
        }),
      })
    );
    expect(validateRunConnection).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it('revalidates the run inputs against the template input schema', async () => {
    const { app, prisma, start } = await harness();
    prisma.workflowTemplate.findFirst.mockResolvedValueOnce({
      id: 'template-1',
      inputSchema: {
        properties: { pageId: { type: 'number' } },
        required: ['pageId'],
        type: 'object',
      },
      teamId: null,
      workspaceProvider: null,
    } as never);
    const response = await app.inject({ headers: auth, method: 'POST', url: '/retry' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_INPUT');
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it('launches when the inputs satisfy the input schema', async () => {
    const { app, prisma, start } = await harness();
    prisma.workflowTemplate.findFirst.mockResolvedValueOnce({
      id: 'template-1',
      inputSchema: {
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
        type: 'object',
      },
      teamId: null,
      workspaceProvider: null,
    } as never);
    expect((await app.inject({ headers: auth, method: 'POST', url: '/retry' })).statusCode).toBe(
      201
    );
    expect(start).toHaveBeenCalled();
    await app.close();
  });
});
