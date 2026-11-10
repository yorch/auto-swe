/**
 * Create the instance's GitHub App from a manifest, in two requests.
 *
 *   POST /api/v1/integrations/github-app-manifest           (ADMIN)
 *     Builds the manifest and a signed, ten-minute, single-purpose `state`, and binds the flow to
 *     this browser with an HttpOnly cookie. Answers with the URL the browser POSTs the manifest to
 *     and the manifest itself; the dashboard submits the form, because GitHub only accepts the
 *     manifest as a browser form post.
 *
 *   GET /api/v1/integrations/github-app-manifest/callback   (GitHub's redirect)
 *     Verifies the state (signature, purpose, expiry, the browser cookie, the API host it was
 *     started for), re-checks that its admin is still an active ADMIN, exchanges the code, and
 *     stores the App id, client id, client secret and private key in the `GitHubConfig` singleton
 *     through the same sealed-envelope writer and audit entry as the integration form. Then it
 *     sends the browser to the App's installation page, since GitHub still needs the App installed.
 *
 * The App is the instance's, on the instance's own host: the form posts to `GitHubConfig.baseUrl`
 * and the code is exchanged at `GitHubConfig.apiUrl`, which must be one host family. A per-host
 * App for another approved host is still registered by hand (`docs/github-app-setup.md`).
 *
 * The flow refuses to start, and refuses to store, while an App id is already configured: it never
 * replaces a working App. Failures land on the integrations page with a fixed error code; GitHub's
 * own response text is never shown or logged.
 */
import crypto from 'node:crypto';
import { sameHostFamily } from '@auto-swe/shared/lib/githubHostScope';
import {
  resolveGitHubConfig,
  resolvePublicUrl,
  resolveWebUrl,
} from '@auto-swe/shared/lib/systemConfig';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  APP_NAME_RE,
  buildGitHubAppManifest,
  convertManifestCode,
  DEFAULT_APP_NAME,
  GITHUB_LOGIN_RE,
  hostBinding,
  installationUrl,
  MANIFEST_CALLBACK_PATH,
  manifestFormAction,
  setAppWebhookSecret,
} from '../lib/githubAppManifest.js';
import { sendError } from '../lib/httpErrors.js';
import { auditConfigWrite, updateGitHubConfig } from '../lib/systemConfigService.js';
import { requireAuth, requireUser } from '../plugins/auth.js';

/** Binds the flow to the browser that started it; cleared by the callback whatever the outcome. */
const MANIFEST_COOKIE = 'auto_swe_github_app_manifest';
/** The state token's lifetime: a flow cannot outlive either. */
const MANIFEST_COOKIE_MAX_AGE_S = 10 * 60;

const StartBody = z.object({
  name: z.string().regex(APP_NAME_RE, 'GitHub App names are 1-34 plain characters').optional(),
  org: z.string().regex(GITHUB_LOGIN_RE, 'must be a GitHub organization login').nullish(),
});

const CallbackQuery = z.object({
  code: z.string().max(500).optional(),
  state: z.string().max(4000).optional(),
});

export interface GitHubAppManifestRouteOptions {
  /** Test seam: replaces the guarded fetch used for GitHub's API. */
  fetchImpl?: typeof fetch;
}

function cookieOptions(): { httpOnly: true; path: string; sameSite: 'lax'; secure: boolean } {
  const url = new URL(`${resolvePublicUrl()}${MANIFEST_CALLBACK_PATH}`);
  return { httpOnly: true, path: url.pathname, sameSite: 'lax', secure: url.protocol === 'https:' };
}

