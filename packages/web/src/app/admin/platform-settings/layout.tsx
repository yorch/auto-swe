import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';

export default function Layout({ children }: { children: ReactNode }) {
  // Open to every signed-in person: the settings API authorises per setting (a team lead with a
  // grant can edit the keys granted to them), and the sidebar offers the entry to those who hold
  // `team.settings.manage` on some team, so a platform-admin-only layout would bounce them.
  return <AccessLayout access="any">{children}</AccessLayout>;
}
