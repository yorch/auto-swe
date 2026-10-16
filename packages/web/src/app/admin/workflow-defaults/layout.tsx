import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

export default function Layout({ children }: { children: ReactNode }) {
  // Every form on this page reads and writes /platform/config/*, which is ADMIN-only.
  return <RoleLayout allowed={['ADMIN']}>{children}</RoleLayout>;
}