/** Constant-time string equality; false for any length mismatch. */
function sameNonce(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Fixed error codes the integrations page knows how to explain. */
type CallbackError =
  | 'INVALID_CALLBACK'
  | 'INVALID_STATE'
  | 'STATE_MISMATCH'
  | 'HOST_CHANGED'
  | 'FORBIDDEN'
  | 'APP_ALREADY_CONFIGURED'
  | 'CODE_REJECTED'
  | 'GITHUB_UNREACHABLE'
  | 'GITHUB_MALFORMED';

export const githubAppManifestRoutes: FastifyPluginAsync<GitHubAppManifestRouteOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const backToIntegrations = (reply: FastifyReply, error: CallbackError) =>
    reply.redirect(`${resolveWebUrl()}/admin/integrations?github_app_error=${error}`);

  app.post(
    '/github-app-manifest',
    { onRequest: requireAuth({ requiredRole: 'ADMIN' }), schema: { body: StartBody.optional() } },
    async (request, reply) => {
      const user = requireUser(request);
      const config = await resolveGitHubConfig();
      if (config.appId) {
        return sendError(
          reply,
          409,
          'APP_ALREADY_CONFIGURED',
          'A GitHub App is already configured. Clear its App ID first to create a new one from a manifest.'
        );
      }
      if (!sameHostFamily(config.baseUrl, config.apiUrl)) {
        return sendError(
          reply,
          409,
          'GITHUB_HOST_MISMATCH',
          'The GitHub base URL and API URL name different hosts; correct them before creating an App.'
        );
      }

      // The nonce binds the flow to this browser (the cookie) and to the API host it was started
      // for (the suffix), so the code GitHub returns is only ever exchanged at the host that issued it.
      const nonce = `${crypto.randomBytes(32).toString('base64url')}.${hostBinding(config.apiUrl)}`;
      const state = fastify.auth.signOAuthState(user.sub, 'github-app-manifest', nonce);
      const manifest = buildGitHubAppManifest({
        name: request.body?.name ?? DEFAULT_APP_NAME,
        publicUrl: resolvePublicUrl(),
        webUrl: resolveWebUrl(),
      });
      reply.setCookie(MANIFEST_COOKIE, nonce, {
        ...cookieOptions(),
        maxAge: MANIFEST_COOKIE_MAX_AGE_S,
      });
      return {
        data: {
          action: manifestFormAction({
            baseUrl: config.baseUrl,
            org: request.body?.org ?? null,
            state,
          }),
          manifest,
        },
      };
    }
  );

  app.get(
    '/github-app-manifest/callback',
    { schema: { querystring: CallbackQuery } },
    async (request, reply) => {
      const { code, state } = request.query;
      // One use only: the cookie is cleared whatever the outcome, a cancelled flow included.
      const browserNonce = request.cookies[MANIFEST_COOKIE];
      reply.clearCookie(MANIFEST_COOKIE, cookieOptions());

      if (!(code && state)) {
        return backToIntegrations(reply, 'INVALID_CALLBACK');
      }
      let payload: { sub: string; nonce?: string };
      try {
        payload = fastify.auth.verifyOAuthState(state, 'github-app-manifest');
      } catch {
        return backToIntegrations(reply, 'INVALID_STATE');
      }
      if (!(payload.nonce && browserNonce && sameNonce(payload.nonce, browserNonce))) {
        return backToIntegrations(reply, 'STATE_MISMATCH');
      }
      // The state is up to ten minutes old: its admin must still be an active ADMIN.
      const starter = await fastify.prisma.user.findUnique({
        select: { isActive: true, role: true },
        where: { id: payload.sub },
      });
      if (!starter?.isActive || starter.role !== 'ADMIN') {
        return backToIntegrations(reply, 'FORBIDDEN');
      }

      const config = await resolveGitHubConfig();
      if (
        !sameHostFamily(config.baseUrl, config.apiUrl) ||
        payload.nonce.split('.')[1] !== hostBinding(config.apiUrl)
      ) {
        return backToIntegrations(reply, 'HOST_CHANGED');
      }
      if (config.appId) {
        return backToIntegrations(reply, 'APP_ALREADY_CONFIGURED');
      }

      const converted = await convertManifestCode({
        apiUrl: config.apiUrl,
        baseUrl: config.baseUrl,
        code,
        fetchImpl: opts.fetchImpl,
      });
      if (!converted.ok) {
        request.log.warn(
          { reason: converted.reason },
          'GitHub App manifest conversion did not produce an App'
        );
        return backToIntegrations(
          reply,
          converted.reason === 'rejected'
            ? 'CODE_REJECTED'
            : converted.reason === 'malformed'
              ? 'GITHUB_MALFORMED'
              : 'GITHUB_UNREACHABLE'
        );
      }
      const created = converted.app;

      // One webhook secret verifies every instance-host delivery. When one is configured (in the
      // database or the environment), the new App is told to sign with it, so repository webhooks
      // already using it keep verifying. Otherwise the App's own secret (or a fresh one, when
      // GitHub generated none) becomes the instance secret.
      let webhookSecretToStore: string | undefined;
      let webhookAligned = true;
      if (config.webhookSecret) {
        webhookAligned =
          created.webhookSecret === config.webhookSecret ||
          (await setAppWebhookSecret({
            apiUrl: config.apiUrl,
            appId: created.id,
            fetchImpl: opts.fetchImpl,
            pem: created.pem,
            secret: config.webhookSecret,
          }));
      } else if (created.webhookSecret) {
        webhookSecretToStore = created.webhookSecret;
      } else {
        const generated = crypto.randomBytes(32).toString('hex');
        webhookAligned = await setAppWebhookSecret({
          apiUrl: config.apiUrl,
          appId: created.id,
          fetchImpl: opts.fetchImpl,
          pem: created.pem,
          secret: generated,
        });
        webhookSecretToStore = generated;
      }

      const result = await updateGitHubConfig(fastify.prisma, {
        appClientId: created.clientId,
        appClientSecret: created.clientSecret,
        appId: created.id,
        appPrivateKey: created.pem,
        ...(webhookSecretToStore ? { webhookSecret: webhookSecretToStore } : {}),
      });
      await auditConfigWrite(fastify.prisma, request.log, payload.sub, {
        ...result,
        auditAfterJson: {
          ...result.auditAfterJson,
          appSlug: created.slug,
          via: 'github-app-manifest',
          webhookSecretAligned: webhookAligned,
        },
      });
      if (!webhookAligned) {
        // The App is stored, but its deliveries will not verify until its secret is set on
        // GitHub: the page says so rather than sending the browser on to the install as if
        // nothing were wrong.
        request.log.warn(
          { appId: created.id },
          'the new GitHub App could not be set to sign with the instance webhook secret'
        );
        return reply.redirect(
          `${resolveWebUrl()}/admin/integrations?github_app_warning=WEBHOOK_SECRET_UNALIGNED`
        );
      }

      // GitHub still needs the App installed on an account; its setup URL brings the browser back.
      return reply.redirect(installationUrl(created, config.baseUrl));
    }
  );
};
