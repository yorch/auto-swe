'use client';

import type { PullRequestCockpitDraft } from '@auto-swe/shared/types/api';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { useCreateDraft, useDeleteDraft, useEditDraft } from '@/hooks/useReviewActions';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';
import { anchorLabel, type CommentAnchor } from './commentRange';

/** What the gateway keeps; a longer comment is refused there. */
export const MAX_COMMENT_CHARS = 4000;

/**
 * A text box with Save and Cancel, for a comment that is being written or changed. Its text is the
 * caller's, so it survives the box being drawn again somewhere else.
 */
function CommentBox({
  busy,
  error,
  label,
  onCancel,
  onSave,
  onTextChange,
  text,
}: {
  busy: boolean;
  error: string | null;
  label: string;
  onCancel: () => void;
  onSave: (text: string) => void;
  onTextChange: (text: string) => void;
  text: string;
}) {
  const frame = useRef<HTMLFormElement>(null);
  useEffect(() => {
    frame.current?.querySelector('textarea')?.focus();
  }, []);
  const empty = text.trim() === '';
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty && !busy) {
          onSave(text);
        }
      }}
      ref={frame}
    >
      <Textarea
        aria-label={label}
        compact
        error={error ?? undefined}
        maxLength={MAX_COMMENT_CHARS}
        mono={false}
        onChange={(event) => onTextChange(event.target.value)}
        rows={3}
        value={text}
      />
      <div className="flex items-center gap-2">
        <Button disabled={empty || busy} size="sm" type="submit" variant="primary">
          {busy ? 'Saving…' : 'Save draft'}
        </Button>
        <Button disabled={busy} onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
        <span className="tabular ml-auto text-xs text-paper-500">
          {text.length}/{MAX_COMMENT_CHARS}
        </span>
      </div>
    </form>
  );
}

/**
 * A comment being written on one line, a range of lines, or a deleted line. Saving keeps it as a
 * draft: nothing reaches the host until a review is sent.
 */
export function NewDraft({
  anchor,
  headSha,
  initialText,
  onDone,
  onTextChange,
  patchDigest,
  path,
  pullId,
}: {
  anchor: CommentAnchor;
  headSha: string;
  /** What the box starts with: the text kept by the caller across a re-anchor. */
  initialText: string;
  onDone: () => void;
  /** Told every change, so the caller can keep the text without drawing again for it. */
  onTextChange: (text: string) => void;
  patchDigest: string;
  path: string;
  pullId: string;
}) {
  const [text, setText] = useState(initialText);
  const create = useCreateDraft(pullId);
  return (
    <CommentBox
      busy={create.isPending}
      error={create.isError ? errMsg(create.error, 'The draft could not be saved') : null}
      label={`Comment on ${anchorLabel(anchor)}`}
      onCancel={onDone}
      onSave={(body) =>
        create.mutate(
          {
            body,
            headSha,
            line: anchor.line,
            patchDigest,
            path,
            side: anchor.side,
            ...(anchor.startLine !== null && { startLine: anchor.startLine }),
          },
          { onSuccess: onDone }
        )
      }
      onTextChange={(next) => {
        setText(next);
        onTextChange(next);
      }}
      text={text}
    />
  );
}

/** A saved draft, under its line, which the reviewer can change or discard. */
export function DraftNote({ draft, pullId }: { draft: PullRequestCockpitDraft; pullId: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.body);
  const edit = useEditDraft(pullId);
  const remove = useDeleteDraft(pullId);

  if (editing) {
    return (
      <CommentBox
        busy={edit.isPending}
        error={edit.isError ? errMsg(edit.error, 'The draft could not be saved') : null}
        label={`Draft comment on ${anchorLabel(draft)}`}
        onCancel={() => setEditing(false)}
        onSave={(body) =>
          edit.mutate({ body, draftId: draft.id }, { onSuccess: () => setEditing(false) })
        }
        onTextChange={setText}
        text={text}
      />
    );
  }
  return (
    <div className="space-y-1.5 rounded-md border border-accent-400/30 bg-accent-400/[0.06] px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-accent-400">Draft comment</span>
        <span className="text-paper-400">{anchorLabel(draft)}</span>
        {draft.outdated ? (
          <Badge tone="warning" variant="outline">
            Outdated
          </Badge>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-paper-200">
        {visibleText(draft.body, { multiline: true })}
      </p>
      {draft.outdated ? (
        <p className="text-xs text-warning-400">
          The file has changed since you wrote this, so it cannot be sent as it is. Delete it and
          comment again on the new line.
        </p>
      ) : null}
      {remove.isError ? (
        <p className="text-xs text-danger-400" role="alert">
          {errMsg(remove.error, 'The draft could not be deleted')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          onClick={() => {
            setText(draft.body);
            setEditing(true);
          }}
          size="sm"
          variant="ghost"
        >
          Edit
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() => remove.mutate(draft.id)}
          size="sm"
          variant="ghost"
        >
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  );
}
