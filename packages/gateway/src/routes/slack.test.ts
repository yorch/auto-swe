import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
}

function buildApp(state: FakeState): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Slack routes rely on rawBody for signature verification.
  app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

  app.decorate('auth', {
    signAccessToken: () => 'fake-jwt',
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: 'u1' }),
  } as unknown as never);
  app.decorate('temporal', {
    signalWorkflow: async () => undefined,
    startRunnableWorkflow: async () => undefined,
  } as unknown as never);

  app.decorate('prisma', {
    activeWorkflow: { create: async () => ({}) },
    repository: {
      findMany: async () => [],
      findUnique: async () => null,
    },
    user: {
      findFirst: async ({ where }: { where: { slackId?: string } }) => {
        return state.users.find((u) => u.slackId === where.slackId) ?? null;
      },
      update: async () => ({}),
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
  if (app) await app.close();
});

beforeEach(async () => {
  if (app) await app.close();
  state = {
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
