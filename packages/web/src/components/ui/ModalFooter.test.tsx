// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModalFooter } from './Modal';

describe('ModalFooter', () => {
  it('submits the enclosing form when it has no onSubmit', () => {
    const onFormSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onFormSubmit}>
        <ModalFooter onCancel={() => {}} submitLabel="Create" />
      </form>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onFormSubmit).toHaveBeenCalledOnce();
  });

  it('is a plain click target with onSubmit, and Cancel never submits', () => {
    const onFormSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <form onSubmit={onFormSubmit}>
        <ModalFooter onCancel={onCancel} onSubmit={onSubmit} submitLabel="Delete" />
      </form>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onFormSubmit).not.toHaveBeenCalled();
  });

  it('renders the primary action as a link with submitHref, and onSubmit runs on click', () => {
    const onSubmit = vi.fn();
    render(
      <ModalFooter
        cancelLabel="Close"
        onCancel={() => {}}
        onSubmit={onSubmit}
        submitHref="/workflows/abc"
        submitLabel="View"
      />
    );
    const link = screen.getByRole('link', { name: 'View' });
    expect(link.getAttribute('href')).toBe('/workflows/abc');
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.click(link);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('disables the action and shows the pending label while pending', () => {
    render(<ModalFooter isPending onCancel={() => {}} submitLabel="Save" />);
    const action = screen.getByRole('button', { name: 'Save…' });
    expect((action as HTMLButtonElement).disabled).toBe(true);
  });
});
