import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// lib/hitlResolve.ts (imported by the route for the hitl_resolve button) only
// uses `Prisma.DbNull` at runtime — mocking the barrel avoids instantiating
// the real PrismaClient singleton (which requires DATABASE_URL at import).
vi.mock('@auto-swe/shared', () => ({ Prisma: { DbNull: { __sentinel: 'Prisma.DbNull' } } }));

/**
 * `provisionChannel` asks Slack for a new channel's authoritative `is_private`.
 * Stubbed so these tests never reach the network; `null` is the "Slack could not
 * answer" case, which falls back to the caller's heuristic.
 */
const fetchSlackChannelIsPrivateMock = vi.fn<(...a: unknown[]) => Promise<boolean | null>>(
  async () => null
);
vi.mock('../lib/slack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/slack.js')>()),
  // Forward the arguments: asserting only the branch taken would let a change
  // that asks Slack about the wrong channel — or drops the token — pass.
  fetchSlackChannelIsPrivate: (...a: unknown[]) => fetchSlackChannelIsPrivateMock(...a),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolvePublicUrl: vi.fn(() => 'http://localhost:8080'),
  resolveSlackBotTokenForSlackChannel: vi.fn(async () => 'xoxb-test'),
  resolveSlackBotTokenForWorkspace: vi.fn(async () => 'xoxb-test'),
  resolveSlackConfig: vi.fn(async () => ({
    botToken: 'xoxb-test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    signingSecret: 'test-signing-secret',
  })),
  resolveWebUrl: vi.fn(() => 'http://localhost:3000'),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

/**
 * The repository-access gate, as these tests see it.
 *
 * Stubbed rather than left to the real resolver, which reaches the settings
 * store and therefore answers "never readable" in a unit test. That value is a
 * refusal, not an off switch — so without this every steer would fail closed for
 * a reason that has nothing to do with the case under test. Default `off`: the
 * long-standing behaviour every other test in this file was written against.
 */
