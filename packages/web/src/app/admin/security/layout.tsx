import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

export default function Layout({ children }: { children: ReactNode }) {
  return <AccessLayout access="platform-admin">{children}</AccessLayout>;
}
