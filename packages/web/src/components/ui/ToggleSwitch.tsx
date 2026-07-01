'use client';

import { cn } from '@/lib/utils';

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  title,
  label,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      aria-checked={checked}
      className={cn('flex items-center gap-2', label && 'cursor-pointer', className)}
      disabled={disabled}
      onClick={onChange}
      role="switch"
      title={title ?? (checked ? 'Disable' : 'Enable')}
      type="button"
    >
      <span
        className={cn(
          'inline-block h-5 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-ember-400' : 'bg-ink-500'
        )}
      >
        <span
          className={cn(
            'block h-4 w-4 translate-x-0.5 rounded-full bg-paper-100 transition-transform',
            checked && 'translate-x-[1.375rem]'
          )}
        />
      </span>
      {label && <span className="text-sm text-paper-400">{label}</span>}
    </button>
  );
}
