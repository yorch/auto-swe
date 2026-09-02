import type { ReactNode } from 'react';
import { requireRole } from '@/lib/auth.server';

export default async function GovernLayout({ children }: { children: ReactNode }) {
  await requireRole(['ENGINEER', 'LEAD', 'ADMIN']);
  return <>{children}</>;
}
