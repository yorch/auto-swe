import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';
import { requireAccess } from '@/lib/auth.server';
import type { Access } from '@/lib/capabilities';

interface AccessLayoutProps {
  access: Access;
  children: ReactNode;
}

/**
 * A server-side gate for a route's pages: `access` is a platform administrator, a capability held
 * anywhere, or `'any'` for a page the API narrows itself.
 */
export async function AccessLayout({ access, children }: AccessLayoutProps) {
  const result = await requireAccess(access);
  if (result.status === 'unavailable') {
    // The gateway could not confirm who the caller is. Say so rather than
    // redirecting as if they lacked the access — a reload usually fixes it.
    return (
      <Alert className="mt-4">
        Could not verify your access to this page. {result.detail} Reload to try again.
      </Alert>
    );
  }
  return <>{children}</>;
}
