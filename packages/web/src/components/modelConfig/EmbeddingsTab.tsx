'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import {
  SUGGESTED_MODEL_SPECS,
  useAdminCredentials,
  useEmbeddingConfig,
  useUpdateEmbeddingConfig,
} from '@/hooks/useModelConfig';

/// Singleton embedding-model selector. Output must be 1536-dimensional or
/// `generateEmbedding` throws (pgvector column is fixed-width); the UI doesn't
/// enforce dimensionality directly — the worker errors loudly when wrong.
export function EmbeddingsTab() {
  const { data: config, isLoading } = useEmbeddingConfig();
  const { data: credentials } = useAdminCredentials();
  const update = useUpdateEmbeddingConfig();

  const [modelSpec, setModelSpec] = useState<string>('');
  const [credentialId, setCredentialId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Sync form state to the query result. Re-keys on the row's updatedAt so a
  // server-side change (e.g. another admin saving) refreshes the form while
  // preserving local edits the user made before saving.
  useEffect(() => {
    if (config && !dirty) {
      setModelSpec(config.modelSpec);
      setCredentialId(config.credentialId ?? '');
    }
  }, [config, dirty]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({ credentialId: credentialId || null, modelSpec });
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const suggestions = SUGGESTED_MODEL_SPECS.flatMap((p) => p.specs);

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Embeddings">System-wide model</CardTitle>
      </CardHeader>
      {isLoading && <p className="text-sm text-paper-400">Loading…</p>}
      <p className="mb-4 text-xs text-paper-500">
        Used by the semantic-memory commit step. Singleton — no per-team or per-template overrides.
        The model MUST produce 1536-dimensional vectors (the <code>agent_lessons.embedding</code>{' '}
        pgvector column is fixed-width).
      </p>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="embedSpec">
            Model spec
          </label>
          <input
            className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs"
            id="embedSpec"
            list="embed-suggestions"
            onChange={(e) => {
              setModelSpec(e.target.value);
              setDirty(true);
            }}
            pattern="[^/\s]+/.+"
            placeholder="openai/text-embedding-3-large"
            required
            title="Must be <provider>/<model-id> with no whitespace"
            value={modelSpec}
          />
          <datalist id="embed-suggestions">
            <option value="openai/text-embedding-3-large" />
            <option value="openai/text-embedding-3-small" />
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <Select
          className="border-ink-600 bg-ink-900"
          id="embedCred"
          label="Pinned credential (optional)"
          onChange={(e) => {
            setCredentialId(e.target.value);
            setDirty(true);
          }}
          value={credentialId}
        >
          <option value="">— Resolve by provider name —</option>
          {(credentials ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.scope} · {c.provider}/****{c.lastFour}
            </option>
          ))}
        </Select>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end pt-2">
          <Button disabled={!dirty || update.isPending} type="submit" variant="primary">
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
