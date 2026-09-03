import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

export default function GovernLayout({ children }: { children: ReactNode }) {
  return <RoleLayout allowed={['ENGINEER', 'LEAD', 'ADMIN']}>{children}</RoleLayout>;
}
