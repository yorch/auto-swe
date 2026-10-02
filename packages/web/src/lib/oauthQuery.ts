/**
 * The signed query an OAuth authorization carries through the login and consent pages.
 *
 * The authorization server redirects the browser to `/login` or `/oauth/consent` with the
 * original authorization request in the query, plus a signature and the list of signed
 * parameter names (`ba_param`). Whatever page the user is on when they sign in or consent
 * sends that signed part back as `oauth_query`, which is how the server knows which
 * authorization to resume. Parameters the page adds itself (`redirect`, `bridge`) are not
 * signed, and sending them would invalidate the signature, so only the signed ones go.
 *
 * This mirrors `buildSignedOAuthQuery` in `@better-auth/oauth-provider`, which ships inside
 * its client plugin; `oauthQuery.test.ts` checks the two agree.
 */

const SIGNATURE_PARAM = 'sig';
const SIGNED_NAMES_PARAM = 'ba_param';

/** The `oauth_query` to send for a page at `search`, or undefined when the page carries none. */
export function signedOAuthQuery(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (!params.has(SIGNATURE_PARAM)) {
    return undefined;
  }
  const names = params.getAll(SIGNED_NAMES_PARAM);
  if (names.length === 0) {
    return undefined;
  }
  const signed = new Set(names);
  const out = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === SIGNATURE_PARAM || key === SIGNED_NAMES_PARAM || signed.has(key)) {
      out.append(key, value);
    }
  }
  return out.toString();
}
