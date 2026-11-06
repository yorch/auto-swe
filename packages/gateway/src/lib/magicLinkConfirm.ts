/**
 * The address a magic sign-in email links to: the dashboard's confirmation page, not better-auth's
 * verify endpoint. A mail scanner that opens the link only loads that page; the token is spent
 * when the user clicks "Sign in" there, which then opens the verify URL.
 *
 * The token and callback ride in the fragment, which a browser never sends to a server, so they
 * stay out of the dashboard's request logs too.
 */
export function magicLinkConfirmUrl(
  verifyUrl: string,
  clientOrigin: string,
  email: string
): string {
  const verify = new URL(verifyUrl);
  const token = verify.searchParams.get('token');
  if (!token) {
    throw new Error('magic-link URL has no token');
  }
  const fragment = new URLSearchParams({ email, token });
  const callbackURL = verify.searchParams.get('callbackURL');
  if (callbackURL) {
    fragment.set('callbackURL', callbackURL);
  }
  return `${new URL('/login/confirm-link', clientOrigin).toString()}#${fragment.toString()}`;
}
