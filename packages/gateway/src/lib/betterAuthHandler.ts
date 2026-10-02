import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import {
  extractSessionCookieValue,
  invalidateSessionCache,
  ipRateLimitKey,
} from '../plugins/auth.js';
import { getAuth } from './betterAuth.js';
import { isCanonicalRequestPath } from './canonicalPath.js';

/** The endpoints whose own contract is `application/x-www-form-urlencoded` (RFC 6749). */
const FORM_ONLY_PREFIX = '/api/auth/oauth2/';

/**
 * Bridge a Fastify request to better-auth's fetch-style handler and back.
 *
 * Fastify has already parsed the body (JSON or, via the app-level parser, an
 * urlencoded form) into an object. better-auth wants a `Request`, so it is
 * re-serialized: as JSON for everything but the OAuth endpoints, which are
 * specified as urlencoded and refuse another media type.
 */
export function createBetterAuthHandler(): RouteHandlerMethod {
  return async (request, reply) => {
    // The URL below is resolved before better-auth dispatches on it, but the
    // route that matched — and the rate limit it carries — was chosen on the
    // raw path. Serve only a path that resolves to itself.
    if (!isCanonicalRequestPath(request.url)) {
      return reply.status(400).send({
        error: { code: 'NON_CANONICAL_PATH', message: 'Request path is not in canonical form' },
      });
    }
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      // Snapshot the session-cookie value BEFORE better-auth runs — on a
      // successful /sign-out it'll clear the cookie in the response, and
      // we want to invalidate our in-memory cache for that token regardless.
      const sessionCookieBefore = extractSessionCookieValue(request.headers);
      // Re-serialize the parsed body and label it so better-auth sees one
      // canonical shape no matter how the browser sent it. A text/plain body
      // arrives as a string and passes through untouched. content-length is a
      // forbidden fetch header — the Request constructor recomputes it from the body.
      let body: string | undefined;
      if (request.body !== undefined && request.body !== null) {
        if (typeof request.body === 'string') {
          body = request.body;
        } else if (
          url.pathname.startsWith(FORM_ONLY_PREFIX) &&
          request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
        ) {
          body = new URLSearchParams(request.body as Record<string, string>).toString();
        } else {
          body = JSON.stringify(request.body);
          headers.set('content-type', 'application/json');
        }
      }
      const req = new Request(url.toString(), {
        ...(body !== undefined ? { body } : {}),
        headers,
        method: request.method,
      });
      const response = await getAuth().handler(req);
      // Invalidate the cache for sign-out / revoke-session calls so the
      // logged-out user is locked out immediately instead of waiting up
      // to 60s for the cached entry to expire.
      if (
        response.status < 400 &&
        sessionCookieBefore &&
        (url.pathname.endsWith('/sign-out') || url.pathname.endsWith('/revoke-session'))
      ) {
        invalidateSessionCache(sessionCookieBefore);
      }
      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      return reply.send(response.body ? await response.text() : null);
    } catch (error) {
      request.log.error({ err: error }, 'better-auth handler failed');
      return reply.status(500).send({
        error: { code: 'AUTH_HANDLER_ERROR', message: 'Internal authentication error' },
      });
    }
  };
}

// Tighter rate-limit on the credential endpoints only. The global limit
// is 200/min — too permissive for sign-in / sign-up / reset / magic-link,
// where credential-stuffing or link spam should be capped — but the same
// 20/min on the whole wildcard also throttled /get-session, which the
// dashboard calls on every full page load, so a user paging through the
// admin area was rate-limited and bounced to the login page.
const CREDENTIAL_AUTH_PATHS = [
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/magic-link',
  '/api/auth/sign-up/email',
  '/api/auth/forget-password',
  '/api/auth/request-password-reset',
  '/api/auth/reset-password',
  '/api/auth/change-password',
  '/api/auth/send-verification-email',
];

/** Anonymous Dynamic Client Registration writes a row per call: capped well below sign-in. */
export const OAUTH_REGISTER_PATH = '/api/auth/oauth2/register';
export const OAUTH_REGISTER_MAX_PER_MINUTE = 10;

/**
 * Mount better-auth at `/api/auth/*`, with the strict per-IP limits on the credential
 * endpoints and on client registration.
 *
 * Keyed on the client IP alone, never the per-user key the global limit uses:
 * these are the brute-force targets, and a per-user key would give an attacker
 * one fresh bucket per self-registered account they sign in as.
 */
export function registerBetterAuthRoutes(app: FastifyInstance, handler: RouteHandlerMethod): void {
  for (const url of CREDENTIAL_AUTH_PATHS) {
    app.route({
      config: { rateLimit: { keyGenerator: ipRateLimitKey, max: 20, timeWindow: '1 minute' } },
      handler,
      method: 'POST',
      url,
    });
  }
  app.route({
    config: {
      rateLimit: {
        keyGenerator: ipRateLimitKey,
        max: OAUTH_REGISTER_MAX_PER_MINUTE,
        timeWindow: '1 minute',
      },
    },
    handler,
    method: 'POST',
    url: OAUTH_REGISTER_PATH,
  });
  app.route({ handler, method: ['GET', 'POST'], url: '/api/auth/*' });
}
