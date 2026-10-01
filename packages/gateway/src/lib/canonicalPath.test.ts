import http from 'node:http';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { isCanonicalRequestPath } from './canonicalPath.js';

describe('isCanonicalRequestPath', () => {
  it('accepts a path already in the form URL resolution produces', () => {
    expect(isCanonicalRequestPath('/api/auth/sign-in/email')).toBe(true);
    expect(isCanonicalRequestPath('/api/auth/get-session?disableCookieCache=true')).toBe(true);
    // Percent-encoding of an ordinary character is not a dot segment.
    expect(isCanonicalRequestPath('/api/auth/sign-in/%65mail')).toBe(true);
  });

  it('rejects a path that resolves to a different one', () => {
    for (const path of [
      '/api/auth/./sign-in/email',
      '/api/auth/x/../sign-in/email',
      '/api/auth/%2e/sign-in/email',
      '/api/auth/%2E%2E/auth/sign-in/email',
      '/api/auth/sign-in\\email',
    ]) {
      expect(isCanonicalRequestPath(path), path).toBe(false);
    }
  });
});

/**
 * The routing shape `index.ts` uses for better-auth — an exact route that
 * carries a stricter policy, and a wildcard for everything else, both served
 * by one handler that resolves the URL before dispatch — over a real socket,
 * since that is where a raw path and a resolved one can disagree.
 */
describe('a strict route beside a wildcard, over HTTP', () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function serve() {
    const app = Fastify();
    const served: string[] = [];
    const handler = (route: string) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isCanonicalRequestPath(request.url)) {
        return reply.status(400).send({ error: { code: 'NON_CANONICAL_PATH' } });
      }
      served.push(`${route} ${new URL(request.url, 'http://h').pathname}`);
      return 'ok';
    };
    app.route({ handler: handler('strict'), method: 'POST', url: '/api/auth/sign-in/email' });
    app.route({ handler: handler('wildcard'), method: ['GET', 'POST'], url: '/api/auth/*' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    close = () => app.close();
    const { port } = app.server.address() as { port: number };
    const post = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', method: 'POST', path, port }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
    return { post, served };
  }

  it('serves the strict path only through the strict route', async () => {
    const { post, served } = await serve();
    expect(await post('/api/auth/sign-in/email')).toBe(200);
    for (const path of [
      '/api/auth/./sign-in/email',
      '/api/auth/x/../sign-in/email',
      '/api/auth/%2e/sign-in/email',
    ]) {
      expect(await post(path), path).toBe(400);
    }
    // Nothing reached the handler's dispatch through the wildcard.
    expect(served).toEqual(['strict /api/auth/sign-in/email']);
  });
});
