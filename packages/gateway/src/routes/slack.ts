import type { FastifyPluginAsync } from 'fastify';
import { registerCommandRoutes } from './slack/commands.js';
import { registerEventRoutes } from './slack/events.js';
import { registerInteractiveRoutes } from './slack/interactive.js';
import { registerOauthRoutes } from './slack/oauth.js';

export const slackRoutes: FastifyPluginAsync = async (fastify) => {
  // Slack delivers slash commands + interactive payloads as
  // application/x-www-form-urlencoded — register a scoped parser so the routes
  // below see `request.body` as an object even when this plugin is mounted
  // standalone (as the tests do). fastify-raw-body has already captured the
  // bytes for signature verification (`runFirst: true` in the plugin config).
  // In the full gateway, index.ts registers an app-level parser with the same
  // Record<string, string> shape, so this duplicate registration throws
  // FST_ERR_CTP_ALREADY_PRESENT — caught and ignored; the app-level parser
  // serves these routes.
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

  // Called directly rather than via `fastify.register`, so every route stays in this
  // plugin's single encapsulation scope, under the parser above.
  await registerOauthRoutes(fastify);
  await registerInteractiveRoutes(fastify);
  await registerCommandRoutes(fastify);
  await registerEventRoutes(fastify);
};
