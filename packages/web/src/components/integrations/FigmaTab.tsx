'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type FigmaConfigInput,
  type FigmaTestDraft,
  testFigmaConnection,
  useFigmaConfig,
  useUpdateFigmaConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { clearableIntField, countChanges } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { ConfigStatusBadge, fieldState } from './ConfigStatusBadge';
import { FieldGrid, IntegrationCard } from './IntegrationCard';
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

  // What Save would send: omitted keys are unchanged, so their count is the unsaved edits.
  const body: FigmaConfigInput = {
    apiToken: apiToken || undefined,
    enabled: enabled === data?.enabled ? undefined : enabled,
    // Prefilled: omit when unchanged, send null when cleared.
    maxNodes: clearableIntField(maxNodes, data?.maxNodes),
  };
  const dirtyCount = countChanges(body);

  const { saved, error, testing, testResult, submit, runTest } =
    useIntegrationConfigForm(dirtyCount);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit(
      () => update.mutateAsync(body),
      () => {
        setApiToken('');
        setEnabled(undefined);
      }
    );
  };

  const handleTest = () => {
    // A blank token means the stored one; the Figma host is fixed, so a typed token only ever
    // goes to Figma.
    const draft: FigmaTestDraft = {};
    if (enabled !== undefined) {
      draft.enabled = enabled;
    }
    if (apiToken) {
      draft.apiToken = apiToken;
    }
    const unsaved = Object.keys(draft).length > 0;
    runTest(async () => ({ ...(await testFigmaConnection(draft)), unsaved }));
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
      <IntegrationCard
        description={
          <>
            Connect Figma so a work request that references a Figma file or node is enriched with a
            compact design summary (frames, text, tokens) that the implementer matches against. The
            connector is read-only: it never writes to Figma. To give agents live, on-demand design
            access during a run, add the Figma Dev Mode endpoint as an{' '}
            <Link className="text-ember-400 hover:underline" href="/studio/mcp">
              MCP connection
            </Link>{' '}
            instead.
          </>
        }
        eyebrow="Figma"
        footer={
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-xs text-paper-500">
                Calls the Figma API with the token on screen, or the saved one if you have not typed
                a new token, to verify connectivity and access.
              </p>
              <Button
                disabled={testing || !(enabled ?? data?.enabled)}
                onClick={handleTest}
                type="button"
                variant="secondary"
              >
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            </div>
            <TestResultAlert result={testResult} />
          </>
        }
        status={
          data?.enabled ? (
            <ConfigStatusBadge state={fieldState(data.apiToken, sources.apiToken)} />
          ) : (
            <Badge dot tone="muted" variant="outline">
              Off
            </Badge>
          )
        }
        title="Figma design source"
      >
        <FieldGrid>
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
          <ConfigField
            current={data?.maxNodes ?? undefined}
            hint="Caps how many design nodes are summarized per request, which bounds context size and cost."
            id="figma-max-nodes"
            label="Max nodes"
          >
            <Input
              compact
              id="figma-max-nodes"
              inputMode="numeric"
              onChange={(e) => setMaxNodes(e.target.value)}
              placeholder="12"
              value={maxNodes}
            />
          </ConfigField>
          <div className="sm:col-span-2">
            <SecretInput
              clear={{ field: 'apiToken', integration: 'figma' }}
              current={data?.apiToken ?? null}
              id="figma-api-token"
              label="API token"
              onChange={setApiToken}
              placeholder="Figma personal access token (figd_…)"
              source={sources.apiToken}
              value={apiToken}
            />
          </div>
        </FieldGrid>
      </IntegrationCard>

      <IntegrationFormFooter
        dirtyCount={dirtyCount}
        error={error}
        isPending={update.isPending}
        saved={saved}
      />
    </form>
  );
}
