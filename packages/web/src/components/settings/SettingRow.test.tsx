// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SettingView } from '@/hooks/useConfigSettings';
import { SettingRow } from './SettingRow';

const setting = {
  canWrite: true,
  defaultValue: 5,
  description: 'How many.',
  group: 'workflow',
  key: 'workflow.maxThings',
  label: 'Max things',
  overridableAt: ['TEAM'],
  redacted: false,
  requiredRole: 'ADMIN',
  restartRequired: false,
  runPinned: false,
  source: 'GLOBAL',
  value: 5,
} as unknown as SettingView;

function row(scopeKey: string, onSave = vi.fn()) {
  return (
    <SettingRow
      canWriteHere
      onClear={() => {}}
      onEdit={() => {}}
      onSave={onSave}
      scope="TEAM"
      scopeKey={scopeKey}
      setting={setting}
    />
  );
}

describe('SettingRow', () => {
  it('shows advisory warnings alongside a successful save', () => {
    render(
      <SettingRow
        canWriteHere
        onClear={() => {}}
        onEdit={() => {}}
        onSave={() => {}}
        scope="TEAM"
        scopeKey="TEAM:a"
        setting={setting}
        status={{ phase: 'saved', warnings: ['No egress proxy'] }}
      />
    );
    expect(screen.getByText('No egress proxy')).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();
  });
  it('drops a dirty draft when the viewed scope changes even though the inherited value is equal', () => {
    const { rerender } = render(row('TEAM:a'));
    const input = screen.getByLabelText('Max things') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9' } });
    expect(input.value).toBe('9');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      false
    );

    rerender(row('TEAM:b'));
    expect((screen.getByLabelText('Max things') as HTMLInputElement).value).toBe('5');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reseeds when only the organization or channel id changes', () => {
    const { rerender } = render(row('ORGANIZATION:a'));
    fireEvent.change(screen.getByLabelText('Max things'), { target: { value: '9' } });
    rerender(row('ORGANIZATION:b'));
    expect((screen.getByLabelText('Max things') as HTMLInputElement).value).toBe('5');
    fireEvent.change(screen.getByLabelText('Max things'), { target: { value: '8' } });
    rerender(row('CHANNEL:b'));
    expect((screen.getByLabelText('Max things') as HTMLInputElement).value).toBe('5');
  });

  it('treats an emptied number as invalid instead of saving 0', () => {
    const onSave = vi.fn();
    render(row('TEAM:a', onSave));
    const input = screen.getByLabelText('Max things') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Enter a number')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByText('Enter a number')).toBeTruthy();
  });

  it('saves on Enter, discards on Escape, and reports its dirty state', () => {
    const onSave = vi.fn();
    const onDirtyChange = vi.fn();
    const { unmount } = render(
      <SettingRow
        canWriteHere
        onClear={() => {}}
        onDirtyChange={onDirtyChange}
        onEdit={() => {}}
        onSave={onSave}
        scope="TEAM"
        scopeKey="TEAM:a"
        setting={setting}
      />
    );
    const input = screen.getByLabelText('Max things') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith('workflow.maxThings', true);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledWith(9);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('5');
    expect(onDirtyChange).toHaveBeenLastCalledWith('workflow.maxThings', false);
    fireEvent.change(input, { target: { value: '7' } });
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith('workflow.maxThings', false);
  });

  it('shows a toggled boolean as unsaved until it is saved', () => {
    render(
      <SettingRow
        canWriteHere
        onClear={() => {}}
        onEdit={() => {}}
        onSave={() => {}}
        scope="GLOBAL"
        scopeKey="GLOBAL"
        setting={
          {
            ...setting,
            defaultValue: false,
            key: 'workflow.flag',
            label: 'Flag',
            value: false,
          } as unknown as SettingView
        }
      />
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch').textContent).toContain('(unsaved)');
    expect(screen.getByText('Unsaved')).toBeTruthy();
  });
});
