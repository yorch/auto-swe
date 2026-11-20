'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { DirectoryPage, JoinRequestRow } from '@/lib/joinRequests';
import type { TeamRoleValue } from '@/lib/roleLabels';
import { PERMISSIONS_KEY } from './useEffectivePermissions';

/** Query keys for the directory and the three request lists, so a write names what it staled. */
export const JOIN_REQUEST_KEYS = {
  directory: ['team-directory'] as const,
  mine: ['my-join-requests'] as const,
  org: (orgId: string) => ['org-join-requests', orgId] as const,
  team: (teamId: string) => ['team-join-requests', teamId] as const,
};

/** The gateway wraps most payloads in `{ data }`; the directory is read either way. */
function unwrap<T>(body: T | { data: T }): T {
  return typeof body === 'object' && body !== null && 'data' in body
    ? (body as { data: T }).data
    : (body as T);
}

const DIRECTORY_PAGE_SIZE = 24;

/** The teams every signed-in user may see, a page at a time (`q` and `orgId` narrow it). */
export function useTeamDirectory(filters: { q: string; orgId: string }) {
  return useInfiniteQuery({
    getNextPageParam: (last: DirectoryPage) => last.nextCursor ?? undefined,
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(DIRECTORY_PAGE_SIZE) });
      if (filters.q) {
        params.set('q', filters.q);
      }
      if (filters.orgId) {
        params.set('orgId', filters.orgId);
      }
      if (pageParam) {
        params.set('cursor', pageParam);
      }
      return api
        .get<DirectoryPage | { data: DirectoryPage }>(`/api/v1/teams/directory?${params}`)
        .then(unwrap);
    },
    queryKey: [...JOIN_REQUEST_KEYS.directory, filters.q, filters.orgId],
  });
}

/** The caller's own requests, newest first. */
export function useMyJoinRequests(options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: () =>
      api.get<{ data: JoinRequestRow[] }>('/api/v1/me/join-requests').then((r) => r.data),
    queryKey: JOIN_REQUEST_KEYS.mine,
  });
}

export function useCreateJoinRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { message: string }) =>
      api.post<{ data: JoinRequestRow }>(`/api/v1/teams/${teamId}/join-requests`, body),
    // A refusal such as ALREADY_MEMBER means the row on screen is stale, so refetch either way.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: JOIN_REQUEST_KEYS.directory });
      void qc.invalidateQueries({ queryKey: JOIN_REQUEST_KEYS.mine });
    },
  });
}

export function useWithdrawJoinRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      api.post<{ data: JoinRequestRow }>(`/api/v1/me/join-requests/${requestId}/withdraw`, {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: JOIN_REQUEST_KEYS.directory });
      void qc.invalidateQueries({ queryKey: JOIN_REQUEST_KEYS.mine });
    },
  });
}

/** A team's open requests for those who manage its members. */
export function useTeamJoinRequests(teamId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: !!teamId && (options.enabled ?? true),
    queryFn: () =>
      api
        .get<{ data: JoinRequestRow[] }>(
          `/api/v1/teams/${teamId}/join-requests?status=PENDING_TEAM`
        )
        .then((r) => r.data),
    queryKey: JOIN_REQUEST_KEYS.team(teamId),
  });
}

/**
 * A team's requests that wait on the organization's decision; the team step is over, so the
 * team's reviewers read them and cannot act.
 */
export function useTeamJoinRequestsAwaitingOrg(
  teamId: string,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    enabled: !!teamId && (options.enabled ?? true),
    queryFn: () =>
      api
        .get<{ data: JoinRequestRow[] }>(`/api/v1/teams/${teamId}/join-requests?status=PENDING_ORG`)
        .then((r) => r.data),
    queryKey: [...JOIN_REQUEST_KEYS.team(teamId), 'awaiting-org'],
  });
}

/** A decision changes who is in the team, so everything that shows membership is refetched. */
function invalidateAfterTeamDecision(qc: ReturnType<typeof useQueryClient>, teamId: string): void {
  for (const queryKey of [
    JOIN_REQUEST_KEYS.team(teamId),
    JOIN_REQUEST_KEYS.directory,
    JOIN_REQUEST_KEYS.mine,
    ['team', teamId],
    ['team-overview', teamId],
    ['teams'],
    PERMISSIONS_KEY,
  ]) {
    void qc.invalidateQueries({ queryKey });
  }
}

export function useApproveTeamJoinRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      requestId,
      ...body
    }: {
      requestId: string;
      role?: TeamRoleValue;
      note?: string;
    }) => api.post(`/api/v1/teams/${teamId}/join-requests/${requestId}/approve`, body),
    onSettled: () => invalidateAfterTeamDecision(qc, teamId),
  });
}

export function useRejectTeamJoinRequest(teamId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, ...body }: { requestId: string; note?: string }) =>
      api.post(`/api/v1/teams/${teamId}/join-requests/${requestId}/reject`, body),
    onSettled: () => invalidateAfterTeamDecision(qc, teamId),
  });
}

/** Requests that crossed organizations and wait for this organization's admins. */
export function useOrgJoinRequests(orgId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: !!orgId && (options.enabled ?? true),
    queryFn: () =>
      api
        .get<{ data: JoinRequestRow[] }>(
          `/api/v1/platform/organizations/${orgId}/join-requests?status=PENDING_ORG`
        )
        .then((r) => r.data),
    queryKey: JOIN_REQUEST_KEYS.org(orgId),
  });
}

function invalidateAfterOrgDecision(qc: ReturnType<typeof useQueryClient>, orgId: string): void {
  for (const queryKey of [
    JOIN_REQUEST_KEYS.org(orgId),
    // The approval makes the requester an organization member and a team member.
    ['org-members', orgId],
    ['teams'],
    ['team-overview'],
    ['team-join-requests'],
    JOIN_REQUEST_KEYS.directory,
    JOIN_REQUEST_KEYS.mine,
    PERMISSIONS_KEY,
  ]) {
    void qc.invalidateQueries({ queryKey });
  }
}

export function useDecideOrgJoinRequest(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      decision,
      note,
      requestId,
    }: {
      requestId: string;
      decision: 'approve' | 'reject';
      note?: string;
    }) =>
      api.post(
        `/api/v1/platform/organizations/${orgId}/join-requests/${requestId}/${decision}`,
        note ? { note } : {}
      ),
    onSettled: () => invalidateAfterOrgDecision(qc, orgId),
  });
}
