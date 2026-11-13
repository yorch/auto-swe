import type { ReactNode } from 'react';
import { RoleLayout } from '@/components/auth/RoleLayout';
import { KnowledgeLayout } from '@/components/layout/KnowledgeLayout';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RoleLayout allowed={['ENGINEER']}>
      <KnowledgeLayout>{children}</KnowledgeLayout>
    </RoleLayout>
  );
}
