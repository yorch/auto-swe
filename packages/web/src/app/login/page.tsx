'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ProviderMark } from '@/components/auth/ProviderMark';
import { AuthHeading, AuthLayout, BrandMark } from '@/components/layout/AuthLayout';
import { SupportContact } from '@/components/SupportContact';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/LoadingState';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { isOkResponse, probeGateway } from '@/hooks/useGatewayStatus';
import { api } from '@/lib/api';
import { describeAuthError } from '@/lib/authErrors';
import { API_BASE, APP_VERSION, IS_DEV } from '@/lib/config';
import { errMsg } from '@/lib/errors';
import { resolveLoginTab } from '@/lib/loginTab';
import { signedOAuthQuery } from '@/lib/oauthQuery';
import { safeRedirectPath } from '@/lib/safeRedirect';
import { type SocialProviderId, useAuthStore } from '@/stores/authStore';

interface ProviderFlags {
  github: boolean;
  google: boolean;
  magicLink: boolean;
  okta: boolean;
}

/** What the probe may actually return: a gateway that predates Okta support
 *  omits that flag entirely, so it is optional on the wire and defaulted to
 *  false before it reaches state. */
type ProviderProbe = Omit<ProviderFlags, 'okta'> & { okta?: boolean };

/**
 * Structural validation for the /api/v1/auth/providers response. Used to
 * distinguish "real gateway, providers reported" from "200 OK but something
 * else is on the port and returned a different shape" (e.g. an adminer
 * container or a misconfigured reverse proxy).
 */
function looksLikeProviderResponse(data: unknown): data is ProviderProbe {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const o = data as Record<string, unknown>;
  // `okta` is checked loosely: a gateway that predates Okta support answers
  // without the key, and that is a valid response — not a wrong server on the
  // port. Treating a missing flag as a shape mismatch would black out the
  // login page against an older gateway.
  return (
    typeof o.github === 'boolean' &&
    typeof o.google === 'boolean' &&
    typeof o.magicLink === 'boolean' &&
    (o.okta === undefined || typeof o.okta === 'boolean')
  );
}

type Tab = 'magic' | 'password';

const TAB_OPTIONS: { label: string; value: Tab }[] = [
  { label: 'Magic link', value: 'magic' },
  { label: 'Password', value: 'password' },
];

const SOCIAL_BUTTONS: { id: SocialProviderId; label: string }[] = [
  { id: 'github', label: 'Continue with GitHub' },
  { id: 'google', label: 'Continue with Google' },
  { id: 'okta', label: 'Continue with Okta' },
];

type GatewayState = 'checking' | 'up' | 'down';

const GATEWAY_STATUS: Record<
  GatewayState,
  { label: string; tone: 'success' | 'danger' | 'muted' }
> = {
  checking: { label: 'Checking gateway', tone: 'muted' },
  down: { label: 'Gateway offline', tone: 'danger' },
  up: { label: 'Gateway online', tone: 'success' },
};

/** The reachability light: a dot plus words, so the state is not colour alone. */
function GatewayStatus({ state }: { state: GatewayState }) {
  const s = GATEWAY_STATUS[state];
  return (
    <Badge dot={state === 'up' ? 'pulse' : true} tone={s.tone} variant="outline">
      {s.label}
    </Badge>
  );
}

const HIGHLIGHTS: { icon: IconName; title: string; detail: string }[] = [
  {
    detail: 'Versioned workflow graphs run on Temporal, so a run survives restarts and retries.',
    icon: 'workflows',
    title: 'Durable by design',
  },
  {
    detail: 'Agents work in isolated containers, with every write and command scanned.',
    icon: 'security',
    title: 'Sandboxed and scanned',
  },
  {
    detail:
      'Approval gates pause a run where it matters, and no built-in step or template merges a pull request.',
    icon: 'gavel',
    title: 'Humans stay in charge',
  },
];

export default function LoginPage() {
  // useSearchParams() requires a Suspense boundary above it when the page
  // is statically prerendered at build time. Wrapping the whole component
  // keeps the page eligible for SSG while still letting us read the
  // ?bridge=1 hint from the magic-link / social callback.
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginPageInner />
    </Suspense>
  );
}

/** Shown while the page hydrates: the card's outline, so the first frame is not blank. */
function LoginFallback() {
  return (
    <AuthLayout>
      <div aria-live="polite" className="space-y-4" role="status">
        <span className="sr-only">Loading sign-in…</span>
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </AuthLayout>
  );
}

