'use client';

import type {
  PullRequestCockpit,
  PullRequestCockpitDraft,
  PullRequestReviewCheckResponse,
} from '@auto-swe/shared/types/api';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { cockpitKey } from './usePullRequestCockpit';

/** A draft as the gateway answers a write: what was stored, with nothing yet said of the file. */
type StoredDraft = Omit<PullRequestCockpitDraft, 'outdated'>;

export type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type ReviewSent = {
  comments: number;
  /** The review is on the host but the drafts it sent could not be cleared; they are still here. */
  draftsKept: boolean;
  event: ReviewEvent;
  reviewId: number | null;
  /** Where the review is on the host; the gateway only ever sends an http(s) address. */
  url: string | null;
};

export type SentBack = { commentId: number | null; url: string | null };

const base = (id: string) => `/api/v1/pull-requests/${id}`;

/**
 * A cockpit read already in flight when a write settles may have been answered before the write was
 * stored, and would put the old drafts back; it is replaced by a fresh one. With none in flight the
 * cache is left alone, since a read carries every patch again for nothing the reviewer has not seen.
 */
function replaceStaleRead(qc: QueryClient, id: string): void {
  if (qc.isFetching({ queryKey: cockpitKey(id) }) > 0) {
    void qc.invalidateQueries({ queryKey: cockpitKey(id) });
  }
}

function withDrafts(
  qc: QueryClient,
  id: string,
  change: (drafts: PullRequestCockpitDraft[]) => PullRequestCockpitDraft[]
): void {
  qc.setQueryData<PullRequestCockpit>(cockpitKey(id), (current) =>
    current ? { ...current, drafts: change(current.drafts) } : current
  );
}

/** Keep a line comment until the reviewer sends a review. */
export function useCreateDraft(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      body: string;
      headSha: string;
      line: number;
      patchDigest: string;
      path: string;
      side: PullRequestCockpitDraft['side'];
      /** Omitted for a single line. */
      startLine?: number;
    }) => api.post<{ data: StoredDraft }>(`${base(id)}/drafts`, input).then((r) => r.data),
    onSettled: () => replaceStaleRead(qc, id),
    onSuccess: (draft) =>
      withDrafts(qc, id, (drafts) => [...drafts, { ...draft, outdated: false }]),
  });
}

/** Change the text of a draft. Whether it is outdated is the file's to say, not the text's. */
export function useEditDraft(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; draftId: string }) =>
      api
        .patch<{ data: StoredDraft }>(`${base(id)}/drafts/${input.draftId}`, { body: input.body })
        .then((r) => r.data),
    onSettled: () => replaceStaleRead(qc, id),
    onSuccess: (draft) =>
      withDrafts(qc, id, (drafts) =>
        drafts.map((d) => (d.id === draft.id ? { ...d, body: draft.body } : d))
      ),
  });
}

/** Discard a draft. One already gone (a 404) is as good as deleted, so it leaves the page too. */
export function useDeleteDraft(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) =>
      api
        .delete<{ data: { deleted: boolean } }>(`${base(id)}/drafts/${draftId}`)
        .then(() => draftId)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.code === 'DRAFT_NOT_FOUND') {
            return draftId;
          }
          throw err;
        }),
    onSettled: () => replaceStaleRead(qc, id),
    onSuccess: (draftId) => withDrafts(qc, id, (drafts) => drafts.filter((d) => d.id !== draftId)),
  });
}

/**
 * Send a review as the reviewer. A success is followed by a fresh read, once, because what was sent
 * is no longer a draft and the page should show what the gateway holds, including any draft it could
 * not clear. A failure changes nothing here: the drafts are still the reviewer's.
 */
export function useSubmitReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      body: string;
      draftIds: string[];
      event: ReviewEvent;
      headSha: string;
    }) => api.post<{ data: ReviewSent }>(`${base(id)}/review`, input).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: cockpitKey(id) }),
  });
}

/**
 * Ask whether a send whose outcome was unknown reached the host. `attemptedAt` is when the send was
 * attempted, and the rest is exactly what was sent. A `found` answer is a successful send (the
 * gateway has cleared the drafts), so it is followed by the same fresh read; a `not-found` answer
 * proves nothing and changes nothing.
 */
export function useCheckReview(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      attemptedAt: string;
      body: string;
      draftIds: string[];
      event: ReviewEvent;
      headSha: string;
    }) =>
      api
        .post<{ data: PullRequestReviewCheckResponse }>(`${base(id)}/review/check`, input)
        .then((r) => r.data),
    onSuccess: (result) =>
      result.status === 'found' ? qc.invalidateQueries({ queryKey: cockpitKey(id) }) : undefined,
  });
}

/** Leave `/auto-swe fix` on the pull request as the reviewer, with an optional note. */
export function useSendBack(id: string) {
  return useMutation({
    mutationFn: (input: { headSha: string; note: string }) =>
      api
        .post<{ data: SentBack }>(`${base(id)}/send-back`, {
          headSha: input.headSha,
          ...(input.note.trim() !== '' && { note: input.note }),
        })
        .then((r) => r.data),
  });
}
