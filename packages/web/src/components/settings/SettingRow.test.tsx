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
      busy={false}
      canWriteHere
      onClear={() => {}}
      onSave={onSave}
      scope="TEAM"
      scopeKey={scopeKey}
      setting={setting}
    />
  );
}

describe('SettingRow', () => {
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
});