/** Seconds before "Resend" works again after a sign-in link is sent. */
const RESEND_COOLDOWN_SEC = 30;

/** Loose shape check, so an empty or obviously wrong address is reported inline. */
function emailProblem(value: string): string | undefined {
  const v = value.trim();
  if (!v) {
    return 'Enter your email address.';
  }
  return /^\S+@\S+$/.test(v) ? undefined : 'Enter a valid email address, like you@example.com.';
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const login = useAuthStore((s) => s.login);
  const signInWithProvider = useAuthStore((s) => s.signInWithProvider);
  const requestMagicLink = useAuthStore((s) => s.requestMagicLink);
  const requestPasswordReset = useAuthStore((s) => s.requestPasswordReset);
  const hydrate = useAuthStore((s) => s.hydrateFromSession);

  // Where to land after a successful sign-in. The proxy sets ?redirect=<path>
  // when it bounces an unauthenticated request here; honor it, but only when it
  // resolves to a path on this origin (see safeRedirectPath) to avoid an
  // open-redirect.
  const destination = safeRedirectPath(
    searchParams.get('redirect'),
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
  );

  // An MCP client's authorization that sent the user here to sign in: the signed part of
  // this page's own query. Sign-in resumes it, so the user lands on the consent screen
  // instead of the dashboard.
  const oauthQuery = signedOAuthQuery(searchParams.toString());

  // The person's own pick; until they make one the default depends on what the gateway offers.
  const [pickedTab, setPickedTab] = useState<Tab | null>(null);
  const [providers, setProviders] = useState<ProviderFlags>({
    github: false,
    google: false,
    magicLink: false,
    okta: false,
  });
  /**
   * The first thing the login page does is probe `/api/v1/auth/providers` to
   * see which social providers are configured. That probe doubles as a
   * gateway-reachability check — if it fails at the network level, no other
   * action on this page will work either, and we want to say so loudly rather
   * than letting the user hit Submit and meet a generic "Failed to fetch".
   */
  const [gateway, setGateway] = useState<GatewayState>('checking');
  const gatewayDown = gateway === 'down';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // A failed OAuth callback returns here as ?error=<code> (see errorCallbackURL in authStore).
  const [error, setError] = useState(() => describeAuthError(searchParams.get('error')) ?? '');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  // Inline field errors: the forms use noValidate, so every problem is reported the same way.
  const [emailError, setEmailError] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  // The provider whose redirect is under way: its button shows the progress.
  const [redirectingTo, setRedirectingTo] = useState<SocialProviderId | null>(null);
  // The address a sign-in link was sent to; set, the magic-link tab shows the confirmation.
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  // Pending-approval screen: a "Check again" in flight, and its last answer.
  const [recheck, setRecheck] = useState<'idle' | 'checking' | 'still-pending' | 'unavailable'>(
    'idle'
  );
  // Set after hydrate when the resolved user has isActive=false. Renders
  // a dedicated approval-pending screen instead of bouncing to /.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  // Bumped by the "Retry" button to re-run the session bridge after the
  // gateway could not be reached.
  const [bridgeAttempt, setBridgeAttempt] = useState(0);
  const [bridgeUnavailable, setBridgeUnavailable] = useState(false);

  // After a better-auth social or magic-link sign-in lands back here with
  // ?bridge=1, resolve the session and either route into the dashboard or
  // surface the pending-approval screen depending on isActive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bridgeAttempt is the retry trigger.
  useEffect(() => {
    if (searchParams.get('bridge') !== '1') {
      return;
    }
    // ?reauth=1 marks a server-side role guard that found the hour-long
    // bearer cookie missing or expired while the week-long session marker was
    // still set: the bridge re-mints the bearer and returns to the page.
    const reauth = searchParams.get('reauth') === '1';
    let cancelled = false;
    setBridgeUnavailable(false);
    (async () => {
      const status = await hydrate();
      if (cancelled) {
        return;
      }
      if (status === 'unknown') {
        // The gateway did not answer (offline, 429, 5xx): nothing is known
        // about the session, so do not claim it expired.
        setBridgeUnavailable(true);
        setError('The gateway is unavailable, so your session could not be checked.');
        return;
      }
      if (status !== 'authenticated') {
        setError(
          reauth
            ? 'Your session has expired — sign in again.'
            : 'Sign-in completed but no session was found — try again.'
        );
        return;
      }
      const u = useAuthStore.getState().user;
      if (u?.isActive === false) {
        setPendingEmail(u.email ?? null);
        return;
      }
      // The guard that sent us here needs the bearer cookie; returning without
      // one would bounce straight back and loop.
      if (reauth && !api.getToken()) {
        setError('Could not refresh your access — sign in again.');
        return;
      }
      router.replace(destination);
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, hydrate, router, destination, bridgeAttempt]);

  // Someone who is already signed in has no use for the form: send them on. Requires the bearer
  // cookie so a guard that bounced them here for lacking it cannot loop.
  useEffect(() => {
    // An app's authorization request resumes through the sign-in form below; redirecting
    // to the dashboard here would drop it.
    if (searchParams.get('bridge') === '1' || oauthQuery) {
      return;
    }
    let cancelled = false;
    (async () => {
      const status = await hydrate();
      if (cancelled || status !== 'authenticated') {
        return;
      }
      const u = useAuthStore.getState().user;
      // An account awaiting approval gets the explanation, not a silent sign-in form.
      if (u?.isActive === false) {
        setPendingEmail(u.email ?? null);
        return;
      }
      if (api.getToken()) {
        router.replace(destination);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, hydrate, router, destination, oauthQuery]);

  // Which social providers are configured in the backend? Also doubles as
  // the gateway-reachability check (see gatewayDown above). "Gateway is up"
  // means three things in this context: (1) the request didn't fail at the
  // network/CORS layer, (2) the response was 2xx, AND (3) the body is the
  // shape we expect — a JSON object carrying the provider flags. The third
  // check matters because a port collision on 8080 (e.g. an unrelated adminer
  // / PHP container) can answer 200 with HTML, which would otherwise leave
  // the page in a quiet "no providers" state instead of telling the user
  // why nothing works.
  // `silent` re-probes without swapping the form for the skeleton, for the automatic retries.
  const probe = useCallback(async (silent = false) => {
    if (!silent) {
      setGateway('checking');
    }
    try {
      const res = await probeGateway('/api/v1/auth/providers', isOkResponse, 5000);
      if (!res) {
        // Non-2xx — could be the real gateway throwing, or a wrong server
        // on the port. Either way the page can't continue, so surface it.
        setGateway('down');
        return;
      }
      const data = (await res.json()) as unknown;
      if (!looksLikeProviderResponse(data)) {
        // 200 OK but the body isn't our shape — almost certainly a different
        // server bound to the port. Surface as gateway-down.
        setGateway('down');
        return;
      }
      setProviders({ okta: false, ...data });
      setGateway('up');
    } catch {
      // TypeError: network failure (DNS, server down, CORS rejected).
      // SyntaxError: 200 OK but body wasn't valid JSON (wrong server bound).
      // Any other failure still ends the "checking" state, or the form would never appear.
      setGateway('down');
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // While the gateway is unreachable, look again when the browser regains the network or the tab
  // is focused, so the page recovers without a reload.
  useEffect(() => {
    if (gateway !== 'down') {
      return;
    }
    const again = () => void probe(true);
    window.addEventListener('online', again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('focus', again);
    };
  }, [gateway, probe]);

  // Count the resend cooldown down once a second.
  useEffect(() => {
    if (resendIn <= 0) {
      return;
    }
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const focusEmail = () => document.getElementById('email')?.focus();

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    const emailIssue = emailProblem(email);
    const passwordIssue = password ? undefined : 'Enter your password.';
    setEmailError(emailIssue);
    setPasswordError(passwordIssue);
    if (emailIssue || passwordIssue) {
      document.getElementById(emailIssue ? 'email' : 'password')?.focus();
      return;
    }
    setLoading(true);
    try {
      const resume = await login(email, password, oauthQuery);
      // An account still awaiting approval may not authorize anything, and the dashboard
      // would only bounce it back here on its first 401.
      if (useAuthStore.getState().user?.isActive === false) {
        setPendingEmail(email);
        return;
      }
      if (resume) {
        window.location.assign(resume);
        return;
      }
      router.push(destination);
    } catch (err: unknown) {
      setError(errMsg(err, 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setInfo('');
    setPasswordError(undefined);
    if (!email.trim()) {
      setEmailError('Enter the email for your account, then choose Forgot password.');
      focusEmail();
      return;
    }
    setEmailError(undefined);
    setLoading(true);
    try {
      await requestPasswordReset(email);
      setInfo(
        IS_DEV
          ? `If an account exists for ${email}, a reset link is on its way. In dev, the link is logged to the gateway stdout.`
          : `If an account exists for ${email}, a reset link is on its way.`
      );
    } catch (err: unknown) {
      setError(errMsg(err, 'Could not send reset link'));
    } finally {
      setLoading(false);
    }
  };

  const handleSocialSignIn = async (provider: SocialProviderId) => {
    setError('');
    setInfo('');
    setLoading(true);
    setRedirectingTo(provider);
    try {
      // Navigates to the provider on success, so `loading` stays set until
      // the page unloads. It also disables both social buttons for the
      // duration of the fetch — a double-click would mint two OAuth states
      // and the second's state cookie would break the first's callback.
      await signInWithProvider(provider, oauthQuery);
    } catch (err: unknown) {
      setError(errMsg(err, `Could not start ${provider} sign-in`));
      setLoading(false);
      setRedirectingTo(null);
    }
  };

  const sendMagicLink = async (address: string) => {
    setError('');
    setInfo('');
    setLoading(true);
    try {
      await requestMagicLink(address);
      setLinkSentTo(address);
      setResendIn(RESEND_COOLDOWN_SEC);
    } catch (err: unknown) {
      setError(errMsg(err, 'Could not send magic link'));
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const issue = emailProblem(email);
    setEmailError(issue);
    if (issue) {
      setError('');
      setInfo('');
      focusEmail();
      return;
    }
    await sendMagicLink(email.trim());
  };

  // "Check again" on the awaiting-approval screen: the account may have been approved since.
  const handleRecheck = async () => {
    setRecheck('checking');
    const status = await hydrate();
    if (status === 'unknown') {
      setRecheck('unavailable');
      return;
    }
    const u = useAuthStore.getState().user;
    if (status === 'authenticated' && u?.isActive !== false) {
      setPendingEmail(null);
      router.replace(destination);
      return;
    }
    setRecheck('still-pending');
  };

  const hasSocial = providers.github || providers.google || providers.okta;
  // Magic link is offered only when the gateway reports it enabled. A pending
  // MCP sign-in cannot continue through a link, so it defaults to Password.
  const magicAvailable = providers.magicLink;
  const tab: Tab = resolveLoginTab(pickedTab, magicAvailable, !!oauthQuery);

  const statusLine = <GatewayStatus state={gateway} />;
  const versionLine = <span className="tabular">v{APP_VERSION}</span>;

  // Pending-approval short-circuit: the user authenticated successfully via
  // better-auth but their User row is isActive=false. Show an explanatory
  // screen instead of the sign-in form so they understand why nothing else
  // in the app works yet.
  if (pendingEmail) {
    return (
      <AuthLayout footer={versionLine}>
        <AuthHeading icon="clock" title="Awaiting approval" tone="warning">
          <p>
            <span className="break-all font-mono text-sm text-paper-100">{pendingEmail}</span> is
            signed in, but an administrator has to approve the account before you can use auto-swe.
          </p>
        </AuthHeading>
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-ink-400/60 bg-ink-900/60 px-3.5 py-3">
          <span className="text-sm text-paper-400">Account status</span>
          <Badge dot tone="warning" variant="outline">
            Pending approval
          </Badge>
        </div>
        <div aria-live="polite" role="status">
          {recheck === 'still-pending' && (
            <p className="mb-3 text-sm text-paper-400">Still waiting for approval.</p>
          )}
          {recheck === 'unavailable' && (
            <p className="mb-3 text-sm text-danger-400">
              The gateway is unavailable, so approval could not be checked. Try again in a moment.
            </p>
          )}
        </div>
        <div className="space-y-2.5">
          <Button
            className="w-full"
            disabled={recheck === 'checking'}
            onClick={handleRecheck}
            size="lg"
            variant="primary"
          >
            <Icon
              className={recheck === 'checking' ? 'animate-spin' : undefined}
              name="refresh"
              size={15}
            />
            {recheck === 'checking' ? 'Checking…' : 'Check again'}
          </Button>
          <Button
            className="w-full"
            onClick={async () => {
              // A pending user can still hold a session; sign it out, or the
              // sign-in check that runs on '/login' puts this screen straight back.
              await useAuthStore.getState().logout();
              setPendingEmail(null);
              router.replace('/login');
            }}
            size="lg"
            variant="secondary"
          >
            <Icon name="arrowLeft" size={15} />
            Back to sign in
          </Button>
        </div>
        <SupportContact className="mt-6 text-center" />
      </AuthLayout>
    );
  }

  return (
    <div className="relative grid min-h-dvh bg-ink-800 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[1.1fr_1fr]">
      {/* LEFT — brand panel, wide screens only */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-ink-600 bg-ink-950 p-12 lg:flex">
        <header className="relative z-10 flex items-center justify-between gap-4">
          <BrandMark size="lg" />
          {/* Driven by the provider probe, which doubles as the reachability
              check — a status light that always reads "online" is worse than
              no status light. */}
          {statusLine}
        </header>

        <div className="relative z-10 max-w-lg">
          {/* A paragraph, not a heading: the page's one h1 is the sign-in card, and a
              screen reader should not meet this slogan first. */}
          <p className="text-4xl font-semibold leading-[1.1] tracking-[-0.03em] text-paper-50 xl:text-5xl">
            Ticket in, reviewed pull request out.
          </p>
          <p className="mt-4 text-base leading-relaxed text-paper-400">
            Durable, governed agent workflows that do the work and leave the decisions to your team.
          </p>
          <ul className="mt-10 space-y-5">
            {HIGHLIGHTS.map((h) => (
              <li className="flex gap-4" key={h.title}>
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-400/70 bg-ink-700/70 text-paper-300"
                >
                  <Icon name={h.icon} size={17} />
                </span>
                <div>
                  <div className="text-sm font-medium text-paper-100">{h.title}</div>
                  <div className="mt-0.5 text-sm leading-relaxed text-paper-500">{h.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <footer className="relative z-10 flex items-center justify-between text-xs text-paper-500">
          {/* Prerendered at build time, so the baked-in year can disagree with the
              client's clock across a New Year boundary. */}
          <span suppressHydrationWarning>© {new Date().getFullYear()} brnby</span>
          {versionLine}
        </footer>
      </aside>

      {/* RIGHT — sign-in card */}
      <AuthLayout
        brand="mobile"
        className="lg:px-12"
        footer={
          <span className="flex items-center gap-4 lg:hidden">
            {statusLine}
            {versionLine}
          </span>
        }
      >
        <AuthHeading title="Sign in">
          {oauthQuery
            ? 'Sign in to finish connecting the app that sent you here.'
            : 'Welcome back. Sign in to continue to auto·swe.'}
        </AuthHeading>

        {gatewayDown && (
          <Alert
            action={
              <Button onClick={() => void probe()} size="sm">
                Retry
              </Button>
            }
            className="mb-6"
            title="Service unavailable"
            variant="error"
          >
            {IS_DEV ? (
              <>
                Can't reach the gateway at{' '}
                <code className="break-all font-mono text-paper-100" suppressHydrationWarning>
                  {API_BASE}
                </code>
                . Check that it's running and that <code className="font-mono">CORS_ORIGIN</code>{' '}
                includes{' '}
                <code className="break-all font-mono text-paper-100">
                  {typeof window !== 'undefined' ? window.location.origin : ''}
                </code>
                .
              </>
            ) : (
              'Sign-in is temporarily unavailable. Choose Retry, or try again in a moment.'
            )}
          </Alert>
        )}

        {/* Social providers — only shown when configured in the backend */}
        {hasSocial && (
          <div className="mb-6">
            <div className="space-y-2.5">
              {SOCIAL_BUTTONS.filter((b) => providers[b.id]).map((b) => (
                <Button
                  aria-busy={redirectingTo === b.id || undefined}
                  className="w-full"
                  disabled={loading || gatewayDown}
                  key={b.id}
                  onClick={() => handleSocialSignIn(b.id)}
                  size="lg"
                  variant="secondary"
                >
                  {redirectingTo === b.id ? (
                    <Icon className="animate-spin" name="refresh" size={15} />
                  ) : (
                    <ProviderMark id={b.id} />
                  )}
                  <span>
                    {redirectingTo === b.id
                      ? `Redirecting to ${b.label.replace('Continue with ', '')}…`
                      : b.label}
                  </span>
                </Button>
              ))}
            </div>
            <div className="mt-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-ink-500" />
              <span className="text-xs text-paper-500">or continue with email</span>
              <span className="h-px flex-1 bg-ink-500" />
            </div>
          </div>
        )}

        {/* Tab switcher: only when the gateway offers more than one way to sign in */}
        {magicAvailable && (
          <SegmentedControl
            ariaLabel="Sign-in method"
            className="mb-5 flex w-full"
            onChange={(next) => {
              setPickedTab(next);
              setError('');
              setInfo('');
              setEmailError(undefined);
              setPasswordError(undefined);
            }}
            optionClassName="flex-1 py-1.5 text-sm"
            options={TAB_OPTIONS}
            value={tab}
          />
        )}

        {error && (
          <Alert
            action={
              bridgeUnavailable ? (
                <Button
                  onClick={() => {
                    setError('');
                    setBridgeAttempt((n) => n + 1);
                  }}
                  size="sm"
                >
                  Retry
                </Button>
              ) : undefined
            }
            className="mb-4"
          >
            {error}
          </Alert>
        )}
        {info && (
          <Alert className="mb-4" variant="success">
            {info}
          </Alert>
        )}

        {oauthQuery && tab === 'magic' && (
          <Alert className="mb-4" variant="warning">
            An app is waiting for you to sign in. A magic link cannot continue that connection: sign
            in with a password or a provider instead, or start the connection again from the app
            after the link signs you in.
          </Alert>
        )}

        {gateway === 'checking' ? (
          <div aria-live="polite" className="space-y-4" role="status">
            <span className="sr-only">Checking sign-in options…</span>
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : tab === 'magic' && linkSentTo ? (
          <div aria-live="polite" className="space-y-4 text-center" role="status">
            <div
              aria-hidden="true"
              className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-success-400/30 bg-success-400/10 text-success-400"
            >
              <Icon name="inbox" size={20} />
            </div>
            <p className="text-base font-medium text-paper-50">Check your inbox</p>
            <p className="text-sm leading-relaxed text-paper-400">
              We sent a sign-in link to{' '}
              <span className="break-all font-mono text-paper-100">{linkSentTo}</span>. It may take
              a minute to arrive; check spam if it does not.
              {IS_DEV && ' In dev, the link prints to the gateway stdout.'}
            </p>
            <div className="flex flex-col gap-2.5">
              <Button
                disabled={loading || resendIn > 0 || gatewayDown}
                onClick={() => void sendMagicLink(linkSentTo)}
                size="lg"
                variant="secondary"
              >
                {loading ? 'Sending…' : resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend link'}
              </Button>
              <Button
                onClick={() => {
                  setLinkSentTo(null);
                  setResendIn(0);
                }}
                size="lg"
                variant="ghost"
              >
                Use a different email
              </Button>
            </div>
          </div>
        ) : tab === 'magic' ? (
          <form className="space-y-5" noValidate onSubmit={handleMagicLinkSubmit}>
            <Input
              autoComplete="email"
              error={emailError}
              label="Email"
              name="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <Button
              className="w-full"
              disabled={loading || gatewayDown}
              size="lg"
              type="submit"
              variant="primary"
            >
              {loading ? 'Sending…' : 'Email me a sign-in link'}
            </Button>
            <p className="text-center text-xs leading-relaxed text-paper-500">
              We'll email you a link that signs you in — no password needed.
              {IS_DEV && ' In dev, the link prints to the gateway stdout.'}
            </p>
          </form>
        ) : (
          <form className="space-y-5" noValidate onSubmit={handlePasswordSubmit}>
            <Input
              autoComplete="username"
              error={emailError}
              label="Email"
              name="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <div className="space-y-2">
              <Input
                autoComplete="current-password"
                error={passwordError}
                label="Password"
                name="password"
                onChange={(e) => setPassword(e.target.value)}
                required
                type="password"
                value={password}
              />
              <div className="flex justify-end">
                <Button
                  className="h-auto min-h-6 px-2 py-1 text-paper-300 hover:bg-transparent hover:text-paper-100 underline-offset-2 hover:underline focus-visible:underline pointer-coarse:px-3"
                  disabled={loading || gatewayDown}
                  onClick={handleForgotPassword}
                  size="sm"
                  variant="ghost"
                >
                  Forgot password?
                </Button>
              </div>
            </div>
            <Button
              className="w-full"
              disabled={loading || gatewayDown}
              size="lg"
              type="submit"
              variant="primary"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        )}
        <p className="mt-6 text-center text-sm leading-relaxed text-paper-500">
          {hasSocial
            ? 'No account yet? Sign in with a provider above and an administrator will approve you, or ask one for an invite.'
            : 'No account yet? Ask an administrator for an invite. New accounts need their approval.'}
        </p>
        <p className="mt-3 text-center text-sm leading-relaxed text-paper-500 lg:hidden">
          auto-swe turns a ticket into a pull request for you to review and merge.
        </p>
        <SupportContact className="mt-6 text-center" />
      </AuthLayout>
    </div>
  );
}
