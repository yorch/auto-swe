import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

export default function Layout({ children }: { children: ReactNode }) {
  // Offered to a platform administrator and to anyone a configuration grant covers for at least one
  // setting (the server's `canWriteAnySetting`); the sidebar entry uses the same rule. The settings
  // API still authorises each write per setting and scope.
  return <AccessLayout access="settings-writer">{children}</AccessLayout>;
}
