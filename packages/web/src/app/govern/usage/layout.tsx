import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

export default function Layout({ children }: { children: ReactNode }) {
  // A LEAD sees the teams they lead; the gateway enforces which scopes each may read.
  return <RoleLayout allowed={['ADMIN', 'LEAD']}>{children}</RoleLayout>;
}
