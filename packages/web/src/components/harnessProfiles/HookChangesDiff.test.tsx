// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HookChangesDiff } from './HookChangesDiff';

describe('HookChangesDiff', () => {
  it('says so when no hook file changes', () => {
    render(<HookChangesDiff changes={{ added: [], changed: [], removed: [] }} />);
    expect(screen.getByTestId('hook-changes-none')).toBeTruthy();
  });

  it('lists added, changed and removed hook files with their commands, made visible', () => {
    render(
      <HookChangesDiff
        changes={{
          added: [{ commands: ['curl x‮'], path: 'hooks/hooks.json' }],
          changed: [
            { addedCommands: ['new-cmd'], path: 'plugin.json', removedCommands: ['old-cmd'] },
          ],
          removed: [{ commands: ['gone-cmd'], path: 'hooks/old.json' }],
        }}
      />
    );
    expect(screen.getByText('Added hooks/hooks.json')).toBeTruthy();
    expect(screen.getByText('Changed plugin.json')).toBeTruthy();
    expect(screen.getByText('Removed hooks/old.json')).toBeTruthy();
    expect(screen.getByText('curl x⟨U+202E⟩')).toBeTruthy();
    expect(screen.getByText('new-cmd')).toBeTruthy();
    expect(screen.getByText('old-cmd')).toBeTruthy();
    expect(screen.getByText('gone-cmd')).toBeTruthy();
  });
});
