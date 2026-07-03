'use client';

import { useEffect, useState } from 'react';
import { AccessTokensSection } from '@/components/settings/AccessTokensSection';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { API_BASE } from '@/lib/config';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

/** Subset of better-auth's list-accounts response shape we actually use. */
interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  createdAt?: string;
}

/** Reflects the public /api/v1/auth/providers shape. */
interface ProviderFlags {
  github: boolean;
  google: boolean;
  magicLink: boolean;
}

interface Provider {
  id: 'github' | 'google';
  label: string;
  description: string;
  tone: 'ember' | 'dust';
}

const SOCIAL_PROVIDERS: Provider[] = [
  {
    description: 'Sign in with your GitHub account.',
    id: 'github',
    label: 'GitHub',
    tone: 'ember',
  },
  {
    description: 'Sign in with your Google account.',
    id: 'google',
    label: 'Google',
    tone: 'dust',
  },
];

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [providers, setProviders] = useState<ProviderFlags>({
    github: false,
    google: false,
    magicLink: true,
  });
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    // Parallel reads: which providers the backend is configured for, and
    // which accounts the current user has linked. Both are tolerant of a
    // missing better-auth session (legacy bcrypt-only users see an empty
    // linked list and "—" everywhere).
    Promise.all([
      fetch(`${API_BASE}/api/v1/auth/providers`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`${API_BASE}/api/auth/list-accounts`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([p, accts]) => {
      if (p) {
        setProviders(p as ProviderFlags);
      }
      if (Array.isArray(accts)) {
        setLinked(accts as LinkedAccount[]);
      }
    });
  }, []);

  const linkedIds = new Set(linked.map((a) => a.providerId));

  const handleLink = async (provider: 'github' | 'google') => {
    setBusy(provider);
    setError(null);
    setInfo(null);
    // better-auth's `link-social` mirrors the sign-in/social shape: a JSON
    // POST answered with `{ url, redirect: true }` — the client navigates to
    // the provider's auth URL. After the OAuth round-trip the user lands back
    // at callbackURL with the new Account row already attached.
    try {
      const res = await fetch(`${API_BASE}/api/auth/link-social`, {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/settings`,
          provider,
        }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(errBody?.message ?? `link failed (${res.status})`);
      }
      const data = (await res.json().catch(() => null)) as { url?: string } | null;
      if (!data?.url) {
        throw new Error(`${provider} link did not return a redirect URL`);
      }
      window.location.href = data.url;
      // Navigating away — leave `busy` set so the button stays disabled.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'link failed');
      setBusy(null);
    }
  };

  const handleUnlink = async (providerId: string, accountId: string) => {
    setBusy(providerId);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/unlink-account`, {
        body: JSON.stringify({ accountId, providerId }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(errBody?.message ?? `unlink failed (${res.status})`);
      }
      setLinked((prev) => prev.filter((a) => a.providerId !== providerId));
      setInfo(`${providerId} unlinked from this account.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unlink failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <PageHeader
          chapter="§ Settings"
          subtitle="Profile, sign-in methods, and integrations. Changes apply to your account only."
          title="Account settings."
        />
      </div>

      <section className="fade-up stagger-1">
        <SectionHeader hint="who you are" number="01" title="Profile" />
        <Card variant="inset">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-4 text-sm">
            <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
              User ID
            </dt>
            <dd className="tabular font-mono text-xs text-paper-200">{user?.sub ?? '—'}</dd>
            <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
              Email
            </dt>
            <dd className="font-mono text-xs text-paper-200">{user?.email ?? '—'}</dd>
            <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
              Role
            </dt>
            <dd className="font-mono text-xs">
              <span className="rounded border border-ember-400/40 bg-ember-400/10 px-2 py-0.5 uppercase tracking-wider text-ember-400">
                {user?.role ?? 'guest'}
              </span>
            </dd>
          </dl>
          <div className="mt-6 border-t border-ink-600 pt-4">
            <Button onClick={logout} size="sm" variant="danger">
              Sign out
            </Button>
          </div>
        </Card>
      </section>

      <section className="fade-up stagger-2">
        <SectionHeader hint="link / unlink sign-in providers" number="02" title="Linked accounts" />

        {error && (
          <Alert className="mb-4" variant="error">
            {error}
          </Alert>
        )}
        {info && (
          <Alert className="mb-4" variant="success">
            {info}
          </Alert>
        )}

        <Card variant="inset">
          <ul className="divide-y divide-ink-600">
            {SOCIAL_PROVIDERS.map((p) => {
              const isLinked = linkedIds.has(p.id);
              const configured = providers[p.id];
              const account = linked.find((a) => a.providerId === p.id);
              return (
                <li className="flex items-center justify-between py-4" key={p.id}>
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className={cn(
                        'inline-block h-2 w-2 rounded-full',
                        isLinked
                          ? p.tone === 'ember'
                            ? 'bg-ember-400'
                            : 'bg-dust-400'
                          : 'bg-ink-500'
                      )}
                    />
                    <div>
                      <div className="text-sm text-paper-100">{p.label}</div>
                      <div className="font-mono text-[11px] text-paper-500">
                        {isLinked
                          ? `linked${account?.accountId ? ` · ${account.accountId.slice(0, 12)}…` : ''}`
                          : configured
                            ? p.description
                            : 'not configured server-side'}
                      </div>
                    </div>
                  </div>
                  {isLinked && account ? (
                    <Button
                      disabled={busy === p.id}
                      onClick={() => handleUnlink(p.id, account.accountId)}
                      size="sm"
                      variant="ghost"
                    >
                      {busy === p.id ? 'Unlinking…' : 'Unlink'}
                    </Button>
                  ) : configured ? (
                    <Button
                      disabled={busy === p.id}
                      onClick={() => handleLink(p.id)}
                      size="sm"
                      variant="secondary"
                    >
                      {busy === p.id ? 'Linking…' : 'Link'}
                    </Button>
                  ) : (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                      —
                    </span>
                  )}
                </li>
              );
            })}

            {/* Slack lives outside better-auth — keep its custom OAuth flow. */}
            <li className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={cn(
                    'inline-block h-2 w-2 rounded-full',
                    user?.slackId ? 'bg-moss-400' : 'bg-ink-500'
                  )}
                />
                <div>
                  <div className="text-sm text-paper-100">Slack</div>
                  <div className="font-mono text-[11px] text-paper-500">
                    {user?.slackId
                      ? `linked · ${user.slackId}`
                      : 'Required for the `/auto-swe` slash command and per-step failure DMs.'}
                  </div>
                </div>
              </div>
              {user?.slackId ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-moss-400">
                  Connected
                </span>
              ) : (
                <a
                  className="inline-flex h-7 items-center justify-center gap-2 rounded-lg border border-ink-500 bg-transparent px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-paper-100 transition-colors hover:border-ember-400 hover:text-ember-400"
                  href={`${API_BASE}/api/v1/auth/slack/connect`}
                >
                  Connect
                </a>
              )}
            </li>
          </ul>
          <p className="mt-4 border-t border-ink-600 pt-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
            Unlinking is blocked if it would leave you without a sign-in method.
          </p>
        </Card>
      </section>

      <section className="fade-up stagger-3">
        <SectionHeader hint="email + password / magic link" number="03" title="Credentials" />
        <Card variant="inset">
          <p className="text-xs text-paper-400">
            Email+password credentials are managed via better-auth. Use the password reset flow on
            the login page if you need to rotate it. Magic link works with no setup — any time you
            need a fresh session, request one from the login page.
          </p>
        </Card>
      </section>

      <section className="fade-up stagger-4">
        <SectionHeader hint="for the auto-swe CLI" number="04" title="API tokens" />
        <AccessTokensSection />
      </section>
    </div>
  );
}
