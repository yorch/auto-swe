/**
 * Backfill `users.github_login` for accounts linked before the column existed.
 *
 * The account-create hook captures the login for every GitHub link from now on,
 * but a deployment that has been running has linked accounts with no login
 * recorded. Those users cannot be resolved by the repository-permission
 * projection, so under enforcement they would lose access to everything.
 *
 * Run this once after deploying, before turning enforcement on:
 *
 *   yarn workspace @auto-swe/gateway exec tsx src/scripts/backfillGithubLogins.ts
 *
 * Idempotent: users who already have a login are skipped, and a login already
 * claimed by another user is reported rather than moved.
 */
import { prisma } from '@auto-swe/shared/db';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { fetchGithubLogin, storeGithubLogin } from '../lib/githubIdentity.js';

async function main(): Promise<void> {
  const { apiUrl } = await resolveGitHubConfig();

  // Accounts, not users: the GitHub token lives on the account row, and a user
  // with no GitHub account is not a candidate at all.
  const accounts = await prisma.account.findMany({
    select: { accessToken: true, userId: true },
    where: { providerId: 'github', user: { githubLogin: null } },
  });

  console.log(`[backfill] ${accounts.length} linked GitHub account(s) with no login recorded`);

  let written = 0;
  const unresolved: string[] = [];

  for (const account of accounts) {
    if (!account.accessToken) {
      unresolved.push(`${account.userId} (no stored access token)`);
      continue;
    }
    const login = await fetchGithubLogin(account.accessToken, apiUrl);
    if (!login) {
      // A token can be revoked or expired; the user re-links to fix it.
      unresolved.push(`${account.userId} (GitHub did not answer for the stored token)`);
      continue;
    }
    const result = await storeGithubLogin(prisma, account.userId, login);
    if (result.login) {
      written++;
    } else {
      unresolved.push(`${account.userId} (login '${login}' is ${result.reason})`);
    }
  }

  console.log(`[backfill] recorded ${written} login(s)`);
  if (unresolved.length > 0) {
    console.warn(
      `[backfill] ${unresolved.length} account(s) still unresolved — these users cannot be gated on GitHub permission until they re-link:\n  ${unresolved.join('\n  ')}`
    );
  }
}

main()
  .catch((err) => {
    console.error('[backfill] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
