'use client';

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '@/lib/config';

/** A linked sign-in account, as the auth service lists it. */
export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  createdAt?: string;
}

/** Which sign-in providers this deployment is set up for (public endpoint). */
export interface ProviderFlags {
  github: boolean;
  google: boolean;
  magicLink: boolean;
  okta: boolean;
}

/** The sign-in providers the backend is configured for. */
export function useAuthProviders() {
  return useQuery({
    queryFn: async (): Promise<ProviderFlags> => {
      const res = await fetch(`${API_BASE}/api/v1/auth/providers`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as ProviderFlags;
    },
    queryKey: ['auth-providers'],
  });
}

/**
 * The accounts the signed-in user has linked. A user who signed in without a session cookie
 * (a legacy password-only account) is refused the list; that reads as "none linked", not as a
 * failure to load.
 */
export function useLinkedAccounts() {
  return useQuery({
    queryFn: async (): Promise<LinkedAccount[]> => {
      const res = await fetch(`${API_BASE}/api/auth/list-accounts`, { credentials: 'include' });
      if ([401, 403, 404].includes(res.status)) {
        return [];
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body: unknown = await res.json();
      return Array.isArray(body) ? (body as LinkedAccount[]) : [];
    },
    queryKey: ['linked-accounts'],
  });
}
