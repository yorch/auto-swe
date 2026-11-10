'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * A button the caller may lack the right to press. With a `blockedReason` it stays in the tab
 * order as `aria-disabled` (a native `disabled` button drops out of it, and takes its reason
 * with it), ignores activation, and ties the reason to itself with `aria-describedby` so a
 * keyboard or screen-reader user hears why; sighted pointer users get it as the tooltip.
 */
export function GuardedButton({
  blockedReason,
  onClick,
  title,
  'aria-describedby': describedBy,
  ...props
}: ButtonProps & { blockedReason?: string | null }) {
  const reasonId = useId();
  if (!blockedReason) {
    return <Button aria-describedby={describedBy} onClick={onClick} title={title} {...props} />;
  }
  return (
    <>
      <Button
        {...props}
        aria-describedby={describedBy ? `${describedBy} ${reasonId}` : reasonId}
        aria-disabled="true"
        className={cn(props.className, 'cursor-not-allowed opacity-40')}
        onClick={(event) => event.preventDefault()}
        title={blockedReason}
      />
      <span className="sr-only" data-testid="blocked-reason" id={reasonId}>
        {blockedReason}
      </span>
    </>
  );
}
