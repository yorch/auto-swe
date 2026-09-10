/**
 * Worker-side GitHub credential resolution.
 *
 * The mechanics live in `@auto-swe/shared/lib/githubInstallation` so the
 * gateway resolves the same installation the same way. What stays here is the
 * Temporal-specific part: a missing credential is a configuration condition, not
 * a transient one, so it must not burn an activity's retry budget.
 */
import {
  GitHubTokenMissingError,
  type InstallationTarget,
  resolveGitHubToken,
} from '@auto-swe/shared/lib/githubInstallation';
import type { ResolvedGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';

export {
  clearInstallationTokenCache,
  GitHubTokenMissingError,
  type InstallationTarget,
  resolveGitHubToken,
} from '@auto-swe/shared/lib/githubInstallation';

/**
 * Like resolveGitHubToken but converts GitHubTokenMissingError into
 * ApplicationFailure.nonRetryable so Temporal does not burn retry budget
 * on a missing-config condition. Use this in all activity call sites.
 */
export async function requireGitHubToken(
  config: ResolvedGitHubConfig,
  target: InstallationTarget = {}
): Promise<string> {
  try {
    return await resolveGitHubToken(config, target);
  } catch (err) {
    if (err instanceof GitHubTokenMissingError) {
      throw ApplicationFailure.nonRetryable(
        `GitHub token not configured. Set it at /admin/integrations.`,
        'CONFIG_MISSING'
      );
    }
    throw err;
  }
}
