import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

export default function Layout({ children }: { children: ReactNode }) {
  // Every form on this page reads and writes /platform/config/*, which is for platform admins only.
  return <AccessLayout access="platform-admin">{children}</AccessLayout>;
}
