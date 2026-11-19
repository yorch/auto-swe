'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';
import { useEffectivePermissions } from '@/hooks/useEffectivePermissions';
import { holdsAccess } from '@/lib/capabilities';
import { activeNavHref, KNOWLEDGE_PAGES } from '@/lib/navigation';

export function KnowledgeLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: perms } = useEffectivePermissions();
  const tabs = KNOWLEDGE_PAGES.filter((item) => holdsAccess(perms, item.access)).map((item) => ({
    href: item.href,
    id: item.href,
    label: item.label,
  }));
  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        subtitle="Curated knowledge, repository-backed reference material and lessons captured from runs."
        title="Knowledge"
      />
      {tabs.length > 0 && (
        <TabBar
          active={activeNavHref(pathname, KNOWLEDGE_PAGES)}
          ariaLabel="Knowledge sections"
          tabs={tabs}
        />
      )}
      {children}
    </div>
  );
}
