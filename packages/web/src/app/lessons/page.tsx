'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
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
    <EmptyState
      action={<ButtonLink href="/">Back to home</ButtonLink>}
      hint="Lessons the agents have learned are reviewed and consolidated by administrators. Ask one to change or remove a lesson."
      title="Lessons are managed by administrators"
    />
  );
}
