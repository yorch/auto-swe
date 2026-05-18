import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as {
  version: string;
};

const nextConfig: NextConfig = {
  // Inject build-time constants we want to surface in the UI. Keep these
  // small — anything under NEXT_PUBLIC_* ends up in the client bundle.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  output: 'standalone',
  reactStrictMode: true,
};

export default nextConfig;
