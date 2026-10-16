import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';
import { AdminNav } from '@/components/layout/AdminNav';

/**
 * The Admin area: one sidebar entry, with the area's own sub-navigation beside every page.
 * This layout admits every role that has at least one Admin page; each page's own layout
 * raises the floor where the page needs it.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RoleLayout allowed={['ENGINEER', 'LEAD', 'ADMIN']}>
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
        <AdminNav />
        <div className="min-w-0">{children}</div>
      </div>
    </RoleLayout>
  );
}
