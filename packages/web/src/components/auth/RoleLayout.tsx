import type { Role } from '@auto-swe/shared';
import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';
import { requireRole } from '@/lib/auth.server';

interface RoleLayoutProps {
  allowed: Role[];
  children: ReactNode;
}

export async function RoleLayout({ allowed, children }: RoleLayoutProps) {
  const access = await requireRole(allowed);
  if (access.status === 'unavailable') {
    // The gateway could not confirm who the caller is. Say so rather than
    // redirecting as if they lacked the role — a reload usually fixes it.
    return (
      <Alert className="mt-4">
        Could not verify your access to this page. {access.detail} Reload to try again.
      </Alert>
    );
  }
  return <>{children}</>;
}
