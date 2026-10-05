import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The route only uses `Prisma.DbNull` at runtime (rollback path); everything
// else from the barrel is type-only. Mocking the barrel avoids instantiating
// the real PrismaClient singleton (which requires DATABASE_URL at import).
const DB_NULL = vi.hoisted(() => ({ __sentinel: 'Prisma.DbNull' }));
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: DB_NULL } }));

import {
  buildWorkflowRunControlFilter,
  buildWorkflowRunVisibilityFilter,
} from '../lib/runVisibility.js';
import { humanStepRoutes } from './humanSteps.js';

const STEP_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = 'user-1';
const AUTH = { authorization: 'Bearer test-token' };

interface UpdateManyCall {
  data: Record<string, unknown>;
  where: Record<string, unknown>;
}

function pendingStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _count: { humanApprovals: 0 },
    context: { plan: 'do the thing' },
    description: 'Please approve the plan',
    fields: null,
    humanApprovals: [],
    id: STEP_ID,
    kind: 'APPROVAL',
    nodeId: 'approveGate',
    options: null,
    requestedAt: new Date('2026-06-01T00:00:00Z'),
    requiredApprovers: 1,
    resolvedAt: null,
    resolvedBy: null,
    run: {
      id: RUN_ID,
      status: 'RUNNING',
      workflowId: 'eng-acme-repo-JIRA-1',
      workRequest: { description: 'Add endpoint', externalTicketId: 'JIRA-1' },
      workRequestId: '00000000-0000-4000-8000-000000000003',
    },
    runId: RUN_ID,
    signalName: 'hitl_approveGate',
    status: 'PENDING',
    timeoutAt: null,
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
  const findManyCalls: Array<Record<string, unknown>> = [];
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

    const prismaMock = {
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prismaMock),
      autonomyDecision: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      configAuditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      workflowHumanStep: {
        findFirst: async () => stepRow,
        findMany: async (args: Record<string, unknown>) => {
          findManyCalls.push(args);
          return listRows;
        },
        updateMany: async (args: UpdateManyCall) => {
          updateManyCalls.push(args);
          return { count: updateManyCount };
        },
      },
    };

    app.decorate('prisma', prismaMock as unknown as never);

    app.decorate('temporal', {
      signalWorkflow: async (workflowId: string, signalName: string, args: unknown[]) => {
        if (signalError) {
          throw signalError;
        }
        signalCalls.push({ args, signalName, workflowId });
      },
    } as unknown as never);

    await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    listRows = [];
    stepRow = null;
    updateManyCount = 1;
    updateManyCalls.length = 0;
    findManyCalls.length = 0;
    signalError = null;
    signalCalls.length = 0;
  });

  describe('GET /', () => {
    it('returns the pending steps visible to the user', async () => {
      listRows = [pendingStep()];
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/human-steps' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: STEP_ID,
        kind: 'APPROVAL',
        nodeId: 'approveGate',
        runId: RUN_ID,
        status: 'PENDING',
        title: 'Approve plan',
      });
      expect(body.data[0].run.workflowId).toBe('eng-acme-repo-JIRA-1');
      // signalName is intentionally not part of the list projection
      expect(body.data[0].signalName).toBeUndefined();
    });
  });

  describe('GET / responses', () => {
    it('projects recorded comments and what the caller already answered', async () => {
      listRows = [
        pendingStep({
          humanApprovals: [
            {
              action: 'approve',
              resolvedAt: new Date('2026-06-01T01:00:00Z'),
              resolvedBy: USER_ID,
              resolvedByUser: { name: 'Ada' },
              value: { comment: 'Looks right' },
            },
          ],
          requiredApprovers: 2,
        }),
      ];
      const res = await app.inject({
        headers: AUTH,
        method: 'GET',
        url: '/api/v1/human-steps?actionable=true',
      });
      expect(res.statusCode).toBe(200);
      const [row] = JSON.parse(res.payload).data;
      expect(row.myResponse).toBe('approve');
      expect(row.responses).toEqual([
        {
          action: 'approve',
          byName: 'Ada',
          comment: 'Looks right',
          resolvedAt: '2026-06-01T01:00:00.000Z',
          value: null,
        },
      ]);
    });

    it('reads a single resolver comment from the stored payload', async () => {
      listRows = [
        pendingStep({
          payload: { action: 'reject', comment: 'Wrong table', resolvedBy: USER_ID },
          resolvedAt: new Date('2026-06-01T02:00:00Z'),
          resolvedByUser: { name: 'Grace' },
          status: 'RESOLVED',
        }),
      ];
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/human-steps' });
      const [row] = JSON.parse(res.payload).data;
      expect(row.responses).toMatchObject([
        { action: 'reject', byName: 'Grace', comment: 'Wrong table' },
      ]);
      expect(row.myResponse).toBeNull();
    });

    it('keeps a reject that resolved a multi-approver step after an approval', async () => {
      const OTHER = 'user-2';
      listRows = [
        pendingStep({
          humanApprovals: [
            {
              action: 'approve',
              resolvedAt: new Date('2026-06-01T01:00:00Z'),
              resolvedBy: USER_ID,
              resolvedByUser: { name: 'Ada' },
              value: { comment: 'Fine by me' },
            },
          ],
          payload: { action: 'reject', comment: 'Wrong table', resolvedBy: OTHER },
          requiredApprovers: 2,
          resolvedAt: new Date('2026-06-01T02:00:00Z'),
          resolvedBy: OTHER,
          resolvedByUser: { name: 'Grace' },
          status: 'RESOLVED',
        }),
      ];
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/human-steps' });
      const [row] = JSON.parse(res.payload).data;
      expect(row.responses).toMatchObject([
        { action: 'approve', byName: 'Ada', comment: 'Fine by me' },
        { action: 'reject', byName: 'Grace', comment: 'Wrong table' },
      ]);
    });

    it('does not duplicate an approval already recorded as a row', async () => {
      listRows = [
        pendingStep({
          humanApprovals: [
            {
              action: 'approve',
              resolvedAt: new Date('2026-06-01T01:00:00Z'),
              resolvedBy: USER_ID,
              resolvedByUser: { name: 'Ada' },
              value: { comment: 'ok' },
            },
          ],
          payload: { action: 'approve', comment: 'ok', resolvedBy: USER_ID },
          resolvedBy: USER_ID,
          resolvedByUser: { name: 'Ada' },
          status: 'RESOLVED',
        }),
      ];
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/human-steps' });
      expect(JSON.parse(res.payload).data[0].responses).toHaveLength(1);
    });
  });

  describe('GET / review value', () => {
    it('shows the submitted review text to whoever reads the step', async () => {
      listRows = [
        pendingStep({
          kind: 'REVIEW',
          payload: { action: 'submit', resolvedBy: USER_ID, value: 'Needs a rollback plan' },
          resolvedAt: new Date('2026-06-01T02:00:00Z'),
          resolvedBy: USER_ID,
          resolvedByUser: { name: 'Grace' },
          status: 'RESOLVED',
        }),
      ];
      const res = await app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/human-steps' });
      expect(JSON.parse(res.payload).data[0].responses).toMatchObject([
        { action: 'submit', value: 'Needs a rollback plan' },
      ]);
    });
  });

  describe('GET / actionable filter', () => {
    const listWhere = async (url: string) => {
      await app.inject({ headers: AUTH, method: 'GET', url });
      return findManyCalls.at(-1)?.where as Record<string, unknown>;
    };

    it('narrows to steps the caller can answer and has not answered', async () => {
      const where = await listWhere('/api/v1/human-steps?actionable=true');
      expect(where.status).toBe('PENDING');
      expect(where.humanApprovals).toEqual({ none: { resolvedBy: USER_ID } });
      expect(where.OR).toEqual([{ timeoutAt: null }, { timeoutAt: { gt: expect.any(Date) } }]);
      const plain = await listWhere('/api/v1/human-steps');
      // The control filter differs from the visibility filter a plain list uses.
      const actor = { role: 'ENGINEER', sub: USER_ID } as never;
      expect(where.run).toEqual(buildWorkflowRunControlFilter(actor, undefined));
      expect(plain.run).toEqual(buildWorkflowRunVisibilityFilter(actor, undefined));
      expect(JSON.stringify(where.run)).not.toBe(JSON.stringify(plain.run));
    });

    it('a plain list carries no actionable narrowing', async () => {
      const where = await listWhere('/api/v1/human-steps');
      expect(where.humanApprovals).toBeUndefined();
      expect(where.status).toBe('PENDING');
    });
  });

  describe('POST /:id/respond', () => {
    function respond(payload: Record<string, unknown>) {
      return app.inject({
        headers: AUTH,
        method: 'POST',
        payload,
        url: `/api/v1/human-steps/${STEP_ID}/respond`,
      });
    }

    it('stores an approver comment with the step but keeps it out of the signal', async () => {
      stepRow = pendingStep();
      const res = await respond({ action: 'reject', comment: '  Needs a test  ' });
      expect(res.statusCode).toBe(200);
      expect(updateManyCalls[0]?.data.payload).toMatchObject({
        action: 'reject',
        comment: 'Needs a test',
      });
      expect(signalCalls[0]?.args[0]).toEqual({ action: 'reject', resolvedBy: USER_ID });
    });

    it('refuses a comment on a step that is not an approval', async () => {
      stepRow = pendingStep({ kind: 'REVIEW' });
      const res = await respond({ action: 'submit', comment: 'hi' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('INVALID_VALUE');
      expect(signalCalls).toHaveLength(0);
    });

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
      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        approvalsRemaining: 0,
        currentApprovers: 1,
        id: STEP_ID,
        requiredApprovers: 1,
        signalSent: true,
        status: 'RESOLVED',
      });

      expect(updateManyCalls).toHaveLength(1);
      const resolveCall = updateManyCalls[0] as UpdateManyCall;
      expect(resolveCall.where).toEqual({ id: STEP_ID, status: 'PENDING' });
      expect(resolveCall.data).toMatchObject({ resolvedBy: USER_ID, status: 'RESOLVED' });

      expect(signalCalls).toEqual([
        {
          args: [{ action: 'approve', resolvedBy: USER_ID }],
          signalName: 'hitl_approveGate',
          workflowId: 'eng-acme-repo-JIRA-1',
        },
      ]);

      expect(app.prisma.configAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'UPDATE',
            afterJson: expect.objectContaining({ action: 'approve' }),
            entityId: RUN_ID,
            entityType: 'WorkflowRun',
          }),
        })
      );
    });

    it('accepts kind-appropriate actions for the other kinds', async () => {
      stepRow = pendingStep({
        kind: 'DECISION',
        options: [{ label: 'Ship', next: 'ship', value: 'ship' }],
        signalName: 'hitl_pick',
      });
      let res = await respond({ action: 'select', value: 'ship' });
      expect(res.statusCode).toBe(200);

      stepRow = pendingStep({
        fields: [{ key: 'reason', label: 'Reason', required: false, type: 'text' }],
        kind: 'INPUT',
        signalName: 'hitl_form',
      });
      res = await respond({ action: 'submit', value: { reason: 'why not' } });
      expect(res.statusCode).toBe(200);

      stepRow = pendingStep({ kind: 'REVIEW', signalName: 'hitl_review' });
      res = await respond({ action: 'submit' });
      expect(res.statusCode).toBe(200);
    });

    it('keeps the step RESOLVED when the workflow is already gone (terminal signal failure)', async () => {
      // A WorkflowNotFoundError can never succeed on retry: the execution has
      // completed or been terminated. Rolling back would return the step to the
      // inbox permanently unclearable — every retry re-fails identically — and
      // would discard a decision the human legitimately made. The resolution
      // stands and the response carries `signalSent: false`, matching what the
      // merge webhook does with the same class of failure.
      stepRow = pendingStep();
      const gone = new Error('workflow execution not found');
      gone.name = 'WorkflowNotFoundError';
      signalError = gone;

      const res = await respond({ action: 'approve' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        approvalsRemaining: 0,
        currentApprovers: 1,
        id: STEP_ID,
        requiredApprovers: 1,
        signalSent: false,
        status: 'RESOLVED',
      });

      // Exactly one write — the PENDING→RESOLVED resolve. No rollback.
      expect(updateManyCalls).toHaveLength(1);
      expect(updateManyCalls[0]?.data).toMatchObject({ resolvedBy: USER_ID, status: 'RESOLVED' });
      expect(updateManyCalls.some((c) => c.data.status === 'PENDING')).toBe(false);
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
