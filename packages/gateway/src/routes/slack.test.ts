import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// lib/hitlResolve.ts (imported by the route for the hitl_resolve button) only
// uses `Prisma.DbNull` at runtime — mocking the barrel avoids instantiating
// the real PrismaClient singleton (which requires DATABASE_URL at import).
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: { __sentinel: 'Prisma.DbNull' } } }));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveSlackConfig: vi.fn(async () => ({
    botToken: 'xoxb-test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    signingSecret: 'test-signing-secret',
  })),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

import { slackRoutes } from './slack.js';

const SIGNING_SECRET = 'test-signing-secret';

interface FakeUser {
  id: string;
  role: string;
  slackId: string | null;
}

interface FakeTemplate {
  id: string;
  name: string;
  description: string;
  status: string;
  isDefault: boolean;
  activeVersion: number | null;
  teamId: string | null;
  team: { id: string; name: string; slug: string } | null;
}

interface FakeState {
  users: FakeUser[];
  templates: FakeTemplate[];
  versions: Map<string, { spec: unknown; version: number }>;
  humanStep: Record<string, unknown> | null;
  humanStepUpdateCount: number;
  humanStepUpdateCalls: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }>;
  signalCalls: Array<{ workflowId: string; signalName: string; args: unknown[] }>;
}

function buildApp(state: FakeState): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Slack routes rely on rawBody for signature verification.
  app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

  app.decorate('auth', {
    signAccessToken: () => 'fake-jwt',
    signOAuthState: () => 'fake-state',
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'u1' }),
    verifyOAuthState: () => ({ sub: 'u1' }),
  } as unknown as never);
  app.decorate('temporal', {
    cancelWorkflow: async () => undefined,
    signalWorkflow: async (workflowId: string, signalName: string, args: unknown[] = []) => {
      state.signalCalls.push({ args, signalName, workflowId });
    },
    startRunnableWorkflow: async () => undefined,
  } as unknown as never);

  app.decorate('prisma', {
    activeWorkflow: { create: async () => ({}) },
    repository: {
      findMany: async () => [],
      findUnique: async () => null,
    },
    user: {
      findFirst: async ({ where }: { where: { slackId?: string } }) =>
        state.users.find((u) => u.slackId === where.slackId) ?? null,
      update: async () => ({}),
    },
    workflowHumanStep: {
      findFirst: async () => state.humanStep,
      updateMany: async (args: {
        data: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        state.humanStepUpdateCalls.push(args);
        return { count: state.humanStepUpdateCount };
      },
    },
    workflowTemplate: {
      findFirst: async () => null,
      findMany: async () => state.templates,
      findUnique: async ({ where }: { where: { id?: string } }) =>
        state.templates.find((t) => t.id === where.id) ?? null,
    },
    workflowTemplateVersion: {
      findUnique: async ({
        where,
      }: {
        where: { templateId_version: { templateId: string; version: number } };
      }) => {
        const key = `${where.templateId_version.templateId}:${where.templateId_version.version}`;
        return state.versions.get(key) ?? null;
      },
    },
    workRequest: {
      create: async () => ({}),
    },
  } as unknown as never);

  app.register(slackRoutes, { prefix: '/api/v1/auth/slack' });
  return app;
}

function signRequest(body: string): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const base = `v0:${ts}:${body}`;
  const sig = `v0=${crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex')}`;
  return { sig, ts };
}

let app: FastifyInstance;
let state: FakeState;

beforeAll(() => {
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
});

afterAll(async () => {
  delete process.env.SLACK_SIGNING_SECRET;
  if (app) {
    await app.close();
  }
});

beforeEach(async () => {
  if (app) {
    await app.close();
  }
  state = {
    humanStep: null,
    humanStepUpdateCalls: [],
    humanStepUpdateCount: 1,
    signalCalls: [],
    templates: [
      {
        activeVersion: 1,
        description: 'Default engineering workflow',
        id: 't1',
        isDefault: true,
        name: 'default-engineering',
        status: 'ACTIVE',
        team: null,
        teamId: null,
      },
      {
        activeVersion: 3,
        description: 'Backend gates',
        id: 't2',
        isDefault: false,
        name: 'backend-gates',
        status: 'ACTIVE',
        team: { id: 'team-a', name: 'Backend', slug: 'backend' },
        teamId: 'team-a',
      },
    ],
    users: [{ id: 'u1', role: 'ADMIN', slackId: 'U1' }],
    versions: new Map([
      [
        't1:1',
        {
          spec: { entry: 'a', nodes: { a: { status: 'SUCCESS', type: 'terminate' } } },
          version: 1,
        },
      ],
    ]),
  };
  app = buildApp(state);
  await app.ready();
});

