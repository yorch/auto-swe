'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type KnowledgeBaseConfigInput,
  type KnowledgeBaseProvider,
  testKnowledgeBaseConnection,
  useKnowledgeBaseConfig,
  useUpdateKnowledgeBaseConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { clearableField, clearableIntField } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput } from './SecretInput';

const PROVIDER_HINTS: Record<
  KnowledgeBaseProvider,
  { baseUrl: string; token: string; spaces: string }
> = {
  confluence: {
    baseUrl: 'Atlassian site URL, e.g. https://acme.atlassian.net',
    spaces: 'Space keys, e.g. ENG, ARCH, RUNBOOKS',
    token: 'Atlassian API token (same as Issue Tracker if Jira is configured)',
  },
  notion: {
    baseUrl: 'Leave empty — Notion API is fixed (api.notion.com)',
    spaces: 'Database IDs to search (comma-separated)',
    token: 'Notion integration token',
  },
};

export function KnowledgeBaseTab() {
  const { data: resp, error: loadError, isError, refetch, isLoading } = useKnowledgeBaseConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateKnowledgeBaseConfig();

  const [provider, setProvider] = useState<'' | 'disabled' | KnowledgeBaseProvider>('');
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [baseUrl, setBaseUrl] = usePrefilledField(data?.baseUrl);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState<boolean | undefined>(undefined);
  const [email, setEmail] = usePrefilledField(data?.email);
  const [apiToken, setApiToken] = useState('');
  const [spacesRaw, setSpacesRaw] = useState('');
  const [maxPages, setMaxPages] = usePrefilledField(data?.maxPages);
  const [testQuery, setTestQuery] = useState('');

  const { saved, error, testing, testResult, submit, runTest } = useIntegrationConfigForm();

  const effectiveProvider = (provider === '' ? data?.provider : provider) as
    | KnowledgeBaseProvider
    | 'disabled'
    | null
    | undefined;
  const hints =
    effectiveProvider && effectiveProvider !== 'disabled'
      ? PROVIDER_HINTS[effectiveProvider]
      : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const body: KnowledgeBaseConfigInput = {};
    if (provider) {
      body.provider = provider === 'disabled' ? null : provider;
    }
    if (enabled !== undefined) {
      body.enabled = enabled;
    }
    // Non-secret fields are prefilled: omit when unchanged, send null when cleared.
    body.baseUrl = clearableField(baseUrl, data?.baseUrl);
    if (allowPrivateNetwork !== undefined) {
      body.allowPrivateNetwork = allowPrivateNetwork;
    }
    body.email = clearableField(email, data?.email);
    if (apiToken) {
      body.apiToken = apiToken;
    }
    if (spacesRaw) {
      body.spaces = spacesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    body.maxPages = clearableIntField(maxPages, data?.maxPages);

    submit(
      () => update.mutateAsync(body),
      () => setApiToken('')
    );
  };

  const handleTest = () => {
    runTest(() => testKnowledgeBaseConnection(testQuery.trim()));
  };

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="knowledge base config"
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Knowledge base">Knowledge base</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Connect a knowledge base so agents can search internal documentation at run time.
          Confluence and Notion are supported. The connector is read-only — it never writes to your
          knowledge base.
        </p>
        <div className="space-y-4">
          <ConfigField
            current={data?.provider || undefined}
            id="kb-provider"
            label="Provider"
            source={sources.provider}
          >
            <Select
              aria-label="Provider"
              compact
              id="kb-provider"
              onChange={(v) => {
                if (v === '' || v === 'disabled' || v === 'confluence' || v === 'notion') {
                  setProvider(v);
                }
              }}
              options={[
                { label: '(keep current)', value: '' },
                { label: 'Disabled', value: 'disabled' },
                { label: 'Confluence', value: 'confluence' },
                { label: 'Notion', value: 'notion' },
              ]}
              value={provider}
            />
          </ConfigField>
          <ConfigField
            current={data?.enabled === undefined ? undefined : data.enabled ? 'yes' : 'no'}
            id="kb-enabled"
            label="Enabled"
            source={sources.enabled}
          >
            <Select
              aria-label="Enabled"
              compact
              id="kb-enabled"
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
            current={data?.baseUrl || undefined}
            id="kb-base-url"
            label="Base URL"
            source={sources.baseUrl}
          >
            <Input
              compact
              id="kb-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
              value={baseUrl}
            />
          </ConfigField>
          <Checkbox
            checked={allowPrivateNetwork ?? data?.allowPrivateNetwork ?? false}
            hint={
              <>
                Allows a base URL on a private-network address (internal, <code>.local</code>,
                private IP). Loopback, link-local and cloud-metadata addresses are always refused;
                use the host's LAN address or <code>host.docker.internal</code> instead. Only enable
                this for a trusted self-hosted instance you control.
              </>
            }
            id="kb-allow-private-network"
            label="Allow private/internal network base URL"
            onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
          />
          {effectiveProvider === 'confluence' && (
            <ConfigField
              current={data?.email || undefined}
              id="kb-email"
              label="Email (Confluence only)"
              source={sources.email}
            >
              <Input
                compact
                id="kb-email"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com (Confluence basic-auth user)"
                value={email}
              />
            </ConfigField>
          )}
          <SecretInput
            current={data?.apiToken ?? null}
            id="kb-api-token"
            label="API token"
            onChange={setApiToken}
            placeholder={hints?.token ?? 'API token'}
            source={sources.apiToken}
            value={apiToken}
          />
          <ConfigField
            current={data?.spaces?.length ? data.spaces.join(', ') : undefined}
            id="kb-spaces"
            label="Spaces"
            source={sources.spaces}
          >
            <Input
              compact
              id="kb-spaces"
              onChange={(e) => setSpacesRaw(e.target.value)}
              placeholder={hints?.spaces ?? 'ENG, ARCH'}
              value={spacesRaw}
            />
          </ConfigField>
          <ConfigField
            current={data?.maxPages ?? undefined}
            id="kb-max-pages"
            label="Max pages"
            source={sources.maxPages}
          >
            <Input
              compact
              id="kb-max-pages"
              inputMode="numeric"
              onChange={(e) => setMaxPages(e.target.value)}
              placeholder="50"
              value={maxPages}
            />
          </ConfigField>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Knowledge base">Test connection</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Runs a search query through the saved configuration to verify connectivity and access.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              compact
              id="kb-test-query"
              label="Search query"
              onChange={(e) => setTestQuery(e.target.value)}
              placeholder="deployment runbook"
              value={testQuery}
            />
          </div>
          <Button
            disabled={testing || !testQuery.trim() || !data?.provider}
            onClick={handleTest}
            size="sm"
            type="button"
            variant="secondary"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        <TestResultAlert result={testResult} />
      </Card>

      <IntegrationFormFooter error={error} isPending={update.isPending} saved={saved} />
    </form>
  );
}
