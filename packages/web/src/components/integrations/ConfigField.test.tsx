// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfigField } from './ConfigField';

/**
 * The 31 migrated call sites guarded their `current:` echo in four different
 * ways — truthiness, `!== undefined`, `!== null && !== undefined`, and a
 * length check. They all funnel through one prop now, so the guard has to
 * treat `0` and `false` as values while still hiding an unset field.
 */
describe('ConfigField', () => {
  function renderWith(current: React.ReactNode) {
    const { unmount } = render(
      <ConfigField current={current} id="f" label="Field">
        <input id="f" readOnly value="" />
      </ConfigField>
    );
    const shown = screen.queryByText(/^current:/) !== null;
    unmount();
    return shown;
  }

  it('hides the echo for an unset field', () => {
    expect(renderWith(undefined)).toBe(false);
    expect(renderWith(null)).toBe(false);
    expect(renderWith('')).toBe(false);
    expect(renderWith(false)).toBe(false);
  });

  it('shows the echo for a falsy-but-real value', () => {
    expect(renderWith(0)).toBe(true);
    expect(renderWith('no')).toBe(true);
  });

  it('ties the label to the control it wraps', () => {
    render(
      <ConfigField id="s3-bucket" label="Bucket">
        <input id="s3-bucket" readOnly value="my-bucket" />
      </ConfigField>
    );

    expect((screen.getByLabelText('Bucket') as HTMLInputElement).value).toBe('my-bucket');
  });

  it('badges an env-sourced field and leaves a db-sourced one unbadged', () => {
    const { unmount } = render(
      <ConfigField id="f" label="Field" source="env">
        <input id="f" readOnly value="" />
      </ConfigField>
    );
    expect(screen.getByText('env')).toBeTruthy();
    unmount();

    render(
      <ConfigField id="f" label="Field" source="db">
        <input id="f" readOnly value="" />
      </ConfigField>
    );
    expect(screen.queryByText('env')).toBeNull();
  });

  it('renders a note aside instead of an echo', () => {
    render(
      <ConfigField id="f" label="Field" note="(optional)">
        <input id="f" readOnly value="" />
      </ConfigField>
    );

    expect(screen.getByText('(optional)')).toBeTruthy();
    expect(screen.queryByText(/^current:/)).toBeNull();
  });
});
