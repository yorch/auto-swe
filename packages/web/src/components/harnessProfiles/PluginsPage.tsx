'use client';

import { MarketplacesTab } from '@/components/marketplaces/MarketplacesTab';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { useUrlFilters } from '@/hooks/useUrlFilters';
import { HELP_LINKS } from '@/lib/helpLinks';
import { HarnessProfilesView } from './HarnessProfilesView';

type Tab = 'plugins' | 'marketplaces';

/**
 * ADMIN page for plugins: the approved plugins, and the marketplaces they are discovered in.
 * The tab lives in the URL (`?tab=marketplaces`) so it can be linked to.
 */
export function PluginsPage() {
  const { params, update } = useUrlFilters();
  const tab: Tab = params.get('tab') === 'marketplaces' ? 'marketplaces' : 'plugins';
  return (
    <>
      <PageHeader
        help="Plugins are Claude Code plugin directories a platform admin has read at an exact commit and approved. Add one from a marketplace or a folder; teams then enable it and bind it to their agents."
        learnMore={HELP_LINKS.plugins}
        subtitle="Approved Claude Code plugins and the marketplaces they come from."
        title="Plugins"
      />
      <TabBar
        active={tab}
        ariaLabel="Plugin views"
        idPrefix="plugins"
        onChange={(next) => update({ tab: next === 'plugins' ? null : next })}
        tabs={[
          { id: 'plugins', label: 'Plugins' },
          { id: 'marketplaces', label: 'Marketplaces' },
        ]}
      />
      <div className="mt-4" {...tabPanelProps('plugins', tab)}>
        {tab === 'plugins' ? <HarnessProfilesView /> : <MarketplacesTab />}
      </div>
    </>
  );
}
