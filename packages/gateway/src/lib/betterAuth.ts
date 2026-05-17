/**
 * Better Auth configuration.
 *
 * Replaces the bcrypt-password-only sign-in flow with a multi-provider
 * setup: email+password, GitHub OAuth, Google OAuth, and email magic links.
 * The existing PAT + JWT bearer paths in `plugins/auth.ts` remain unchanged
 * — those are for programmatic / CLI access. Browser sessions go through
 * better-auth's cookie-based session model.
 *
 * In dev, magic-link emails are logged to the gateway stdout (no real SMTP
 * configured). Production deployments should swap `sendMagicLink` to a real
 * transactional-email transport (Resend / SES / Mailgun / etc.).
 */

import crypto from 'node:crypto';
import { PrismaClient } from '@auto-swe/shared/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { magicLink } from 'better-auth/plugins';

// Reuse the same Prisma client wiring the rest of the gateway uses so we
// hit the same connection pool.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const BASE_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:8080';
const CLIENT_ORIGIN = process.env.CORS_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:3000';

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  // Cookies on the gateway need to be readable by the browser running on
  // a different port. SameSite=Lax is sufficient for top-level GET nav and
  // OAuth callbacks; Secure flips on automatically under HTTPS.
  advanced: {
    crossSubDomainCookies: { enabled: false },
    // Our existing schema uses `@db.Uuid` for every primary key (User row
    // pre-dates better-auth and is referenced by half the system); the
    // better-auth tables we just added follow the same convention. Override
    // better-auth's default nanoid generator to emit RFC-4122 UUIDs so the
    // Postgres `uuid` column accepts them on insert.
    database: { generateId: () => crypto.randomUUID() },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: BASE_URL.startsWith('https://'),
    },
  },
  baseURL: BASE_URL,
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    autoSignIn: true,
    enabled: true,
    minPasswordLength: 8,
    requireEmailVerification: false,
  },
  plugins: [
    magicLink({
      disableSignUp: false,
      expiresIn: 60 * 10, // 10 minutes
      sendMagicLink: async ({ email, url }) => {
        // Dev: log to stdout so engineers can copy-paste the link from logs.
        // Prod: swap this for a real transactional-email transport.
        // biome-ignore lint/suspicious/noConsole: dev-only magic-link delivery
        console.log(
          `\n[magic-link] → ${email}\n[magic-link]   ${url}\n[magic-link]   (link expires in 10 min)\n`
        );
      },
    }),
  ],
  // Strict origins for browser-initiated calls. The Slack OAuth flow keeps
  // its own server-side redirect handling so it doesn't need to appear here.
  secret:
    process.env.BETTER_AUTH_SECRET ??
    'dev-better-auth-secret-please-change-this-in-production-at-least-32-chars',
  socialProviders: {
    ...(githubClientId && githubClientSecret
      ? {
          github: { clientId: githubClientId, clientSecret: githubClientSecret },
        }
      : {}),
    ...(googleClientId && googleClientSecret
      ? {
          google: { clientId: googleClientId, clientSecret: googleClientSecret },
        }
      : {}),
  },
  trustedOrigins: [CLIENT_ORIGIN, BASE_URL],
  // Map better-auth's User fields onto our existing Prisma columns. The
  // legacy `password_hash` column lives on `users` for back-compat (the
  // old admin seed used it) but better-auth stores its own credential hash
  // in the Account row, so this field is optional from better-auth's POV.
  user: {
    additionalFields: {
      isActive: { defaultValue: true, input: false, required: false, type: 'boolean' },
      role: { defaultValue: 'ENGINEER', input: false, required: false, type: 'string' },
      slackId: { input: false, required: false, type: 'string' },
    },
  },
});

/** Helper for the Fastify handler — exposes the auth-list of providers
 *  currently configured (used by the front-end to know which buttons to
 *  show). The presence of credentials in env decides what we advertise. */
export function configuredProviders(): { github: boolean; google: boolean; magicLink: boolean } {
  return {
    github: Boolean(githubClientId && githubClientSecret),
    google: Boolean(googleClientId && googleClientSecret),
    magicLink: true,
  };
}
