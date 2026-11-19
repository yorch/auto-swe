import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

/**
 * Every automation kind in one list. It used to sit in the Admin area, whose layout admitted every
 * role; the gateway still decides, per repository and team, what a caller may see and change.
 */
export default function AutomationsLayout({ children }: { children: ReactNode }) {
  return <AccessLayout access="any">{children}</AccessLayout>;
}
