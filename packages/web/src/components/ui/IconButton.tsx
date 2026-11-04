import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn, FOCUS_RING } from '@/lib/utils';

type IconButtonSize = 'xs' | 'sm' | 'md';
type IconButtonShape = 'square' | 'round';
type IconButtonVariant = 'ghost' | 'outline';

// Visual sizes at the 14px root: 17.5 / 24.5 / 28px. `xs` is smaller than the 24px WCAG 2.5.8
// floor, so it grows an invisible `::after` hit area (24.5px; 45px on a coarse pointer) without
// moving the neighbours. `sm` and `md` already meet the floor and grow to 44px for touch.
const SIZE: Record<IconButtonSize, string> = {
  md: 'h-8 w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  sm: 'h-7 w-7 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  xs: 'relative h-5 w-5 after:absolute after:-inset-1 pointer-coarse:after:-inset-4',
};

const VARIANT: Record<IconButtonVariant, string> = {
  ghost:
    'border border-transparent text-paper-500 hover:bg-ink-500/60 hover:text-paper-100 data-[pressed]:bg-ink-500/60',
  outline:
    'border border-ink-400 text-paper-300 hover:border-accent-400/60 hover:text-paper-100 data-[pressed]:border-accent-400/60',
};

const SHAPE: Record<IconButtonShape, string> = {
  round: 'rounded-full',
  square: 'rounded-md',
};

/**
 * The class string of an icon-only button, for an element that cannot be an
 * `IconButton` itself — a React Aria `Button` that must stay one to join a
 * `MenuTrigger`, say. Every other use is `<IconButton>`.
 */
export function iconButtonClassName(
  {
    shape = 'square',
    size = 'sm',
    variant = 'ghost',
  }: { shape?: IconButtonShape; size?: IconButtonSize; variant?: IconButtonVariant } = {},
  className?: string
) {
  return cn(
    'inline-flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    SIZE[size],
    SHAPE[shape],
    VARIANT[variant],
    FOCUS_RING,
    className
  );
}

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'aria-labelledby' | 'children'
> & {
  /** Required: an icon alone names nothing. Say what the button does ("Close"), not what it shows. */
  'aria-label': string;
  /** The icon (decorative; the label names the button). */
  children: ReactNode;
  size?: IconButtonSize;
  shape?: IconButtonShape;
  variant?: IconButtonVariant;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * A button that is only an icon. Enforces an accessible name at the type level and a hit area
 * of at least 24px (44px on a touch screen), whatever the icon's own size. Defaults to a quiet
 * square `ghost` button; `variant="outline"` + `shape="round"` is the top-bar chip.
 */
export function IconButton({
  children,
  className,
  ref,
  shape,
  size,
  type = 'button',
  variant,
  ...props
}: IconButtonProps) {
  return (
    <button
      className={iconButtonClassName({ shape, size, variant }, className)}
      ref={ref}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
