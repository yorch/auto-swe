import type { ReactNode } from 'react';
import { AccessLayout } from '@/components/auth/AccessLayout';
import { KnowledgeLayout } from '@/components/layout/KnowledgeLayout';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <AccessLayout access="any">
      <KnowledgeLayout>{children}</KnowledgeLayout>
    </AccessLayout>
  );
}
