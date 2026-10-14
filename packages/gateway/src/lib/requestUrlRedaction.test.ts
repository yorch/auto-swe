import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { redactedRequestSerializer, redactRequestUrl } from './requestUrlRedaction.js';

const TOKEN = '6f1c2a9e-0b7d-4c55-9a1e-3d2f8b7c6a51';

describe('redactRequestUrl', () => {
  it.each([
    [`/api/v1/webhooks/${TOKEN}`, '/api/v1/webhooks/[redacted]'],
    [`/api/v1/webhooks/${TOKEN}?x=1`, '/api/v1/webhooks/[redacted]?x=1'],
    [`/api/v1/webhooks/${TOKEN}/extra`, '/api/v1/webhooks/[redacted]/extra'],
    [`/API/V1/WEBHOOKS/${TOKEN}`, '/API/V1/WEBHOOKS/[redacted]'],
    ['/api/v1/webhooks/not-a-uuid-but-still-a-token', '/api/v1/webhooks/[redacted]'],
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
});
