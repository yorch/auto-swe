'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { AccessTokensSection } from '@/components/settings/AccessTokensSection';
import { ConnectedAppsSection } from '@/components/settings/ConnectedAppsSection';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { BUTTON_STYLE, Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { API_BASE } from '@/lib/config';
import { errMsg } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { type SocialProviderId, useAuthStore } from '@/stores/authStore';

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
  okta: boolean;
}

interface Provider {
  id: SocialProviderId;
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
  {
    description: "Sign in with your organization's Okta account.",
    id: 'okta',
    label: 'Okta',
    tone: 'ember',
  },
];

/** One sign-in method in the linked-accounts list: status dot, name, detail line, action. */
function LinkedAccountRow({
  action,
  detail,
  dotClass,
  label,
}: {
  action: ReactNode;
  detail: ReactNode;
  /** Background class for the status dot; `bg-ink-500` when not linked. */
  dotClass: string;
  label: string;
}) {
  return (
    <li className="flex items-center justify-between py-4">
      <div className="flex items-center gap-3">
        <span aria-hidden className={cn('inline-block h-2 w-2 rounded-full', dotClass)} />
        <div>
          <div className="text-sm text-paper-100">{label}</div>
          <div className="font-mono text-[11px] text-paper-500">{detail}</div>
        </div>
      </div>
      {action}
    </li>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const linkProvider = useAuthStore((s) => s.linkProvider);
  const [providers, setProviders] = useState<ProviderFlags>({
    github: false,
    google: false,
    magicLink: true,
    okta: false,
  });
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<{
    accountId: string;
    label: string;
    providerId: string;
  } | null>(null);

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

  const handleLogout = async () => {
    // Same as the TopBar: wait for logout() to clear the session before
    // navigating, or /login can load with the old session still valid.
    await logout();
    router.push('/login');
  };

  const handleLink = async (provider: SocialProviderId) => {
    setBusy(provider);
    setError(null);
    setInfo(null);
    try {
      // Navigates to the provider on success, so `busy` stays set until the
      // page unloads (the button remains disabled).
      await linkProvider(provider);
    } catch (err) {
      setError(errMsg(err, 'link failed'));
      setBusy(null);
    }
  };

  // `accountId` is better-auth's own account-row id (`LinkedAccount.id`), not
  // the provider's subject. Since 1.7 the unlink endpoint selects purely on
  // that row id — passing `providerId` alongside it is rejected as an unknown
  // body field. Rejects on failure so the ConfirmModal shows the error inline.
  const handleUnlink = async (providerId: string, accountId: string) => {
    setError(null);
    setInfo(null);
    const res = await fetch(`${API_BASE}/api/auth/unlink-account`, {
      body: JSON.stringify({ accountId }),
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
  };

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Account"
        subtitle="Profile, sign-in methods, and integrations. Changes apply to your account only."
        title="Account settings"
      />

      <section>
        <SectionHeader hint="who you are" number="01" title="Profile" />
        <Card variant="inset">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-4 text-sm">
            <dt className="label-mono">User ID</dt>
            <dd className="tabular font-mono text-xs text-paper-200">{user?.sub ?? '—'}</dd>
            <dt className="label-mono">Email</dt>
            <dd className="font-mono text-xs text-paper-200">{user?.email ?? '—'}</dd>
            <dt className="label-mono">Role</dt>
            <dd>
              <Badge tone="ember" uppercase variant="outline">
                {user?.role ?? 'guest'}
              </Badge>
            </dd>
          </dl>
          <div className="mt-6 border-t border-ink-600 pt-4">
            <Button onClick={handleLogout} size="sm" variant="danger">
              Sign out
            </Button>
          </div>
        </Card>
      </section>

      <section>
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
                <LinkedAccountRow
                  action={
                    isLinked && account ? (
                      <Button
                        onClick={() =>
                          setUnlinkTarget({
                            accountId: account.id,
                            label: p.label,
                            providerId: p.id,
                          })
                        }
                        size="sm"
                        variant="danger"
                      >
                        Unlink
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
                    )
                  }
                  detail={
                    isLinked
                      ? `linked${account?.accountId ? ` · ${account.accountId.slice(0, 12)}…` : ''}`
                      : configured
                        ? p.description
                        : 'not configured server-side'
                  }
                  dotClass={
                    isLinked ? (p.tone === 'ember' ? 'bg-ember-400' : 'bg-dust-400') : 'bg-ink-500'
                  }
                  key={p.id}
                  label={p.label}
                />
              );
            })}

            {/* Slack lives outside better-auth — keep its custom OAuth flow. */}
            <LinkedAccountRow
              action={
                user?.slackId ? (
                  <Badge tone="moss" uppercase variant="text">
                    Connected
                  </Badge>
                ) : (
                  // A full-page navigation to the gateway's OAuth start, not an
                  // app route, so it stays a plain anchor rather than a ButtonLink.
                  <a
                    className={buttonClassName('secondary', 'sm')}
                    href={`${API_BASE}/api/v1/auth/slack/connect`}
                    style={BUTTON_STYLE}
                  >
                    Connect
                  </a>
                )
              }
              detail={
                user?.slackId
                  ? `linked · ${user.slackId}`
                  : 'Required for the `/auto-swe` slash command and per-step failure DMs.'
              }
              dotClass={user?.slackId ? 'bg-moss-400' : 'bg-ink-500'}
              label="Slack"
            />
          </ul>
          <p className="mt-4 border-t border-ink-600 pt-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
            Unlinking is blocked if it would leave you without a sign-in method.
          </p>
        </Card>
      </section>

      <section>
        <SectionHeader hint="email + password / magic link" number="03" title="Credentials" />
        <Card variant="inset">
          <p className="text-xs text-paper-400">
            Email+password credentials are managed via better-auth. Use the password reset flow on
            the login page if you need to rotate it. Magic link works with no setup — any time you
            need a fresh session, request one from the login page.
          </p>
        </Card>
      </section>

      <section>
        <AccessTokensSection number="04" />
      </section>

      <section>
        <ConnectedAppsSection number="05" />
      </section>

      <ConfirmModal
        confirmLabel="Unlink"
        dangerous
        message={`You will no longer be able to sign in with ${unlinkTarget?.label ?? 'this provider'} until you link it again.`}
        onClose={() => setUnlinkTarget(null)}
        onConfirm={() =>
          unlinkTarget ? handleUnlink(unlinkTarget.providerId, unlinkTarget.accountId) : undefined
        }
        open={unlinkTarget !== null}
        pendingLabel="Unlinking…"
        title={`Unlink ${unlinkTarget?.label ?? 'account'}?`}
      />
    </div>
  );
}
