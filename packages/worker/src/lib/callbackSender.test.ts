import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhookSignature } from '@auto-swe/shared/lib/webhookSigning';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCallbackError, sendCallback } from './callbackSender.js';

/** "hooks.test" resolves to the local server, and the classifier lets loopback through. */
const LOCAL = {
  classify: () => 'ok' as const,
  proxied: false,
  resolver: async () => [{ address: '127.0.0.1', family: 4 as const }],
};

interface Seen {
  headers: IncomingMessage['headers'];
  body: string;
  url: string | undefined;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(
  handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      seen.push({ body, headers: req.headers, url: req.url });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen };
}

const NOW = 1_760_400_000;
const base = (port: number) => ({
  allowPrivateNetwork: false,
  body: '{"id":"d-1","type":"run.completed"}',
  deliveryId: 'd-1',
  event: 'run.completed',
  nowSec: NOW,
  secrets: ['whsec_current', 'whsec_previous'],
  url: `http://hooks.test:${port}/hooks/run?token=abc`,
});

describe('sendCallback', () => {
  it('POSTs the exact body, signed with both secrets, with the event and delivery headers', async () => {
    const { port, seen } = await serve((_req, res) => res.writeHead(204).end());
    const result = await sendCallback(base(port), LOCAL);
    expect(result).toEqual({ ok: true, statusCode: 204 });
    const req = seen[0] as Seen;
    expect(req.url).toBe('/hooks/run?token=abc');
    expect(req.body).toBe('{"id":"d-1","type":"run.completed"}');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-autoswe-event']).toBe('run.completed');
    expect(req.headers['x-autoswe-delivery']).toBe('d-1');
    const header = req.headers['x-autoswe-signature'] as string;
    expect(header.match(/v1=/g)).toHaveLength(2);
    for (const secret of ['whsec_current', 'whsec_previous']) {
      expect(
        verifyWebhookSignature({ header, nowSec: NOW, rawBody: req.body, secrets: [secret] }).ok
      ).toBe(true);
    }
  });

  it('refuses to follow a redirect', async () => {
    const target = await serve((_req, res) => res.writeHead(200).end());
    const { port } = await serve((_req, res) =>
      res.writeHead(302, { Location: `http://hooks.test:${target.port}/elsewhere` }).end()
    );
    const result = await sendCallback(base(port), LOCAL);
    expect(result).toEqual({ error: 'REDIRECT', ok: false, statusCode: null });
    expect(target.seen).toHaveLength(0);
  });

  it('refuses a name that resolves to a private address, without connecting', async () => {
    const { port, seen } = await serve((_req, res) => res.writeHead(200).end());
    const result = await sendCallback(base(port), {
      proxied: false,
      resolver: async () => [{ address: '10.1.2.3', family: 4 as const }],
    });
    expect(result).toEqual({ error: 'ADDRESS_REFUSED', ok: false, statusCode: null });
    expect(seen).toHaveLength(0);
  });

  it('reports a non-2xx answer by its status code only, never its body', async () => {
    const { port } = await serve((_req, res) =>
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('stack trace with secrets')
    );
    const result = await sendCallback(base(port), LOCAL);
    expect(result).toEqual({ error: 'HTTP_STATUS', ok: false, statusCode: 500 });
    expect(JSON.stringify(result)).not.toContain('secrets');
  });

  it('gives up on a receiver that does not answer in time', async () => {
    const { port } = await serve(() => undefined);
    const result = await sendCallback(base(port), { ...LOCAL, timeoutMs: 200 });
    expect(result).toEqual({ error: 'TIMEOUT', ok: false, statusCode: null });
  });

  it('classifies an unknown failure as NETWORK, whatever its text', () => {
    expect(classifyCallbackError(new TypeError('fetch failed: secret detail'))).toBe('NETWORK');
  });
});
