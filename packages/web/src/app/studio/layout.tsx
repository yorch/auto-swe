import type { ReactNode } from 'react';
import { requireRole } from '@/lib/auth.server';

export default async function StudioLayout({ children }: { children: ReactNode }) {
  await requireRole(['LEAD', 'ADMIN']);
  return <>{children}</>;
}