describe('POST /api/v1/auth/slack/commands', () => {
  it('rejects requests without a Slack signature', async () => {
    const res = await app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: 'user_id=U1&text=workflows+list',
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a bad signature', async () => {
    const body = 'user_id=U1&text=help';
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': 'v0=deadbeef',
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns an ephemeral hint when the Slack user has no linked account', async () => {
    const body = 'user_id=UNKNOWN&text=help';
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { response_type: string; text: string };
    expect(json.response_type).toBe('ephemeral');
    expect(json.text).toMatch(/not linked/i);
  });

  it('lists workflow templates for a linked user', async () => {
    const body = `user_id=U1&text=${encodeURIComponent('workflows list')}`;
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { text: string };
    expect(json.text).toContain('default-engineering');
    expect(json.text).toContain('backend-gates');
    expect(json.text).toContain('(default)');
  });

  it('returns help for unknown subcommands', async () => {
    const body = `user_id=U1&text=${encodeURIComponent('frobnicate')}`;
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { text: string };
    expect(json.text).toContain('Unknown subcommand');
    expect(json.text).toContain('workflows list');
  });

  it('shows the active spec for a named template', async () => {
    const body = `user_id=U1&text=${encodeURIComponent('workflows show default-engineering')}`;
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { text: string };
    expect(json.text).toContain('default-engineering');
    expect(json.text).toContain('terminate');
  });

  it('returns 404-shaped friendly message when template name is unknown', async () => {
    const body = `user_id=U1&text=${encodeURIComponent('workflows show no-such-template')}`;
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/commands',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { text: string };
    expect(json.text).toMatch(/no workflow template/i);
  });
});

