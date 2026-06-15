import crypto from 'node:crypto';
import { resolveSlackConfig, resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { generateBranchName, generateWorkflowId } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type HitlResolveErrorCode, resolveHitlStep } from '../lib/hitlResolve.js';
import { openSlackView, postSlackMessage, verifySlackSignature } from '../lib/slack.js';
import { getErrorName, hasRole, requireAuth, requireUser } from '../plugins/auth.js';
import { resolveDefaultTemplate } from './workRequests.js';

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  authed_user: { access_token: string };
}

interface SlackIdentityResponse {
  ok: boolean;
  user: { id: string };
}

interface SlackInteractivePayload {
  type?: string;
  actions?: Array<{ action_id: string; value?: string }>;
  user?: { id: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  message?: { ts?: string };
  view?: {
    callback_id?: string;
    state?: {
      values?: Record<
        string,
        Record<string, { selected_option?: { value: string }; value?: string }>
      >;
    };
    private_metadata?: string;
  };
}

export const slackRoutes: FastifyPluginAsync = async (fastify) => {
  // Slack delivers slash commands + interactive payloads as
  // application/x-www-form-urlencoded — register a scoped parser so the routes
  // below see `request.body` as an object. fastify-raw-body has already captured
  // the bytes for signature verification (`runFirst: true` in the plugin config).
  // `try/catch` because plugin-scope contentTypeParser registration can throw on
  // duplicate registration; safe to ignore in that case.
  try {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const params = new URLSearchParams(body as string);
          const out: Record<string, string> = {};
          for (const [k, v] of params) {
            out[k] = v;
          }
          done(null, out);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
  } catch {
    /* parser already registered at a parent scope */
  }

  // GET /api/v1/auth/slack/connect — Initiate Slack OAuth (authenticated users only)
  fastify.get(
    '/connect',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
    },
    async (request, reply) => {
      const { clientId } = await resolveSlackConfig();
      if (!clientId) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack integration not configured' },
        });
      }

      const user = requireUser(request);
      // Single-purpose, short-lived state token (not an API access token) so a
      // leak via Slack logs / Referer / browser history can't be replayed as a
      // bearer credential.
      const state = fastify.auth.signOAuthState(user.sub);

      const redirectUri = `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/api/v1/auth/slack/callback`;
      // We link by Slack user id only; identity.basic is sufficient.
      const scopes = 'identity.basic';

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

    // Verify the single-purpose OAuth state token.
    let statePayload: { sub: string };
    try {
      statePayload = fastify.auth.verifyOAuthState(state);
    } catch {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: 'Invalid state parameter' },
      });
    }

    const { clientId, clientSecret } = await resolveSlackConfig();
    if (!clientId || !clientSecret) {
      return reply.status(503).send({
        error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack OAuth credentials missing' },
      });
    }
    const redirectUri = `${process.env.PUBLIC_URL ?? 'http://localhost:8080'}/api/v1/auth/slack/callback`;

    // Exchange code for token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });

    const tokenData = (await tokenResponse.json()) as SlackOAuthResponse;
    if (!tokenData.ok) {
      return reply.status(400).send({
        error: { code: 'SLACK_AUTH_FAILED', message: tokenData.error ?? 'Slack OAuth failed' },
      });
    }

    // Get user identity
    const identityResponse = await fetch('https://slack.com/api/users.identity', {
      headers: { Authorization: `Bearer ${tokenData.authed_user.access_token}` },
    });

    const identity = (await identityResponse.json()) as SlackIdentityResponse;
    if (!identity.ok) {
      return reply.status(400).send({
        error: { code: 'SLACK_IDENTITY_FAILED', message: 'Failed to get Slack identity' },
      });
    }

    const slackId = identity.user.id;

    // Prevent double-linking
    const existingLink = await fastify.prisma.user.findFirst({
      where: { id: { not: statePayload.sub }, slackId },
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
      data: { slackId },
      where: { id: statePayload.sub },
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
      const { signingSecret } = await resolveSlackConfig();
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

      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (!rawBody) {
        return reply.status(400).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Missing raw body' },
        });
      }

      if (!verifySlackSignature(rawBody.toString(), timestamp, signature, signingSecret)) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Invalid Slack signature' },
        });
      }

      // Parse the interactive payload
      const body = request.body as { payload?: string };
      const payload: SlackInteractivePayload = JSON.parse(body.payload ?? '{}');
      const slackUserId = payload.user?.id;

      if (!slackUserId) {
        return { data: { ignored: true } };
      }

      const actionId = payload.actions?.[0]?.action_id ?? '';
      const isHitlResolve = actionId === 'hitl_resolve' || actionId.startsWith('hitl_resolve:');

      // Resolve user by Slack ID
      const user = await fastify.prisma.user.findFirst({
        where: { slackId: slackUserId },
      });

      if (!user) {
        if (isHitlResolve) {
          // Button clicks come from arbitrary channel members — answer the
          // clicker with an ephemeral hint instead of a bare 403 (Slack shows
          // nothing useful for non-2xx interaction responses).
          await respondToInteraction(
            payload,
            ':lock: Link your Slack account in Settings first — then you can resolve steps from Slack.',
            { ephemeral: true }
          );
          return { data: { ignored: true, reason: 'slack_user_not_linked' } };
        }
        return reply.status(403).send({
          error: { code: 'USER_NOT_FOUND', message: 'No user linked to this Slack account' },
        });
      }

      // View-submission: the workflow picker modal closing with "Run".
      if (
        payload.type === 'view_submission' &&
        payload.view?.callback_id === 'auto_swe_run_modal'
      ) {
        return handleRunModalSubmission(fastify, user, payload);
      }

      if (!actionId) {
        return { data: { ignored: true } };
      }

      // HITL resolve buttons posted by the worker's notifySlackHumanStep.
      // Shares the inbox route's resolve core (lib/hitlResolve.ts): same team
      // visibility, action validation, atomic guard, and signal rollback.
      if (isHitlResolve) {
        return handleHitlResolveAction(fastify, request, user, payload);
      }

      // Handle known actions
      if (actionId.startsWith('approve_')) {
        // Only LEAD or ADMIN can approve
        if (!hasRole(user.role, 'LEAD')) {
          return reply.status(403).send({
            error: { code: 'FORBIDDEN', message: 'Only LEAD or ADMIN can approve workflows' },
          });
        }

        const workflowId = payload.actions?.[0]?.value;
        if (!workflowId) {
          return reply.status(400).send({
            error: { code: 'INVALID_PAYLOAD', message: 'Missing workflow id in action value' },
          });
        }
        await fastify.temporal.signalWorkflow(workflowId, 'humanMergeSignal', [true]);
        return { data: { action: 'approved', workflowId } };
      }

      if (actionId.startsWith('retry_ci_')) {
        const workflowId = payload.actions?.[0]?.value;
        if (!workflowId) {
          return reply.status(400).send({
            error: { code: 'INVALID_PAYLOAD', message: 'Missing workflow id in action value' },
          });
        }
        // Signal CI failure to trigger the CI fix loop. The workflow will
        // re-provision a workspace, run the CI fix agent, and push a new commit.
        // This is intentionally "passed: false" — the user is requesting the
        // agent to fix CI, not to re-run the same CI pipeline.
        await fastify.temporal.signalWorkflow(workflowId, 'ciPipelineSignal', [
          { logsUrl: undefined, passed: false },
        ]);
        return { data: { action: 'ci_fix_requested', workflowId } };
      }

      return { data: { ignored: true, reason: 'Unknown action' } };
    }
  );

  // POST /api/v1/auth/slack/commands — Handle Slack slash commands
  // The slash command is `/auto-swe` (configured in the Slack app manifest). It
  // dispatches on `text` to subcommands:
  //   /auto-swe workflows list            → list visible workflow templates
  //   /auto-swe workflows show <name>     → show one template's spec
  //   /auto-swe run                       → open the work-request modal (workflow picker)
  // The slash-command handler must reply within 3s so we keep the handlers thin
  // (no Temporal start here — modal submit handles that).
  fastify.post(
    '/commands',
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const { signingSecret } = await resolveSlackConfig();
      if (!signingSecret) {
        return reply.status(503).send({
          error: { code: 'SLACK_NOT_CONFIGURED', message: 'Slack signing secret not configured' },
        });
      }
      const timestamp = request.headers['x-slack-request-timestamp'] as string | undefined;
      const signature = request.headers['x-slack-signature'] as string | undefined;
      const rawBody = (request as FastifyRequest & { rawBody?: string | Buffer }).rawBody;
      if (
        !timestamp ||
        !signature ||
        !rawBody ||
        !verifySlackSignature(rawBody.toString(), timestamp, signature, signingSecret)
      ) {
        return reply.status(401).send({
          error: { code: 'SLACK_AUTH_FAILED', message: 'Invalid Slack signature' },
        });
      }

      // Slack sends slash commands as application/x-www-form-urlencoded
      const body = request.body as Record<string, string | undefined>;
      const slackUserId = body.user_id ?? '';
      const text = (body.text ?? '').trim();
      const triggerId = body.trigger_id ?? '';
      const channelId = body.channel_id ?? '';

      const user = slackUserId
        ? await fastify.prisma.user.findFirst({ where: { slackId: slackUserId } })
        : null;
      if (!user) {
        // Ephemeral reply — only visible to the invoking user
        return ephemeral(
          'Your Slack account is not linked to auto-swe. Visit /api/v1/auth/slack/connect to link it.'
        );
      }

      const [head, ...rest] = text.split(/\s+/).filter(Boolean);
      const sub = head ?? '';
      const arg = rest.join(' ').trim();

      try {
        if (sub === 'workflows' && (rest[0] ?? '') === 'list') {
          const tpls = await listVisibleTemplates(fastify, user);
          return ephemeral(formatTemplateList(tpls));
        }
        if (sub === 'workflows' && (rest[0] ?? '') === 'show') {
          const name = rest.slice(1).join(' ').trim();
          if (!name) {
            return ephemeral('Usage: `/auto-swe workflows show <name>`');
          }
          const tpl = await findTemplateByName(fastify, user, name);
          if (!tpl) {
            return ephemeral(`No workflow template named "${name}" is visible to you.`);
          }
          return ephemeral(formatTemplateShow(tpl));
        }
        if (sub === 'run') {
          if (!triggerId) {
            return ephemeral('Slack did not provide a trigger_id — please try again.');
          }
          const built = await buildRunModalView(fastify, user, channelId, arg);
          if (!built.ok) {
            return ephemeral(built.error);
          }
          const { botToken: slackBotToken } = await resolveSlackConfig();
          const opened = await openSlackView(
            { triggerId, view: built.view },
            slackBotToken ?? undefined
          );
          if (!opened.ok) {
            return ephemeral(`Could not open modal: ${opened.error ?? 'unknown error'}`);
          }
          return reply.send(''); // empty 200 ack
        }
        if (sub === 'help' || sub === '' || sub === undefined) {
          return ephemeral(slashHelpText());
        }
        return ephemeral(`Unknown subcommand "${sub}".\n\n${slashHelpText()}`);
      } catch (err) {
        request.log.error({ err }, 'slack slash command failed');
        return ephemeral(
          `Command failed: ${err instanceof Error ? err.message : 'internal error'}`
        );
      }
    }
  );
};

