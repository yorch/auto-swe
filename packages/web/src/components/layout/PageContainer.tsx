import { cn } from '@/lib/utils';

/**
 * The page column: centred, capped at 1280px, with the shell's gutters and vertical rhythm.
 * `AppShell` wraps every ordinary page in it; a route that opts out of the shell's padding
 * (the fullscreen editor routes) but has scrolling prose or forms of its own uses this too, so
 * the two columns cannot drift.
 */
export const PAGE_CONTAINER_CLASS = 'mx-auto max-w-[1280px] px-4 pt-6 pb-16 md:px-10 md:pt-10';

export function PageContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn(PAGE_CONTAINER_CLASS, className)}>{children}</div>;
}
