#!/usr/bin/env node
/**
 * Write the model configuration the worker's boot gate needs on a fresh
 * database. Run by `yarn quickstart` after `db:seed`:
 *
 *   QUICKSTART_ANTHROPIC_API_KEY=… QUICKSTART_OPENAI_API_KEY=… \
 *     yarn workspace @auto-swe/shared exec tsx --env-file=../../.env src/scripts/seedQuickstart.ts
 *
 * Keys arrive through the environment only, never argv (visible in `ps`), and
 * are stored encrypted under CONFIG_ENCRYPTION_KEY. Existing rows are kept.
 */
import { prisma } from '../db.js';
import {
  applyQuickstartSeed,
  planQuickstartSeed,
  type QuickstartDb,
} from '../lib/quickstartSeed.js';

async function main(): Promise<void> {
  const plan = planQuickstartSeed({
    anthropic: process.env.QUICKSTART_ANTHROPIC_API_KEY,
    openai: process.env.QUICKSTART_OPENAI_API_KEY,
  });
  const result = await applyQuickstartSeed(prisma as unknown as QuickstartDb, plan);
  for (const p of result.credentialsCreated) {
    console.log(`Quickstart: stored a GLOBAL ${p} credential`);
  }
  for (const p of result.credentialsKept) {
    console.log(`Quickstart: kept the existing GLOBAL ${p} credential`);
  }
  if (result.embeddingCreated) {
    console.log('Quickstart: created the embedding configuration');
  }
  for (const p of plan.missing) {
    console.log(`Quickstart: no ${p} key supplied; add one at /models before starting the worker`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
