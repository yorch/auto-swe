import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

export default function Layout({ children }: { children: ReactNode }) {
  // LEADs reach this page too: the settings API authorises per setting (a LEAD
  // with a config grant can edit the keys granted to them) and the sidebar
  // offers the entry to LEADs, so an ADMIN-only layout would bounce them.
  return <RoleLayout allowed={['LEAD', 'ADMIN']}>{children}</RoleLayout>;
}
