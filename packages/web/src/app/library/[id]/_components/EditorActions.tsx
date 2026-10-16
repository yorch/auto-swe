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
      {isDirty && (
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      )}
      {isDirty && jsonInvalid && (
        <span className="text-xs text-brick-400" id="save-blocked-reason">
          Fix the JSON to save
        </span>
      )}
      {isDirty && (
        <Button
          aria-describedby={jsonInvalid ? 'save-blocked-reason' : undefined}
          disabled={savePending || jsonInvalid}
          onClick={onSave}
          size="sm"
          variant="primary"
        >
          {savePending ? 'Saving…' : 'Save new version'}
        </Button>
      )}
      {canPromote && promoteReason && (
        <span className="text-xs text-brick-400" id="promote-blocked-reason">
          {promoteReason}
        </span>
      )}
      {canPromote &&
        (selectedNeedsReview ? (
          <Button
            aria-describedby={
              promoteBlocked && isActiveVersion ? 'promote-blocked-reason' : undefined
            }
            disabled={reviewPending || (promoteBlocked && isActiveVersion)}
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
