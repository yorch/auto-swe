import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';

/**
 * Every automation kind in one list. It used to sit in the Admin area, whose layout admitted every
 * role; the gateway still decides, per repository and team, what a caller may see and change.
 */
export default function AutomationsLayout({ children }: { children: ReactNode }) {
  return <RoleLayout allowed={['ENGINEER', 'LEAD', 'ADMIN']}>{children}</RoleLayout>;
}
