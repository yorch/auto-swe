'use client';

import { Icon, type IconName } from '@/components/ui/Icon';
import { cn, FOCUS_RING } from '@/lib/utils';
import { type PalettePreference, type ThemePreference, useThemeStore } from '@/stores/themeStore';

/**
 * The three theme choices, in the order the TopBar toggle cycles through them.
 * The command palette lists the same three, so the two cannot disagree.
 */
export const THEME_CHOICES: readonly { value: ThemePreference; label: string; icon: IconName }[] = [
  { icon: 'moon', label: 'Dark', value: 'dark' },
  { icon: 'sun', label: 'Light', value: 'light' },
  { icon: 'monitor', label: 'System', value: 'system' },
];

/**
 * The two palettes, shared by the user menu and the command palette. Navy is the
 * default; graphite swaps the blue-tinted surfaces and text for neutral greys.
 */
export const PALETTE_CHOICES: readonly {
  value: PalettePreference;
  label: string;
  title: string;
}[] = [
  { label: 'Navy', title: 'Blue-tinted surfaces', value: 'navy' },
  { label: 'Graphite', title: 'Neutral grey surfaces', value: 'graphite' },
];

function choiceFor(preference: ThemePreference) {
  return THEME_CHOICES.find((c) => c.value === preference) ?? THEME_CHOICES[0];
}

/**
 * One-click theme switch for the TopBar. The setting already lives in the
 * user menu at the foot of the sidebar, which is where nobody looks for it.
 * Each click moves to the next choice; the icon shows the current one.
 */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const current = choiceFor(preference);
  const next = THEME_CHOICES[(THEME_CHOICES.indexOf(current) + 1) % THEME_CHOICES.length];
  const label = `Theme: ${current.label}. Switch to ${next.label}`;
  return (
    <button
      aria-label={label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink-400 text-paper-300 transition-colors hover:border-accent-400/60 hover:text-paper-100',
        FOCUS_RING
      )}
      onClick={() => setPreference(next.value)}
      title={label}
      type="button"
    >
      <Icon name={current.icon} size={14} />
    </button>
  );
}
