'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import {
  useAdminCredentials,
  useEmbeddingConfig,
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
  const { error, submit } = useIntegrationConfigForm();

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
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Embeddings">System-wide model</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        Used by the semantic-memory commit step. Singleton — no per-team or per-template overrides.
        The model MUST produce 1536-dimensional vectors (the <code>agent_lessons.embedding</code>{' '}
        pgvector column is fixed-width).
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
        {error && <Alert>{error}</Alert>}
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
  );
}
