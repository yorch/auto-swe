'use client';

import { useRouter } from 'next/navigation';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { cn, FOCUS_RING } from '@/lib/utils';
import { Icon, type IconName } from './Icon';

export interface ActionMenuItem {
  /** Stable identity within the menu. */
  id: string;
  label: string;
  icon?: IconName;
  /** `danger` renders the item in the destructive tone — pair it with a confirm step. */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Navigate with the app router. */
  href?: string;
  onAction?: () => void;
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
  /** Accessible name for the trigger, e.g. "Actions for default-engineering". */
  label: string;
}) {
  const router = useRouter();
  const visible = items.filter(Boolean);
  if (visible.length === 0) {
    return null;
  }
  return (
    <MenuTrigger>
      <AriaButton
        aria-label={label}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-md text-paper-500 transition-colors hover:bg-ink-500/60 hover:text-paper-100 data-[pressed]:bg-ink-500/60',
          FOCUS_RING,
          className
        )}
      >
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
            if (!item) {
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
            <MenuItem
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none',
                item.tone === 'danger'
                  ? 'text-brick-400 data-[focused]:bg-brick-400/10'
                  : 'text-paper-200 data-[focused]:bg-ink-600',
                'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40'
              )}
              id={item.id}
              key={item.id}
              textValue={item.label}
            >
              {item.icon && <Icon className="opacity-80" name={item.icon} size={14} />}
              {item.label}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
