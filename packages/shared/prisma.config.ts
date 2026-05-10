import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { expand } from 'dotenv-expand';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 resolves `env(...)` eagerly when this config loads. When the script
// runs from packages/shared (yarn workspace), the monorepo root `.env` is not
// auto-loaded, and dotenv v17 does not expand `${VAR}` interpolation. Load and
// expand the root .env explicitly here so DATABASE_URL is a real DSN.
const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, '../../.env');
expand(dotenv.config({ path: rootEnv, quiet: true }));

export default defineConfig({
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'src/prisma/migrations',
    seed: 'tsx src/prisma/seed.ts',
  },
  schema: 'src/prisma/schema.prisma',
});
