/**
 * Approving a GitHub sign-in on the strength of an organization membership.
 *
 * New accounts wait in the approval queue (`isActive: false`). When an admin lists
 * organizations in `github.signInAutoApproveOrgs`, a user who signs in with GitHub and
 * is a member of one of them is approved without waiting.
 *
 * Everything here fails closed and never throws: it runs on the sign-in path, so an
 * outage, a rejected credential or a private membership leaves the user in the queue
 * (where they were) rather than blocking sign-in or approving on a guess.
 */

import type { PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { resolveGitHubToken } from '@auto-swe/shared/lib/githubInstallation';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { resolveGithubApiUrl } from './githubEnterpriseAuth.js';

/** Wall-clock cap: this sits on the sign-in path, so it must not hang it. */
const MEMBERSHIP_TIMEOUT_MS = 5_000;

export type OrgMembership = 'member' | 'not-member' | 'unavailable';

/**
 * Is `login` a member of `org`, asked with the platform credential?
 *
 * `GET /orgs/{org}/members/{login}` answers 204 for a member. A 404 means "not a
 * member" (or an organization the credential cannot see — the same outcome here). A
 * 302 is GitHub saying the *credential's owner* is not itself a member and so can only
 * see public members: that is "could not ask", never a verdict, and following it would
 * answer a different question, so redirects are not followed.
 */
export async function fetchOrgMembership(args: {
  apiUrl: string;
  token: string;
  org: string;
  login: string;
}): Promise<OrgMembership> {
  const url =
    `${args.apiUrl.replace(/\/$/, '')}/orgs/${encodeURIComponent(args.org)}` +
    `/members/${encodeURIComponent(args.login)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${args.token}`,
        'User-Agent': 'auto-swe/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(MEMBERSHIP_TIMEOUT_MS),
    });
    if (res.status === 204) {
      return 'member';
    }
    if (res.status === 404) {
      return 'not-member';
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export type AutoApproveOutcome =
  | { approved: true; org: string }
  | {
      approved: false;
      reason:
        | 'disabled'
        | 'not-pending'
        | 'not-sole-account'
        | 'email-unverified'
        | 'no-login'
        | 'no-credential'
        | 'not-member'
        | 'unavailable'
        | 'raced';
    };

/** The pieces a test replaces; production wires the real ones. */
export interface AutoApproveDeps {
  orgs: () => Promise<string[]>;
  /** The platform credential's token and the API root it is valid on, or null. */
  credential: () => Promise<{ apiUrl: string; token: string } | null>;
  membership: typeof fetchOrgMembership;
  now: () => Date;
}

async function platformCredentialForSignIn(): Promise<{ apiUrl: string; token: string } | null> {
  try {
    const config = await resolveGitHubConfig();
    // The API root sign-in itself resolved, so the credential goes to the host the user
    // authenticated against; `resolveGitHubToken` refuses a host that is not the one the
    // credential belongs to.
    const apiUrl = resolveGithubApiUrl(config.baseUrl, config.apiUrl);
    if (!apiUrl) {
      return null;
    }
    const token = await resolveGitHubToken(config, { apiUrl });
    return { apiUrl, token };
  } catch {
    return null;
  }
}

const defaultDeps: AutoApproveDeps = {
  credential: platformCredentialForSignIn,
  membership: fetchOrgMembership,
  now: () => new Date(),
  orgs: async () => resolveSetting('github.signInAutoApproveOrgs'),
};

/**
 * Approve `userId` if they are still waiting in the queue and belong to a listed
 * organization.
 *
 * Called from the better-auth `account.create.after` hook for a GitHub account, after the
 * user's GitHub login has been recorded. That hook also fires when GitHub is linked to an
 * existing user, so the conditions are about the user, not about the request:
 *
 * - `isActive` is false and `approvedAt` is null — still waiting, never approved. A
 *   deactivated account has been approved once, so deactivation sticks.
 * - GitHub is the only account the user has, so a user who already signs in another way
 *   is not carried through by a GitHub link.
 * - The email is verified and a GitHub login is on record, which is the identity the
 *   membership is asked about.
 *
 * The write is conditional on the same state, so two concurrent sign-ins approve once.
 */
export async function autoApproveGithubUser(
  prisma: PrismaClient,
  userId: string,
  deps: AutoApproveDeps = defaultDeps
): Promise<AutoApproveOutcome> {
  const orgs = await deps.orgs();
  if (orgs.length === 0) {
    return { approved: false, reason: 'disabled' };
  }

  const user = await prisma.user.findUnique({
    select: { approvedAt: true, emailVerified: true, githubLogin: true, isActive: true },
    where: { id: userId },
  });
  if (!user || user.isActive || user.approvedAt) {
    return { approved: false, reason: 'not-pending' };
  }
  if ((await prisma.account.count({ where: { userId } })) !== 1) {
    return { approved: false, reason: 'not-sole-account' };
  }
  if (!user.emailVerified) {
    return { approved: false, reason: 'email-unverified' };
  }
  if (!user.githubLogin) {
    return { approved: false, reason: 'no-login' };
  }

  const credential = await deps.credential();
  if (!credential) {
    return { approved: false, reason: 'no-credential' };
  }

  let answered = false;
  let matched: string | null = null;
  for (const org of orgs) {
    const verdict = await deps.membership({
      apiUrl: credential.apiUrl,
      login: user.githubLogin,
      org,
      token: credential.token,
    });
    if (verdict === 'member') {
      matched = org;
      break;
    }
    if (verdict === 'not-member') {
      answered = true;
    }
  }
  if (!matched) {
    return { approved: false, reason: answered ? 'not-member' : 'unavailable' };
  }

  const approvedAt = deps.now();
  const approvalSource = `github-org:${matched}`;
  const won = await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      data: { approvalSource, approvedAt, isActive: true },
      where: { approvedAt: null, id: userId, isActive: false },
    });
    if (count !== 1) {
      return false;
    }
    await tx.configAuditLog.create({
      data: {
        action: 'UPDATE',
        actorId: null,
        afterJson: { approvalSource, githubLogin: user.githubLogin, isActive: true },
        beforeJson: { isActive: false },
        entityId: userId,
        entityType: 'User',
      },
    });
    return true;
  });
  return won ? { approved: true, org: matched } : { approved: false, reason: 'raced' };
}
