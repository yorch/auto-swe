import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { hasRole, requireAuth } from '../plugins/auth.js';

const SLACK_TIMESTAMP_MAX_AGE = 5 * 60; // 5 minutes (replay protection)

/**
 * Verify Slack request signature using signing secret.
 */
function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): boolean {
  // Replay protection
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > SLACK_TIMESTAMP_MAX_AGE) {
    return false;
  }

  const baseString = `v0:${timestamp}:${body}`;
  const expected =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export const slackRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/auth/slack/connect — Initiate Slack OAuth (authenticated users only)
  fastify.get(
    '/connect',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request, reply) => {
      const clientId = process.env.SLACK_CLIENT_ID;
      if (!clientId) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack integration not configured' },
        });
      }

      const state = fastify.auth.signAccessToken({
        sub: request.user!.sub,
        role: request.user!.role,
      });

      const redirectUri = `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/api/v1/auth/slack/callback`;
      const scopes = 'identity.basic,identity.email';

      const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

      return reply.redirect(url);
    }
  );

  // GET /api/v1/auth/slack/callback — Handle Slack OAuth callback
  fastify.get('/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      return reply.status(400).send({
        error: { code: 'INVALID_CALLBACK', message: 'Missing code or state' },
      });
    }

    // Verify state JWT
    let statePayload: any;
    try {
      statePayload = fastify.auth.verifyAccessToken(state);
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: 'Invalid state parameter' },
      });
    }

    const clientId = process.env.SLACK_CLIENT_ID!;
    const clientSecret = process.env.SLACK_CLIENT_SECRET!;
    const redirectUri = `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/api/v1/auth/slack/callback`;

    // Exchange code for token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = (await tokenResponse.json()) as any;
    if (!tokenData.ok) {
      return reply.status(400).send({
        error: { code: 'SLACK_AUTH_FAILED', message: tokenData.error ?? 'Slack OAuth failed' },
      });
    }

    // Get user identity
    const identityResponse = await fetch('https://slack.com/api/users.identity', {
      headers: { Authorization: `Bearer ${tokenData.authed_user.access_token}` },
    });

    const identity = (await identityResponse.json()) as any;
    if (!identity.ok) {
      return reply.status(400).send({
        error: { code: 'SLACK_IDENTITY_FAILED', message: 'Failed to get Slack identity' },
      });
    }

    const slackId = identity.user.id;

    // Prevent double-linking
    const existingLink = await fastify.prisma.user.findFirst({
      where: { slackId, id: { not: statePayload.sub } },
    });
    if (existingLink) {
      return reply.status(409).send({
        error: {
          code: 'SLACK_ALREADY_LINKED',
          message: 'This Slack account is linked to another user',
        },
      });
    }

    // Update user with Slack ID
    await fastify.prisma.user.update({
      where: { id: statePayload.sub },
      data: { slackId },
    });

    return { data: { connected: true, slackId } };
  });

  // POST /api/v1/webhooks/slack — Handle Slack interactive webhooks
  fastify.post(
    '/interactive',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const signingSecret = process.env.SLACK_SIGNING_SECRET;
      if (!signingSecret) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack signing secret not configured' },
        });
      }

      const timestamp = request.headers['x-slack-request-timestamp'] as string;
      const signature = request.headers['x-slack-signature'] as string;

      if (!timestamp || !signature) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Missing Slack signature headers' },
        });
      }

      if (!verifySlackSignature((request as any).rawBody!, timestamp, signature, signingSecret)) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Invalid Slack signature' },
        });
      }

      // Parse the interactive payload
      const payload = JSON.parse((request.body as any).payload ?? '{}');
      const actionId = payload.actions?.[0]?.action_id;
      const slackUserId = payload.user?.id;

      if (!slackUserId || !actionId) {
        return { data: { ignored: true } };
      }

      // Resolve user by Slack ID
      const user = await fastify.prisma.user.findFirst({
        where: { slackId: slackUserId },
      });

      if (!user) {
        return reply.status(403).send({
          error: { code: 'USER_NOT_FOUND', message: 'No user linked to this Slack account' },
        });
      }

      // Handle known actions
      if (actionId.startsWith('approve_')) {
        // Only LEAD or ADMIN can approve
        if (!hasRole(user.role, 'LEAD')) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Only LEAD or ADMIN can approve workflows' },
          });
        }

        const workflowId = payload.actions[0].value;
        await fastify.temporal.signalWorkflow(workflowId, 'humanMergeSignal', [true]);
        return { data: { action: 'approved', workflowId } };
      }

      if (actionId.startsWith('retry_ci_')) {
        const workflowId = payload.actions[0].value;
        // Signal CI failure to trigger the CI fix loop. The workflow will
        // re-provision a workspace, run the CI fix agent, and push a new commit.
        // This is intentionally "passed: false" — the user is requesting the
        // agent to fix CI, not to re-run the same CI pipeline.
        await fastify.temporal.signalWorkflow(workflowId, 'ciPipelineSignal', [
          { passed: false, logsUrl: undefined },
        ]);
        return { data: { action: 'ci_fix_requested', workflowId } };
      }

      return { data: { ignored: true, reason: 'Unknown action' } };
    }
  );
};
