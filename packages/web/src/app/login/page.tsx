'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { API_BASE, APP_VERSION, IS_DEV } from '@/lib/config';
import { useAuthStore } from '@/stores/authStore';

interface ProviderFlags {
  github: boolean;
  google: boolean;
  magicLink: boolean;
}

/**
 * Structural validation for the /api/v1/auth/providers response. Used to
 * distinguish "real gateway, providers reported" from "200 OK but something
 * else is on the port and returned a different shape" (e.g. an adminer
 * container or a misconfigured reverse proxy).
 */
function looksLikeProviderResponse(data: unknown): data is ProviderFlags {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const o = data as Record<string, unknown>;
  return (
    typeof o.github === 'boolean' &&
    typeof o.google === 'boolean' &&
    typeof o.magicLink === 'boolean'
  );
}

type Tab = 'magic' | 'password';

export default function LoginPage() {
  // useSearchParams() requires a Suspense boundary above it when the page
  // is statically prerendered at build time. Wrapping the whole component
  // keeps the page eligible for SSG while still letting us read the
  // ?bridge=1 hint from the magic-link / social callback.
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
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
  // when it bounces an unauthenticated request here; honor it, but only for
  // same-origin relative paths (reject `//host` and absolute URLs) to avoid an
  // open-redirect.
  const redirectParam = searchParams.get('redirect');
  const destination =
    redirectParam?.startsWith('/') && !redirectParam.startsWith('//') ? redirectParam : '/';

  const [tab, setTab] = useState<Tab>('magic');
  const [providers, setProviders] = useState<ProviderFlags>({
    github: false,
    google: false,
    magicLink: true,
  });
  /**
   * The first thing the login page does is probe `/api/v1/auth/providers` to
   * see which social providers are configured. That probe doubles as a
   * gateway-reachability check — if it fails at the network level, no other
   * action on this page will work either, and we want to say so loudly rather
   * than letting the user hit Submit and meet a generic "Failed to fetch".
   */
  const [gatewayDown, setGatewayDown] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  // Set after hydrate when the resolved user has isActive=false. Renders
  // a dedicated approval-pending screen instead of bouncing to /.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // After a better-auth social or magic-link sign-in lands back here with
  // ?bridge=1, resolve the session and either route into the dashboard or
  // surface the pending-approval screen depending on isActive.
  useEffect(() => {
    if (searchParams.get('bridge') !== '1') {
      return;
    }
    let cancelled = false;
    (async () => {
      const ok = await hydrate();
      if (cancelled) {
        return;
      }
      if (!ok) {
        setError('Sign-in completed but no session was found — try again.');
        return;
      }
      const u = useAuthStore.getState().user;
      if (u?.isActive === false) {
        setPendingEmail(u.email ?? null);
        return;
      }
      router.replace(destination);
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, hydrate, router, destination]);

  // Which social providers are configured in the backend? Also doubles as
  // the gateway-reachability check (see gatewayDown above). "Gateway is up"
  // means three things in this context: (1) the request didn't fail at the
  // network/CORS layer, (2) the response was 2xx, AND (3) the body is the
  // shape we expect — a JSON object with the three provider flags. The third
  // check matters because a port collision on 8080 (e.g. an unrelated adminer
  // / PHP container) can answer 200 with HTML, which would otherwise leave
  // the page in a quiet "no providers" state instead of telling the user
  // why nothing works.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/providers`);
        if (!res.ok) {
          // 4xx/5xx — could be the real gateway throwing, or a wrong server
          // on the port. Either way the page can't continue, so surface it.
          setGatewayDown(true);
          return;
        }
        const data = (await res.json()) as unknown;
        if (!looksLikeProviderResponse(data)) {
          // 200 OK but the body isn't our shape — almost certainly a different
          // server bound to the port. Surface as gateway-down.
          setGatewayDown(true);
          return;
        }
        setProviders(data);
        setGatewayDown(false);
      } catch (err) {
        // TypeError: network failure (DNS, server down, CORS rejected).
        // SyntaxError: 200 OK but body wasn't valid JSON (wrong server bound).
        if (err instanceof TypeError || err instanceof SyntaxError) {
          setGatewayDown(true);
        }
      }
    })();
  }, []);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      await login(email, password);
      router.push(destination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    setInfo('');
    if (!email) {
      setError('Enter the email associated with your account first.');
      return;
    }
    setLoading(true);
    try {
      await requestPasswordReset(email);
      setInfo(
        IS_DEV
          ? `If an account exists for ${email}, a reset link is on its way. In dev, the link is logged to the gateway stdout.`
          : `If an account exists for ${email}, a reset link is on its way.`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send reset link');
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!email) {
      setError('Enter an email to receive a sign-in link.');
      return;
    }
    setLoading(true);
    try {
      await requestMagicLink(email);
      setInfo(
        IS_DEV
          ? `A sign-in link was sent to ${email}. In dev, the link is logged to the gateway stdout.`
          : `A sign-in link was sent to ${email}.`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send magic link');
    } finally {
      setLoading(false);
    }
  };

  const hasSocial = providers.github || providers.google;

  // Pending-approval short-circuit: the user authenticated successfully via
  // better-auth but their User row is isActive=false. Show an explanatory
  // screen instead of the sign-in form so they understand why nothing else
  // in the app works yet.
  if (pendingEmail) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-800 px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-400">
            ¶ § auth/pending
          </div>
          <h1 className="mb-3 font-display text-4xl font-light tracking-tight text-paper-50">
            Awaiting approval.
          </h1>
          <p className="mb-6 text-sm leading-relaxed text-paper-400">
            We received your sign-in for{' '}
            <span className="font-mono text-paper-100">{pendingEmail}</span>. An admin needs to
            approve your account before you can use the workshop. Ping an admin once you're approved
            — sign in again and you'll be in.
          </p>
          <div className="rounded-[9px] border border-ink-600 bg-ink-800/40 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-paper-500">
            status: pending
          </div>
          <Button
            className="mt-6"
            onClick={() => {
              setPendingEmail(null);
              router.replace('/login');
            }}
            size="sm"
            variant="secondary"
          >
            ← Back to sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* LEFT — editorial panel (unchanged from prior design) */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-ink-600 bg-ink-950 p-12 lg:flex">
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'radial-gradient(circle at 30% 20%, rgba(226,107,60,0.18), transparent 55%),' +
              'radial-gradient(circle at 80% 80%, rgba(133,166,197,0.10), transparent 55%)',
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, var(--color-paper-500) 1px, transparent 1px),' +
              'linear-gradient(to bottom, var(--color-paper-500) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />

        <header className="relative z-10 flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-3xl font-medium leading-none tracking-tight text-paper-50">
                auto
              </span>
              <span className="display-italic text-3xl leading-none text-ember-400">·swe</span>
            </div>
            <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
              autonomous workflows
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-moss-400" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-400">
              gateway online
            </span>
          </div>
        </header>

        <div className="relative z-10 max-w-xl space-y-8">
          <div className="fade-up">
            <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.24em] text-ember-400">
              ¶ Manifesto
            </div>
            <p className="font-display text-[44px] font-light leading-[1.1] tracking-tight text-paper-50">
              A workshop for{' '}
              <span className="display-italic text-ember-300">software at scale</span>
              <span className="text-ember-400">.</span>
            </p>
          </div>
          <p className="fade-up stagger-2 max-w-md text-base leading-relaxed text-paper-300">
            Coordinate fleets of engineering agents, observe every workflow run, and ship code with
            the rigor of an instrument — not a gamble.
          </p>
        </div>

        <footer className="relative z-10 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          <span>© {new Date().getFullYear()} · brnby</span>
          <span>v{APP_VERSION} · oauth + magic link + password</span>
        </footer>
      </aside>

      {/* RIGHT — sign-in panel */}
      <section className="relative flex items-center justify-center bg-ink-800 px-6 py-12 lg:px-16">
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-baseline gap-1.5 lg:hidden">
            <span className="font-display text-2xl font-medium leading-none tracking-tight text-paper-50">
              auto
            </span>
            <span className="display-italic text-2xl leading-none text-ember-400">·swe</span>
          </div>

          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-ember-400">
            ¶ § auth/01
          </div>
          <h1 className="mb-2 font-display text-4xl font-light tracking-tight text-paper-50">
            Sign in.
          </h1>
          <p className="mb-8 text-sm text-paper-400">
            Pick a sign-in method. New email addresses join a pending-approval queue.
          </p>

          {gatewayDown && (
            <div className="mb-6 rounded-[9px] border border-brick-400/40 bg-brick-400/10 px-4 py-3 text-xs text-brick-200">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-brick-400">
                ! Gateway unreachable
              </div>
              <p className="leading-relaxed">
                Can't reach the auto-swe gateway at{' '}
                <code className="text-brick-100" suppressHydrationWarning>
                  {API_BASE}
                </code>
                . Sign-in won't work until the gateway is running and CORS_ORIGIN includes this
                page's origin (
                <code className="text-brick-100">
                  {typeof window !== 'undefined' ? window.location.origin : ''}
                </code>
                ).
              </p>
            </div>
          )}

          {/* Social providers — only shown when configured in the backend */}
          {hasSocial && (
            <div className="mb-6 space-y-2">
              {providers.github && (
                <button
                  className="group flex w-full items-center justify-center gap-2 rounded-lg border border-ink-500 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-200 transition-colors hover:border-ember-400 hover:text-ember-400"
                  onClick={() => signInWithProvider('github')}
                  type="button"
                >
                  <span aria-hidden>◐</span>
                  <span>continue with github</span>
                </button>
              )}
              {providers.google && (
                <button
                  className="group flex w-full items-center justify-center gap-2 rounded-lg border border-ink-500 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-200 transition-colors hover:border-ember-400 hover:text-ember-400"
                  onClick={() => signInWithProvider('google')}
                  type="button"
                >
                  <span aria-hidden>◑</span>
                  <span>continue with google</span>
                </button>
              )}
              <div className="my-6 flex items-center gap-4">
                <span className="h-px flex-1 bg-ink-600" />
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                  or
                </span>
                <span className="h-px flex-1 bg-ink-600" />
              </div>
            </div>
          )}

          {/* Tab switcher: magic link vs password */}
          <div className="mb-5 flex gap-px overflow-hidden rounded-lg border border-ink-600 bg-ink-600/40">
            <button
              className={`flex-1 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${
                tab === 'magic'
                  ? 'bg-ink-800 text-ember-400'
                  : 'bg-ink-900/60 text-paper-400 hover:bg-ink-800/60'
              }`}
              onClick={() => {
                setTab('magic');
                setError('');
                setInfo('');
              }}
              type="button"
            >
              Magic link
            </button>
            <button
              className={`flex-1 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${
                tab === 'password'
                  ? 'bg-ink-800 text-ember-400'
                  : 'bg-ink-900/60 text-paper-400 hover:bg-ink-800/60'
              }`}
              onClick={() => {
                setTab('password');
                setError('');
                setInfo('');
              }}
              type="button"
            >
              Password
            </button>
          </div>

          {error && <Alert className="mb-4">{error}</Alert>}
          {info && (
            <Alert className="mb-4" variant="success">
              {info}
            </Alert>
          )}

          {tab === 'magic' ? (
            <form className="space-y-5" onSubmit={handleMagicLinkSubmit}>
              <Input
                autoComplete="email"
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
                disabled={loading}
                size="lg"
                type="submit"
                variant="primary"
              >
                {loading ? 'Sending…' : 'Email me a sign-in link →'}
              </Button>
              {IS_DEV && (
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-600">
                  In dev, the magic link prints to the gateway stdout.
                </p>
              )}
            </form>
          ) : (
            <form className="space-y-5" onSubmit={handlePasswordSubmit}>
              <Input
                autoComplete="email"
                label="Email"
                name="email"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
              <Input
                autoComplete="current-password"
                label="Password"
                name="password"
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                required
                type="password"
                value={password}
              />
              <Button
                className="w-full"
                disabled={loading}
                size="lg"
                type="submit"
                variant="primary"
              >
                {loading ? 'Authenticating…' : 'Enter →'}
              </Button>
              <div className="flex items-center justify-end">
                <button
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
                  disabled={loading}
                  onClick={handleForgotPassword}
                  type="button"
                >
                  Forgot password?
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
