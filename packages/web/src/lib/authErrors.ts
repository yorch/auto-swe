const RESTART = 'The sign-in attempt expired or was interrupted. Start again.';
const UNAVAILABLE =
  'Sign-in is not available right now, or is misconfigured. Try again, and if it keeps happening ask an administrator.';
const NOT_LINKABLE = 'That account is already linked to a different user, or does not match.';

// better-auth's OAuth callback failures. Each reaches the login page as `?error=<code>` once the
// sign-in request names an errorCallbackURL; without one the browser lands on the gateway's root.
const MESSAGES: Record<string, string> = {
  access_denied: 'Sign-in was cancelled or denied at the provider.',
  account_already_linked_to_different_user: NOT_LINKABLE,
  email_does_not_match: NOT_LINKABLE,
  email_not_found:
    'Your account has no verified email address, which sign-in requires. Verify your primary email with the provider and try again.',
  email_not_verified:
    'Your account has no verified email address, which sign-in requires. Verify your primary email with the provider and try again.',
  invalid_callback_request: RESTART,
  invalid_code: RESTART,
  issuer_mismatch: UNAVAILABLE,
  issuer_missing: UNAVAILABLE,
  no_callback_url: UNAVAILABLE,
  no_code: RESTART,
  nonce_binding_missing: RESTART,
  oauth_provider_not_found: UNAVAILABLE,
  state_mismatch: RESTART,
  state_not_found: RESTART,
  unable_to_get_user_info:
    "We couldn't read your profile from the provider, most often because it did not share a verified primary email address. Check that your account has one, and if it does ask an administrator to check the server log.",
  unable_to_link_account:
    'That account could not be linked. Try again, and if it keeps happening ask an administrator.',
};

const PLAIN_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * A readable message for the `?error=` code a failed OAuth callback leaves on the login page, or
 * null when there is none. The code comes from the URL, so it is only ever echoed when it is a
 * plain machine code, never as arbitrary text.
 */
export function describeAuthError(code: string | null): string | null {
  if (!code) {
    return null;
  }
  const known = MESSAGES[code];
  if (known) {
    return known;
  }
  const generic = 'Sign-in failed. Try again, and if it keeps happening ask an administrator.';
  return PLAIN_CODE.test(code) ? `${generic} (${code})` : generic;
}
