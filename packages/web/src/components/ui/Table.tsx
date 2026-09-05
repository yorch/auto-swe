import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Align = 'left' | 'right' | 'center';
const ALIGN: Record<Align, string> = {
  center: 'text-center',
  left: 'text-left',
  right: 'text-right',
};

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cn('w-full text-sm', className)}>{children}</table>;
}

/** Header row (`<thead><tr>`). `className` carries a row background or text treatment. */
export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead>
      <tr className={cn('border-b border-ink-600', className)}>{children}</tr>
    </thead>
  );
}

/**
 * The header treatments in use: `mono` (small caps, admin lists), `plain`
 * (main list pages), `compact` (dense admin cards without side padding) and
 * `dense` (numeric admin tables). New tables should pick `mono` or `plain`.
 */
export type ThVariant = 'mono' | 'plain' | 'compact' | 'dense';
const TH_VARIANT: Record<ThVariant, string> = {
  compact: 'py-2 text-xs text-paper-500',
  dense: 'px-4 py-2 font-medium',
  mono: 'px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500',
  plain: 'px-4 py-3 font-medium',
};

export function Th({
  align = 'left',
  children,
  className,
  variant = 'mono',
}: {
  align?: Align;
  children?: ReactNode;
  className?: string;
  variant?: ThVariant;
}) {
  return <th className={cn(TH_VARIANT[variant], ALIGN[align], className)}>{children}</th>;
}

/** Body row with the standard divider; `hover` adds the row highlight. */
export function TRow({
  children,
  className,
  hover = false,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
}) {
  return (
    <tr
      className={cn(
        'border-b border-ink-600 last:border-0',
        hover && 'transition-colors hover:bg-ink-800',
        className
      )}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

export function Td({
  align,
  children,
  className,
  colSpan,
  title,
}: {
  align?: Align;
  children?: ReactNode;
  className?: string;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td className={cn(align && ALIGN[align], className)} colSpan={colSpan} title={title}>
      {children}
    </td>
  );
}
