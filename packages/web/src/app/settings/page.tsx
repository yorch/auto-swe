'use client';

import { useAuthStore } from '@/stores/authStore';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-[var(--muted-foreground)]">Role</dt>
              <dd className="font-medium">{user?.role ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted-foreground)]">User ID</dt>
              <dd className="font-mono text-xs">{user?.sub ?? '-'}</dd>
            </div>
          </dl>
        </Card>
        <Card>
          <CardHeader><CardTitle>Integrations</CardTitle></CardHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Slack</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {user?.slackId ? `Connected (${user.slackId})` : 'Not connected'}
                </p>
              </div>
              {!user?.slackId && (
                <a
                  href="/api/v1/auth/slack/connect"
                  className="text-sm text-[var(--primary)] hover:underline"
                >
                  Connect
                </a>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
