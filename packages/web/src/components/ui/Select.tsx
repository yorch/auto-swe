'use client';

import { Select as AriaSelect, Button, ListBox, SelectValue } from 'react-aria-components';
import { cn } from '@/lib/utils';
import {
  Chevron,
  DropdownItem,
  type DropdownOption,
  DropdownPopover,
  FieldHelp,
  FieldLabel,
  fieldBoxClass,
  fromKey,
  toKey,
  validationProps,
} from './dropdown';

export type SelectOption = DropdownOption;

interface SelectProps {
  options: SelectOption[];
  /** The selected option's value. A value matching no option shows the placeholder. */
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  error?: string;
  /** Dense rails and inline editors: `h-8`, mono `text-xs`. */
  compact?: boolean;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Submits the value with an enclosing `<form>` (React Aria renders a hidden native select). */
  name?: string;
  id?: string;
  /** The accessible name when there is no visible `label`. */
  'aria-label'?: string;
  className?: string;
  /**
   * `field` (default) is a form control. `pill` is an inline toolbar chip — a
   * context switcher such as the TopBar's team picker — and takes no label,
   * hint or error; give it an `aria-label`.
   */
  appearance?: 'field' | 'pill';
  /** Muted text before the value inside a `pill`, e.g. "team:". */
  prefix?: string;
}

const PILL_TRIGGER =
  'inline-flex min-w-0 items-center gap-1.5 rounded-[8px] border border-ink-400 bg-ink-700 px-2.5 py-[5px] text-[12.5px] text-paper-400 outline-none transition-colors data-[hovered]:border-ink-300 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ember-400';

/**
 * A themed single-choice dropdown, the same in every browser (Firefox has no
 * customizable native select). Built on React Aria, which supplies the
 * listbox semantics, keyboard support and typeahead; a hidden native select
 * keeps `name` / `required` working in forms. For a long list a user would
 * rather type into, use `Combobox`.
 */
export function Select({
  options,
  value,
  onChange,
  label,
  hint,
  error,
  compact = false,
  required,
  disabled,
  placeholder = 'Select…',
  name,
  id,
  'aria-label': ariaLabel,
  className,
  appearance = 'field',
  prefix,
}: SelectProps) {
  const pill = appearance === 'pill';
  // The trigger shows the selected option's plain text, not its listbox row
  // (check mark, description line), which does not fit a one-line trigger.
  const renderSelected = ({
    isPlaceholder,
    selectedText,
  }: {
    isPlaceholder: boolean;
    selectedText: string;
  }) => (isPlaceholder ? placeholder : selectedText);
  const selected = options.some((o) => o.value === value) ? toKey(value) : null;
  return (
    <AriaSelect
      aria-label={ariaLabel}
      className={cn(pill ? 'inline-block min-w-0' : 'block', className)}
      id={id}
      isDisabled={disabled}
      isRequired={required}
      name={name}
      onChange={(key) => {
        const next = fromKey(key as string | number | null);
        if (next !== null) {
          onChange(next);
        }
      }}
      placeholder={placeholder}
      value={selected}
      {...validationProps(error)}
    >
      {!pill && <FieldLabel label={label} required={required} />}
      {pill ? (
        <Button className={PILL_TRIGGER}>
          {prefix && <span className="max-sm:hidden">{prefix}</span>}
          <SelectValue className="max-w-[9rem] truncate font-semibold text-ember-400">
            {renderSelected}
          </SelectValue>
          <Chevron />
        </Button>
      ) : (
        <Button
          className={cn(fieldBoxClass(compact, Boolean(error)), 'flex items-center text-left')}
        >
          <SelectValue className="min-w-0 flex-1 truncate data-[placeholder]:text-paper-600">
            {renderSelected}
          </SelectValue>
          <Chevron />
        </Button>
      )}
      {!pill && <FieldHelp error={error} hint={hint} />}
      <DropdownPopover>
        <ListBox className="outline-none" items={options}>
          {(option) => <DropdownItem compact={compact} option={option} />}
        </ListBox>
      </DropdownPopover>
    </AriaSelect>
  );
}
