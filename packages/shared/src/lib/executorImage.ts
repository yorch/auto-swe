import { detectedTarget } from './stackDetection.js';
import { resolveWorkspaceInfra } from './systemConfig.js';

/**
 * The image a repository's workspace should ask `createWorkspace` for, or `undefined` to take
 * the deployment's default (`WORKSPACE_IMAGE`). Most specific first:
 *
 * 1. the connection's `executorImage` — a platform admin's explicit choice, never overridden;
 * 2. the deployer's image for the repository's detected stack (`WORKSPACE_IMAGE_PYTHON|JVM|GO`),
 *    when one is set;
 * 3. `undefined`.
 *
 * Lives in `shared` beside the detection it reads; the worker's workspaces and its image probe
 * both use it. Pass the
 * result straight to `createWorkspace`, never `?? '<some image>'` (a literal there
 * wins the `??` inside `createWorkspace` and the deployment's setting is never read).
 *
 * The stored detection only *selects* among images the deployer configured; it never names one.
 * Node has no entry because the default image is the Node image, and an ambiguous layout, an
 * unlisted tree or an unconfigured stack all fall through to the default — exactly what a
 * repository with no detection gets. The detection is the weekly scan's, so a repository moves
 * to its stack's image when the scan next runs, not when a deployer sets the variable.
 */
export function executorImageFor(repo: {
  detectedStack?: unknown;
  executorImage?: string | null;
}): string | undefined {
  if (repo.executorImage !== null && repo.executorImage !== undefined) {
    return repo.executorImage;
  }
  const target = detectedTarget(repo.detectedStack);
  if (target === null || target === 'ambiguous' || target.stack === 'node') {
    return undefined;
  }
  return resolveWorkspaceInfra().stackImages[target.stack];
}
