/**
 * How a person signed in, as a closed set so it is safe to count and to chart
 * (docs/user-activity.md). Derived from the better-auth endpoint that ran, never from anything the
 * client typed beyond the provider id, which is itself matched against the set.
 */
export const AUTH_METHODS = [
  'password',
  'github',
  'google',
  'okta',
  'magic-link',
  'oauth',
  'unknown',
] as const;
export type SignInMethod = (typeof AUTH_METHODS)[number];

const PROVIDER_METHODS: ReadonlySet<string> = new Set(['github', 'google', 'okta']);

/** Why a sign-in attempt failed, as a closed set. */
export const SIGN_IN_FAILURE_REASONS = [
  'invalid_credentials',
  'unverified',
  'locked',
  'other',
] as const;
export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

/** The slice of a better-auth endpoint context the resolver reads. */
export interface AuthEndpointShape {
  path?: string | null;
  params?: Record<string, unknown> | null;
  body?: unknown;
}

/** A provider id mapped into the set: a configured SSO provider other than the named ones is `oauth`. */
function providerMethod(id: unknown): SignInMethod {
  if (typeof id !== 'string' || id === '') {
    return 'oauth';
  }
  const lower = id.toLowerCase();
  return PROVIDER_METHODS.has(lower) ? (lower as SignInMethod) : 'oauth';
}

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

/** The sign-in method of the better-auth endpoint that ran; `unknown` when it is not a sign-in path. */
export function signInMethodFor(ctx: AuthEndpointShape): SignInMethod {
  const path = ctx.path ?? '';
  if (path === '/sign-in/email' || path === '/sign-up/email' || path === '/verify-email') {
    return 'password';
  }
  if (path.startsWith('/magic-link/verify') || path === '/sign-in/magic-link') {
    return 'magic-link';
  }
  if (path.startsWith('/callback/')) {
    return providerMethod(ctx.params?.id ?? path.split('/').pop());
  }
  if (path === '/sign-in/social') {
    return providerMethod(bodyField(ctx.body, 'provider'));
  }
  if (path === '/sign-in/oauth2') {
    return providerMethod(bodyField(ctx.body, 'providerId'));
  }
  return 'unknown';
}

/** Paths whose failure is a failed sign-in attempt (a sign-up is not one). */
export function isSignInPath(path: string | null | undefined): boolean {
  return (
    path === '/sign-in/email' ||
    path === '/sign-in/social' ||
    path === '/sign-in/oauth2' ||
    Boolean(path?.startsWith('/magic-link/verify')) ||
    Boolean(path?.startsWith('/callback/'))
  );
}

function reasonFromCode(code: string): SignInFailureReason {
  const c = code.toUpperCase();
  if (c.includes('INVALID_EMAIL_OR_PASSWORD') || c.includes('INVALID_PASSWORD')) {
    return 'invalid_credentials';
  }
  if (c.includes('NOT_VERIFIED') || c.includes('UNVERIFIED')) {
    return 'unverified';
  }
  if (c.includes('BANNED') || c.includes('LOCKED') || c.includes('DISABLED')) {
    return 'locked';
  }
  return 'other';
}

/**
 * Classify what an endpoint returned: `null` when it succeeded, else the failure reason. A
 * better-auth `APIError` is a failure when its status is an error status, or when it is a redirect
 * (the OAuth and magic-link endpoints redirect on both outcomes) whose location carries an `error`
 * query parameter. Anything that is not an `APIError` is a success.
 */
export function classifySignInFailure(returned: unknown): SignInFailureReason | null {
  if (!returned || typeof returned !== 'object') {
    return null;
  }
  const err = returned as {
    name?: unknown;
    statusCode?: unknown;
    body?: { code?: unknown } | null;
    headers?: unknown;
  };
  if (err.name !== 'APIError' && !(returned instanceof Error)) {
    return null;
  }
  const status = typeof err.statusCode === 'number' ? err.statusCode : 0;
  if (status >= 400) {
    return reasonFromCode(typeof err.body?.code === 'string' ? err.body.code : '');
  }
  if (status >= 300) {
    const headers = err.headers;
    const location =
      headers instanceof Headers
        ? headers.get('location')
        : headers && typeof headers === 'object'
          ? ((headers as Record<string, unknown>).location ?? null)
          : null;
    if (typeof location !== 'string') {
      return null;
    }
    const query = location.split('?')[1];
    if (!query) {
      return null;
    }
    const error = new URLSearchParams(query.split('#')[0]).get('error');
    return error ? reasonFromCode(error) : null;
  }
  return null;
}