// ── HITL resolve button (block_actions, action_id `hitl_resolve[:…]`) ───────

interface HitlButtonValue {
  stepId?: string;
  action?: string;
  value?: unknown;
}

/**
 * Resolve a pending human step from a Slack Block Kit button. The button
 * `value` carries JSON `{stepId, action, value?}` written by the worker's
 * `notifySlackHumanStep`. Authorization and resolve semantics are exactly the
 * inbox route's — both call `resolveHitlStep`.
 *
 * Always acks with HTTP 200 (Slack treats non-2xx as a delivery failure and
 * shows a generic warning); the human-readable outcome is delivered as a
 * thread reply / ephemeral message instead.
 */
async function handleHitlResolveAction(
  fastify: FastifyInstance,
  request: FastifyRequest,
  user: { id: string; role: string },
  payload: SlackInteractivePayload
): Promise<unknown> {
  let parsed: HitlButtonValue = {};
  try {
    parsed = JSON.parse(payload.actions?.[0]?.value ?? '{}') as HitlButtonValue;
  } catch {
    /* malformed JSON — handled below */
  }
  if (typeof parsed.stepId !== 'string' || !parsed.stepId || typeof parsed.action !== 'string') {
    await respondToInteraction(
      payload,
      ':warning: This button is malformed — please resolve the step from the inbox instead.',
      { ephemeral: true }
    );
    return { data: { action: 'hitl_resolve', ignored: true, reason: 'malformed_value' } };
  }

  const result = await resolveHitlStep(
    { log: request.log, prisma: fastify.prisma, temporal: fastify.temporal },
    parsed.stepId,
    parsed.action,
    parsed.value,
    { role: user.role, sub: user.id }
  );

  if (result.ok) {
    const who = payload.user?.id ? `<@${payload.user.id}>` : 'someone';
    await respondToInteraction(
      payload,
      `:white_check_mark: *${result.title}* — resolved with \`${parsed.action}\` by ${who}.`,
      { ephemeral: false }
    );
    return { data: { action: 'hitl_resolve', ok: true, stepId: result.stepId } };
  }

  await respondToInteraction(payload, hitlErrorText(result.code, result.message), {
    ephemeral: true,
  });
  return { data: { action: 'hitl_resolve', code: result.code, ok: false } };
}

