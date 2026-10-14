import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  redactedRequestSerializer,
  redactingLogMethod,
  redactLogText,
  redactRequestUrl,
} from './requestUrlRedaction.js';

const TOKEN = '6f1c2a9e-0b7d-4c55-9a1e-3d2f8b7c6a51';

describe('redactRequestUrl', () => {
  it.each([
    [`/api/v1/webhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [`/api/v1/webhooks/${TOKEN}?x=1`, '/api/v1/webhooks/[redacted]?x=1'],
    [`/api/v1/webhooks/${TOKEN}/extra`, '/api/v1/webhooks/[redacted]/extra'],
    [`/API/V1/WEBHOOKS/${TOKEN}`, '/API/V1/WEBHOOKS/[redacted]'],
    ['/api/v1/webhooks/not-a-uuid-but-still-a-token', '/api/v1/webhooks/[redacted]'],
    // Percent-encoded spellings the router still matches to /:token.
    [`/api/v1/%77ebhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [`/%61pi/v1/webhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [
      `/api/v1/webhooks/${encodeURIComponent(TOKEN).replace(/6/g, '%36')}`,
      '/api/v1/webhooks/[redacted]',
    ],
    // Paths the router 404s, but that are still logged and traced (OTel resolves `..`).
    [`/api/v1/webhooks//${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [`/api//v1/webhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [`/api/v1/x/../webhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [`/api/v1/./webhooks/${TOKEN}/`, '/api/v1/webhooks/[redacted]/'],
    [`/api/v1/%2e%2e/v1/webhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    // An encoded slash is not a separator: the whole segment is the token.
    [`/api/v1/webhooks/${TOKEN}%2Fx`, '/api/v1/webhooks/[redacted]'],
  ])('redacts the token in %s', (url, expected) => {
    expect(redactRequestUrl(url)).toBe(expected);
  });

  it.each([
    '/api/v1/webhooks/git',
    '/api/v1/webhooks/ci',
    '/api/v1/webhooks/access',
    '/api/v1/webhooks/jira?x=1',
    '/api/v1/webhooks/slack',
    '/api/v1/webhooks/',
    '/api/v1/workflow-templates/abc/webhook/regenerate',
    '/health',
  ])('leaves %s readable', (url) => {
    expect(redactRequestUrl(url)).toBe(url);
  });
});

describe('redactLogText', () => {
  it('redacts a URL inside a message', () => {
    expect(redactLogText(`Route POST:/api/v1/webhooks/${TOKEN}/ not found`)).toBe(
      'Route POST:/api/v1/webhooks/[redacted]/ not found'
    );
    expect(redactLogText('incoming request')).toBe('incoming request');
  });
});

describe('redactedRequestSerializer', () => {
  it('keeps the token out of the request log line Fastify writes', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        serializers: { req: redactedRequestSerializer },
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    app.post('/api/v1/webhooks/:token', async () => ({ ok: true }));
    await app.ready();
    await app.inject({ method: 'POST', payload: {}, url: `/api/v1/webhooks/${TOKEN}` });
    await app.close();

    const all = lines.join('\n');
    expect(all).toContain('/api/v1/webhooks/[redacted]');
    expect(all).not.toContain(TOKEN);
  });

  it('keeps the token out of the not-found line and of encoded spellings', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        hooks: { logMethod: redactingLogMethod },
        level: 'info',
        serializers: { req: redactedRequestSerializer },
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    app.post('/api/v1/webhooks/:token', async () => ({ ok: true }));
    await app.ready();
    const routed = await app.inject({
      method: 'POST',
      payload: {},
      url: `/api/v1/%77ebhooks/${TOKEN}`,
    });
    expect(routed.statusCode).toBe(200);
    for (const url of [
      `/api/v1/webhooks/${TOKEN}/extra`,
      `/api/v1/webhooks//${TOKEN}`,
      `/api//v1/webhooks/${TOKEN}`,
      `/api/v1/x/../webhooks/${TOKEN}`,
    ]) {
      // Most 404; whichever the router accepts or refuses, the token must not be logged.
      await app.inject({ method: 'POST', payload: {}, url });
    }
    await app.close();

    const all = lines.join('\n');
    expect(all).toContain('not found');
    expect(all).not.toContain(TOKEN);
  });
});
