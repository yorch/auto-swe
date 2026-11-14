'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api } from '@/lib/api';
import { randomId } from '@/lib/randomId';

/** The body of POST /api/v1/prd-runs; mirrors `CreatePrdRunSchema` in the gateway. */
export interface CreatePrdRunBody {
  /** The full text of the PRD. */
  prdContent: string;
  prdTitle: string;
  /** Jira project key, Linear team id or GitHub "owner/repo" for the tracker items; omitted when blank. */
  projectKey?: string;
  repoIds: string[];
}

export interface CreatePrdRunResponse {
  prdWorkflowId: string;
  workRequestId: string;
}

/**
 * Starts a PRD run. One Idempotency-Key is kept for as long as the request is the same, so a
 * retry after a lost response reaches the run the first call started (the gateway answers 409
 * `PRD_RUN_ALREADY_EXISTS` for it) instead of starting a second decomposition; a changed request
 * gets a new key.
 */
export function useCreatePrdRun() {
  const qc = useQueryClient();
  const submission = useRef<{ body: string; key: string } | null>(null);
  return useMutation({
    mutationFn: (body: CreatePrdRunBody) => {
      const serialised = JSON.stringify(body);
      if (submission.current?.body !== serialised) {
        submission.current = { body: serialised, key: randomId() };
      }
      return api
        .fetch<{ data: CreatePrdRunResponse }>('/api/v1/prd-runs', {
          body: serialised,
          headers: { 'Idempotency-Key': submission.current.key },
          method: 'POST',
        })
        .then((r) => r.data);
    },
    onSuccess: () => {
      submission.current = null;
      qc.invalidateQueries({ queryKey: ['workflow-runs'] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}
