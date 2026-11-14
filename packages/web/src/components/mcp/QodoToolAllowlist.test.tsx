// @vitest-environment jsdom
import { QODO_READ_TOOLS } from '@auto-swe/shared/lib/qodoConnection';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { allowlistChange, effectiveQodoTools, QodoToolAllowlist } from './QodoToolAllowlist';

describe('effectiveQodoTools', () => {
  it('is the whole read list when nothing is stored', () => {
    expect(effectiveQodoTools(undefined)).toEqual([...QODO_READ_TOOLS]);
  });
  it('narrows a stored list to read tools', () => {
    expect(effectiveQodoTools(['rules-get', 'add-comment'])).toEqual(['rules-get']);
  });
  it('binds nothing for an empty stored list', () => {
    expect(effectiveQodoTools([])).toEqual([]);
  });
});

describe('allowlistChange', () => {
  it('omits an unchanged selection', () => {
    expect(allowlistChange(undefined, [...QODO_READ_TOOLS])).toBeUndefined();
    expect(allowlistChange(['rules-get'], ['rules-get'])).toBeUndefined();
  });
  it('sends a narrowed list in read-list order', () => {
    expect(allowlistChange(undefined, ['rules-list', 'rules-get'])).toEqual([
      'rules-get',
      'rules-list',
    ]);
  });
  it('clears the stored list when every read tool is selected again', () => {
    expect(allowlistChange(['rules-get'], [...QODO_READ_TOOLS])).toBeNull();
  });
});

describe('QodoToolAllowlist', () => {
  it('says the read-only default applies when no list is stored', () => {
    render(
      <QodoToolAllowlist
        idPrefix="t"
        onChange={vi.fn()}
        selected={[...QODO_READ_TOOLS]}
        stored={undefined}
      />
    );
    expect(screen.getByRole('status').textContent).toContain('read-only default applies');
    expect(screen.getByText(/Run Test on the connection/)).toBeTruthy();
  });

  it('unticking a tool reports the narrowed selection', () => {
    const onChange = vi.fn();
    render(
      <QodoToolAllowlist
        idPrefix="t"
        onChange={onChange}
        selected={[...QODO_READ_TOOLS]}
        stored={undefined}
      />
    );
    fireEvent.click(document.getElementById('t-tool-rules-get') as HTMLInputElement);
    expect(onChange).toHaveBeenCalledWith(QODO_READ_TOOLS.filter((n) => n !== 'rules-get'));
  });

  it('marks advertised tools and lists advertised non-read tools as not allowable', () => {
    render(
      <QodoToolAllowlist
        advertised={['rules-get', 'add-comment']}
        idPrefix="t"
        onChange={vi.fn()}
        selected={[...QODO_READ_TOOLS]}
        stored={undefined}
      />
    );
    expect(screen.getByText(/cannot be allowed: add-comment/)).toBeTruthy();
    expect(screen.getAllByText('Advertised').length).toBe(1);
  });

  it('warns about stored names outside the read list and about an empty selection', () => {
    render(
      <QodoToolAllowlist idPrefix="t" onChange={vi.fn()} selected={[]} stored={['add-comment']} />
    );
    expect(screen.getByText(/outside the read list \(add-comment\)/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('nothing would bind');
  });
});
