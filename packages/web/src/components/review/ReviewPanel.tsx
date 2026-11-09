'use client';

import type { PullRequestCockpit } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Textarea } from '@/components/ui/Textarea';
import {
  type ReviewEvent,
  type ReviewSent,
  type SentBack,
  useSendBack,
  useSubmitReview,
} from '@/hooks/useReviewActions';
import { safeHttpUrl } from '@/lib/safeUrl';
import { cn, FOCUS_RING, plural } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { DraftNote, MAX_COMMENT_CHARS } from './DraftComments';

const EVENTS = [
  { description: 'Send your comments without a verdict.', label: 'Comment', value: 'COMMENT' },
  { description: 'Approve the pull request.', label: 'Approve', value: 'APPROVE' },
  {
    description: 'Say it needs changes before it can merge.',
    label: 'Request changes',
    value: 'REQUEST_CHANGES',
  },
] as const satisfies { description: string; label: string; value: ReviewEvent }[];

const SEND_LABEL: Record<ReviewEvent, string> = {
  APPROVE: 'Approve',
  COMMENT: 'Send comments',
  REQUEST_CHANGES: 'Request changes',
};

/** Why writing from here is not on, and what to do about it. */
const WHY_NOT: Record<NonNullable<PullRequestCockpit['write']['reason']>, string> = {
  disabled:
    'Sending reviews from here is off on this platform. Review on the host; your reading marks and drafts here are kept.',
  'no-token':
    'To send reviews and comments from here as yourself, save a GitHub token for this repository.',
  unreadable:
    'Your saved token for this repository can no longer be read. Save it again to send from here.',
  unusable:
    'Your saved token for this repository cannot be used now, because the repository moved or you left its team. Save it again to send from here.',
};