function hitlErrorText(code: HitlResolveErrorCode, message: string): string {
  switch (code) {
    case 'ALREADY_RESOLVED':
      return ':information_source: This step has already been resolved — nothing left to do.';
    case 'NOT_FOUND':
      return ':warning: This step no longer exists or is not visible to you.';
    case 'RUN_NOT_RUNNING':
      return ':warning: The workflow run is no longer running.';
    case 'SIGNAL_FAILED':
      return ':warning: Could not deliver your response to the workflow — please try the button again.';
    default:
      return `:warning: ${message}`;
  }
}

/**
 * Best-effort reply to a Slack interaction. Success confirmations annotate the
 * original message as a thread reply (chat.postMessage — what lib/slack.ts
 * already supports); errors and the unlinked-account hint go to `response_url`
 * as an ephemeral message visible only to the clicker. Never replaces the
 * original message (`replace_original: false`) so the audit trail stays
 * intact. All failures are swallowed — Slack chatter must never fail the ack.
 */
async function respondToInteraction(
  payload: SlackInteractivePayload,
  text: string,
  opts: { ephemeral: boolean }
): Promise<void> {
  try {
    if (!opts.ephemeral && payload.channel?.id && payload.message?.ts) {
      const { botToken } = await resolveSlackConfig();
      const ts = await postSlackMessage(
        { channel: payload.channel.id, text, threadTs: payload.message.ts },
        botToken ?? undefined
      );
      if (ts) {
        return;
      }
      // fall through to response_url if the thread reply failed
    }
    if (payload.response_url) {
      await fetch(payload.response_url, {
        body: JSON.stringify({
          replace_original: false,
          response_type: opts.ephemeral ? 'ephemeral' : 'in_channel',
          text,
        }),
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        method: 'POST',
      });
    }
  } catch {
    /* best-effort */
  }
}

