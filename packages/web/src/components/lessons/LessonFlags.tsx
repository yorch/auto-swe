'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import {
  type Lesson,
  type LessonQuarantine,
  useClearLessonFlags,
  useFlagLesson,
  useQuarantineLesson,
  useRestoreLesson,
  useWithdrawLessonFlag,
} from '@/hooks/useLessons';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

const MAX_REASON = 500;

type TriageLesson = Pick<Lesson, 'id' | 'lessonSummary' | 'flagCount' | 'flags' | 'myFlag'>;

export function LessonQuarantineBadge({ lesson }: { lesson: LessonQuarantine }) {
  if (!lesson.quarantinedAt) {
    return null;
  }
  return (
    <div className="mt-1 text-xs text-paper-400">
      <Badge tone="warning" variant="outline">
        Quarantined
      </Badge>{' '}
      {lesson.quarantineSource === 'FLAG_THRESHOLD' ? 'Flag threshold' : 'Manual'}
      {lesson.quarantineReason && <span> — {lesson.quarantineReason}</span>}
    </div>
  );
}

export function LessonQuarantineActions({ lesson }: { lesson: TriageLesson & LessonQuarantine }) {
  const [quarantining, setQuarantining] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restore = useRestoreLesson();
  return (
    <>
      {lesson.quarantinedAt ? (
        <Button onClick={() => setRestoring(true)} size="sm" variant="ghost">
          Restore
        </Button>
      ) : null}
      {(!lesson.quarantinedAt || lesson.quarantineSource === 'FLAG_THRESHOLD') && (
        <Button onClick={() => setQuarantining(true)} size="sm" variant="ghost">
          {lesson.quarantinedAt ? 'Quarantine manually' : 'Quarantine'}
        </Button>
      )}
      {quarantining && (
        <LessonReasonModal
          action="quarantine"
          lesson={lesson}
          onClose={() => setQuarantining(false)}
          open
        />
      )}
      <ConfirmModal
        confirmLabel="Restore"
        message="Restore this lesson to recall and clear all its flags? The flag reasons stay in the audit log. Retired lessons remain retired."
        onClose={() => setRestoring(false)}
        onConfirm={async () => {
          await restore.mutateAsync(lesson.id);
        }}
        open={restoring}
        title="Restore lesson"
      />
    </>
  );
}

/** Who flagged a lesson and why — shown only to someone who may act on it. */
export function LessonFlagReasons({ lesson }: { lesson: TriageLesson }) {
  if (!lesson.flags || lesson.flags.length === 0) {
    return null;
  }
  return (
    <ul className="mt-2 space-y-1 border-l-2 border-warning-400/50 pl-3 text-xs text-paper-400">
      {lesson.flags.map((f) => (
        <li key={`${f.email}-${f.createdAt}`}>
          <span className="text-paper-200">{f.reason}</span>{' '}
          <span className="text-paper-500">
            — {f.email}, {formatDate(f.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Flag, withdraw a flag, and — for someone who manages the lesson — clear its flags. Clearing is
 * the decision that the lesson stands; deleting it is the other answer, next to this.
 */
export function LessonFlagActions({ lesson, manages }: { lesson: TriageLesson; manages: boolean }) {
  const [flagging, setFlagging] = useState(false);
  const [clearing, setClearing] = useState(false);
  const withdraw = useWithdrawLessonFlag();
  const clear = useClearLessonFlags();
  return (
    <>
      {lesson.myFlag ? (
        <Button
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate(lesson.id)}
          size="sm"
          variant="ghost"
        >
          {withdraw.isPending ? 'Withdrawing…' : 'Withdraw flag'}
        </Button>
      ) : (
        <Button onClick={() => setFlagging(true)} size="sm" variant="ghost">
          Flag
        </Button>
      )}
      {manages && lesson.flagCount > 0 && (
        <Button onClick={() => setClearing(true)} size="sm" variant="ghost">
          Clear flags
        </Button>
      )}
      {withdraw.isError && (
        <Alert className="w-full">{errMsg(withdraw.error, 'Could not withdraw your flag')}</Alert>
      )}
      {lesson.myFlag && (
        <p className="w-full text-xs text-paper-500">You flagged this: {lesson.myFlag.reason}</p>
      )}
      {/* Mounted only while open: the dialog quotes the lesson, and a closed one would repeat
          every lesson's text in the page. */}
      {flagging && (
        <LessonReasonModal action="flag" lesson={lesson} onClose={() => setFlagging(false)} open />
      )}
      <ConfirmModal
        confirmLabel="Clear flags"
        message="Keep this lesson and clear its flags? The reasons stay in the audit log."
        onClose={() => setClearing(false)}
        onConfirm={async () => {
          await clear.mutateAsync(lesson.id);
        }}
        open={clearing}
        title="Clear flags"
      />
    </>
  );
}

function LessonReasonModal({
  action,
  lesson,
  open,
  onClose,
}: {
  action: 'flag' | 'quarantine';
  lesson: TriageLesson;
  open: boolean;
  onClose: () => void;
}) {
  const flag = useFlagLesson();
  const quarantine = useQuarantineLesson();
  const mutation = action === 'flag' ? flag : quarantine;
  const verb = action === 'flag' ? 'Flag' : 'Quarantine';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = reason.trim();
    if (!text) {
      setError('Describe what is wrong with this lesson.');
      return;
    }
    try {
      await mutation.mutateAsync({ id: lesson.id, reason: text });
      setReason('');
      onClose();
    } catch (err) {
      setError(errMsg(err, `Could not ${verb.toLowerCase()} this lesson`));
    }
  }

  return (
    <Modal
      dismissible={!mutation.isPending}
      onClose={onClose}
      open={open}
      subtitle={
        action === 'flag'
          ? "A lead of the repository's team, or an administrator, reviews flags. Reaching the repository's flag threshold automatically quarantines the lesson and stops recall."
          : 'Quarantined lessons stay visible to readers but are excluded from agent recall. Manual quarantine stays until a manager restores it.'
      }
      title={`${verb} this lesson`}
    >
      <form className="space-y-3" onSubmit={handleSubmit}>
        <blockquote className="whitespace-pre-wrap rounded-md border-l-2 border-ink-300 bg-ink-900/60 px-3 py-2 text-sm text-paper-200">
          {lesson.lessonSummary}
        </blockquote>
        <Textarea
          error={error ?? undefined}
          hint={`${reason.length}/${MAX_REASON}`}
          id={`flag-reason-${lesson.id}`}
          label="What is wrong with it"
          maxLength={MAX_REASON}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          rows={3}
          value={reason}
        />
        <ModalFooter
          disabled={!reason.trim()}
          isPending={mutation.isPending}
          onCancel={onClose}
          pendingLabel={action === 'flag' ? 'Flagging…' : 'Quarantining…'}
          submitLabel={`${verb} lesson`}
        />
      </form>
    </Modal>
  );
}
