'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import {
  useAdminCredentials,
  useEmbeddingConfig,
  useMemoryReembedStatus,
  useStartMemoryReembed,
  useUpdateEmbeddingConfig,
} from '@/hooks/useModelConfig';
import { ModelSpecPicker } from './ModelSpecPicker';

/// Singleton embedding-model selector. Output must be 1536-dimensional or
/// `generateEmbedding` throws (pgvector column is fixed-width); the UI doesn't
/// enforce dimensionality directly — the worker errors loudly when wrong.
export function EmbeddingsTab() {
  const {
    data: config,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useEmbeddingConfig();
  const { data: credentials } = useAdminCredentials();
  const update = useUpdateEmbeddingConfig();

  const [modelSpec, setModelSpec] = useState<string>('');
  const [credentialId, setCredentialId] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [catalogWarnings, setCatalogWarnings] = useState<string[]>([]);
  const { error, saved, submit } = useIntegrationConfigForm();

  // Sync form state to the query result. Re-keys on the row's updatedAt so a
  // server-side change (e.g. another admin saving) refreshes the form while
  // preserving local edits the user made before saving.
  useEffect(() => {
    if (config && !dirty) {
      setModelSpec(config.modelSpec);
      setCredentialId(config.credentialId ?? '');
    }
  }, [config, dirty]);

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="embedding config"
        onRetry={() => void refetch()}
      />
    );
  }

  // A pinned credential covers any provider; otherwise one must exist for the chosen provider.
  const embeddingProvider = modelSpec.split('/')[0]?.trim().toLowerCase() ?? '';
  const noCredential =
    !credentialId &&
    embeddingProvider !== '' &&
    credentials !== undefined &&
    !credentials.some(
      (c) => c.scope === 'GLOBAL' && c.provider.toLowerCase() === embeddingProvider
    );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void submit(
      async () => {
        const res = await update.mutateAsync({ credentialId: credentialId || null, modelSpec });
        setCatalogWarnings(res.catalogWarnings ?? []);
        return res;
      },
      () => setDirty(false)
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Embeddings">System-wide model</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Turns lessons and memory into vectors so the platform can find similar ones later. One
          model serves the whole platform; teams and workflows cannot override it. The model must
          produce 1536-dimensional vectors, because stored memory has a fixed width.
        </p>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <ModelSpecPicker
            id="embedSpec"
            kind="EMBEDDING"
            label="Model spec"
            onChange={(spec) => {
              setModelSpec(spec);
              setDirty(true);
            }}
            placeholder="openai/text-embedding-3-large"
            required
            value={modelSpec}
          />
          <Combobox
            id="embedCred"
            label="Pinned credential (optional)"
            onChange={(v) => {
              setCredentialId(v);
              setDirty(true);
            }}
            options={[
              { label: '— Resolve by provider name —', value: '' },
              ...(credentials ?? []).map((c) => ({
                label: `${c.scope} · ${c.provider}/****${c.lastFour}`,
                value: c.id,
              })),
            ]}
            value={credentialId}
          />
          {noCredential && (
            <Alert variant="warning">
              No credential is stored for {embeddingProvider}. Add one on the Credentials tab, or
              memory and lesson search will fail.
            </Alert>
          )}
          {error && <Alert>{error}</Alert>}
          {saved && !dirty && <Alert variant="success">Embedding model saved.</Alert>}
          {catalogWarnings.length > 0 && (
            <Alert variant="warning">Model catalog: {catalogWarnings.join(' ')}</Alert>
          )}
          <div className="flex justify-end pt-2">
            <Button disabled={!dirty || update.isPending} type="submit" variant="primary">
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Card>
      <ReembedMemoryCard />
    </div>
  );
}

/// Memory embedded by another model is invisible to recall and consolidation,
/// which compare vectors from one model only. This shows how much there is and
/// starts the bulk re-embed — one embedding call per row, so it asks first.
function ReembedMemoryCard() {
  const { data: status } = useMemoryReembedStatus();
  const start = useStartMemoryReembed();
  const [confirming, setConfirming] = useState(false);
  const [startError, setStartError] = useState<string | undefined>();

  if (!status || (status.stale === 0 && !status.running)) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Memory">Re-embed older memory</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        {status.stale.toLocaleString()} of {status.total.toLocaleString()} memory items were
        embedded by a different model than {status.modelSpec ?? 'the configured one'}. Lesson and
        channel-memory search skips them until they are re-embedded.
      </p>
      {status.running ? (
        <Alert variant="info">Re-embedding is running. The count updates as it goes.</Alert>
      ) : (
        <div className="flex justify-end">
          <Button onClick={() => setConfirming(true)} variant="primary">
            Re-embed {status.stale.toLocaleString()} items
          </Button>
        </div>
      )}
      <ConfirmModal
        confirmLabel="Re-embed"
        error={startError}
        message={`This makes one embedding call per item — ${status.stale.toLocaleString()} calls to ${
          status.modelSpec ?? 'the configured model'
        }, billed to its credential. Each item rejoins search as soon as it is re-embedded.`}
        onClose={() => {
          setConfirming(false);
          setStartError(undefined);
        }}
        onConfirm={async () => {
          try {
            await start.mutateAsync();
            setConfirming(false);
          } catch (err) {
            setStartError(err instanceof Error ? err.message : 'Could not start the re-embed.');
          }
        }}
        open={confirming}
        title="Re-embed memory"
      />
    </Card>
  );
}
