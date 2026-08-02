#!/usr/bin/env node
/**
 * Re-encrypt every stored secret under the current `CONFIG_ENCRYPTION_KEY`.
 *
 *   yarn keys:rotate --dry-run   # report what would move, touch nothing
 *   yarn keys:rotate             # do it
 *
 * Rotation procedure:
 *   1. Generate a new key: `openssl rand -base64 32`
 *   2. Set on gateway AND worker:
 *        CONFIG_ENCRYPTION_KEY=<new>
 *        CONFIG_ENCRYPTION_KEY_VERSION=<old version + 1>
 *        CONFIG_ENCRYPTION_KEY_PREVIOUS=<old>
 *   3. Restart both. Existing rows still decrypt under the previous key; new
 *      writes are stamped with the new version.
 *   4. Run this with `--dry-run`, then for real.
 *   5. Once it reports nothing left to rotate, drop
 *      `CONFIG_ENCRYPTION_KEY_PREVIOUS` and restart.
 *
 * Step 3 is what makes this safe to run against a live deployment: at no point
 * is there a key the running services cannot read.
 */
import { prisma } from '../db.js';
import { rotateEncryptionKey } from '../lib/keyRotation.js';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('Dry run — nothing will be written.\n');
  }

  const report = await rotateEncryptionKey({ dryRun });

  const rotatedTotal = Object.values(report.rotated).reduce((a, b) => a + b, 0);
  console.log(`Target key version: ${report.toVersion}`);
  console.log(`Rows ${dryRun ? 'that would be ' : ''}re-encrypted: ${rotatedTotal}`);
  for (const [model, count] of Object.entries(report.rotated).sort()) {
    console.log(`  ${model}: ${count}`);
  }
  console.log(`Fields already at version ${report.toVersion}: ${report.skipped}`);

  if (report.failed.length > 0) {
    console.error(`\n${report.failed.length} field(s) could not be decrypted:\n`);
    for (const f of report.failed) {
      console.error(`  ${f.model}.${f.field} (id ${f.id}): ${f.reason}`);
    }
    console.error(
      '\nThese rows were left untouched. Set CONFIG_ENCRYPTION_KEY_PREVIOUS to the key ' +
        'they were written with and run again — do NOT drop the previous key yet.'
    );
    process.exitCode = 1;
    return;
  }

  if (!dryRun && rotatedTotal > 0) {
    console.log('\nDone. Once every service has restarted, remove CONFIG_ENCRYPTION_KEY_PREVIOUS.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
