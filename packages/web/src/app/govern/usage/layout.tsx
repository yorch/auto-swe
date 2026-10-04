import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';
import { requireUsageScope } from '@/lib/auth.server';

export default async function Layout({ children }: { children: ReactNode }) {
  // Gated on holding a usage scope, not on the platform role: a team LEAD or
  // ORG_ADMIN by membership may have a lower one. The gateway enforces which
  // scopes each may read.
  const access = await requireUsageScope();
  if (access.status === 'unavailable') {
    return (
      <Alert className="mt-4">
        Could not verify your access to this page. {access.detail} Reload to try again.
      </Alert>
    );
  }
  return <>{children}</>;
}
