import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  danger:
    'border-brick-400/40 bg-transparent text-brick-400 hover:bg-brick-400/10 hover:border-brick-400',
  ghost:
    'border-transparent bg-transparent text-paper-400 hover:text-paper-200 hover:bg-ink-600/50',
  primary:
    'border-transparent bg-gradient-to-br from-ember-400 to-ember-600 text-white hover:brightness-110',
  secondary:
    'border-ink-400 bg-ink-600 text-paper-300 hover:bg-ink-500 hover:text-paper-100 hover:border-ink-300',
};

// Sizes differ by height and horizontal padding only. Type size is the
// component-wide 13.5px set inline below; the `text-xs`/`text-sm` classes
// that used to be here never applied, because an inline style beats every
// class, so all three rendered at 13.5px regardless.
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
  type = 'button',
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
        borderRadius: '10px',
        fontSize: '13.5px',
        letterSpacing: '0.01em',
      }}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
