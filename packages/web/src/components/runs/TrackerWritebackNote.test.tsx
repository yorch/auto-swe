// @vitest-environment jsdom

import { TICKET_FAILURE_CLASSES } from '@auto-swe/shared/lib/integrations/ticketFailure';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TRACKER_WRITE_LINES, TrackerWritebackNote } from './TrackerWritebackNote';

afterEach(cleanup);

const snapshot = (failure: string) => ({ result: {}, trackerWriteback: { failure } });

describe('TrackerWritebackNote', () => {
  it('renders nothing when the run recorded no failure', () => {
    const { container } = render(<TrackerWritebackNote contextSnapshot={{ result: {} }} />);
    expect(container.firstChild).toBeNull();
  });

  it('has a line for every failure class, and no line for anything else', () => {
    expect([...TRACKER_WRITE_LINES.keys()].sort()).toEqual([...TICKET_FAILURE_CLASSES].sort());
  });

  it('says the ticket was not updated, and why, for a refused comment', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('forbidden')} />);
    expect(screen.getByText(/ticket was not updated/i)).toBeTruthy();
    expect(screen.getByText(/access was refused/i)).toBeTruthy();
  });

  it('points an administrator at the tracker credentials for a rejected login', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('unauthorized')} />);
    expect(screen.getByText(/credentials/i)).toBeTruthy();
  });

  it('does not claim the tracker refused it, since a failure before the request lands here too', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('unknown')} />);
    expect(screen.getByText(/could not be posted/i)).toBeTruthy();
    expect(screen.queryByText(/refused/i)).toBeNull();
  });

  it('is a static note, not a live announcement', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('forbidden')} />);
    expect(screen.getByRole('note')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('never renders text that is not from its own table', () => {
    const { container } = render(
      <TrackerWritebackNote contextSnapshot={snapshot('<img src=x onerror=alert(1)>')} />
    );
    expect(container.firstChild).toBeNull();
  });
});