function HostLink({ url, children }: { url: string | null; children: string }) {
  const href = safeHttpUrl(url);
  return href ? (
    <a
      className={cn(FOCUS_RING, 'rounded-sm text-accent-400 hover:underline')}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : null;
}

/**
 * What a reviewer can do from the page besides reading: send the review they have been drafting, or
 * send the pull request back to the agent. Both are posted on the host as them, with a token they
 * saved, so each asks first and says what it will do. Without such a token the panel only says why.
 */
export function ReviewPanel({ data }: { data: PullRequestCockpit }) {
  const { drafts, files, pull, write } = data;
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<ReviewSent | null>(null);
  const [note, setNote] = useState('');
  const [confirmingBack, setConfirmingBack] = useState(false);
  const [sentBack, setSentBack] = useState<SentBack | null>(null);
  const submit = useSubmitReview(pull.id);
  const sendBack = useSendBack(pull.id);

  if (files.type !== 'ok') {
    return null;
  }
  if (!write.available) {
    return (
      <Card className="space-y-2 p-5" variant="inset">
        <h2 className="text-sm font-semibold text-paper-100">Review from here</h2>
        <p className="text-sm text-paper-400">
          {write.reason ? WHY_NOT[write.reason] : 'Writing from here is not available.'}
        </p>
        {write.reason && write.reason !== 'disabled' ? (
          <Link className="text-sm text-accent-400 hover:underline" href="/connections">
            Open Connections
          </Link>
        ) : null}
      </Card>
    );
  }
  if (files.state !== 'open') {
    return (
      <Card className="p-5" variant="inset">
        <h2 className="text-sm font-semibold text-paper-100">Review from here</h2>
        <p className="mt-1 text-sm text-paper-400">
          This pull request is {files.state} on the host, so nothing can be sent.
        </p>
      </Card>
    );
  }

  const outdated = drafts.filter((d) => d.outdated);
  const current = drafts.filter((d) => !d.outdated);
  const text = body.trim();
  const nothingToSend =
    (event === 'REQUEST_CHANGES' && text === '') ||
    (event === 'COMMENT' && text === '' && current.length === 0);
  const blocked = outdated.length > 0 || nothingToSend;
  const headSha = files.headSha;

  const reason = (() => {
    if (outdated.length > 0) {
      return 'Delete or redo the outdated draft comments first.';
    }
    if (event === 'REQUEST_CHANGES' && text === '') {
      return 'Say what needs to change.';
    }
    if (nothingToSend) {
      return 'Write a comment, or add a comment on a line.';
    }
    return null;
  })();

  return (
    <Card className="space-y-6 p-5" variant="inset">
      <section aria-labelledby="review-heading" className="space-y-3">
        <h2 className="text-sm font-semibold text-paper-100" id="review-heading">
          Your review
        </h2>
        <p className="text-xs text-paper-500">
          Sent to the host as you, with your saved token. {plural(current.length, 'draft comment')}{' '}
          will go with it.
        </p>
        {outdated.length > 0 ? (
          <div className="space-y-2">
            <Alert announce={false} title="Some drafts no longer fit the diff" variant="warning">
              {plural(outdated.length, 'draft comment')} {outdated.length === 1 ? 'is' : 'are'} on a
              file or line that has changed since you wrote {outdated.length === 1 ? 'it' : 'them'}.
              They cannot be sent as they are.
            </Alert>
            {outdated.map((draft) => (
              <div className="space-y-1" key={draft.id}>
                <p className="break-all font-mono text-xs text-paper-400">
                  {visibleText(draft.path)}:{draft.line}
                </p>
                <DraftNote draft={draft} pullId={pull.id} />
              </div>
            ))}
          </div>
        ) : null}
        <RadioGroup
          legend="Review verdict"
          name="review-event"
          onChange={setEvent}
          options={EVENTS.map((e) => ({
            description: e.description,
            label: e.label,
            value: e.value,
          }))}
          value={event}
        />
        {event === 'APPROVE' && write.approvalMayNotCount ? (
          <Alert announce={false} variant="warning">
            You launched or requested this work. The platform sets your approval aside, so it will
            not count toward the approvals the pull request needs, even though the host shows it.
          </Alert>
        ) : null}
        {event === 'REQUEST_CHANGES' && write.feedbackLoopEnabled ? (
          <Alert announce={false} variant="info">
            Requesting changes also asks the agent to address them, as sending it back does.
          </Alert>
        ) : null}
        <Textarea
          aria-label="Review summary"
          hint={
            event === 'REQUEST_CHANGES'
              ? 'Required when you request changes.'
              : 'Optional when you send line comments.'
          }
          maxLength={MAX_COMMENT_CHARS}
          mono={false}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Summary of your review"
          rows={4}
          value={body}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={blocked || submit.isPending}
            onClick={() => setConfirming(true)}
            variant="primary"
          >
            {SEND_LABEL[event]}
          </Button>
          {reason ? <span className="text-xs text-paper-400">{reason}</span> : null}
        </div>
        {sent ? (
          <Alert title="Review sent" variant="success">
            {sent.comments > 0 ? `${plural(sent.comments, 'line comment')} went with it. ` : ''}
            <HostLink url={sent.url}>View it on the host</HostLink>
            {sent.draftsKept
              ? ' Your draft comments were sent but could not be cleared here. Delete them before you send another review, or they will go twice.'
              : ''}
          </Alert>
        ) : null}
      </section>

      <section
        aria-labelledby="send-back-heading"
        className="space-y-3 border-t border-ink-600 pt-5"
      >
        <h2 className="text-sm font-semibold text-paper-100" id="send-back-heading">
          Send back to the agent
        </h2>
        <p className="text-xs text-paper-500">
          Leaves <code className="font-mono">/auto-swe fix</code> on the pull request as you, which
          asks the agent to address the review so far. It starts only if you are allowed to on the
          host and rounds remain.
        </p>
        {write.feedbackLoopEnabled ? (
          <>
            <Textarea
              aria-label="Note for the agent"
              compact
              maxLength={MAX_COMMENT_CHARS}
              mono={false}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What the agent should know (optional)"
              rows={2}
              value={note}
            />
            <Button
              disabled={sendBack.isPending}
              onClick={() => setConfirmingBack(true)}
              variant="secondary"
            >
              Send back
            </Button>
          </>
        ) : (
          <p className="text-sm text-paper-400">
            Pull-request feedback automations are off for this repository, so sending it back would
            start nothing.
          </p>
        )}
        {sentBack ? (
          <Alert title="Sent back" variant="success">
            <HostLink url={sentBack.url}>View the comment on the host</HostLink>
          </Alert>
        ) : null}
      </section>

      <ConfirmModal
        confirmLabel={SEND_LABEL[event]}
        message={
          <>
            This is posted on the host as you
            {current.length > 0 ? `, with ${plural(current.length, 'line comment')}` : ''}. It
            cannot be unsent from here.
          </>
        }
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          const result = await submit.mutateAsync({
            body: text,
            draftIds: current.map((d) => d.id),
            event,
            headSha,
          });
          setSent(result);
          setBody('');
        }}
        open={confirming}
        pendingLabel="Sending…"
        title={`${SEND_LABEL[event]}?`}
      />
      <ConfirmModal
        confirmLabel="Send back"
        message="This leaves /auto-swe fix on the pull request as you, which can start a run."
        onClose={() => setConfirmingBack(false)}
        onConfirm={async () => {
          const result = await sendBack.mutateAsync({ headSha, note });
          setSentBack(result);
          setNote('');
        }}
        open={confirmingBack}
        pendingLabel="Sending…"
        title="Send back to the agent?"
      />
    </Card>
  );
}
