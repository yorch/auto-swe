'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { TabBar } from '@/components/ui/TabBar';
import { activeNavHref, KNOWLEDGE_PAGES } from '@/lib/navigation';
import { hasRole } from '@/lib/roles';
import { useAuthStore } from '@/stores/authStore';

export function KnowledgeLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);
  const tabs = KNOWLEDGE_PAGES.filter((item) => hasRole(role, item.minRole)).map((item) => ({
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
