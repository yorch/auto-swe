import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as {
  version: string;
};

// Per-user dev origins come from the environment so a developer's Tailscale/
// LAN IP is never committed. Values are plain hostnames/IPs, comma-separated,
// no scheme or port (e.g. "100.64.0.10,my-host.tailnet.ts.net"). Next.js
// only honours `allowedDevOrigins` under `next dev`, so this has no effect on
// the production build.
const extraDevOrigins =
  process.env.ALLOWED_DEV_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0) ?? [];

/**
 * Addresses the dashboard used before its navigation was regrouped into Work, Build and
 * Admin, each sent permanently to where the page lives now. Next keeps the query string
 * and fills `:path*` with the rest of the path, so a deep link (`/workflows/library/<id>/diff`,
 * `/govern/approvals?status=x`) lands on the same view.
 *
 * Order matters: the first matching rule wins. The specific rules come before the prefix
 * rules that would otherwise swallow them — `/workflows/library/…` before `/workflows/…`,
 * `/govern/approvals` before `/govern/…`. No old prefix is reused by a new page, so every old
 * address maps to exactly one new one.
 *
 * These run before `src/proxy.ts`: a signed-out visitor to an old address is first sent to
 * the new one, and the proxy then sends that to `/login?redirect=<new address>`.
 */
export const LEGACY_REDIRECTS: { source: string; destination: string }[] = [
  // Work. Requests left /workflows, and the library left /workflows/library for Build.
  { destination: '/library', source: '/workflows/library' },
  { destination: '/library/:path*', source: '/workflows/library/:path*' },
  { destination: '/requests', source: '/workflows' },
  { destination: '/requests/:path*', source: '/workflows/:path*' },
  { destination: '/approvals', source: '/govern/approvals' },
  // The approvals page's first address; Slack notifications and run callbacks linked here.
  { destination: '/approvals', source: '/inbox' },
  // Build: the Studio pages that are authoring move to the top level.
  { destination: '/agents', source: '/studio/agents/library' },
  { destination: '/agents', source: '/studio/agents' },
  { destination: '/skills', source: '/studio/skills' },
  { destination: '/models', source: '/studio/models' },
  { destination: '/mcp', source: '/studio/mcp' },
  { destination: '/bundles', source: '/studio/bundles' },
  // Admin: the Studio pages that are administration, then every Govern page.
  { destination: '/admin/integrations', source: '/studio/integrations' },
  { destination: '/admin/github-installations', source: '/studio/github-installations' },
  // Budget alerts became the "Alerting only" filter on Organizations.
  { destination: '/admin/organizations?alerting=1', source: '/govern/budget-alerts' },
  // Knowledge: the two pages every role reads left Admin for their own group.
  { destination: '/lessons', source: '/admin/lessons' },
  { destination: '/knowledge', source: '/admin/knowledge' },
  { destination: '/lessons', source: '/govern/lessons' },
  { destination: '/knowledge', source: '/govern/knowledge' },
  { destination: '/admin', source: '/govern' },
  { destination: '/admin/:path*', source: '/govern/:path*' },
];

const nextConfig: NextConfig = {
  // Allow the dev server to serve _next/static, HMR, and font resources when
  // the browser reaches it via a non-localhost IP/hostname. Without this,
  // Next 16 blocks cross-origin dev resource requests and the client bundle
  // never hydrates. localhost/127.0.0.1 cover the common case; add your own
  // IP via ALLOWED_DEV_ORIGINS in .env.
  allowedDevOrigins: [...extraDevOrigins, 'localhost', '127.0.0.1'],
  // Inject build-time constants we want to surface in the UI. Keep these
  // small — anything under NEXT_PUBLIC_* ends up in the client bundle.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  experimental: { useTypeScriptCli: true },
  output: 'standalone',
  reactStrictMode: true,
  redirects: async () => LEGACY_REDIRECTS.map((rule) => ({ ...rule, permanent: true })),
};

export default nextConfig;
