'use client';

import { cn } from '@/lib/utils';

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  title,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      className={cn(
        'h-5 w-10 rounded-full transition-colors',
        checked ? 'bg-ember-400' : 'bg-ink-500',
        className
      )}
      disabled={disabled}
      onClick={onChange}
      title={title ?? (checked ? 'Disable' : 'Enable')}
      type="button"
    >
      <span
        className={cn(
          'block h-4 w-4 translate-x-0.5 rounded-full bg-paper-100 transition-transform',
          checked && 'translate-x-[1.375rem]'
        )}
      />
    </button>
  );
}
