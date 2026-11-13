import { resolveSetting } from '@auto-swe/shared/config';
import type { StandInOptions } from '../activities/scanDiffText.js';

/**
 * The options the diff stand-in is built with: the `workspace.nulAllowedPaths` list. The setting
 * is platform-wide (GLOBAL only), so no run scope changes its value; the context is passed on
 * anyway so a later change to the definition cannot silently resolve a broader value.
 *
 * Fails closed: a list that cannot be read (or that is not a list of strings) is the empty list,
 * which refuses a NUL byte in a file not named like a binary and allows nothing. Reading it must
 * never abort the step that is about to run the security gate.
 */
export async function resolveStandInOptions(
  ctx?: Parameters<typeof resolveSetting>[1]
): Promise<StandInOptions> {
  try {
    const paths = await resolveSetting('workspace.nulAllowedPaths', ctx);
    if (Array.isArray(paths) && paths.every((p) => typeof p === 'string')) {
      return { nulAllowedPaths: paths };
    }
  } catch {
    // fall through to the empty list
  }
  return { nulAllowedPaths: [] };
}
