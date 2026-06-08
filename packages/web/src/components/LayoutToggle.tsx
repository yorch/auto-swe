'use client';

type RunDetailLayout = 'split' | 'inline';

interface LayoutToggleProps {
  value: RunDetailLayout;
  onChange: (v: RunDetailLayout) => void;
}

export function LayoutToggle({ value, onChange }: LayoutToggleProps) {
  return (
    <div className="flex items-center gap-px bg-ink-700 rounded p-0.5">
      <button
        aria-label="Split panel layout"
        className={`p-1 rounded transition-colors ${
          value === 'split' ? 'bg-ink-500 text-paper-100' : 'text-paper-400 hover:text-paper-200'
        }`}
        onClick={() => onChange('split')}
        title="Split panel"
        type="button"
      >
        {/* Two-column split icon */}
        <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
          <rect height="10" rx="1" stroke="currentColor" strokeWidth="1.2" width="5" x="1" y="2" />
          <rect height="10" rx="1" stroke="currentColor" strokeWidth="1.2" width="5" x="8" y="2" />
        </svg>
      </button>
      <button
        aria-label="Inline list layout"
        className={`p-1 rounded transition-colors ${
          value === 'inline' ? 'bg-ink-500 text-paper-100' : 'text-paper-400 hover:text-paper-200'
        }`}
        onClick={() => onChange('inline')}
        title="Inline list"
        type="button"
      >
        {/* List with indent lines icon */}
        <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
          <line stroke="currentColor" strokeWidth="1.2" x1="2" x2="12" y1="4" y2="4" />
          <line stroke="currentColor" strokeWidth="1.2" x1="2" x2="12" y1="7" y2="7" />
          <line stroke="currentColor" strokeWidth="1.2" x1="4" x2="12" y1="10" y2="10" />
        </svg>
      </button>
    </div>
  );
}
