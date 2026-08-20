/**
 * Provision a better-auth credential account for the seeded admin user.
 *
 * The legacy `yarn db:seed` (in packages/shared) creates the admin User row
 * with a bcrypt `passwordHash` so the hand-rolled /api/v1/auth/login still
 * works. Better-auth uses a *different* hashing scheme (scrypt) and stores
 * the hash in its `Account` table with `providerId='credential'`. Without
 * this row, the admin can sign in via magic link / GitHub / Google, but
 * the email+password tab on /login (which now routes through better-auth)
 * has no credentials to verify against.
 *
 * This script idempotently:
 *   1. Finds the admin user by email (default `admin@auto-swe.local`)
 *   2. Hashes `SEED_ADMIN_PASSWORD` (or a generated random) via better-auth's
 *      own password util — guarantees the format matches what `signInEmail`
 *      expects.
 *   3. Upserts the credential Account row pointing at that user.
 *
 * Run after `yarn db:seed` (or as part of the chained `yarn db:seed:auth`).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { expand } from 'dotenv-expand';

// Load the monorepo-root .env so DATABASE_URL / BETTER_AUTH_SECRET / etc.
// resolve when the script is invoked directly via `tsx`. Mirrors the dotenv
// preload that `prisma.config.ts` does for the shared workspace.
const here = path.dirname(fileURLToPath(import.meta.url));
expand(dotenv.config({ path: path.resolve(here, '../../../../.env'), quiet: true }));

// Lazy import to make sure dotenv has populated process.env first.
const { initAuth, getAuth } = await import('../lib/betterAuth.js');
await initAuth();
const auth = getAuth();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@auto-swe.local';

// `createLocalAccountIssuer('credential')` from @better-auth/core/db. Inlined
// rather than imported: that entry point is internal to better-auth, and this
// value is also hard-coded in the 00000000000002 backfill migration, so the two
// have to be read side by side anyway.
const CREDENTIAL_ISSUER = 'local:credential';

async function main() {
  // Re-derive the password the same way the shared seed does so the two
  // paths (legacy bcrypt + better-auth scrypt) agree on the value.
  let password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(16).toString('hex');
    console.log(`[provisionAuthAdmin] generated random password: ${password}`);
    console.log('[provisionAuthAdmin]   set SEED_ADMIN_PASSWORD to keep it stable across runs');
  }

  // better-auth's internal context exposes the password helpers we need
  // without forcing us to spin up a real Fastify request to /sign-up/email.
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);

  // Find the existing User row (created by the shared seed). If absent, the
  // shared seed hasn't been run yet — bail loudly so the user runs them in
  // the right order.
  // biome-ignore lint/suspicious/noExplicitAny: betterAuth lazy singleton requires any for type deferral
  const user = await (ctx.adapter.findOne as any)({
    model: 'user',
    where: [{ field: 'email', operator: 'eq', value: ADMIN_EMAIL }],
  });
  if (!user) {
    throw new Error(
      `Admin user ${ADMIN_EMAIL} not found. Run \`yarn db:seed\` first to create the User row.`
    );
  }

  // Idempotent upsert into the Account table. Since better-auth 1.7 an account
  // is keyed by (issuer, accountId); credential accounts carry the synthetic
  // `local:credential` issuer that `createLocalAccountIssuer('credential')`
  // produces, and sign-in matches on it exactly.
  // biome-ignore lint/suspicious/noExplicitAny: betterAuth lazy singleton requires any for type deferral
  const existing = await (ctx.adapter.findOne as any)({
    model: 'account',
    where: [
      { field: 'issuer', operator: 'eq', value: CREDENTIAL_ISSUER },
      { connector: 'AND', field: 'accountId', operator: 'eq', value: user.id },
    ],
  });

  if (existing) {
    await ctx.adapter.update({
      model: 'account',
      update: { password: hash, updatedAt: new Date() },
      where: [{ field: 'id', operator: 'eq', value: existing.id }],
    });
    console.log(`[provisionAuthAdmin] updated credential password for ${ADMIN_EMAIL}`);
  } else {
    await ctx.adapter.create({
      data: {
        accountId: user.id,
        createdAt: new Date(),
        issuer: CREDENTIAL_ISSUER,
        password: hash,
        providerId: 'credential',
        updatedAt: new Date(),
        userId: user.id,
      },
      model: 'account',
    });
    console.log(`[provisionAuthAdmin] created credential account for ${ADMIN_EMAIL}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[provisionAuthAdmin] failed:', err);
    process.exit(1);
  });
