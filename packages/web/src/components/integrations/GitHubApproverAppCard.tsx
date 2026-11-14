'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Textarea } from '@/components/ui/Textarea';
import {
  GITHUB_APPROVER_APP_TEST_PATH,
  type GithubApproverApp,
  useGithubApproverApp,
  useRemoveGithubApproverApp,
  useSaveGithubApproverApp,
} from '@/hooks/useGithubApproverApp';
import { errMsg } from '@/lib/errors';
import { ConfigStatusBadge } from './ConfigStatusBadge';
import { FieldGrid, IntegrationCard } from './IntegrationCard';
import { ProbeModal } from './ProbeModal';

function ApproverForm({ current }: { current: GithubApproverApp }) {
  const [appId, setAppId] = useState(current.appId ?? '');
  const [appSlug, setAppSlug] = useState(current.appSlug ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const save = useSaveGithubApproverApp();
  const remove = useRemoveGithubApproverApp();

  const idChanged = appId.trim() !== (current.appId ?? '');
  const slugChanged = appSlug.trim() !== (current.appSlug ?? '');
  const dirty = idChanged || slugChanged || privateKey !== '';
  const hasAnything = Boolean(current.appId || current.appSlug || current.privateKeyLastFour);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await save.mutateAsync({
        ...(idChanged && { appId: appId.trim() || null }),
        ...(slugChanged && { appSlug: appSlug.trim().toLowerCase() || null }),
        ...(privateKey !== '' && { privateKey }),
      });
      setPrivateKey('');
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <IntegrationCard
      description="A second GitHub App, different from the one above, whose only job is submitting an approving review on a LOW-risk pull request the platform opened. GitHub refuses an App approving its own pull request, so the two can never be the same App. There is no environment fallback: without it, no pull request is approved by the platform."
      status={
        <ConfigStatusBadge
          state={current.configured ? 'configured' : hasAnything ? 'partial' : 'unset'}
        />
      }
      title="Approver App"
    >
      <form className="space-y-4" onSubmit={submit}>
        <FieldGrid>
          <Input
            className="font-mono"
            id="gh-approver-app-id"
            label="App ID"
            onChange={(e) => setAppId(e.target.value)}
            placeholder="12345"
            value={appId}
          />
          <Input
            className="font-mono"
            hint="The App's URL name on GitHub, as in github.com/apps/<slug>. Reviews it submits are recognised by it."
            id="gh-approver-app-slug"
            label="App slug"
            onChange={(e) => setAppSlug(e.target.value)}
            placeholder="my-org-approver"
            value={appSlug}
          />
        </FieldGrid>
        <Textarea
          autoComplete="off"
          compact
          hint={
            current.privateKeyLastFour
              ? `Set (…${current.privateKeyLastFour}). Leave empty to keep it. It is stored encrypted and never shown again.`
              : "The App's PEM-encoded RSA private key. It is stored encrypted and never shown again."
          }
          id="gh-approver-app-key"
          label="Private key"
          onChange={(e) => setPrivateKey(e.target.value)}
          rows={4}
          value={privateKey}
        />
        <p className="text-xs text-paper-500">
          Saving checks the id, slug and key against GitHub; nothing is stored if they do not name
          one App. Replacing or removing the App re-evaluates open pull requests.
        </p>
        {error && <Alert>{error}</Alert>}
        {saved && !dirty && <Alert variant="success">Approver App saved.</Alert>}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!dirty || save.isPending} type="submit">
            {save.isPending ? 'Saving…' : 'Save approver App'}
          </Button>
          <Button
            disabled={!current.configured}
            onClick={() => setTesting(true)}
            type="button"
            variant="secondary"
          >
            Test
          </Button>
          <Button
            disabled={!hasAnything}
            onClick={() => setRemoving(true)}
            type="button"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      </form>

      {testing && (
        <ProbeModal
          onClose={() => setTesting(false)}
          path={GITHUB_APPROVER_APP_TEST_PATH}
          subtitle={current.appSlug ?? undefined}
          title="Test approver App"
        />
      )}
      <ConfirmModal
        confirmLabel="Remove"
        dangerous
        message="Removes the App id, slug and private key. Approvals the App already gave stand on GitHub; open pull requests are re-evaluated and the platform withdraws what no longer holds. Until an approver App is configured again, nothing is approved by the platform."
        onClose={() => setRemoving(false)}
        onConfirm={async () => {
          await remove.mutateAsync();
          setAppId('');
          setAppSlug('');
          setPrivateKey('');
        }}
        open={removing}
        pendingLabel="Removing…"
        title="Remove the approver App?"
      />
    </IntegrationCard>
  );
}

/**
 * The approver App's credentials. Rendered outside the tab's form: it saves on its own, not with
 * "Save changes". ADMIN-only on the API; the integrations pages are admin pages.
 */
export function GitHubApproverAppCard() {
  const { data, error, isError, isFetching, isLoading, refetch } = useGithubApproverApp();
  return (
    <QueryBoundary
      error={error}
      isError={isError}
      isFetching={isFetching}
      isLoading={isLoading}
      label="Approver App"
      onRetry={() => void refetch()}
      rows={3}
      shape="form"
    >
      {data && <ApproverForm current={data} key={data.updatedAt ?? 'unset'} />}
    </QueryBoundary>
  );
}
