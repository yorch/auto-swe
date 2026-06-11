import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  danger:
    'border-brick-400/40 bg-transparent text-brick-400 hover:bg-brick-400/10 hover:border-brick-400',
  ghost: 'border-transparent bg-transparent text-paper-400 hover:text-paper-200',
  primary: 'border-ember-400 bg-ember-400 text-ink-950 hover:bg-ember-300 hover:border-ember-300',
  secondary:
    'border-ink-400 bg-transparent text-paper-400 hover:text-paper-200 hover:border-ink-300',
};

const SIZES: Record<Size, string> = {
  lg: 'h-10 px-5',
  md: 'h-8 px-4',
  sm: 'h-7 px-3',
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
        'inline-flex items-center justify-center gap-2 border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      style={{
        borderRadius: '2px',
        fontFamily: 'var(--font-mono)',
        fontSize: '10.5px',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
      }}
      {...props}
    >
      {children}
    </button>
  );
}
