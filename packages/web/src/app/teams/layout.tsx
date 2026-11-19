import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

/**
 * The Teams directory and, below it, every team space. The directory used to sit in the Admin area,
 * whose layout admitted every role. A team space resolves its own slug against the caller's
 * memberships in its own layout, so this only requires a signed-in user.
 */
export default function TeamsLayout({ children }: { children: ReactNode }) {
  return <AccessLayout access="any">{children}</AccessLayout>;
}
