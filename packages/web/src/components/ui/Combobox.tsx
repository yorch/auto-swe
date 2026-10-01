'use client';

import { ComboBox as AriaComboBox, Button, Group, Input, ListBox } from 'react-aria-components';
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

export type ComboboxOption = DropdownOption;

interface ComboboxProps {
  options: ComboboxOption[];
  /** The selected option's value; '' (or any value matching no option) means none. */
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  error?: string;
  compact?: boolean;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Shown in the open list when the typed text matches nothing. */
  emptyMessage?: string;
  name?: string;
  id?: string;
  'aria-label'?: string;
  className?: string;
}

/**
 * A searchable single-choice dropdown for long, data-driven lists — users,
 * repositories, templates, teams — where scanning a native list is slow. Typing
 * filters the options by their text (`textValue`, else a string `label`); the
 * value can only ever be one of the options.
 */
export function Combobox({
  options,
  value,
  onChange,
  label,
  hint,
  error,
  compact = false,
  required,
  disabled,
  placeholder = 'Search…',
  emptyMessage = 'No matches',
  name,
  id,
  'aria-label': ariaLabel,
  className,
}: ComboboxProps) {
  const selected = options.some((o) => o.value === value) ? toKey(value) : null;
  return (
    <AriaComboBox
      allowsEmptyCollection
      aria-label={ariaLabel}
      className={cn('block', className)}
      // Uncontrolled items so React Aria filters them; it re-reads them every
      // render, so options that arrive after mount still appear.
      defaultItems={options}
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
      value={selected}
      {...validationProps(error)}
    >
      <FieldLabel label={label} required={required} />
      {/* A Group, not a div: it carries data-focus-within / -disabled / -invalid,
          so the box shows focus and state like the Select trigger does. */}
      <Group className={cn(fieldBoxClass(compact, Boolean(error)), 'flex items-center pr-1')}>
        <Input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-paper-600"
          placeholder={placeholder}
        />
        <Button aria-label="Show options" className="px-1">
          <Chevron />
        </Button>
      </Group>
      <FieldHelp error={error} hint={hint} />
      <DropdownPopover>
        <ListBox
          className="outline-none"
          renderEmptyState={() => (
            <p className="px-2.5 py-1.5 text-sm text-paper-500">{emptyMessage}</p>
          )}
        >
          {(option: ComboboxOption) => <DropdownItem compact={compact} option={option} />}
        </ListBox>
      </DropdownPopover>
    </AriaComboBox>
  );
}
