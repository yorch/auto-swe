/**
 * Whether, and why not, a reviewer can write to a repository's pull requests as themselves. The
 * credential is only ever the one they saved for that repository, and what is missing is never made
 * up with the platform's: a review or a comment sent from the page is the person's act, and the
 * host, the audit log and the launcher exclusion must all see it as theirs.
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  CredentialUnreadableError,
  resolveUserCredential,
  resolveUserCredentialPolicy,
  type UsableCredential,
} from '@auto-swe/shared/lib/connectionCredential';
import { ScmProviderMismatchError } from '@auto-swe/shared/lib/githubHostScope';

/**
 * `disabled`: an operator has the saved-token switch off. `no-token`: they saved none for this
 * repository. `unusable`: they saved one that may not be used now (the repository moved to another
 * host or origin or to another source-control provider, or they have left its team). `unreadable`: it cannot be decrypted any more.
 */
export type WriteUnavailable = 'disabled' | 'no-token' | 'unreadable' | 'unusable';

export type ReviewerWrite =
  | { available: true; credential: UsableCredential }
  | { available: false; reason: WriteUnavailable };

/**
 * A database failure throws: reading it as "no token" would send a reviewer to save one that is
 * already there, and reading it as the platform's would change who the write is by.
 */
export async function resolveReviewerWrite(
  prisma: PrismaClient,
  args: { connectionId: string; userId: string }
): Promise<ReviewerWrite> {
  let credential: UsableCredential | null;
  try {
    credential = await resolveUserCredential(prisma, args);
  } catch (err) {
    if (err instanceof CredentialUnreadableError) {
      return { available: false, reason: 'unreadable' };
    }
    // The repository is now served by another provider (the column changed after a token was
    // saved): a saved GitHub token is never used for it. A standing condition the page can show,
    // not a server error.
    if (err instanceof ScmProviderMismatchError) {
      return { available: false, reason: 'unusable' };
    }
    throw err;
  }
  if (credential) {
    return { available: true, credential };
  }
  if (!(await resolveUserCredentialPolicy()).enabled) {
    return { available: false, reason: 'disabled' };
  }
  const saved = await prisma.connectionCredential.findUnique({
    select: { id: true },
    where: { connectionId_userId: args },
  });
  return { available: false, reason: saved ? 'unusable' : 'no-token' };
}
