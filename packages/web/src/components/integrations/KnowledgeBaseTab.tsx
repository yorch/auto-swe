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
  const { data: resp, error: loadError, isError, isLoading } = useKnowledgeBaseConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateKnowledgeBaseConfig();

  const [provider, setProvider] = useState<'' | 'disabled' | KnowledgeBaseProvider>('');
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState('');
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState<boolean | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [spacesRaw, setSpacesRaw] = useState('');
  const [maxPages, setMaxPages] = useState('');
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
    if (baseUrl) {
      body.baseUrl = baseUrl;
    }
    if (allowPrivateNetwork !== undefined) {
      body.allowPrivateNetwork = allowPrivateNetwork;
    }
    if (email) {
      body.email = email;
    }
    if (apiToken) {
      body.apiToken = apiToken;
    }
    if (spacesRaw) {
      body.spaces = spacesRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (maxPages) {
      const parsed = Number.parseInt(maxPages, 10);
      if (!Number.isNaN(parsed)) {
        body.maxPages = parsed;
      }
    }

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
              compact
              id="kb-provider"
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || v === 'disabled' || v === 'confluence' || v === 'notion') {
                  setProvider(v);
                }
              }}
              value={provider}
            >
              <option value="">(keep current)</option>
              <option value="disabled">Disabled</option>
              <option value="confluence">Confluence</option>
              <option value="notion">Notion</option>
            </Select>
          </ConfigField>
          <ConfigField
            current={data?.enabled === undefined ? undefined : data.enabled ? 'yes' : 'no'}
            id="kb-enabled"
            label="Enabled"
            source={sources.enabled}
          >
            <Select
              compact
              id="kb-enabled"
              onChange={(e) => {
                const v = e.target.value;
                setEnabled(v === '' ? undefined : v === 'true');
              }}
              value={enabled === undefined ? '' : String(enabled)}
            >
              <option value="">(keep current)</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
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
                Bypasses the SSRF guard that otherwise rejects internal/<code>.local</code>
                /private-IP base URLs. Only enable this for a trusted self-hosted instance you
                control — it reopens the server to requests against your internal network for this
                connector.
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
