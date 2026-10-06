'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useHasRole } from '@/hooks/useHasRole';
import { useAuthStore } from '@/stores/authStore';

/** The old lessons URL: administrators go to the Lessons page, everyone else is told why not. */
export default function LessonsRedirect() {
  const router = useRouter();
  const loaded = useAuthStore((s) => s.user !== null);
  const isAdmin = useHasRole('ADMIN');

  useEffect(() => {
    if (isAdmin) {
      router.replace('/govern/lessons');
    }
  }, [isAdmin, router]);

  if (!loaded || isAdmin) {
    return null;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Lessons" />
      <EmptyState
        action={<ButtonLink href="/">Back to home</ButtonLink>}
        bordered
        hint="Lessons the agents have learned are reviewed and consolidated by administrators. Ask one to change or remove a lesson."
        icon="lock"
        title="Lessons are managed by administrators"
      />
    </div>
  );
}
