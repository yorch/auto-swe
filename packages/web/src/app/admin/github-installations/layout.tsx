import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

export default function Layout({ children }: { children: ReactNode }) {
  return <RoleLayout allowed={['ADMIN']}>{children}</RoleLayout>;
}
