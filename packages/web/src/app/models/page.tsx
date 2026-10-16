'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { ConfigAuditLogTab } from '@/components/audit/ConfigAuditLogTab';
import { CatalogTab } from '@/components/modelConfig/CatalogTab';
import { CredentialsTab } from '@/components/modelConfig/CredentialsTab';
import { EmbeddingsTab } from '@/components/modelConfig/EmbeddingsTab';
import { MidRunWarning } from '@/components/modelConfig/MidRunWarning';
import { SetupBanner } from '@/components/setup/SetupReadiness';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { HELP_LINKS } from '@/lib/helpLinks';

type Tab = 'credentials' | 'catalog' | 'embeddings' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'credentials', label: 'Credentials' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'audit', label: 'Audit log' },
];

function isTab(value: string | null): value is Tab {
  return TABS.some((t) => t.id === value);
}

export default function StudioModelConfigPage() {
  // useSearchParams() needs a Suspense boundary above it for the page to stay
  // statically prerenderable.
  return (
    <Suspense fallback={null}>
      <StudioModelConfigPageInner />
    </Suspense>
  );
}

function StudioModelConfigPageInner() {
  // The active tab lives in `?tab=` so a tab can be linked to (the setup checklist does).
  const { params, update } = useUrlFilters();
  const requested = params.get('tab');
  const active: Tab = isTab(requested) ? requested : 'credentials';

  return (
    <div className="space-y-6">
      <PageHeader
        help={
          <>
            <p>
              <strong className="text-paper-100">Start here:</strong> add a provider credential
              first. Without one, no agent can call a model, and the worker will not start until the
              required credentials exist, so no run can begin.
            </p>
            <p>
              Each agent's model, prompt, skills, and tools are set in the{' '}
              <Link className="text-paper-100 underline decoration-paper-600 underline-offset-2 hover:decoration-current" href="/agents">
                Agent library
              </Link>
              .
            </p>
          </>
        }
        learnMore={{ ...HELP_LINKS.modelConfiguration, label: 'About model configuration' }}
        subtitle="Encrypted provider credentials, the embedding model, and the audit trail."
        title="Model configuration"
      />
      <SetupBanner here={`/models?tab=${active}`} items={['credentials', 'embeddings']} />
      <MidRunWarning />
      <TabBar
        active={active}
        idPrefix="models"
        onChange={(tab) => update({ tab: tab === 'credentials' ? null : tab })}
        tabs={TABS}
      />
      <div {...tabPanelProps('models', active)}>
        {active === 'credentials' && <CredentialsTab />}
        {active === 'catalog' && <CatalogTab />}
        {active === 'embeddings' && <EmbeddingsTab />}
        {active === 'audit' && <ConfigAuditLogTab initialGroup="models" />}
      </div>
    </div>
  );
}
