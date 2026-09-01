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
};

export default nextConfig;
