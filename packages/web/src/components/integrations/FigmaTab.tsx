'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type FigmaConfigInput,
  testFigmaConnection,
  useFigmaConfig,
  useUpdateFigmaConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { clearableIntField } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput } from './SecretInput';

export function FigmaTab() {
  const {
    data: resp,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useFigmaConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateFigmaConfig();

  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [apiToken, setApiToken] = useState('');
  const [maxNodes, setMaxNodes] = usePrefilledField(data?.maxNodes);

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
    // Prefilled: omit when unchanged, send null when cleared.
    body.maxNodes = clearableIntField(maxNodes, data?.maxNodes);

    submit(
      () => update.mutateAsync(body),
      () => setApiToken('')
    );
  };

  const handleTest = () => {
    runTest(() => testFigmaConnection());
  };

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="Figma config"
        onRetry={() => void refetch()}
      />
    );
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
            <Select
              aria-label="Enabled"
              compact
              id="figma-enabled"
              onChange={(v) => {
                setEnabled(v === '' ? undefined : v === 'true');
              }}
              options={[
                { label: '(keep current)', value: '' },
                { label: 'Yes', value: 'true' },
                { label: 'No', value: 'false' },
              ]}
              value={enabled === undefined ? '' : String(enabled)}
            />
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
            <Input
              compact
              id="figma-max-nodes"
              inputMode="numeric"
              onChange={(e) => setMaxNodes(e.target.value)}
              placeholder="12"
              value={maxNodes}
            />
            <p className="text-[11px] text-paper-600">
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
        <TestResultAlert result={testResult} />
      </Card>

      <IntegrationFormFooter error={error} isPending={update.isPending} saved={saved} />
    </form>
  );
}