// ── Slash-command helpers ───────────────────────────────────────────────────

function ephemeral(text: string): { response_type: 'ephemeral'; text: string } {
  return { response_type: 'ephemeral', text };
}

function slashHelpText(): string {
  return [
    '*auto-swe slash commands*',
    '• `/auto-swe workflows list` — list workflow templates visible to you',
    '• `/auto-swe workflows show <name>` — show one template (active version)',
    '• `/auto-swe run [description]` — open a work-request modal (workflow picker)',
    '• `/auto-swe help` — this message',
  ].join('\n');
}

interface SimpleTemplateRow {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  activeVersion: number | null;
  team: { id: string; slug: string; name: string } | null;
}

async function listVisibleTemplates(
  fastify: FastifyInstance,
  user: { id: string; role: string }
): Promise<SimpleTemplateRow[]> {
  const where =
    user.role === 'ADMIN'
      ? {}
      : {
          OR: [{ teamId: null }, { team: { memberships: { some: { userId: user.id } } } }],
        };
  const rows = await fastify.prisma.workflowTemplate.findMany({
    include: { team: { select: { id: true, name: true, slug: true } } },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    where,
  });
  return rows.map((r) => ({
    activeVersion: r.activeVersion,
    description: r.description,
    id: r.id,
    isDefault: r.isDefault,
    name: r.name,
    team: r.team ? { id: r.team.id, name: r.team.name, slug: r.team.slug } : null,
  }));
}

async function findTemplateByName(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  name: string
): Promise<
  | (SimpleTemplateRow & {
      spec: unknown | null;
      activeVersionRow: { version: number } | null;
    })
  | null
> {
  const tpls = await listVisibleTemplates(fastify, user);
  const tpl = tpls.find((t) => t.name === name);
  if (!tpl) {
    return null;
  }
  const v = tpl.activeVersion
    ? await fastify.prisma.workflowTemplateVersion.findUnique({
        where: { templateId_version: { templateId: tpl.id, version: tpl.activeVersion } },
      })
    : null;
  return {
    ...tpl,
    activeVersionRow: v ? { version: v.version } : null,
    spec: v ? v.spec : null,
  };
}

