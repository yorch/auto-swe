'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import {
  type Lesson,
  useClearLessonFlags,
  useFlagLesson,
  useWithdrawLessonFlag,
} from '@/hooks/useLessons';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

const MAX_REASON = 500;

/** Who flagged a lesson and why — shown only to someone who may act on it. */
export function LessonFlagReasons({ lesson }: { lesson: Lesson }) {
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
export function LessonFlagActions({ lesson, manages }: { lesson: Lesson; manages: boolean }) {
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
          title={`You flagged this: ${lesson.myFlag.reason}`}
          variant="ghost"
        >
          Withdraw flag
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
      {/* Mounted only while open: the dialog quotes the lesson, and a closed one would repeat
          every lesson's text in the page. */}
      {flagging && <FlagLessonModal lesson={lesson} onClose={() => setFlagging(false)} open />}
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

function FlagLessonModal({
  lesson,
  open,
  onClose,
}: {
  lesson: Lesson;
  open: boolean;
  onClose: () => void;
}) {
  const flag = useFlagLesson();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = reason.trim();
    if (!text) {
      setError('Say what is wrong with it.');
      return;
    }
    try {
      await flag.mutateAsync({ id: lesson.id, reason: text });
      setReason('');
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Could not flag this lesson'));
    }
  }

  return (
    <Modal
      onClose={onClose}
      open={open}
      subtitle="A lead of the repository's team, or an administrator, reviews flagged lessons and deletes or keeps them. Until then the lesson is still recalled."
      title="Flag this lesson"
    >
      <form className="space-y-3" onSubmit={handleSubmit}>
        <blockquote className="whitespace-pre-wrap rounded-md border-l-2 border-ink-300 bg-ink-900/60 px-3 py-2 text-sm text-paper-200">
          {lesson.lessonSummary}
        </blockquote>
        <Textarea
          hint={`${reason.length}/${MAX_REASON}`}
          id={`flag-reason-${lesson.id}`}
          label="What is wrong with it"
          maxLength={MAX_REASON}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          value={reason}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={flag.isPending}
          onCancel={onClose}
          pendingLabel="Flagging…"
          submitLabel="Flag lesson"
        />
      </form>
    </Modal>
  );
}
