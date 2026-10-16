import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/utils';

interface EditorActionBarProps {
  paletteOpen: boolean;
  showOutline: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShowOutline: Dispatch<SetStateAction<boolean>>;
  /** True while the server half of "Check workflow" is in flight. */
  checkPending: boolean;
  onCheck: () => void;
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
  actions,
}: EditorActionBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-b border-ink-600 bg-ink-950/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-expanded={paletteOpen}
          className="lg:hidden"
          onClick={() => {
            setPaletteOpen((v) => !v);
            // One overlay at a time below lg.
            setShowOutline(false);
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
            setPaletteOpen(false);
          }}
          size="sm"
          variant="ghost"
        >
          <Icon name="list" size={13} />
          Outline
        </Button>
        {actions}
      </div>
    </div>
  );
}
