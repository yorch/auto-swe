'use client';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useOrganizationGithub } from '@/hooks/useOrganizationGithub';
import { errMsg } from '@/lib/errors';

export function OrganizationGithub({ orgId }: { orgId: string }) {
  const { installations, connect, retire } = useOrganizationGithub(orgId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  async function start() {
    setError(null);
    try {
      window.location.assign((await connect.mutateAsync()).url);
    } catch (err) {
      setError(errMsg(err, 'Could not connect GitHub'));
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
      </CardHeader>
      <p>
        Connect a new installation of the instance GitHub App. Only teams in this organization can
        import through it.
      </p>
      <Button disabled={connect.isPending} onClick={start}>
        Connect a GitHub org
      </Button>
      {error && <Alert variant="error">{error}</Alert>}
      {installations.isLoading && <p>Loading installations…</p>}
      {installations.isError && <Alert variant="error">Could not load GitHub installations.</Alert>}
      {installations.data?.length === 0 && <p>No linked installations.</p>}
      <ul className="space-y-2">
        {installations.data?.map((row) => (
          <li className="flex items-center justify-between gap-3" key={row.id}>
            <span>
              {row.accountLogin} · {row.installationId} · {row.isActive ? 'Active' : 'Retired'}
            </span>
            {row.isActive && (
              <Button onClick={() => setPending(row.id)}>Retire {row.accountLogin}</Button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmModal
        confirmLabel="Retire"
        message="New runs using this installation stop. Existing runs continue. Reactivation requires a platform admin."
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) {
            return;
          }
          try {
            await retire.mutateAsync(pending);
            setPending(null);
          } catch (err) {
            setError(errMsg(err));
            setPending(null);
          }
        }}
        open={pending !== null}
        title="Retire GitHub installation"
      />
    </Card>
  );
}
