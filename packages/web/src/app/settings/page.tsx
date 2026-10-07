'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProviderMark } from '@/components/auth/ProviderMark';
import { AccessTokensSection } from '@/components/settings/AccessTokensSection';
import { ConnectedAppsSection } from '@/components/settings/ConnectedAppsSection';
import { GitHubCredentialsSection } from '@/components/settings/GitHubCredentialsSection';
import { SettingsListRow, SettingsSection } from '@/components/settings/SettingsSection';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { BUTTON_STYLE, Button, buttonClassName } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useAuthProviders, useLinkedAccounts } from '@/hooks/useAccountSettings';
import { API_BASE } from '@/lib/config';
import { errMsg } from '@/lib/errors';
import { platformRoleLabel } from '@/lib/govLabels';
import { type SocialProviderId, useAuthStore } from '@/stores/authStore';

interface Provider {
  id: SocialProviderId;
  label: string;
  description: string;
}

const SOCIAL_PROVIDERS: Provider[] = [
  { description: 'Sign in with your GitHub account.', id: 'github', label: 'GitHub' },
  { description: 'Sign in with your Google account.', id: 'google', label: 'Google' },
  {
    description: "Sign in with your organization's Okta account.",
    id: 'okta',
    label: 'Okta',
  },
];

export default function SettingsPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const linkProvider = useAuthStore((s) => s.linkProvider);
  const qc = useQueryClient();
  const providersQuery = useAuthProviders();
  const linkedQuery = useLinkedAccounts();
  const providers = providersQuery.data;
  const linked = linkedQuery.data ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<{
    accountId: string;
    label: string;
    providerId: string;
  } | null>(null);

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
      setError(errMsg(err, 'Could not link that account'));
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
    await qc.invalidateQueries({ queryKey: ['linked-accounts'] });
    setInfo(
      `${SOCIAL_PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId} unlinked from your account.`
    );
  };

  const roleLabel = user?.role ? platformRoleLabel(user.role) : 'Guest';

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        subtitle="Your profile, how you sign in, and the tokens and apps that act as you. Changes apply to your account only."
        title="Account settings"
      />

      {error && <Alert variant="error">{error}</Alert>}
      {info && <Alert variant="success">{info}</Alert>}

      <SettingsSection
        actions={
          <Button onClick={handleLogout} size="sm">
            Sign out
          </Button>
        }
        description="The account you are signed in as."
        icon="users"
        id="profile"
        title="Profile"
      >
        <div className="flex flex-wrap items-center gap-4 py-4">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-ember-400 to-violet-400 text-lg font-semibold text-paper-50"
          >
            {(user?.email ?? '?').charAt(0).toUpperCase()}
          </span>
          <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-[auto_auto] sm:justify-start">
            <div className="min-w-0">
              <dt className="label-mono">Email</dt>
              <dd className="mt-0.5 break-all text-sm text-paper-100">{user?.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="label-mono">Role</dt>
              <dd className="mt-1">
                <Badge tone="ember" variant="outline">
                  {roleLabel}
                </Badge>
              </dd>
            </div>
          </dl>
        </div>
      </SettingsSection>

      <SettingsSection
        description="Providers you can sign in with. Unlinking is blocked if it would leave you without a way to sign in."
        icon="lock"
        id="sign-in"
        title="Sign-in methods"
      >
        <QueryBoundary
          compact
          error={providersQuery.error ?? linkedQuery.error}
          isError={providersQuery.isError || linkedQuery.isError}
          isFetching={providersQuery.isFetching || linkedQuery.isFetching}
          isLoading={providersQuery.isLoading || linkedQuery.isLoading}
          label="your sign-in methods"
          loading={<SkeletonRows rows={4} />}
          onRetry={() => {
            void providersQuery.refetch();
            void linkedQuery.refetch();
          }}
        >
          <ul className="divide-y divide-ink-600">
            <SettingsListRow
              detail="Change your password with Forgot password on the sign-in page. A magic link needs no setup: request one there whenever you need a fresh session."
              leading={<Icon name="key" size={16} />}
              title="Email and password"
            />
            {SOCIAL_PROVIDERS.map((p) => {
              const isLinked = linkedIds.has(p.id);
              const configured = providers?.[p.id] ?? false;
              const account = linked.find((a) => a.providerId === p.id);
              return (
                <SettingsListRow
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
                      <Button disabled={busy === p.id} onClick={() => handleLink(p.id)} size="sm">
                        {busy === p.id ? 'Linking…' : 'Link'}
                      </Button>
                    ) : null
                  }
                  detail={
                    isLinked ? (
                      account?.accountId ? (
                        <>
                          Account{' '}
                          <span className="font-mono text-xs text-paper-400">
                            {account.accountId.slice(0, 12)}…
                          </span>
                        </>
                      ) : (
                        p.description
                      )
                    ) : configured ? (
                      p.description
                    ) : (
                      'Not enabled by your administrator'
                    )
                  }
                  key={p.id}
                  leading={<ProviderMark id={p.id} />}
                  status={
                    isLinked ? (
                      <Badge dot tone="moss" variant="outline">
                        Linked
                      </Badge>
                    ) : configured ? null : (
                      <Badge tone="muted" variant="outline">
                        Unavailable
                      </Badge>
                    )
                  }
                  title={p.label}
                />
              );
            })}

            {/* Slack lives outside better-auth — keep its custom OAuth flow. */}
            <SettingsListRow
              action={
                user?.slackId ? null : (
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
                user?.slackId ? (
                  <>
                    Slack user{' '}
                    <span className="font-mono text-xs text-paper-400">{user.slackId}</span>
                  </>
                ) : (
                  <>
                    Needed for the <code className="font-mono text-xs">/auto-swe</code> slash
                    command and per-step failure DMs.
                  </>
                )
              }
              leading={<ProviderMark id="slack" />}
              status={
                user?.slackId ? (
                  <Badge dot tone="moss" variant="outline">
                    Connected
                  </Badge>
                ) : null
              }
              title="Slack"
            />
          </ul>
        </QueryBoundary>
      </SettingsSection>

      <AccessTokensSection />
      <GitHubCredentialsSection />
      <ConnectedAppsSection />

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
