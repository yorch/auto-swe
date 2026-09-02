'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  type FigmaConfigInput,
  testFigmaConnection,
  useFigmaConfig,
  useUpdateFigmaConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { ConfigField } from './ConfigField';
import { SecretInput } from './SecretInput';

export function FigmaTab() {
  const { data: resp, isLoading } = useFigmaConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateFigmaConfig();

  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [apiToken, setApiToken] = useState('');
  const [maxNodes, setMaxNodes] = useState('');

  const { saved, error, testing, testResult, submit, runTest } = useIntegrationConfigForm();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const body: FigmaConfigInput = {};
    if (enabled !== undefined) {
      body.enabled = enabled;
    }
    if (apiToken) {
      body.apiToken = apiToken;
    }
    if (maxNodes) {
      const parsed = Number.parseInt(maxNodes, 10);
      if (!Number.isNaN(parsed)) {
        body.maxNodes = parsed;
      }
    }

    submit(
      () => update.mutateAsync(body),
      () => setApiToken('')
    );
  };

  const handleTest = () => {
    runTest(() => testFigmaConnection());
  };

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Figma">Figma design source</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Connect Figma so a work request that references a Figma file/node is enriched with a
          compact design summary (frames, text, tokens) that the implementer matches against. The
          connector is read-only — it never writes to Figma. To give agents live, on-demand design
          access during a run, add the Figma Dev Mode endpoint as an MCP connection under{' '}
          <span className="font-mono text-[10px] text-paper-400">/studio/mcp</span> instead.
        </p>
        <div className="space-y-4">
          <ConfigField
            current={data?.enabled === undefined ? undefined : data.enabled ? 'yes' : 'no'}
            id="figma-enabled"
            label="Enabled"
          >
            <select
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs focus:border-ember-400 focus:outline-none"
              id="figma-enabled"
              onChange={(e) => {
                const v = e.target.value;
                setEnabled(v === '' ? undefined : v === 'true');
              }}
              value={enabled === undefined ? '' : String(enabled)}
            >
              <option value="">(keep current)</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </ConfigField>
          <SecretInput
            current={data?.apiToken ?? null}
            id="figma-api-token"
            label="API token"
            onChange={setApiToken}
            placeholder="Figma personal access token (figd_…)"
            source={sources.apiToken}
            value={apiToken}
          />
          <ConfigField current={data?.maxNodes ?? undefined} id="figma-max-nodes" label="Max nodes">
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="figma-max-nodes"
              inputMode="numeric"
              onChange={(e) => setMaxNodes(e.target.value)}
              placeholder="12"
              value={maxNodes}
            />
            <p className="mt-1 text-[10px] text-paper-600">
              Caps how many design nodes are summarized per request — bounds context size and cost.
            </p>
          </ConfigField>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Figma">Test connection</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Calls the Figma API with the saved token to verify connectivity and access.
        </p>
        <Button
          disabled={testing || !data?.enabled}
          onClick={handleTest}
          size="sm"
          type="button"
          variant="secondary"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {testResult && (
          <p className={`mt-2 text-sm ${testResult.ok ? 'text-moss-400' : 'text-brick-400'}`}>
            {testResult.ok ? '✓' : '✗'} {testResult.detail}
          </p>
        )}
      </Card>

      {saved && <p className="text-sm text-moss-400">Settings saved.</p>}
      {error && <p className="text-sm text-brick-400">{error}</p>}

      <div className="flex justify-end">
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