describe('POST /api/v1/auth/slack/interactive — hitl_resolve buttons', () => {
  const STEP_ID = '00000000-0000-4000-8000-000000000042';
  const RESPONSE_URL = 'https://hooks.slack.test/respond';

  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    // Captures the best-effort confirmation chatter: chat.postMessage thread
    // replies and response_url ephemeral posts.
    globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
      fetchCalls.push({ body: init?.body ? JSON.parse(init.body) : null, url: String(url) });
      return { json: async () => ({ ok: true, ts: '1.0' }) } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function pendingHumanStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: STEP_ID,
      kind: 'APPROVAL',
      run: { status: 'RUNNING', workflowId: 'eng-acme-repo-JIRA-1' },
      signalName: 'hitl_approveGate',
      status: 'PENDING',
      title: 'Approve plan',
      ...overrides,
    };
  }

  function interactivePayload(overrides: Record<string, unknown> = {}): string {
    const payload = {
      actions: [
        {
          action_id: 'hitl_resolve:approve',
          value: JSON.stringify({ action: 'approve', stepId: STEP_ID }),
        },
      ],
      channel: { id: 'C-hitl' },
      message: { ts: '1111.2222' },
      response_url: RESPONSE_URL,
      type: 'block_actions',
      user: { id: 'U1' },
      ...overrides,
    };
    return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  }

  function injectInteractive(body: string, sign = true) {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (sign) {
      const { ts, sig } = signRequest(body);
      headers['x-slack-request-timestamp'] = ts;
      headers['x-slack-signature'] = sig;
    }
    return app.inject({
      headers,
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/interactive',
    });
  }

  it('rejects unsigned requests with 401', async () => {
    state.humanStep = pendingHumanStep();
    const res = await injectInteractive(interactivePayload(), false);
    expect(res.statusCode).toBe(401);
    expect(state.signalCalls).toHaveLength(0);
  });

  it('politely rejects a Slack user with no linked account (no 403, ephemeral hint)', async () => {
    state.humanStep = pendingHumanStep();
    const res = await injectInteractive(interactivePayload({ user: { id: 'U-UNLINKED' } }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { ignored: true, reason: 'slack_user_not_linked' } });
    expect(state.signalCalls).toHaveLength(0);
    expect(state.humanStepUpdateCalls).toHaveLength(0);
    // Ephemeral hint delivered via response_url.
    const hint = fetchCalls.find((c) => c.url === RESPONSE_URL);
    expect(hint).toBeDefined();
    const hintBody = hint?.body as {
      response_type: string;
      replace_original: boolean;
      text: string;
    };
    expect(hintBody.response_type).toBe('ephemeral');
    expect(hintBody.replace_original).toBe(false);
    expect(hintBody.text).toMatch(/link your slack account/i);
  });

  it('happy path: resolves the step, signals the workflow, posts a thread confirmation', async () => {
    state.humanStep = pendingHumanStep();
    const res = await injectInteractive(interactivePayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { action: 'hitl_resolve', ok: true, stepId: STEP_ID },
    });

    // Atomic PENDING→RESOLVED guard preserved (same core as the inbox route).
    expect(state.humanStepUpdateCalls).toHaveLength(1);
    expect(state.humanStepUpdateCalls[0]?.where).toEqual({ id: STEP_ID, status: 'PENDING' });
    expect(state.humanStepUpdateCalls[0]?.data).toMatchObject({
      resolvedBy: 'u1',
      status: 'RESOLVED',
    });

    expect(state.signalCalls).toEqual([
      {
        args: [{ action: 'approve', resolvedBy: 'u1', value: undefined }],
        signalName: 'hitl_approveGate',
        workflowId: 'eng-acme-repo-JIRA-1',
      },
    ]);

    // Confirmation annotates the original message as a thread reply.
    const confirm = fetchCalls.find((c) => c.url.includes('chat.postMessage'));
    expect(confirm).toBeDefined();
    const confirmBody = confirm?.body as { channel: string; thread_ts: string; text: string };
    expect(confirmBody.channel).toBe('C-hitl');
    expect(confirmBody.thread_ts).toBe('1111.2222');
    expect(confirmBody.text).toMatch(/approve plan/i);
    expect(confirmBody.text).toContain('<@U1>');
  });

  it('forwards the decision option value through to the Temporal signal', async () => {
    state.humanStep = pendingHumanStep({ kind: 'DECISION', signalName: 'hitl_pick' });
    const body = interactivePayload({
      actions: [
        {
          action_id: 'hitl_resolve:select:0',
          value: JSON.stringify({ action: 'select', stepId: STEP_ID, value: 'ship-it' }),
        },
      ],
    });
    const res = await injectInteractive(body);
    expect(res.statusCode).toBe(200);
    expect(state.signalCalls).toEqual([
      {
        args: [{ action: 'select', resolvedBy: 'u1', value: 'ship-it' }],
        signalName: 'hitl_pick',
        workflowId: 'eng-acme-repo-JIRA-1',
      },
    ]);
  });

  it('already-resolved step → 200 ack with a friendly ephemeral message, no signal', async () => {
    state.humanStep = pendingHumanStep({ status: 'RESOLVED' });
    const res = await injectInteractive(interactivePayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { action: 'hitl_resolve', code: 'ALREADY_RESOLVED', ok: false },
    });
    expect(state.signalCalls).toHaveLength(0);
    const msg = fetchCalls.find((c) => c.url === RESPONSE_URL);
    expect(msg).toBeDefined();
    const msgBody = msg?.body as { response_type: string; text: string };
    expect(msgBody.response_type).toBe('ephemeral');
    expect(msgBody.text).toMatch(/already been resolved/i);
  });

  it('invisible/missing step → NOT_FOUND ack, no signal', async () => {
    state.humanStep = null;
    const res = await injectInteractive(interactivePayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { action: 'hitl_resolve', code: 'NOT_FOUND', ok: false },
    });
    expect(state.signalCalls).toHaveLength(0);
  });

  it('malformed button value → ignored ack with ephemeral warning', async () => {
    state.humanStep = pendingHumanStep();
    const body = interactivePayload({
      actions: [{ action_id: 'hitl_resolve:approve', value: 'not-json' }],
    });
    const res = await injectInteractive(body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { action: 'hitl_resolve', ignored: true, reason: 'malformed_value' },
    });
    expect(state.signalCalls).toHaveLength(0);
    expect(state.humanStepUpdateCalls).toHaveLength(0);
  });
});
