import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** The urlencoded body exactly as received, before repeated keys were collapsed into an object. */
    rawFormBody?: string;
  }
}

/**
 * Accept HTML form posts (application/x-www-form-urlencoded) everywhere —
 * without this Fastify 415s them before any handler runs, which is how the
 * better-auth social sign-in buttons silently broke. The Slack routes
 * (slash commands, interactivity) rely on this parser too.
 *
 * The parsed object keeps the last value of a repeated key, so the string is also kept on
 * the request: the OAuth endpoints are specified over repeated keys (RFC 8707 `resource`),
 * and a policy check must see what the client sent, not what survived the collapse.
 */
export function registerFormBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        req.rawFormBody = body as string;
        const out: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(body as string)) {
          out[k] = v;
        }
        done(null, out);
      } catch (err) {
        done(err as Error);
      }
    }
  );
}
