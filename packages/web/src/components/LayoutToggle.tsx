'use client';

export type RunDetailLayout = 'A' | 'B' | 'C';

const OPTIONS: { id: RunDetailLayout; label: string; title: string }[] = [
  { id: 'A', label: 'A', title: 'Split Console' },
  { id: 'B', label: 'B', title: 'Transcript' },
  { id: 'C', label: 'C', title: 'Flight Recorder' },
];

interface LayoutToggleProps {
  value: RunDetailLayout;
  onChange: (v: RunDetailLayout) => void;
}

export function LayoutToggle({ value, onChange }: LayoutToggleProps) {
  return (
    <div className="flex items-center border border-ink-400" style={{ borderRadius: '2px' }}>
      {OPTIONS.map((opt, i) => (
        <button
          aria-label={opt.title}
          className="relative px-3 py-1 transition-colors"
          key={opt.id}
          onClick={() => onChange(opt.id)}
          style={{
            background: value === opt.id ? 'oklch(0.70 0.145 28 / 0.14)' : 'transparent',
            borderLeft: i > 0 ? '1px solid var(--color-ink-400)' : 'none',
            color: value === opt.id ? 'var(--color-ember-400)' : 'var(--color-paper-500)',
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            letterSpacing: '0.14em',
          }}
          title={opt.title}
          type="button"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
