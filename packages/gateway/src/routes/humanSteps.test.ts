import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The route only uses `Prisma.DbNull` at runtime (rollback path); everything
// else from the barrel is type-only. Mocking the barrel avoids instantiating
// the real PrismaClient singleton (which requires DATABASE_URL at import).
const DB_NULL = vi.hoisted(() => ({ __sentinel: 'Prisma.DbNull' }));
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: DB_NULL } }));

import { humanStepRoutes } from './humanSteps.js';

const STEP_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = 'user-1';
const AUTH = { authorization: 'Bearer test-token' };

interface UpdateManyCall {
  data: Record<string, unknown>;
  where: Record<string, unknown>;
}

function pendingStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: { plan: 'do the thing' },
    description: 'Please approve the plan',
    fields: null,
    id: STEP_ID,
    kind: 'APPROVAL',
    nodeId: 'approveGate',
    options: null,
    requestedAt: new Date('2026-06-01T00:00:00Z'),
    run: {
      id: 'run-1',
      status: 'RUNNING',
      workflowId: 'eng-acme-repo-JIRA-1',
      workRequest: { description: 'Add endpoint', externalTicketId: 'JIRA-1' },
    },
    runId: 'run-1',
    signalName: 'hitl_approveGate',
    status: 'PENDING',
    title: 'Approve plan',
    ...overrides,
  };
}

describe('human step routes', () => {
  const app = Fastify();

  let listRows: Array<Record<string, unknown>> = [];
  let stepRow: Record<string, unknown> | null = null;
  let updateManyCount = 1;
  const updateManyCalls: UpdateManyCall[] = [];
  let signalError: Error | null = null;
  const signalCalls: Array<{ workflowId: string; signalName: string; args: unknown[] }> = [];

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) {
          throw new Error('No token');
        }
        return { exp: 9999999999, iat: 0, role: 'ENGINEER', sub: USER_ID };
      },
    } as unknown as never);

    app.decorate('prisma', {
      workflowHumanStep: {
        findFirst: async () => stepRow,
        findMany: async () => listRows,
        updateMany: async (args: UpdateManyCall) => {
          updateManyCalls.push(args);
          return { count: updateManyCount };
        },
      },
    } as unknown as never);

    app.decorate('temporal', {
      signalWorkflow: async (workflowId: string, signalName: string, args: unknown[]) => {
        if (signalError) {
          throw signalError;
        }
        signalCalls.push({ args, signalName, workflowId });
      },
    } as unknown as never);

    await app.register(humanStepRoutes, { prefix: '/api/v1/inbox' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    listRows = [];
    stepRow = null;
    updateManyCount = 1;
    updateManyCalls.length = 0;
    signalError = null;
    signalCalls.length = 0;
  });

  describe('GET /', () => {
    it('returns the pending steps visible to the user', async () => {
      listRows = [pendingStep()];
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/inbox' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: STEP_ID,
        kind: 'APPROVAL',
        nodeId: 'approveGate',
        runId: 'run-1',
        status: 'PENDING',
        title: 'Approve plan',
      });
      expect(body.data[0].run.workflowId).toBe('eng-acme-repo-JIRA-1');
      // signalName is intentionally not part of the list projection
      expect(body.data[0].signalName).toBeUndefined();
    });
  });

  describe('POST /:id/respond', () => {
    function respond(payload: Record<string, unknown>) {
      return app.inject({
        headers: AUTH,
        method: 'POST',
        payload,
        url: `/api/v1/inbox/${STEP_ID}/respond`,
      });
    }

    it('returns 404 when the step does not exist', async () => {
      stepRow = null;
      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('NOT_FOUND');
    });

    it('returns 400 INVALID_ACTION when the action is not valid for the kind', async () => {
      // 'select' belongs to DECISION steps, not APPROVAL.
      stepRow = pendingStep();
      const res = await respond({ action: 'select' });
      expect(res.statusCode).toBe(400);
      const { error } = JSON.parse(res.payload);
      expect(error.code).toBe('INVALID_ACTION');
      expect(error.message).toContain('approve or reject');
      expect(updateManyCalls).toHaveLength(0);
      expect(signalCalls).toHaveLength(0);
    });

    it('returns 400 UNKNOWN_KIND for an unrecognized step kind', async () => {
      stepRow = pendingStep({ kind: 'TELEPATHY' });
      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('UNKNOWN_KIND');
    });

    it('returns 409 when the step has already been resolved', async () => {
      stepRow = pendingStep({ status: 'RESOLVED' });
      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('ALREADY_RESOLVED');
    });

    it('returns 409 when the run is no longer running', async () => {
      stepRow = pendingStep({
        run: { status: 'COMPLETED', workflowId: 'eng-acme-repo-JIRA-1' },
      });
      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('RUN_NOT_RUNNING');
    });

    it('happy path: marks the row RESOLVED, signals the workflow, returns 200', async () => {
      stepRow = pendingStep();
      const res = await respond({ action: 'approve', value: { note: 'lgtm' } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({ id: STEP_ID, status: 'RESOLVED' });

      expect(updateManyCalls).toHaveLength(1);
      const resolveCall = updateManyCalls[0] as UpdateManyCall;
      expect(resolveCall.where).toEqual({ id: STEP_ID, status: 'PENDING' });
      expect(resolveCall.data).toMatchObject({ resolvedBy: USER_ID, status: 'RESOLVED' });

      expect(signalCalls).toEqual([
        {
          args: [{ action: 'approve', resolvedBy: USER_ID, value: { note: 'lgtm' } }],
          signalName: 'hitl_approveGate',
          workflowId: 'eng-acme-repo-JIRA-1',
        },
      ]);
    });

    it('accepts kind-appropriate actions for the other kinds', async () => {
      stepRow = pendingStep({ kind: 'DECISION', signalName: 'hitl_pick' });
      let res = await respond({ action: 'select', value: 'ship' });
      expect(res.statusCode).toBe(200);

      stepRow = pendingStep({ kind: 'INPUT', signalName: 'hitl_form' });
      res = await respond({ action: 'submit', value: { reason: 'why not' } });
      expect(res.statusCode).toBe(200);

      stepRow = pendingStep({ kind: 'REVIEW', signalName: 'hitl_review' });
      res = await respond({ action: 'submit' });
      expect(res.statusCode).toBe(200);
    });

    it('rolls the row back to PENDING and returns 502 when the Temporal signal fails', async () => {
      stepRow = pendingStep();
      signalError = new Error('Temporal unreachable');
      const res = await respond({ action: 'reject' });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.payload).error.code).toBe('SIGNAL_FAILED');

      // First call resolved the row; second call rolled it back.
      expect(updateManyCalls).toHaveLength(2);
      const rollback = updateManyCalls[1] as UpdateManyCall;
      expect(rollback.where).toEqual({
        id: STEP_ID,
        resolvedBy: USER_ID,
        status: 'RESOLVED',
      });
      expect(rollback.data).toEqual({
        payload: DB_NULL,
        resolvedAt: null,
        resolvedBy: null,
        status: 'PENDING',
      });
      expect(signalCalls).toHaveLength(0);
    });

    it('returns 409 when a concurrent resolve wins the updateMany race', async () => {
      stepRow = pendingStep();
      updateManyCount = 0;
      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('ALREADY_RESOLVED');
      expect(signalCalls).toHaveLength(0);
    });
  });
});
