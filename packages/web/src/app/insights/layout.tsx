import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

/**
 * Analytics, Reports and LLM usage: pages every signed-in role may open, which used to sit in the
 * Admin area. What each one shows is narrowed by the gateway to the caller's teams and scopes; the
 * usage page raises the floor to holding a usage scope in its own layout.
 */
export default function InsightsLayout({ children }: { children: ReactNode }) {
  return <AccessLayout access="any">{children}</AccessLayout>;
}
