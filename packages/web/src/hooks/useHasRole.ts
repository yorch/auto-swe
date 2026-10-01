import type { Role } from '@auto-swe/shared';
import { hasRole } from '@/lib/roles';
import { useAuthStore } from '@/stores/authStore';

/** Whether the signed-in user's platform role meets `required`. */
export function useHasRole(required: Role): boolean {
  return useAuthStore((s) => hasRole(s.user?.role, required));
}
