'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef } from 'react';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './Icon';
import { iconButtonClassName } from './IconButton';

export interface ActionMenuItem {
  /** Stable identity within the menu. */
  id: string;
  label: string;
  icon?: IconName;
  /** `danger` renders the item in the destructive tone — pair it with a confirm step. */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /**
   * The caller may not use this item, and here is why. Unlike `disabled` the item stays in the
   * keyboard order, is `aria-disabled`, ignores activation without closing the menu, and ties the
   * reason to itself with `aria-describedby` so a screen-reader user hears it (sighted pointer
   * users get it as the tooltip). Use it for a permission the caller lacks, where the reason is
   * the point; use `disabled` for an action that is merely unavailable.
   */
  disabledReason?: string | null;
  /** Navigate with the app router. */
  href?: string;
  onAction?: () => void;
}

/**
 * The label of one entry. React Aria sets `aria-disabled` only for its own disabled keys, which
 * also drop out of the keyboard order, and passes no `title` through, so an entry blocked with a
 * reason gets both on its `menuitem` element from here, found through a marker inside it. This
 * renders in the live tree (the collection builder renders `MenuItem`'s children there, not in
 * the entry), which is why the effect lives here.
 */
function EntryLabel({ label, reason }: { label: string; reason?: string | null }) {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = marker.current?.closest('[role="menuitem"]');
    if (!el) {
      return;
    }
    if (reason) {
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', reason);
    } else {
      el.removeAttribute('aria-disabled');
      el.removeAttribute('title');
    }
  }, [reason]);
  return <span ref={marker}>{label}</span>;
}

function ActionMenuEntry({ item, reasonId }: { item: ActionMenuItem; reasonId: string }) {
  const reason = item.disabledReason;
  return (
    <MenuItem
      aria-describedby={reason ? reasonId : undefined}
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none pointer-coarse:min-h-[44px]',
        item.tone === 'danger'
          ? 'text-danger-400 data-[focused]:bg-danger-400/10'
          : 'text-paper-200 data-[focused]:bg-ink-600',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        reason && 'cursor-not-allowed opacity-40'
      )}
      id={item.id}
      shouldCloseOnSelect={!reason}
      textValue={item.label}
    >
      {item.icon && <Icon className="opacity-80" name={item.icon} size={14} />}
      <EntryLabel label={item.label} reason={reason} />
    </MenuItem>
  );
}

/**
 * A row's secondary actions behind a "⋯" button. A table row keeps its one
 * primary action as a visible `Button` and puts the rest — edit, history,
 * archive, delete — here, so rows stay one line tall and a destructive action is
 * never a stray click away. Keyboard: Enter/Space opens, arrows move, Escape closes.
 */
export function ActionMenu({
  className,
  items,
  label,
}: {
  className?: string;
  items: ActionMenuItem[];
  /** Accessible name for the trigger, e.g. "Actions for ticket-to-merge". */
  label: string;
}) {
  const router = useRouter();
  const reasonPrefix = useId();
  const visible = items.filter(Boolean);
  if (visible.length === 0) {
    return null;
  }
  return (
    <MenuTrigger>
      <AriaButton aria-label={label} className={iconButtonClassName({ size: 'sm' }, className)}>
        <Icon name="more" size={18} strokeWidth={2.6} />
      </AriaButton>
      <Popover
        className="min-w-44 rounded-lg border border-ink-400 bg-ink-800 p-1 shadow-2xl shadow-black/40 outline-none"
        offset={4}
        placement="bottom end"
      >
        <Menu
          className="outline-none"
          disabledKeys={visible.filter((i) => i.disabled).map((i) => i.id)}
          onAction={(key) => {
            const item = visible.find((i) => i.id === key);
            if (!item || item.disabledReason) {
              return;
            }
            if (item.onAction) {
              item.onAction();
            } else if (item.href) {
              router.push(item.href);
            }
          }}
        >
          {visible.map((item) => (
            <ActionMenuEntry item={item} key={item.id} reasonId={`${reasonPrefix}-${item.id}`} />
          ))}
        </Menu>
        {visible
          .filter((item) => item.disabledReason)
          .map((item) => (
            <span
              className="sr-only"
              data-testid="menu-blocked-reason"
              id={`${reasonPrefix}-${item.id}`}
              key={item.id}
            >
              {item.disabledReason}
            </span>
          ))}
      </Popover>
    </MenuTrigger>
  );
}