const repoAccessGate = vi.fn<() => Promise<{ mode: string; staleAfterHours: number } | null>>(
  async () => ({ mode: 'off', staleAfterHours: 72 })
);
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (importOriginal) => ({
  // Spread the original: `repoAccessDecision` imports `decideRepoLaunch` and the
  // refusal messages from this module at load time, so a factory that returns
  // only the resolver leaves those undefined and the decision module throws
  // while it is still being evaluated.
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: () => repoAccessGate(),
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
  installer: { id: string; isActive: boolean; role: string } | null;
  users: FakeUser[];
  templates: FakeTemplate[];
  versions: Map<string, { spec: unknown; version: number }>;
  humanStep: Record<string, unknown> | null;
  humanStepUpdateCount: number;
  humanStepUpdateCalls: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }>;
  /** Run the Slack button's workflow id resolves to for this user (null = not visible). */
  visibleRun: { id: string } | null;
  signalCalls: Array<{ workflowId: string; signalName: string; args: unknown[] }>;
  /** When set, `signalWorkflow` rejects with this instead of recording a call. */
  signalError: Error | null;
  channelAssistantStarts: Array<{ workflowId: string; input: Record<string, unknown> }>;
  /** When set, `startChannelAssistant` throws this instead of recording a start. */
  channelAssistantStartError: Error | null;
  /** Existing SlackWorkspace returned by findUnique (null = not yet provisioned). */
  existingWorkspace: Record<string, unknown> | null;
  workspaceCreateCalls: Array<{ data: Record<string, unknown> }>;
  workspaceUpdateCalls: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }>;
  /** Connection returned by `connection.findUnique` (null = not found). */
  connectionRow: Record<string, unknown> | null;
  /** Ledger writes recorded by the run-modal path. */
  runInputCreates: Array<Record<string, unknown>>;
  /** The thread's task row, as the steer path's `runInput.findFirst` sees it. */
  threadTaskRunInput: { connectionId: string | null } | null;
  activeWorkflowCreates: Array<Record<string, unknown>>;
  /** Ordered log of 'ledger' vs 'start', proving the write precedes the start. */
  launchOrder: string[];
  runnableStarts: Array<{ id: string; args: unknown }>;
  /** When set, `startRunnableWorkflow` rejects with this. */
  runnableStartError: Error | null;
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
      if (state.signalError) {
        throw state.signalError;
      }
      state.signalCalls.push({ args, signalName, workflowId });
    },
    startChannelAssistant: async (workflowId: string, input: Record<string, unknown>) => {
      if (state.channelAssistantStartError) {
        throw state.channelAssistantStartError;
      }
      state.channelAssistantStarts.push({ input, workflowId });
    },
    startRunnableWorkflow: async (id: string, args: unknown) => {
      state.launchOrder.push('start');
      if (state.runnableStartError) {
        throw state.runnableStartError;
      }
      state.runnableStarts.push({ args, id });
    },
  } as unknown as never);

  app.decorate('prisma', {
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(app.prisma);
      }
      state.launchOrder.push('ledger');
      return Promise.all(arg as Promise<unknown>[]);
    },
    activeWorkflow: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // Mirrors the unique index on temporalWorkflowId — the dedup gate.
        if (
          state.activeWorkflowCreates.some((a) => a.temporalWorkflowId === data.temporalWorkflowId)
        ) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        state.activeWorkflowCreates.push(data);
        return { id: `aw-${state.activeWorkflowCreates.length}`, ...data };
      },
      delete: async () => ({}),
    },
    autonomyDecision: {
      create: async () => ({ id: 'audit-1' }),
      deleteMany: async () => ({ count: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
    channelThreadSession: {
      findUnique: async () => null,
    },
    // Used by buildRunModalView (the run picker the /auto-swe run slash command +
    // the global "Run a workflow" shortcut open).
    connection: {
      findMany: async () => [
        {
          id: 'conn-1',
          organizationName: 'acme',
          repoName: 'payments',
          team: { memberships: [{ userId: 'u1' }] },
        },
      ],
      findUnique: async () => state.connectionRow,
    },
    repository: {
      findMany: async () => [],
      findUnique: async () => null,
    },
    runInput: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.runInputCreates.push(data);
        return data;
      },
      delete: async () => ({}),
      // The steer path's lookup: which repository does this thread's task target?
      findFirst: async () => state.threadTaskRunInput,
    },
    slackChannel: {
      // No row yet → provisionChannel takes its create path, where it asks
      // Slack for the authoritative `is_private`.
      create: async () => ({
        followupSessionEnabled: false,
        id: 'chan-1',
        orgId: 'org-1',
        teamId: 'team-default',
      }),
      findFirst: async () => null,
      findUnique: async () => null,
    },
    slackWorkspace: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.workspaceCreateCalls.push(args);
        return { id: 'ws-1', ...args.data };
      },
      findUnique: async () => state.existingWorkspace,
      update: async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        state.workspaceUpdateCalls.push(args);
        return { id: 'ws-1', ...args.data };
      },
      upsert: async () => ({ id: 'ws-1', orgId: 'org-1', slackTeamId: 'T1' }),
    },
    team: {
      findUnique: async () => ({ id: 'team-default', orgId: 'org-1', slug: 'default' }),
    },
    user: {
      findFirst: async ({ where }: { where: { slackId?: string } }) =>
        state.users.find((u) => u.slackId === where.slackId) ?? null,
      // The install callback re-checks the installer's platform role.
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.installer && state.installer.id === where.id ? state.installer : null,
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
    workflowRun: {
      findFirst: async () => state.visibleRun,
    },
    workflowTemplate: {
      // The run modal looks the chosen template up with the visibility filter;
      // other callers (default-template resolution) look up by team/default.
      findFirst: async ({ where }: { where: { id?: string; status?: string } }) =>
        where.id
          ? (state.templates.find(
              (t) => t.id === where.id && (!where.status || t.status === where.status)
            ) ?? null)
          : null,
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
  // The install callback encrypts the captured bot token (real `encryptSecret`).
  process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterAll(async () => {
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.CONFIG_ENCRYPTION_KEY;
  if (app) {
    await app.close();
  }
});

beforeEach(async () => {
  if (app) {
    await app.close();
  }
  state = {
    activeWorkflowCreates: [],
    channelAssistantStartError: null,
    channelAssistantStarts: [],
    connectionRow: null,
    existingWorkspace: null,
    humanStep: null,
    humanStepUpdateCalls: [],
    humanStepUpdateCount: 1,
    installer: { id: 'u1', isActive: true, role: 'ADMIN' },
    launchOrder: [],
    runInputCreates: [],
    runnableStartError: null,
    runnableStarts: [],
    signalCalls: [],
    signalError: null,
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
    threadTaskRunInput: null,
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
    visibleRun: { id: 'run-1' },
    workspaceCreateCalls: [],
    workspaceUpdateCalls: [],
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
      requiredApprovers: 1,
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
      data: {
        action: 'hitl_resolve',
        approvalsRemaining: 0,
        currentApprovers: 1,
        ok: true,
        requiredApprovers: 1,
        signalSent: true,
        status: 'RESOLVED',
        stepId: STEP_ID,
      },
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
    state.humanStep = pendingHumanStep({
      kind: 'DECISION',
      options: [{ label: 'Ship', next: 'ship', value: 'ship-it' }],
      signalName: 'hitl_pick',
    });
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

  it('terminal signal failure → step stays RESOLVED, confirmation says nothing was signalled', async () => {
    state.humanStep = pendingHumanStep();
    const gone = new Error('workflow execution not found');
    gone.name = 'WorkflowNotFoundError';
    state.signalError = gone;

    const res = await injectInteractive(interactivePayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        action: 'hitl_resolve',
        approvalsRemaining: 0,
        currentApprovers: 1,
        ok: true,
        requiredApprovers: 1,
        signalSent: false,
        status: 'RESOLVED',
        stepId: STEP_ID,
      },
    });
    // Resolve only — no rollback write.
    expect(state.humanStepUpdateCalls).toHaveLength(1);

    const confirm = fetchCalls.find((c) => c.url.includes('chat.postMessage'));
    expect((confirm?.body as { text: string } | undefined)?.text).toMatch(/already finished/i);
  });

  it('transient signal failure → rolls back to PENDING and reports SIGNAL_FAILED', async () => {
    state.humanStep = pendingHumanStep();
    state.signalError = new Error('Temporal unreachable');

    const res = await injectInteractive(interactivePayload());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { action: 'hitl_resolve', code: 'SIGNAL_FAILED', ok: false },
    });
    expect(state.humanStepUpdateCalls).toHaveLength(2);
    expect(state.humanStepUpdateCalls[1]?.data).toMatchObject({ status: 'PENDING' });
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

describe('POST /api/v1/auth/slack/interactive — shortcuts', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
      fetchCalls.push({ body: init?.body ? JSON.parse(init.body) : null, url: String(url) });
      return {
        json: async () => ({ ok: true, ts: '1.0', view: { id: 'V1' } }),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function injectShortcut(payloadObj: Record<string, unknown>) {
    const body = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
    const { ts, sig } = signRequest(body);
    return app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/interactive',
    });
  }

  it('global "Run a workflow" shortcut opens the run-picker modal', async () => {
    const res = await injectShortcut({
      callback_id: 'auto_swe_run_shortcut',
      team: { id: 'T1' },
      trigger_id: 'trig-1',
      type: 'shortcut',
      user: { id: 'U1' },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchCalls.some((c) => c.url.includes('views.open'))).toBe(true);
    // A shortcut never starts a workflow directly — it just opens the picker.
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('message "Ask auto-swe about this" shortcut starts a channel turn on the message', async () => {
    const res = await injectShortcut({
      callback_id: 'auto_swe_ask_shortcut',
      channel: { id: 'C-msg' },
      message: { text: 'summarise this thread', ts: '1700.1' },
      team: { id: 'T1' },
      type: 'message_action',
      user: { id: 'U1' },
    });
    expect(res.statusCode).toBe(200);
    // The turn is started out-of-band after the 3s ack.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.channelAssistantStarts).toHaveLength(1);
    const start = state.channelAssistantStarts[0];
    expect(start?.workflowId).toBe('chan-chan-1-ask-1700.1');
    expect(start?.input.userText).toBe('summarise this thread');
    expect(start?.input.threadTs).toBe('1700.1');
    expect(start?.input.followup).toBe(false);
  });

  it('message shortcut does not require the clicker to have a linked account', async () => {
    // `U-unlinked` is absent from state.users — like an @mention, the turn still starts.
    const res = await injectShortcut({
      callback_id: 'auto_swe_ask_shortcut',
      channel: { id: 'C-msg' },
      message: { text: 'help me', ts: '1700.2' },
      team: { id: 'T1' },
      type: 'message_action',
      user: { id: 'U-unlinked' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.channelAssistantStarts).toHaveLength(1);
  });

  it('message shortcut on a text-less message (file/image only) starts no turn', async () => {
    const res = await injectShortcut({
      callback_id: 'auto_swe_ask_shortcut',
      channel: { id: 'C-msg' },
      message: { text: '', ts: '1700.3' },
      team: { id: 'T1' },
      type: 'message_action',
      user: { id: 'U1' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.channelAssistantStarts).toHaveLength(0);
  });
});

describe('POST /api/v1/auth/slack/events — channel assistant teammate', () => {
  it('echoes the challenge on url_verification once the signature passes', async () => {
    const body = JSON.stringify({ challenge: 'abc123', type: 'url_verification' });
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: 'abc123' });
  });

  it('rejects an unsigned url_verification handshake (signature verified first)', async () => {
    const res = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: JSON.stringify({ challenge: 'abc123', type: 'url_verification' }),
      url: '/api/v1/auth/slack/events',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an event_callback with a bad signature', async () => {
    const body = JSON.stringify({ event: { type: 'app_mention' }, type: 'event_callback' });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': 'v0=deadbeef',
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    expect(res.statusCode).toBe(401);
  });

  /** Provision a channel via an app_mention and return the row `create` args. */
  async function provisionViaMention(channelType: string): Promise<Record<string, unknown>> {
    const creates: Record<string, unknown>[] = [];
    const prisma = (app as unknown as { prisma: Record<string, unknown> }).prisma;
    prisma.slackChannel = {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { followupSessionEnabled: false, id: 'chan-1', orgId: 'org-1', teamId: 'team-x' };
      },
      findFirst: async () => null,
      findUnique: async () => null,
    };
    const body = JSON.stringify({
      event: {
        channel: 'C9',
        channel_type: channelType,
        team: 'T1',
        text: '<@UBOT> hello',
        ts: '1700000000.000700',
        type: 'app_mention',
        user: 'UME',
      },
      team_id: 'T1',
      type: 'event_callback',
    });
    const { ts, sig } = signRequest(body);
    await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return creates[0] ?? {};
  }

  it("provisions isPrivate from Slack's answer, not the channel_type guess", async () => {
    // `channel_type: 'channel'` is the heuristic's "public" signal. Slack says
    // otherwise, and Slack is the one that knows — getting this wrong makes the
    // channel's memory readable by every other channel in the org.
    fetchSlackChannelIsPrivateMock.mockResolvedValue(true);
    expect(await provisionViaMention('channel')).toMatchObject({ isPrivate: true });
    // Asked about the right channel, with a token.
    expect(fetchSlackChannelIsPrivateMock).toHaveBeenCalledWith('C9', 'xoxb-test');
  });

  it('falls back to the channel_type guess when Slack cannot answer', async () => {
    // No `groups:read` scope, no token, network failure — behaviour is what it
    // was before Slack was consulted at all.
    fetchSlackChannelIsPrivateMock.mockResolvedValue(null);
    expect(await provisionViaMention('group')).toMatchObject({ isPrivate: true });
    expect(await provisionViaMention('channel')).toMatchObject({ isPrivate: false });
  });

  it('acks and starts the assistant workflow for an app_mention', async () => {
    const body = JSON.stringify({
      event: {
        channel: 'C9',
        team: 'T1',
        text: '<@UBOT> hello there',
        ts: '1700000000.000100',
        type: 'app_mention',
        user: 'UME',
      },
      team_id: 'T1',
      type: 'event_callback',
    });
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    expect(res.statusCode).toBe(200);
    // Processing is out-of-band after the ack — give the microtask a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.channelAssistantStarts).toHaveLength(1);
    const started = state.channelAssistantStarts[0];
    expect(started.workflowId).toBe('chan-chan-1-1700000000.000100');
    expect(started.input).toMatchObject({
      channelId: 'chan-1',
      orgId: 'org-1',
      slackChannelId: 'C9',
      teamId: 'team-default',
      threadTs: '1700000000.000100',
      userSlackId: 'UME',
      userText: 'hello there',
    });
  });

  it('skips Slack retries (x-slack-retry-num) without starting a workflow', async () => {
    const body = JSON.stringify({
      event: {
        channel: 'C9',
        team: 'T1',
        text: '<@UBOT> hi',
        ts: '1.1',
        type: 'app_mention',
        user: 'U',
      },
      team_id: 'T1',
      type: 'event_callback',
    });
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-retry-num': '1',
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('swallows a duplicate workflow start (WorkflowExecutionAlreadyStartedError) as a no-op', async () => {
    const alreadyStarted = new Error('Workflow execution already started');
    alreadyStarted.name = 'WorkflowExecutionAlreadyStartedError';
    state.channelAssistantStartError = alreadyStarted;
    const body = JSON.stringify({
      event: {
        channel: 'C9',
        team: 'T1',
        text: '<@UBOT> hello again',
        ts: '1700000000.000200',
        type: 'app_mention',
        user: 'UME',
      },
      team_id: 'T1',
      type: 'event_callback',
    });
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    // Endpoint still acks 200 (reply was sent before processing); the
    // already-started rejection must not bubble up as an unhandled rejection.
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The start was attempted but rejected; nothing recorded, no crash.
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('ignores bot-authored and subtype messages', async () => {
    const body = JSON.stringify({
      event: { bot_id: 'B1', channel: 'C9', team: 'T1', ts: '1.2', type: 'app_mention' },
      team_id: 'T1',
      type: 'event_callback',
    });
    const { ts, sig } = signRequest(body);
    const res = await app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.channelAssistantStarts).toHaveLength(0);
  });
});

describe('POST /api/v1/auth/slack/events — thread-reply signal-steering (Phase C)', () => {
  // SlackChannel resolves to id `chan-1` (see provisionChannel mock above), so
  // the deterministic task workflowId for thread root `1700.root` is
  // `chantask-chan-1-1700.root` — sanitized to the Temporal-safe charset.
  const STEER_WORKFLOW_ID = 'chantask-chan-1-1700-root';

  // The best-effort steer ack posts to chat.postMessage — stub fetch so a
  // successful steer never makes a real network call.
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () =>
      ({ json: async () => ({ ok: true, ts: '1.0' }) }) as unknown as Response) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeNotFound(): Error {
    const err = new Error('workflow not found');
    err.name = 'WorkflowNotFoundError';
    return err;
  }

  /** Override the temporal signal mock so steers throw not-found (records the
   * attempt first, then throws — mirrors a real signal that found no run). */
  function setSteerNotFound(): void {
    (app as unknown as { temporal: { signalWorkflow: unknown } }).temporal.signalWorkflow = (async (
      workflowId: string,
      signalName: string,
      args: unknown[] = []
    ) => {
      state.signalCalls.push({ args, signalName, workflowId });
      throw makeNotFound();
    }) as unknown;
  }

  function postEvent(event: Record<string, unknown>) {
    const body = JSON.stringify({ event, team_id: 'T1', type: 'event_callback' });
    const { ts, sig } = signRequest(body);
    return app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
  }

  it('steers an in-flight task on a plain thread reply — no new turn started', async () => {
    const res = await postEvent({
      channel: 'C9',
      channel_type: 'channel',
      team: 'T1',
      text: 'actually use a queue instead',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'message',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.signalCalls).toEqual([
      {
        args: ['actually use a queue instead'],
        signalName: 'steer',
        workflowId: STEER_WORKFLOW_ID,
      },
    ]);
    // Steering replaces the turn — no ChannelAssistantWorkflow started.
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('steers an in-flight task on a thread reply that is ALSO an app_mention (steer precedence)', async () => {
    const res = await postEvent({
      channel: 'C9',
      team: 'T1',
      text: '<@UBOT> tighten the validation',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'app_mention',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.signalCalls).toEqual([
      { args: ['tighten the validation'], signalName: 'steer', workflowId: STEER_WORKFLOW_ID },
    ]);
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  describe('repository access', () => {
    /** A `git_repo` row the decision can be taken against. */
    const REPO_ROW = {
      githubApiUrl: null,
      id: 'conn-1',
      installation: null,
      organizationName: 'acme',
      repoName: 'payments',
      team: { memberships: [] },
      type: 'git_repo',
    };

    /** A plain thread reply from `user`, which is only ever a steer attempt. */
    function reply(user: string) {
      return postEvent({
        channel: 'C9',
        channel_type: 'channel',
        team: 'T1',
        text: 'push it to production too',
        thread_ts: '1700.root',
        ts: '1700.reply',
        type: 'message',
        user,
      });
    }

    beforeEach(() => {
      // `mockResolvedValue` outlives `clearAllMocks` (which clears calls, not
      // implementations), so re-state the default or each test inherits the mode
      // the one before it set.
      repoAccessGate.mockResolvedValue({ mode: 'off', staleAfterHours: 72 });
      state.threadTaskRunInput = { connectionId: 'conn-1' };
      state.connectionRow = REPO_ROW;
    });

    it('does not steer a repo-bound task for someone with no linked account', async () => {
      // A steer is not a smaller thing than a launch: for a deferred task this
      // text is spliced into the run description before the run starts, so it is
      // indistinguishable from having asked for the work.
      repoAccessGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });

      expect((await reply('U-STRANGER')).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.signalCalls).toHaveLength(0);
      // Silently, and then dropped as ordinary channel chatter — the bot does
      // not announce that a task it will not steer is running in this thread.
      expect(state.channelAssistantStarts).toHaveLength(0);
    });

    it('steers for someone the decision allows', async () => {
      // The discriminating case: without it, the refusal above would also pass
      // if enforcement simply stopped all steering.
      repoAccessGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });

      expect((await reply('U1')).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.signalCalls).toEqual([
        { args: ['push it to production too'], signalName: 'steer', workflowId: STEER_WORKFLOW_ID },
      ]);
    });

    it('steers a repo-less general task without asking who is speaking', async () => {
      // The general route is untouched in every mode — it answers questions and
      // needs no identity to do so, which is the same line the code route draws.
      repoAccessGate.mockResolvedValue({ mode: 'enforce', staleAfterHours: 72 });
      state.threadTaskRunInput = { connectionId: null };

      expect((await reply('U-STRANGER')).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.signalCalls).toHaveLength(1);
    });

    it('steers for anyone while the gate is off', async () => {
      // A deployment that has not asked for the gate keeps the behaviour it has.
      expect((await reply('U-STRANGER')).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(state.signalCalls).toHaveLength(1);
    });
  });

  it('falls through to a turn for a mention thread reply with NO in-flight task', async () => {
    setSteerNotFound();
    const res = await postEvent({
      channel: 'C9',
      team: 'T1',
      text: '<@UBOT> any update?',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'app_mention',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Steer was attempted and rejected (not-found) — fall through to a turn.
    expect(state.signalCalls).toHaveLength(1);
    expect(state.channelAssistantStarts).toHaveLength(1);
    expect(state.channelAssistantStarts[0]?.input).toMatchObject({
      threadTs: '1700.root',
      userText: 'any update?',
    });
  });

  it('ignores a plain (non-mention) thread reply with NO in-flight task — no turn', async () => {
    setSteerNotFound();
    const res = await postEvent({
      channel: 'C9',
      channel_type: 'channel',
      team: 'T1',
      text: 'just some channel chatter',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'message',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Steer attempted (rejected); a plain non-mention reply must NOT start a turn.
    expect(state.signalCalls).toHaveLength(1);
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('continues a plain thread reply WITHOUT a re-mention when the channel has a live session (Gap H)', async () => {
    setSteerNotFound();
    // Channel opts into follow-up sessions, and the assistant was active in this
    // thread 1 minute ago (within the 30-min window).
    (app as unknown as { prisma: Record<string, unknown> }).prisma = {
      ...(app as unknown as { prisma: Record<string, unknown> }).prisma,
      channelThreadSession: {
        findUnique: async () => ({ lastAssistantAt: new Date(Date.now() - 60_000) }),
      },
      slackChannel: {
        create: async () => ({
          followupSessionEnabled: true,
          id: 'chan-1',
          orgId: 'org-1',
          teamId: 'team-default',
        }),
        findFirst: async () => null,
        findUnique: async () => null,
      },
    };

    const res = await postEvent({
      channel: 'C9',
      channel_type: 'channel',
      team: 'T1',
      text: 'and what about retries?',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'message',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No active task to steer (rejected), but a live session ⇒ a continuation turn.
    expect(state.signalCalls).toHaveLength(1);
    expect(state.channelAssistantStarts).toHaveLength(1);
    expect(state.channelAssistantStarts[0]?.input).toMatchObject({
      threadTs: '1700.root',
      userText: 'and what about retries?',
    });
  });

  it('does NOT continue a plain thread reply when the session window has lapsed (Gap H)', async () => {
    setSteerNotFound();
    (app as unknown as { prisma: Record<string, unknown> }).prisma = {
      ...(app as unknown as { prisma: Record<string, unknown> }).prisma,
      channelThreadSession: {
        // Last active 2 hours ago — well outside the 30-min window.
        findUnique: async () => ({ lastAssistantAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
      },
      slackChannel: {
        create: async () => ({
          followupSessionEnabled: true,
          id: 'chan-1',
          orgId: 'org-1',
          teamId: 'team-default',
        }),
        findFirst: async () => null,
        findUnique: async () => null,
      },
    };

    const res = await postEvent({
      channel: 'C9',
      channel_type: 'channel',
      team: 'T1',
      text: 'stale follow-up',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'message',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('drops a plain non-mention channel message that is NOT a thread reply (never steers/starts)', async () => {
    const res = await postEvent({
      channel: 'C9',
      channel_type: 'channel',
      team: 'T1',
      text: 'random message in the channel',
      ts: '1700.standalone',
      type: 'message',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No thread root → no steer attempt and no turn (not a firehose responder).
    expect(state.signalCalls).toHaveLength(0);
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('does not steer a fresh mention in a NEW thread (thread_ts === ts) — normal turn', async () => {
    const res = await postEvent({
      channel: 'C9',
      team: 'T1',
      text: '<@UBOT> kick this off',
      thread_ts: '1700.same',
      ts: '1700.same',
      type: 'app_mention',
      user: 'UME',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // thread_ts === ts ⇒ not a reply ⇒ no steer; a normal turn starts.
    expect(state.signalCalls).toHaveLength(0);
    expect(state.channelAssistantStarts).toHaveLength(1);
  });

  it('ignores the bot’s own thread-reply messages (bot_id present)', async () => {
    const res = await postEvent({
      bot_id: 'B1',
      channel: 'C9',
      channel_type: 'channel',
      team: 'T1',
      text: 'bot self message',
      thread_ts: '1700.root',
      ts: '1700.reply',
      type: 'message',
      user: 'UBOT',
    });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.signalCalls).toHaveLength(0);
    expect(state.channelAssistantStarts).toHaveLength(0);
  });
});

describe('POST /api/v1/auth/slack/events — App Home tab (Gap I)', () => {
  const originalFetch = globalThis.fetch;
  let publishCalls: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    publishCalls = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      publishCalls.push({ body: init?.body ? JSON.parse(init.body) : {}, url: String(url) });
      return { json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function postEvent(event: Record<string, unknown>) {
    const body = JSON.stringify({ event, team_id: 'T1', type: 'event_callback' });
    const { ts, sig } = signRequest(body);
    return app.inject({
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/events',
    });
  }

  it('publishes the Home view when a user opens the home tab', async () => {
    const res = await postEvent({ tab: 'home', type: 'app_home_opened', user: 'UME' });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].url).toContain('views.publish');
    expect(publishCalls[0].body.user_id).toBe('UME');
    const view = publishCalls[0].body.view as { type: string; blocks: unknown[] };
    expect(view.type).toBe('home');
    expect(view.blocks.length).toBeGreaterThan(0);
    // No conversational workflow is started for a Home open.
    expect(state.channelAssistantStarts).toHaveLength(0);
  });

  it('ignores the messages tab (only the home tab publishes)', async () => {
    const res = await postEvent({ tab: 'messages', type: 'app_home_opened', user: 'UME' });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishCalls).toHaveLength(0);
  });
});

describe('GET /api/v1/auth/slack/install/callback (multi-workspace install)', () => {
  const originalFetch = globalThis.fetch;

  function stubOauthExchange(body: Record<string, unknown>) {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('oauth.v2.access')) {
        return { json: async () => body } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('stores the encrypted bot token on a new workspace and redirects', async () => {
    stubOauthExchange({
      access_token: 'xoxb-installed-9999',
      app_id: 'A123',
      bot_user_id: 'UBOT',
      ok: true,
      team: { id: 'T-NEW', name: 'Acme HQ' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/slack/install/callback?code=c1&state=s1',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/admin/integrations?tab=slack&slack_installed=T-NEW');

    // New workspace → create (not update), carrying encrypted token columns +
    // install metadata, and never the plaintext token.
    expect(state.workspaceCreateCalls).toHaveLength(1);
    const data = state.workspaceCreateCalls[0].data;
    expect(data.slackTeamId).toBe('T-NEW');
    expect(data.appId).toBe('A123');
    expect(data.botUserId).toBe('UBOT');
    expect(data.botTokenLastFour).toBe('9999');
    expect(data.botTokenCiphertext).toBeDefined();
    expect(data.installedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(data)).not.toContain('xoxb-installed-9999');
  });

  it('updates an existing workspace in place', async () => {
    state.existingWorkspace = { id: 'ws-1', orgId: 'org-1', slackTeamId: 'T-EXIST' };
    stubOauthExchange({ access_token: 'xoxb-abcd', ok: true, team: { id: 'T-EXIST' } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/slack/install/callback?code=c1&state=s1',
    });

    expect(res.statusCode).toBe(302);
    expect(state.workspaceCreateCalls).toHaveLength(0);
    expect(state.workspaceUpdateCalls).toHaveLength(1);
    expect(state.workspaceUpdateCalls[0].where).toEqual({ slackTeamId: 'T-EXIST' });
  });

  it('refuses to bind a bot token when the installer is not an active admin', async () => {
    stubOauthExchange({ access_token: 'xoxb-abcd', ok: true, team: { id: 'T-NEW' } });
    state.installer = { id: 'u1', isActive: true, role: 'LEAD' };

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/slack/install/callback?code=c1&state=s1',
    });

    expect(res.statusCode).toBe(403);
    expect(state.workspaceCreateCalls).toHaveLength(0);
    expect(state.workspaceUpdateCalls).toHaveLength(0);
  });

  it('rejects a grant with no bot token (e.g. a user-scope grant)', async () => {
    stubOauthExchange({ authed_user: { access_token: 'xoxp-user' }, ok: true });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/slack/install/callback?code=c1&state=s1',
    });

    expect(res.statusCode).toBe(400);
    expect(state.workspaceCreateCalls).toHaveLength(0);
    expect(state.workspaceUpdateCalls).toHaveLength(0);
  });
});

describe('Slack buttons respect run visibility', () => {
  function buttonPayload(actionId: string, value: string): string {
    return JSON.stringify({
      actions: [{ action_id: actionId, value }],
      type: 'block_actions',
      user: { id: 'U1' },
    });
  }

  function inject(body: string) {
    const payload = `payload=${encodeURIComponent(body)}`;
    const { ts, sig } = signRequest(payload);
    return app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload,
      url: '/api/v1/auth/slack/interactive',
    });
  }

  it('refuses to approve a run the clicker cannot see', async () => {
    state.visibleRun = null;
    const res = await inject(buttonPayload('approve_merge', 'wf-other-team'));
    expect(res.statusCode).toBe(404);
    expect(state.signalCalls).toHaveLength(0);
  });

  it('refuses to request a CI fix on a run the clicker cannot see', async () => {
    state.visibleRun = null;
    const res = await inject(buttonPayload('retry_ci_x', 'wf-other-team'));
    expect(res.statusCode).toBe(404);
    expect(state.signalCalls).toHaveLength(0);
  });

  it('signals when the run is visible', async () => {
    const res = await inject(buttonPayload('approve_merge', 'wf-mine'));
    expect(res.statusCode).toBe(200);
    expect(state.signalCalls).toEqual([
      { args: [true], signalName: 'humanMergeSignal', workflowId: 'wf-mine' },
    ]);
  });
});

// ── Run-modal submission ──
// The "Run a workflow" modal is one of the four workflow-launch call sites.
// It used to start Temporal and only then write RunInput + ActiveWorkflow as
// two un-compensated creates, so a DB failure left a workflow running with
// nothing to attribute its spend or PRs to.
describe('POST /api/v1/auth/slack/interactive — run modal submission', () => {
  const GIT_REPO = {
    id: 'conn-1',
    isActive: true,
    organizationName: 'acme',
    repoName: 'payments',
    team: { memberships: [{ userId: 'u1' }] },
    teamId: 'team-a',
    type: 'git_repo',
  };

  function runModalPayload(over: { ticket?: string; templateId?: string } = {}): string {
    return `payload=${encodeURIComponent(
      JSON.stringify({
        type: 'view_submission',
        user: { id: 'U1' },
        view: {
          callback_id: 'auto_swe_run_modal',
          private_metadata: JSON.stringify({ channelId: 'C-run', initialDescription: '' }),
          state: {
            values: {
              description_block: { description_input: { value: 'Add a health endpoint' } },
              repo_block: { repo_select: { selected_option: { value: 'conn-1' } } },
              template_block: {
                template_select: { selected_option: { value: over.templateId ?? 't1' } },
              },
              ticket_block: { ticket_input: { value: over.ticket ?? 'JIRA-42' } },
            },
          },
        },
      })
    )}`;
  }

  beforeEach(() => {
    state.connectionRow = GIT_REPO;
  });

  // Local signed-POST helper: the HITL suite's copy is scoped to its own
  // describe block.
  function submit(body: string) {
    const { ts, sig } = signRequest(body);
    return app.inject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      method: 'POST',
      payload: body,
      url: '/api/v1/auth/slack/interactive',
    });
  }

  it('writes the ledger before starting the workflow', async () => {
    const res = await submit(runModalPayload());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ response_action: 'clear' });
    expect(state.launchOrder).toEqual(['ledger', 'start']);
    expect(state.runInputCreates).toHaveLength(1);
    expect(state.activeWorkflowCreates).toHaveLength(1);
  });

  it('rejects a double submission through the unique index instead of starting twice', async () => {
    await submit(runModalPayload());
    const second = await submit(runModalPayload());

    // The workflow ID is deterministic per (org, repo, ticket), so the ledger
    // insert loses the race and Temporal is never reached a second time.
    expect(second.json()).toEqual({
      errors: { ticket_block: 'Workflow already running for JIRA-42' },
      response_action: 'errors',
    });
    expect(state.runnableStarts).toHaveLength(1);
  });

  it('starts separate runs for different tickets', async () => {
    await submit(runModalPayload({ ticket: 'JIRA-1' }));
    await submit(runModalPayload({ ticket: 'JIRA-2' }));
    expect(state.runnableStarts).toHaveLength(2);
  });

  it('leaves no orphan ledger rows when the start fails', async () => {
    state.runnableStartError = new Error('temporal unreachable');

    await expect(submit(runModalPayload())).resolves.toBeDefined();

    // Compensated: the resubmission path stays open rather than wedging on a
    // row that points at a workflow which never ran.
    expect(state.activeWorkflowCreates).toHaveLength(1);
    expect(state.runnableStarts).toHaveLength(0);
  });
});
