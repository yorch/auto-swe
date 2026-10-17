import { createServer } from 'node:http';
import { SERVER_SESSION_USER } from '../fixtures/session';

/**
 * Answers the two calls the Next server itself makes to the gateway (the
 * role gate in `lib/auth.server.ts`), which `page.route` cannot intercept
 * because they leave from Node, not the browser.
 */
export default async function globalSetup() {
  const port = Number(process.env.VISUAL_STUB_PORT ?? 3211);
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    res.setHeader('Content-Type', 'application/json');
    if (path === '/api/v1/auth/me') {
      res.end(JSON.stringify({ data: SERVER_SESSION_USER }));
      return;
    }
    if (path === '/api/v1/platform/usage/scopes') {
      res.end(JSON.stringify({ data: { orgs: [], platform: true, teams: [] } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no stub for ${path}` } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
