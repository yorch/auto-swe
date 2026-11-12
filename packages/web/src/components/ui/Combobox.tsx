'use client';

import {
  ComboBox as AriaComboBox,
  Button,
  Collection,
  Group,
  Header,
  Input,
  ListBox,
  ListBoxSection,
  useFilter,
} from 'react-aria-components';
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
  optionText,
  toKey,
  validationProps,
  withIds,
} from './dropdown';

export type ComboboxOption = DropdownOption & { searchText?: string };

export interface ComboboxSection {
  id: string;
  label: string;
  options: ComboboxOption[];
}

type CollectionItem = (ComboboxOption & { id: string }) | ComboboxSection;

interface ComboboxProps {
  options?: ComboboxOption[];
  sections?: ComboboxSection[];
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
  /**
   * Accept typed text that matches no option as the value — for a field whose
   * options are suggestions rather than the whole set, such as a model spec the
   * catalog does not list yet. The input text then IS the value, so each
   * option's text must equal its `value`.
   */
  allowsCustomValue?: boolean;
}

/**
 * A searchable single-choice dropdown for long, data-driven lists — users,
 * repositories, templates, teams — where scanning a native list is slow. Typing
 * filters the options by their text (`textValue`, else a string `label`); the
 * value can only ever be one of the options, unless `allowsCustomValue` is set.
 */
export function Combobox({
  options = [],
  sections,
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
  allowsCustomValue = false,
}: ComboboxProps) {
  const allOptions = sections ? sections.flatMap((section) => section.options) : options;
  const { contains } = useFilter({ sensitivity: 'base' });
  const selected = allOptions.some((o) => o.value === value) ? toKey(value) : null;
  const items: CollectionItem[] = sections ?? withIds(options);
  return (
    <AriaComboBox
      allowsCustomValue={allowsCustomValue}
      allowsEmptyCollection
      aria-label={ariaLabel}
      className={cn('block', className)}
      defaultFilter={(text, input) =>
        allOptions.some(
          (option) => optionText(option) === text && contains(option.searchText ?? text, input)
        )
      }
      // Uncontrolled items so React Aria filters them; it re-reads them every
      // render, so options that arrive after mount still appear.
      defaultItems={items}
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
      {...(allowsCustomValue && { inputValue: value, onInputChange: onChange })}
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
          {(item: CollectionItem) =>
            'options' in item ? (
              <ListBoxSection id={item.id}>
                <Header className="px-2.5 pt-3 pb-1 text-xs font-semibold text-paper-400">
                  {item.label}
                </Header>
                <Collection items={withIds(item.options)}>
                  {(option) => <DropdownItem compact={compact} option={option} />}
                </Collection>
              </ListBoxSection>
            ) : (
              <DropdownItem compact={compact} option={item} />
            )
          }
        </ListBox>
      </DropdownPopover>
    </AriaComboBox>
  );
}
