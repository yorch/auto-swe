// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Alert } from './Alert';

afterEach(cleanup);

describe('Alert live-region roles (default announce)', () => {
  it('error is an alert', () => {
    render(<Alert>Could not save</Alert>);
    expect(screen.getByRole('alert').textContent).toBe('Could not save');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each(['success', 'warning', 'info'] as const)('%s is a polite status region', (variant) => {
    render(<Alert variant={variant}>Saved</Alert>);
    expect(screen.getByRole('status').textContent).toBe('Saved');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('explicit announce={true} keeps the live-region roles (alert for error, status otherwise)', () => {
    const { unmount } = render(<Alert announce>Boom</Alert>);
    expect(screen.getByRole('alert')).toBeTruthy();
    unmount();
    render(
      <Alert announce variant="warning">
        Careful
      </Alert>
    );
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('Alert announce={false}', () => {
  it.each(['error', 'success', 'warning', 'info'] as const)(
    '%s carries no live-region role',
    (variant) => {
      render(
        <Alert announce={false} variant={variant}>
          Standing note
        </Alert>
      );
      expect(screen.getByRole('note').textContent).toBe('Standing note');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    }
  );

  it('keeps title, body and action rendered', () => {
    render(
      <Alert
        action={<a href="/docs/x">Read more</a>}
        announce={false}
        title="Heads up"
        variant="warning"
      >
        The body text.
      </Alert>
    );
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Heads up');
    expect(note.textContent).toContain('The body text.');
    expect(screen.getByRole('link', { name: 'Read more' }).getAttribute('href')).toBe('/docs/x');
    expect(note.contains(screen.getByRole('link', { name: 'Read more' }))).toBe(true);
  });

  it('does not render a live region anywhere in the tree', () => {
    render(
      <Alert announce={false} title="Static" variant="warning">
        Body
      </Alert>
    );
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

describe('Alert content and classes', () => {
  it('renders the title as a heading line and the body beneath it', () => {
    render(<Alert title="Scanner findings">Two patterns matched</Alert>);
    expect(screen.getByText('Scanner findings')).toBeTruthy();
    expect(screen.getByText('Two patterns matched')).toBeTruthy();
  });

  it('passes className through to the root element', () => {
    render(
      <Alert announce={false} className="mt-4" variant="info">
        Note
      </Alert>
    );
    expect(screen.getByRole('note').className).toContain('mt-4');
  });

  it('renders the trailing action without a live region of its own', () => {
    render(<Alert action={<button type="button">Retry</button>}>Failed</Alert>);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('alert').contains(screen.getByRole('button'))).toBe(true);
  });
});
