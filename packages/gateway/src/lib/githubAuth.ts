/**
 * Gateway-side GitHub credential resolution.
 *
 * The mechanics — App JWT, installation token, per-installation cache, PAT
 * fallback — live in `@auto-swe/shared/lib/githubInstallation` so the worker
 * resolves the same installation the same way. This file exists to re-export
 * them under the names the gateway already imports.
 */
export {
  clearInstallationTokenCache,
  GitHubTokenMissingError,
  type InstallationTarget,
  resolveGitHubToken,
} from '@auto-swe/shared/lib/githubInstallation';
