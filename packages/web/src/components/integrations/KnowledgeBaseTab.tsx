'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type KnowledgeBaseConfigInput,
  type KnowledgeBaseProvider,
  type KnowledgeBaseTestDraft,
  testKnowledgeBaseConnection,
  useKnowledgeBaseConfig,
  useUpdateKnowledgeBaseConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { clearableField, clearableIntField, countChanges } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { ConfigStatusBadge, fieldState, groupState } from './ConfigStatusBadge';
import { FieldGrid, IntegrationCard } from './IntegrationCard';
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

/**
 * What a Spaces edit sends, or undefined when it changes nothing. Retyping the stored list is not
 * a change, and a field holding only separators ("," or ", ,") is stray input rather than a
 * request to clear — only a field the person emptied outright clears the stored list.
 */
function spacesEdit(
  raw: string,
  touched: boolean,
  stored: string[] | null | undefined
): string[] | undefined {
  if (!touched) {
    return undefined;
  }
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 && raw.trim() !== '') {
    return undefined;
  }
  const current = stored ?? [];
  const same = list.length === current.length && list.every((v, n) => v === current[n]);
  return same ? undefined : list;
}

export function KnowledgeBaseTab() {
  const {
    data: resp,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useKnowledgeBaseConfig();
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
  // The field starts blank (the stored list shows beside it), so blank alone cannot mean "clear".
  const [spacesTouched, setSpacesTouched] = useState(false);
  const [maxPages, setMaxPages] = usePrefilledField(data?.maxPages);

  // What Save would send: omitted keys are unchanged, so their count is the unsaved edits.
  // Non-secret fields are prefilled: omit when unchanged, send null when cleared.
  const spacesChange = spacesEdit(spacesRaw, spacesTouched, data?.spaces);
  // Notion's API address is fixed, so it has no base URL and no private-network switch.
  const isNotion = (provider === '' ? data?.provider : provider) === 'notion';
  const body: KnowledgeBaseConfigInput = {
    allowPrivateNetwork:
      isNotion || allowPrivateNetwork === data?.allowPrivateNetwork
        ? undefined
        : allowPrivateNetwork,
    apiToken: apiToken || undefined,
    baseUrl: isNotion ? undefined : clearableField(baseUrl, data?.baseUrl),
    email: clearableField(email, data?.email),
    enabled: enabled === data?.enabled ? undefined : enabled,
    maxPages: clearableIntField(maxPages, data?.maxPages),
    spaces: spacesChange,
  };
  if (provider && provider !== (data?.provider ?? 'disabled')) {
    body.provider = provider === 'disabled' ? null : provider;
  }
  const dirtyCount = countChanges(body);

  const { saved, error, testing, testResult, submit, runTest } =
    useIntegrationConfigForm(dirtyCount);

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

    submit(
      () => update.mutateAsync(body),
      () => {
        setApiToken('');
        setSpacesRaw('');
        setSpacesTouched(false);
        setProvider('');
        setEnabled(undefined);
        setAllowPrivateNetwork(undefined);
      }
    );
  };

  const handleTest = () => {
    // Send what is on screen so the result describes what Save would store. A blank token means
    // the stored one; unchanged fields are left out.
    const draft: KnowledgeBaseTestDraft = {};
    if (provider) {
      draft.provider = provider === 'disabled' ? null : provider;
    }
    if (enabled !== undefined) {
      draft.enabled = enabled;
    }
    const baseUrlDraft = isNotion ? undefined : clearableField(baseUrl, data?.baseUrl);
    if (baseUrlDraft !== undefined) {
      draft.baseUrl = baseUrlDraft;
    }
    const emailDraft = clearableField(email, data?.email);
    if (emailDraft !== undefined) {
      draft.email = emailDraft;
    }
    if (apiToken) {
      draft.apiToken = apiToken;
    }
    if (spacesChange) {
      draft.spaces = spacesChange;
    }
    if (allowPrivateNetwork !== undefined) {
      draft.allowPrivateNetwork = allowPrivateNetwork;
    }
    const unsaved = Object.keys(draft).length > 0;
    runTest(async () => ({ ...(await testKnowledgeBaseConnection(draft)), unsaved }));
  };

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="knowledge base config"
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <IntegrationCard
        description="Connect a knowledge base so agents can search internal documentation at run time. Confluence and Notion are supported. The connector is read-only: it never writes to your knowledge base."
        eyebrow="Knowledge base"
        footer={
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-xs text-paper-500">
                Runs a search through the configuration on screen, including values you have not
                saved yet, to verify connectivity and access.
              </p>
              <Button
                disabled={testing || !effectiveProvider || effectiveProvider === 'disabled'}
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
          data?.provider && data.enabled !== false ? (
            <ConfigStatusBadge
              state={groupState([
                fieldState(data.provider, sources.provider),
                fieldState(data.apiToken, sources.apiToken),
              ])}
            />
          ) : (
            <Badge dot tone="muted" variant="outline">
              Off
            </Badge>
          )
        }
        title="Documentation search"
      >
        <FieldGrid>
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
          {!isNotion && (
            <>
              <div className="sm:col-span-2">
                <ConfigField
                  current={data?.baseUrl || undefined}
                  id="kb-base-url"
                  label="Base URL"
                  source={sources.baseUrl}
                >
                  <Input
                    className="font-mono"
                    compact
                    id="kb-base-url"
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
                    value={baseUrl}
                  />
                </ConfigField>
              </div>
              <Checkbox
                checked={allowPrivateNetwork ?? data?.allowPrivateNetwork ?? false}
                className="sm:col-span-2"
                hint={
                  <>
                    Allows a base URL on a private-network address (internal, <code>.local</code>,
                    private IP). Loopback, link-local and cloud-metadata addresses are always
                    refused; use the host's LAN address or <code>host.docker.internal</code>{' '}
                    instead. Only enable this for a trusted self-hosted instance you control.
                  </>
                }
                id="kb-allow-private-network"
                label="Allow private/internal network base URL"
                onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
              />
            </>
          )}
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
            clear={{ field: 'apiToken', integration: 'knowledge-base' }}
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
              onChange={(e) => {
                setSpacesRaw(e.target.value);
                setSpacesTouched(true);
              }}
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
