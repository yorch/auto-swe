'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { useClaimGithubInstallation } from '@/hooks/useOrganizationGithub';
import { errMsg } from '@/lib/errors';

function InstallationCallback() {
  const params = useSearchParams();
  const router = useRouter();
  const claim = useClaimGithubInstallation();
  const state = params.get('state');
  const installationId = params.get('installation_id');
  const code = params.get('code');
  useEffect(() => {
    if (!state) {
      const query = new URLSearchParams();
      if (installationId) {
        query.set('installation_id', installationId);
      }
      if (params.get('setup_action')) {
        query.set('setup_action', params.get('setup_action') ?? '');
      }
      router.replace(`/admin/integrations?${query}`);
    }
  }, [state, installationId, params, router]);
  if (!state) {
    return <p>Returning to GitHub administration…</p>;
  }
  if (!code || !installationId) {
    return (
      <Alert variant="error">
        GitHub did not complete installation authorization. Start again from your organization.
      </Alert>
    );
  }
  if (claim.data) {
    return (
      <div>
        <h1>GitHub connected</h1>
        <p>{claim.data.accountLogin} is linked to your organization.</p>
        <ButtonLink href={`/admin/organizations/${claim.data.organizationId}`}>
          Return to organization
        </ButtonLink>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <h1>Connect GitHub installation</h1>
      <p>
        Confirm this new installation for the organization where you started. Sign in as the same
        organization admin if your session has expired.
      </p>
      {claim.isError && (
        <Alert variant="error">{errMsg(claim.error, 'Could not claim the installation')}</Alert>
      )}
      <Button
        disabled={claim.isPending}
        onClick={() => claim.mutate({ code, installation_id: installationId, state })}
      >
        Connect installation
      </Button>
    </div>
  );
}

export default function GithubInstallCallbackPage() {
  return (
    <Suspense fallback={<p>Loading GitHub authorization…</p>}>
      <InstallationCallback />
    </Suspense>
  );
}
