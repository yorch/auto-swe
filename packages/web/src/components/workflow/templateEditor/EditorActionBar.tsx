import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';
import { overlayMode } from './overlayFocus';

interface EditorActionBarProps {
  paletteOpen: boolean;
  showOutline: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShowOutline: Dispatch<SetStateAction<boolean>>;
  /** True while the server half of "Check workflow" is in flight. */
  checkPending: boolean;
  onCheck: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Re-run the layout for every node, discarding hand placement. */
  onAutoLayout: () => void;
  /** Parent-supplied Save/Cancel CTAs. */
  actions?: ReactNode;
}

/** The strip above the canvas: editor actions only. The graph's read-only stats live in `EditorStatusBar`. */
export function EditorActionBar({
  paletteOpen,
  showOutline,
  setPaletteOpen,
  setShowOutline,
  checkPending,
  onCheck,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAutoLayout,
  actions,
}: EditorActionBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-ink-600 bg-ink-950/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-expanded={paletteOpen}
          onClick={() => {
            setPaletteOpen((v) => !v);
            // One overlay at a time below lg; from lg up the two rails sit side by side.
            if (overlayMode()) {
              setShowOutline(false);
            }
          }}
          size="sm"
          variant="secondary"
        >
          <Icon name="plus" size={13} />
          Add node
        </Button>
        <Button
          aria-busy={checkPending}
          data-check-workflow=""
          data-tour="editor:check"
          onClick={onCheck}
          size="sm"
          variant="secondary"
        >
          <Icon name="checkCircle" size={13} />
          Check workflow
        </Button>
        <Button
          aria-pressed={showOutline}
          className={cn(showOutline && 'border-accent-400/50 bg-accent-400/10 text-accent-300')}
          onClick={() => {
            setShowOutline((v) => !v);
            if (overlayMode()) {
              setPaletteOpen(false);
            }
          }}
          size="sm"
          variant="ghost"
        >
          <Icon name="list" size={13} />
          Outline
        </Button>
        <Button
          aria-label="Undo"
          disabled={!canUndo}
          onClick={onUndo}
          size="sm"
          title="Undo (Ctrl/Cmd+Z)"
          variant="ghost"
        >
          <Icon name="arrowLeft" size={13} />
          Undo
        </Button>
        <Button
          aria-label="Redo"
          disabled={!canRedo}
          onClick={onRedo}
          size="sm"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          variant="ghost"
        >
          <Icon name="arrowRight" size={13} />
          Redo
        </Button>
        <Button
          onClick={onAutoLayout}
          size="sm"
          title="Re-arrange every node; positions you set by hand are discarded"
          variant="ghost"
        >
          <Icon name="canvas" size={13} />
          Auto-layout
        </Button>
        {actions}
      </div>
    </div>
  );
}
