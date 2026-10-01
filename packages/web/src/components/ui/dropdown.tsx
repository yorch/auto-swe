'use client';

import type { ReactNode } from 'react';
import { FieldError, Label, ListBoxItem, Popover, Text } from 'react-aria-components';
import { cn } from '@/lib/utils';
import { RequiredMark } from './FieldWrapper';

/**
 * Pieces shared by `Select` and `Combobox`, so the two dropdowns cannot drift:
 * the option shape, the field chrome (label / hint / error, styled exactly like
 * `FieldWrapper`), the popover and the option row.
 */

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** Plain text for typeahead and filtering when `label` is not a string. */
  textValue?: string;
  /** A second, muted line under the label. */
  description?: ReactNode;
  disabled?: boolean;
}

// "" is a real option value here ("All", "None", "inherit") and is used as
// the React Aria key unchanged: the hidden native select submits the key, so
// a form must see "" — and `required` must treat it as missing, as a native
// select does. Only `null` (no selection) is absent; never test keys for
// truthiness.
export const toKey = (value: string) => value;
export const fromKey = (key: string | number | null) => (key === null ? null : String(key));

export function optionText(option: DropdownOption): string {
  if (option.textValue !== undefined) {
    return option.textValue;
  }
  return typeof option.label === 'string' ? option.label : option.value;
}

/** The control's box: matches `Input` (h-10, or h-8 mono when compact). */
export function fieldBoxClass(compact: boolean, invalid: boolean) {
  return cn(
    'w-full rounded-[9px] border border-ink-400 bg-ink-900/60 text-paper-100 outline-none transition-colors',
    compact ? 'h-8 px-2 font-mono text-xs' : 'h-10 px-3 text-sm',
    // data-focused: a Select's trigger button; data-focus-within: a Combobox's
    // Group around its input. Each primitive gets the attribute that applies.
    'data-[focused]:border-ember-400 data-[focused]:bg-ink-900/80',
    'data-[focus-within]:border-ember-400 data-[focus-within]:bg-ink-900/80',
    'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
    invalid &&
      'border-brick-400 data-[focused]:border-brick-400 data-[focus-within]:border-brick-400'
  );
}

export function FieldLabel({ label, required }: { label?: string; required?: boolean }) {
  if (!label) {
    return null;
  }
  return (
    <Label className="label-mono mb-1.5 block">
      {label}
      {required && <RequiredMark />}
    </Label>
  );
}

const HELP_LINE = 'mt-1.5 block font-mono text-[10px] uppercase tracking-wider';

/**
 * How a dropdown validates. Without a caller `error` it validates natively, so a
 * `required` empty dropdown blocks its form's submit the way a native select
 * did (and `FieldHelp` shows why). A caller `error` switches to `aria`: shown to
 * the user and to AT, but never a validity flag — otherwise displaying an
 * error would make the form unsubmittable, so the caller could never clear it.
 */
export function validationProps(error: string | undefined) {
  return error
    ? ({ isInvalid: true, validationBehavior: 'aria' } as const)
    : ({ validationBehavior: 'native' } as const);
}

/** Hint and error lines in `FieldWrapper`'s style; React Aria wires their ids. */
export function FieldHelp({ hint, error }: { hint?: string; error?: string }) {
  if (error) {
    return (
      <Text className={cn(HELP_LINE, 'text-brick-400')} slot="errorMessage">
        {error}
      </Text>
    );
  }
  return (
    <>
      {hint && (
        <Text className={cn(HELP_LINE, 'text-paper-500')} slot="description">
          {hint}
        </Text>
      )}
      {/* Native validation's verdict, after a submit attempt. React Aria
          suppresses the browser's own bubble, so without this a required
          dropdown would block submit silently. */}
      <FieldError className={cn(HELP_LINE, 'text-brick-400')}>
        {({ validationDetails }) =>
          validationDetails.valueMissing ? 'Choose an option' : 'Not a valid choice'
        }
      </FieldError>
    </>
  );
}

export function Chevron() {
  return (
    <span aria-hidden className="ml-2 shrink-0 font-mono text-[10px] text-paper-500">
      ▾
    </span>
  );
}

/** The open list's surface. As wide as its trigger, scrolling past ~8 rows. */
export function DropdownPopover({ children }: { children: ReactNode }) {
  return (
    <Popover
      className="max-h-72 w-[var(--trigger-width)] overflow-auto rounded-[9px] border border-ink-400 bg-ink-900 p-1 shadow-xl outline-none data-[entering]:animate-none"
      offset={4}
    >
      {children}
    </Popover>
  );
}

export function DropdownItem({ option, compact }: { option: DropdownOption; compact: boolean }) {
  return (
    <ListBoxItem
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-[7px] px-2.5 py-1.5 text-paper-200 outline-none',
        compact ? 'font-mono text-xs' : 'text-sm',
        'data-[focused]:bg-ink-600 data-[selected]:text-ember-400',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40'
      )}
      id={toKey(option.value)}
      isDisabled={option.disabled}
      textValue={optionText(option)}
    >
      {({ isSelected }) => (
        <>
          <span aria-hidden className="w-3 shrink-0 text-center text-ember-400">
            {isSelected ? '✓' : ''}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{option.label}</span>
            {option.description && (
              <span className="block text-xs text-paper-500">{option.description}</span>
            )}
          </span>
        </>
      )}
    </ListBoxItem>
  );
}
