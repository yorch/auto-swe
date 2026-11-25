import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

export type ViewMode = 'view' | 'edit' | 'json';

interface EditorActionsProps {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  canManage: boolean;
  isDirty: boolean;
  jsonInvalid: boolean;
  savePending: boolean;
  reviewPending: boolean;
  canPromote: boolean;
  promoteBlocked: boolean;
  promoteReason: string | null;
  promoteVariant: 'primary' | 'secondary';
  isActiveVersion: boolean;
  selectedNeedsReview: boolean;
  reviewBlockedReason?: string | null;
  onCancel: () => void;
  onSave: () => void;
  onReview: () => void;
  onPromote: () => void;
}

/** The mode switch and the Edit / Cancel / Save / Review / Promote buttons for the open version. */
export function EditorActions({
  mode,
  setMode,
  canManage,
  isDirty,
  jsonInvalid,
  savePending,
  reviewPending,
  canPromote,
  promoteBlocked,
  promoteReason,
  promoteVariant,
  isActiveVersion,
  selectedNeedsReview,
  reviewBlockedReason = null,
  onCancel,
  onSave,
  onReview,
  onPromote,
}: EditorActionsProps) {
  return (
    <>
      <SegmentedControl
        ariaLabel="Editor view"
        onChange={(next) => {
          // Leaving unparseable edits would drop the typed text: fix them (or Cancel) first.
          // An untouched stored version that does not parse can still be left.
          if (isDirty && jsonInvalid && next !== 'json') {
            return;
          }
          if ((next === 'json') !== (mode === 'json')) {
            setMode(mode === 'json' ? (canManage ? 'edit' : 'view') : 'json');
          }
        }}
        options={[
          { label: 'Visual', value: 'visual' },
          { label: 'JSON', value: 'json' },
        ]}
        value={mode === 'json' ? 'json' : 'visual'}
      />
      {mode === 'view' && canManage && (
        <Button onClick={() => setMode('edit')} size="sm" variant="secondary">
          <Icon name="edit" size={13} />
          Edit
        </Button>
      )}
      {(isDirty || mode === 'edit') && (
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      )}
      {isDirty && jsonInvalid && (
        <span className="text-xs text-danger-400" id="save-blocked-reason">
          Fix the JSON, or Cancel, to switch to Visual
        </span>
      )}
      {(isDirty || mode === 'edit') && (
        <Button
          aria-describedby={jsonInvalid ? 'save-blocked-reason' : undefined}
          disabled={savePending || jsonInvalid || !isDirty}
          onClick={onSave}
          size="sm"
          variant="primary"
        >
          {savePending ? 'Saving…' : 'Save new version'}
        </Button>
      )}
      {canPromote && promoteReason && (
        <span className="text-xs text-danger-400" id="promote-blocked-reason">
          {promoteReason}
        </span>
      )}
      {canPromote && selectedNeedsReview && reviewBlockedReason && (
        <span className="text-xs text-paper-500" id="review-blocked-reason">
          {reviewBlockedReason}
        </span>
      )}
      {canPromote &&
        (selectedNeedsReview ? (
          <Button
            aria-describedby={
              reviewBlockedReason
                ? 'review-blocked-reason'
                : promoteBlocked && isActiveVersion
                  ? 'promote-blocked-reason'
                  : undefined
            }
            disabled={
              reviewPending || reviewBlockedReason !== null || (promoteBlocked && isActiveVersion)
            }
            onClick={onReview}
            size="sm"
            variant={promoteVariant}
          >
            {reviewPending
              ? 'Reviewing…'
              : isActiveVersion
                ? 'Review & activate'
                : 'Review & approve'}
          </Button>
        ) : (
          <Button
            aria-describedby={promoteBlocked ? 'promote-blocked-reason' : undefined}
            disabled={promoteBlocked}
            onClick={onPromote}
            size="sm"
            variant={promoteVariant}
          >
            {isActiveVersion ? 'Activate' : 'Promote to active'}
          </Button>
        ))}
    </>
  );
}
