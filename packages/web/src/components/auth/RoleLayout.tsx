import type { Role } from '@auto-swe/shared';
import type { ReactNode } from 'react';
import { requireRole } from '@/lib/auth.server';

interface RoleLayoutProps {
  allowed: Role[];
  children: ReactNode;
}

export async function RoleLayout({ allowed, children }: RoleLayoutProps) {
  await requireRole(allowed);
  return <>{children}</>;
}
