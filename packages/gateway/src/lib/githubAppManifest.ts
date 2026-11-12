/**
 * GitHub's "create an App from a manifest" flow, for the instance's own GitHub App.
 *
 * GitHub's flow: the browser POSTs a manifest (name, webhook, permissions, events, redirect) to
 * `<web>/settings/apps/new?state=…` (or an organization's `…/organizations/<org>/settings/apps/new`);
 * the person confirms on GitHub; GitHub redirects back with a one-hour, single-use `code`; and
 * `POST <api>/app-manifests/{code}/conversions` (no authentication) answers with the new App's id,
 * slug, private key, webhook secret and OAuth client id and secret.
 *
 * Everything here is pure or takes its fetch as an argument, so the routes stay thin and the
 * exchange is testable without GitHub. The API URL is the instance's own (`GitHubConfig`), which an
 * operator configured, so every request goes through `createGuardedFetch` and never follows a
 * redirect. Response bodies are parsed only; their text never reaches an error or a log.
 */
import { createHash, createPrivateKey } from 'node:crypto';
import { hostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { createGitHubAppJwt } from '@auto-swe/shared/lib/githubInstallation';
import { createGuardedFetch } from '@auto-swe/shared/lib/guardedDispatcher';

/** Where GitHub sends the browser back with the conversion code. */
export const MANIFEST_CALLBACK_PATH = '/api/v1/integrations/github-app-manifest/callback';

/** Default App name; GitHub requires it to be unique on the host. */
export const DEFAULT_APP_NAME = 'auto-swe';

/** An organization or user login: GitHub's own rule (alphanumerics and single hyphens, ≤ 39). */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** GitHub App names are at most 34 characters; this keeps them to plain, printable ones. */
export const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$/;

/** The conversion code GitHub appends to the redirect. Anything else is refused before a request. */
const CODE_RE = /^[A-Za-z0-9_-]{1,200}$/;

const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * The repository permissions the platform uses, each with the feature that needs it
 * (`docs/github-app-setup.md`). Least privilege: nothing here is requested "just in case".
 */
export const MANIFEST_PERMISSIONS = {
  /** Read a failed workflow run's jobs and logs for CI-failure triage. */
  actions: 'read',
  /** Read check runs to wait on CI. */
  checks: 'read',
  /** Clone, push branches. */
  contents: 'write',
  /** Issue-label automations; pull-request feedback's summary and command replies. */
  issues: 'write',
  /** The sign-in organization-membership check. */
  members: 'read',
  /** Mandatory for every App. */
  metadata: 'read',
  /** Open and update draft pull requests, read reviews. */
  pull_requests: 'write',
  /** Pull-request evaluation's commit status. */
  statuses: 'write',
} as const;

/** The webhook events the gateway acts on (`/api/v1/webhooks/git`). */
export const MANIFEST_EVENTS = [
  'check_run',
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'workflow_run',
] as const;

export interface GitHubAppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  request_oauth_on_install: true;
  public: false;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/** Whether GitHub can deliver to this public URL at all: a loopback gateway cannot be reached. */
function isReachableFromGitHub(publicUrl: string): boolean {
  try {
    const { hostname } = new URL(publicUrl);
    return !(
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * The manifest for the instance's App. The webhook is created inactive when the gateway's public
 * URL is a loopback address (GitHub could never deliver to it); it can be activated on GitHub once
 * the gateway is reachable.
 */
export function buildGitHubAppManifest(input: {
  name: string;
  publicUrl: string;
  webUrl: string;
}): GitHubAppManifest {
  const publicUrl = input.publicUrl.replace(/\/$/, '');
  const webUrl = input.webUrl.replace(/\/$/, '');
  return {
    callback_urls: [`${webUrl}/github/install/callback`],
    default_events: [...MANIFEST_EVENTS],
    default_permissions: { ...MANIFEST_PERMISSIONS },
    description: 'Durable, governed agent workflows: tickets in, reviewed draft pull requests out.',
    hook_attributes: {
      active: isReachableFromGitHub(publicUrl),
      url: `${publicUrl}/api/v1/webhooks/git`,
    },
    name: input.name,
    public: false,
    redirect_url: `${publicUrl}${MANIFEST_CALLBACK_PATH}`,
    request_oauth_on_install: true,
    url: webUrl,
  };
}

/** Where the browser posts the manifest: the person's account, or an organization they own. */
export function manifestFormAction(input: {
  baseUrl: string;
  org: string | null;
  state: string;
}): string {
  const base = input.baseUrl.replace(/\/$/, '');
  const path = input.org
    ? `/organizations/${encodeURIComponent(input.org)}/settings/apps/new`
    : '/settings/apps/new';
  return `${base}${path}?state=${encodeURIComponent(input.state)}`;
}

/**
 * A short digest of the API host family, carried in the state's nonce so a flow started against
 * one GitHub host cannot be finished against another: the conversion code returns a private key,
 * and it must only ever be presented to the host that issued it.
 */
export function hostBinding(apiUrl: string): string {
  return createHash('sha256').update(hostFamily(apiUrl)).digest('base64url').slice(0, 16);
}

export function isValidConversionCode(code: string): boolean {
  return CODE_RE.test(code);
}

function isRsaPem(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/** The new App, as the conversion returned it, every field checked. */
export interface ConvertedGitHubApp {
  id: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  pem: string;
  /** Null when GitHub generated none (the manifest had no active webhook). */
  webhookSecret: string | null;
  /** The App's page on its host, checked to be on that host; null when it was not. */
  htmlUrl: string | null;
}

export type ConversionResult =
  | { ok: true; app: ConvertedGitHubApp }
  /** GitHub refused the code: expired, already used, or never issued. */
  | { ok: false; reason: 'rejected' }
  /** GitHub could not be reached, or its answer could not be read. */
  | { ok: false; reason: 'unreachable' }
  /** GitHub answered, but not with a usable App. */
  | { ok: false; reason: 'malformed' };

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'auto-swe/1.0',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

/** A guarded fetch for the instance's API host: private addresses only for an Enterprise host. */
export function guardedFetchFor(apiUrl: string): typeof fetch {
  return createGuardedFetch({ allowPrivate: hostFamily(apiUrl) !== 'github.com' });
}

/** The App page URL when it is on the host's own web origin and has the App-page shape. */
function checkedHtmlUrl(raw: unknown, baseUrl: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const url = new URL(raw);
    const expected = new URL(baseUrl);
    if (url.origin !== expected.origin || url.search || url.hash) {
      return null;
    }
    return /^\/(apps|github-apps)\/[a-z0-9][a-z0-9-]{0,99}$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

/** Exchange a conversion code for the new App's credentials. Never throws. */
export async function convertManifestCode(input: {
  apiUrl: string;
  baseUrl: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<ConversionResult> {
  if (!isValidConversionCode(input.code)) {
    return { ok: false, reason: 'rejected' };
  }
  const base = input.apiUrl.replace(/\/$/, '');
  const doFetch = input.fetchImpl ?? guardedFetchFor(base);
  let res: Response;
  try {
    res = await doFetch(`${base}/app-manifests/${input.code}/conversions`, {
      headers: GITHUB_HEADERS,
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status === 404 || res.status === 410 || res.status === 422) {
    return { ok: false, reason: 'rejected' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'unreachable' };
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  const { client_id, client_secret, html_url, id, pem, slug, webhook_secret } = body;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== 'string' ||
    !APP_SLUG_RE.test(slug) ||
    typeof client_id !== 'string' ||
    client_id.length === 0 ||
    client_id.length > 200 ||
    typeof client_secret !== 'string' ||
    client_secret.length === 0 ||
    client_secret.length > 500 ||
    typeof pem !== 'string' ||
    pem.length > 10_000 ||
    !isRsaPem(pem) ||
    !(
      webhook_secret === null ||
      webhook_secret === undefined ||
      (typeof webhook_secret === 'string' && webhook_secret.length <= 500)
    )
  ) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    app: {
      clientId: client_id,
      clientSecret: client_secret,
      htmlUrl: checkedHtmlUrl(html_url, input.baseUrl),
      id: String(id),
      pem,
      slug,
      webhookSecret: typeof webhook_secret === 'string' && webhook_secret ? webhook_secret : null,
    },
    ok: true,
  };
}

/**
 * Set the new App's webhook secret (`PATCH /app/hook/config`, authenticated as the App). Used so
 * the App signs its deliveries with the secret the gateway already verifies with, instead of
 * replacing that secret and breaking every repository webhook configured with it. Never throws.
 */
export async function setAppWebhookSecret(input: {
  apiUrl: string;
  appId: string;
  pem: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const base = input.apiUrl.replace(/\/$/, '');
  const doFetch = input.fetchImpl ?? guardedFetchFor(base);
  try {
    const res = await doFetch(`${base}/app/hook/config`, {
      body: JSON.stringify({ content_type: 'json', secret: input.secret }),
      headers: {
        ...GITHUB_HEADERS,
        Authorization: `Bearer ${createGitHubAppJwt(input.appId, input.pem)}`,
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Where to send the browser to install the new App: its page on the host when GitHub named one we
 * could check, else the github.com shape on the configured web host.
 */
export function installationUrl(app: ConvertedGitHubApp, baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  // GitHub Enterprise Server serves an App's page at /github-apps/<slug>; github.com and
  // GHE.com tenants (`<t>.ghe.com`) serve it at /apps/<slug>.
  const host = new URL(base).hostname.toLowerCase();
  const path = host === 'github.com' || host.endsWith('.ghe.com') ? 'apps' : 'github-apps';
  const page = app.htmlUrl ?? `${base}/${path}/${app.slug}`;
  return `${page}/installations/new`;
}
