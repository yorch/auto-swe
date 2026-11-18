import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

/**
 * The Teams directory and, below it, every team space. The directory used to sit in the Admin area,
 * whose layout admitted every role. A team space resolves its own slug against the caller's
 * memberships in its own layout, so this only requires a signed-in user.
 */
export default function TeamsLayout({ children }: { children: ReactNode }) {
  return <RoleLayout allowed={['ENGINEER', 'LEAD', 'ADMIN']}>{children}</RoleLayout>;
}
