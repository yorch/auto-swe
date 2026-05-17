import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  danger:
    'border-brick-400/40 bg-transparent text-brick-400 hover:bg-brick-400/10 hover:border-brick-400',
  ghost: 'border-transparent bg-transparent text-paper-400 hover:text-paper-100 hover:bg-ink-700',
  primary: 'border-ember-400 bg-ember-400 text-ink-950 hover:bg-ember-300 hover:border-ember-300',
  secondary:
    'border-ink-500 bg-transparent text-paper-100 hover:border-ember-400 hover:text-ember-400',
};

const SIZES: Record<Size, string> = {
  lg: 'h-11 px-5 text-sm',
  md: 'h-9 px-4 text-xs',
  sm: 'h-7 px-3 text-[11px]',
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-sm border font-mono uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
