/**
 * Image allowlist for phase-6 user-authored shell steps.
 *
 * Built-in defaults are statically allowed for every team. Additional images
 * can be added per team via `Team.shellImageAllowlist` (managed by team
 * admins through the gateway). The runtime checks the merged set at workflow
 * start; an unknown image rejects the activity before any docker call runs.
 *
 * The matching rule is exact-string equality on `image:tag`. We deliberately
 * don't pattern-match on the registry/org prefix — a typo'd allowlist entry
 * shouldn't silently grant access to a similarly-named image.
 *
 * Lives in `shared` so the gateway can validate templates without depending
 * on the worker package.
 */

export const BUILTIN_SHELL_IMAGES: readonly string[] = Object.freeze([
  // Both Node majors are permitted, and neither is redundant. node:26-alpine
  // matches the Node the services run on; node:24-alpine is still the workspace
  // default, because it is the only one of the two carrying `yarn` — and
  // `DEFAULT_COMMANDS` in the worker's qualityGates activity makes every
  // built-in gate a `yarn` command, so a shell step on a yarn-less image fails
  // with 127 rather than a real result.
  //
  // Dropping either entry would reject already-stored templates that pin it,
  // and the allowlist is re-checked at container launch, so that rejection
  // lands mid-run.
  'node:26-alpine',
  'node:24-alpine',
  'python:3.13-alpine',
  'alpine:latest',
]);

/**
 * Regex for validating Docker image references (`registry/org/name:tag@sha256:digest`).
 * Used by allowlist input validation in the gateway and as a defense-in-depth
 * guard against argv smuggling in the worker. Exact character set; no whitespace.
 */
export const DOCKER_IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;

export class ShellImageNotAllowedError extends Error {
  readonly image: string;
  readonly allowed: readonly string[];
  constructor(image: string, allowed: readonly string[]) {
    super(
      `image '${image}' is not on the shell-step allowlist for this team. ` +
        `Built-in images: ${BUILTIN_SHELL_IMAGES.join(', ')}. ` +
        `Allowed for this team: ${allowed.length ? allowed.join(', ') : '(none beyond built-ins)'}.`
    );
    this.name = 'ShellImageNotAllowedError';
    this.image = image;
    this.allowed = allowed;
  }
}

/**
 * Merge built-in + per-team allowlist entries with the exact image string.
 * Returns true when the image is permitted. Empty/whitespace entries are
 * ignored so a malformed `Team.shellImageAllowlist` row can't accidentally
 * pass an empty string through.
 */
export function isShellImageAllowed(
  image: string,
  teamAllowlist: readonly string[] | null | undefined
): boolean {
  if (!image || image.trim().length === 0) {
    return false;
  }
  if (BUILTIN_SHELL_IMAGES.includes(image)) {
    return true;
  }
  if (!teamAllowlist || teamAllowlist.length === 0) {
    return false;
  }
  for (const entry of teamAllowlist) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length > 0 && trimmed === image) {
      return true;
    }
  }
  return false;
}

/**
 * Throws {@link ShellImageNotAllowedError} when the image is rejected. Used
 * by the gateway (template save validation) and the worker activity
 * (runtime guard) so both pathways enforce the same rule.
 */
export function assertShellImageAllowed(
  image: string,
  teamAllowlist: readonly string[] | null | undefined
): void {
  if (!isShellImageAllowed(image, teamAllowlist)) {
    throw new ShellImageNotAllowedError(image, teamAllowlist ?? []);
  }
}
