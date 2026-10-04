/**
 * What a failed skill-source fetch may say.
 *
 * Node puts header values and URL userinfo into fetch's error messages, and a
 * provider's response body can echo a request back, so no message text from
 * either ever leaves this module: every failure is one of the codes below, and
 * its message is the fixed string beside it. That string is what reaches the
 * API, the logs, the CLI and `SkillSource.lastError`.
 */
export const SKILL_SOURCE_ERRORS = {
  BAD_PATH: 'the repository contains an unsafe path',
  BAD_RESPONSE: 'unrecognised response from the host',
  HOST_BLOCKED: 'the host resolves to a blocked address or is not allowed',
  HOST_NOT_APPROVED: 'host is not an approved repository host',
  HTTP_ERROR: 'the host returned an error',
  INVALID_SOURCE: 'invalid source (host, owner, repository, path or ref)',
  LIMIT_BYTES: 'the source exceeds the total size limit',
  LIMIT_SKILLS: 'the source holds more skills than the limit',
  NETWORK: 'request failed',
  NO_SKILLS: 'no SKILL.md found under the path',
  NOT_FOUND: 'repository, ref or path not found, or not accessible',
  RATE_LIMITED: 'rate limited by the host',
  REDIRECT_BLOCKED: 'a redirect led somewhere not allowed',
  SHA_MOVED: 'the ref no longer resolves to the commit that was previewed',
  TIMEOUT: 'timed out',
  TOO_MANY_REDIRECTS: 'too many redirects',
  TREE_TRUNCATED: 'the repository tree is too large to list completely',
  UNAUTHORIZED: 'not authorised: the platform credential cannot read this repository',
} as const;

export type SkillSourceErrorCode = keyof typeof SKILL_SOURCE_ERRORS;

const SAFE_TOKEN = /^[A-Za-z0-9_]{1,40}$/;

/** A failure whose `message` is always the fixed string for its `code`. */
export class SkillSourceError extends Error {
  readonly code: SkillSourceErrorCode;
  constructor(code: SkillSourceErrorCode, detail?: string) {
    super(detail ? `${SKILL_SOURCE_ERRORS[code]} (${detail})` : SKILL_SOURCE_ERRORS[code]);
    this.name = 'SkillSourceError';
    this.code = code;
  }
}

/**
 * A thrown fetch error as a fixed-vocabulary failure: only its name and error
 * code survive (both matched against a token pattern), never its message.
 */
export function networkError(err: unknown): SkillSourceError {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new SkillSourceError('TIMEOUT');
  }
  const e = err as { cause?: { code?: unknown }; code?: unknown } | null;
  const code = e?.cause?.code ?? e?.code;
  const parts = [
    typeof name === 'string' && SAFE_TOKEN.test(name) ? name : 'Error',
    ...(typeof code === 'string' && SAFE_TOKEN.test(code) ? [code] : []),
  ];
  return new SkillSourceError('NETWORK', parts.join(', '));
}

/**
 * The message of any error as a string safe to store and show: a
 * {@link SkillSourceError}'s own, or the generic failure for anything else
 * (an unexpected throw may carry anything).
 */
export function safeSourceErrorMessage(err: unknown): string {
  return err instanceof SkillSourceError ? err.message : SKILL_SOURCE_ERRORS.NETWORK;
}
