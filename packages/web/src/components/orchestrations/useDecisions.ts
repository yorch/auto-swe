'use client';

import type { OrchestrationDetailDto } from '@auto-swe/shared/lib/orchestrationApi';
import { useRef, useState } from 'react';
import { useAttachRepo, useDecideApproval, useDeclineAttach } from '@/hooks/useOrchestrations';
import { describeOrchestrationError, isAlreadyDecided } from '@/lib/orchestration';

export const attachKey = (messageId: string) => `attach:${messageId}`;
export const approvalKey = (approvalId: string) => `approval:${approvalId}`;

const ALREADY_DECIDED = 'Already decided. Showing the latest state.';

/**
 * The launcher's answers to the attach request and the MCP approvals. Each item stays locked
 * from the click until a refetch of the detail no longer lists it, so a second click cannot
 * send a second answer. A refusal that says the item was already decided is the outcome the
 * launcher wanted (or a race with another tab), so it reads as a note, not an error.
 */
export function useDecisions(detail: OrchestrationDetailDto) {
  const attach = useAttachRepo(detail.id);
  const decline = useDeclineAttach(detail.id);
  const decide = useDecideApproval(detail.id);
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Synchronous twin of `decided`: two clicks in one tick both see the same rendered state.
  const sent = useRef<Set<string>>(new Set());

  const run = (key: string, start: (cb: { onError: (err: unknown) => void }) => void) => {
    if (sent.current.has(key)) {
      return;
    }
    sent.current.add(key);
    setDecided((d) => new Set(d).add(key));
    setErrors(({ [key]: _gone, ...rest }) => rest);
    setNotes(({ [key]: _gone, ...rest }) => rest);
    start({
      onError: (err) => {
        if (isAlreadyDecided(err)) {
          setNotes((n) => ({ ...n, [key]: ALREADY_DECIDED }));
          return;
        }
        sent.current.delete(key);
        setDecided((d) => {
          const next = new Set(d);
          next.delete(key);
          return next;
        });
        setErrors((e) => ({ ...e, [key]: describeOrchestrationError(err) }));
      },
    });
  };

  return {
    attach: (messageId: string, repoId: string) =>
      run(attachKey(messageId), (cb) => attach.mutate(repoId, cb)),
    decide: (approvalId: string, decision: 'APPROVE' | 'DENY') =>
      run(approvalKey(approvalId), (cb) => decide.mutate({ approvalId, decision }, cb)),
    decline: (messageId: string) =>
      run(attachKey(messageId), (cb) => decline.mutate(undefined, cb)),
    errorFor: (key: string) => errors[key] ?? null,
    isDecided: (key: string) => decided.has(key),
    noteFor: (key: string) => notes[key] ?? null,
  };
}