function formatTemplateList(rows: SimpleTemplateRow[]): string {
  if (rows.length === 0) {
    return 'No workflow templates visible to you.';
  }
  const lines = rows.map((r) => {
    const teamLabel = r.team ? r.team.slug : 'global';
    const defaultLabel = r.isDefault ? ' *(default)*' : '';
    const versionLabel = r.activeVersion ? ` v${r.activeVersion}` : ' (no active version)';
    return `• \`${r.name}\` — ${teamLabel}${versionLabel}${defaultLabel}`;
  });
  return ['*Workflow templates*', ...lines].join('\n');
}

function formatTemplateShow(
  tpl: SimpleTemplateRow & { spec: unknown | null; activeVersionRow: { version: number } | null }
): string {
  const teamLabel = tpl.team ? tpl.team.slug : 'global';
  const versionLabel = tpl.activeVersionRow
    ? `v${tpl.activeVersionRow.version}`
    : 'no active version';
  const header = `*${tpl.name}* — ${teamLabel} (${versionLabel})${tpl.isDefault ? ' — default' : ''}`;
  const desc = tpl.description ? `\n${tpl.description}` : '';
  if (!tpl.spec) {
    return `${header}${desc}`;
  }
  // Truncate to fit within Slack's 3000-char text limit for an ephemeral message.
  const json = JSON.stringify(tpl.spec, null, 2);
  const max = 2600;
  const trimmed = json.length > max ? `${json.slice(0, max)}\n…[truncated]` : json;
  return `${header}${desc}\n\`\`\`${trimmed}\`\`\``;
}

// ── Modal: work-request picker ──────────────────────────────────────────────

interface RunModalMetadata {
  channelId: string;
  initialDescription: string;
}

async function buildRunModalView(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  channelId: string,
  initialDescription: string
): Promise<{ ok: true; view: unknown } | { ok: false; error: string }> {
  const tpls = await listVisibleTemplates(fastify, user);
  const repos = await fastify.prisma.connection.findMany({
    select: {
      id: true,
      organizationName: true,
      repoName: true,
      team: { select: { memberships: { select: { userId: true }, where: { userId: user.id } } } },
    },
    where: { isActive: true },
  });
  const accessibleRepos =
    user.role === 'ADMIN' ? repos : repos.filter((r) => r.team.memberships.length > 0);
  // The submission handler binds the repo via `selected_option.value` on a
  // `static_select` element — rendering a free-text fallback would silently
  // skip submission validation, so we short-circuit when there's nothing to
  // pick. Caller surfaces this as an ephemeral message.
  if (accessibleRepos.length === 0) {
    return {
      error: 'You do not have access to any active repositories. Ask a team admin to add you.',
      ok: false,
    };
  }

  const repoOptions = accessibleRepos.slice(0, 100).map((r) => ({
    text: { text: `${r.organizationName}/${r.repoName}`, type: 'plain_text' as const },
    value: r.id,
  }));
  const tplOptions = [
    { text: { text: '(team default)', type: 'plain_text' as const }, value: '' },
    ...tpls.slice(0, 100).map((t) => ({
      text: {
        text: `${t.name}${t.isDefault ? ' (default)' : ''}`,
        type: 'plain_text' as const,
      },
      value: t.id,
    })),
  ];

  const metadata: RunModalMetadata = { channelId, initialDescription };

  const view = {
    blocks: [
      {
        block_id: 'ticket_block',
        element: {
          action_id: 'ticket_input',
          placeholder: { text: 'e.g. JIRA-1234', type: 'plain_text' },
          type: 'plain_text_input',
        },
        label: { text: 'Ticket ID', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'description_block',
        element: {
          action_id: 'description_input',
          ...(initialDescription ? { initial_value: initialDescription } : {}),
          multiline: true,
          placeholder: { text: 'What should the agent build?', type: 'plain_text' },
          type: 'plain_text_input',
        },
        label: { text: 'Description', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'repo_block',
        element: {
          action_id: 'repo_select',
          options: repoOptions,
          placeholder: { text: 'Select a repository', type: 'plain_text' },
          type: 'static_select',
        },
        label: { text: 'Repository', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'template_block',
        element: {
          action_id: 'template_select',
          initial_option: tplOptions[0],
          options: tplOptions,
          type: 'static_select',
        },
        label: { text: 'Workflow', type: 'plain_text' },
        optional: true,
        type: 'input',
      },
    ],
    callback_id: 'auto_swe_run_modal',
    close: { text: 'Cancel', type: 'plain_text' },
    private_metadata: JSON.stringify(metadata),
    submit: { text: 'Run', type: 'plain_text' },
    title: { text: 'Run a workflow', type: 'plain_text' },
    type: 'modal',
  };
  return { ok: true, view };
}

async function handleRunModalSubmission(
  fastify: FastifyInstance,
  user: { id: string; role: string },
  payload: SlackInteractivePayload
): Promise<unknown> {
  const values = payload.view?.state?.values ?? {};
  const ticket = (values.ticket_block?.ticket_input?.value ?? '').trim();
  const description = (values.description_block?.description_input?.value ?? '').trim();
  const repoId = values.repo_block?.repo_select?.selected_option?.value ?? '';
  const templateId = values.template_block?.template_select?.selected_option?.value ?? '';

  const errors: Record<string, string> = {};
  if (!ticket) {
    errors.ticket_block = 'Ticket ID is required';
  }
  if (!description) {
    errors.description_block = 'Description is required';
  }
  if (!repoId) {
    errors.repo_block = 'Repository is required';
  }
  if (Object.keys(errors).length > 0) {
    return { errors, response_action: 'errors' };
  }

  let metadata: RunModalMetadata = { channelId: '', initialDescription: '' };
  try {
    metadata = JSON.parse(payload.view?.private_metadata ?? '{}') as RunModalMetadata;
  } catch {
    /* keep defaults */
  }

  const repo = await fastify.prisma.connection.findUnique({
    include: { team: { select: { memberships: { where: { userId: user.id } } } } },
    where: { id: repoId },
  });
  if (!repo?.isActive) {
    return {
      errors: { repo_block: 'Repository not found or inactive' },
      response_action: 'errors',
    };
  }
  if (user.role !== 'ADMIN' && repo.team.memberships.length === 0) {
    return {
      errors: { repo_block: 'You do not have access to this repository' },
      response_action: 'errors',
    };
  }

  // Resolve workflow template — explicit choice wins, else default resolver.
  let resolvedTemplate: { templateId: string; version: number } | null = null;
  if (templateId) {
    const tpl = await fastify.prisma.workflowTemplate.findUnique({ where: { id: templateId } });
    if (!tpl?.activeVersion) {
      return {
        errors: { template_block: 'Selected workflow has no active version' },
        response_action: 'errors',
      };
    }
    resolvedTemplate = { templateId: tpl.id, version: tpl.activeVersion };
  } else {
    const def = await resolveDefaultTemplate(fastify.prisma, repo.teamId, ticket);
    if (!def) {
      return {
        errors: { template_block: 'No default workflow template configured for this team' },
        response_action: 'errors',
      };
    }
    resolvedTemplate = { templateId: def.templateId, version: def.version };
  }

  const temporalWorkflowId = generateWorkflowId(ticket, repo.organizationName, repo.repoName);
  const { branchPrefix: slackBranchPrefix } = await resolveWorkflowDefaults();
  const branch = generateBranchName(ticket, slackBranchPrefix);
  const workRequestId = crypto.randomUUID();
  const repoWorkRequest: RepoWorkRequest = {
    budgetTier: 'STANDARD',
    description,
    externalTicketId: ticket,
    repoId: repo.id,
    requestPayload: JSON.stringify({ description, externalTicketId: ticket, source: 'slack' }),
    workRequestId,
  };

  try {
    await fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
      request: repoWorkRequest,
      templateId: resolvedTemplate.templateId,
      templateVersion: resolvedTemplate.version,
    });
  } catch (err) {
    if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
      return {
        errors: { ticket_block: `Workflow already running for ${ticket}` },
        response_action: 'errors',
      };
    }
    throw err;
  }

  await fastify.prisma.workRequest.create({
    data: {
      description,
      externalTicketId: ticket,
      id: workRequestId,
      requestPayload: JSON.stringify({ description, externalTicketId: ticket, source: 'slack' }),
      slackChannelId: metadata.channelId || null,
      templateId: resolvedTemplate.templateId,
      templateVersion: resolvedTemplate.version,
    },
  });

  await fastify.prisma.activeWorkflow.create({
    data: {
      assignedBranch: branch,
      budgetTier: 'STANDARD',
      currentStatus: 'IMPLEMENTING',
      repoId: repo.id,
      temporalWorkflowId,
      workRequestId,
    },
  });

  // Closing the modal with no `response_action` dismisses it cleanly.
  return { response_action: 'clear' };
}
