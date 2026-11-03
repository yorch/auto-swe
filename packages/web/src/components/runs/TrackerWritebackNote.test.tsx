// @vitest-environment jsdom

import { TICKET_FAILURE_CLASSES } from '@auto-swe/shared/lib/integrations/ticketFailure';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TRACKER_WRITE_LINES, TrackerWritebackNote } from './TrackerWritebackNote';

afterEach(cleanup);

const snapshot = (failure: string, event = 'workflow_failed') => ({
  result: {},
  trackerWriteback: { event, failure },
});

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

  it('keeps the wording for a run that did not finish, and for a record stored without an event', () => {
    const { rerender } = render(<TrackerWritebackNote contextSnapshot={snapshot('forbidden')} />);
    expect(screen.getByText(/saying the run did not finish could not be posted/i)).toBeTruthy();
    rerender(
      <TrackerWritebackNote contextSnapshot={{ trackerWriteback: { failure: 'forbidden' } }} />
    );
    expect(screen.getByText(/saying the run did not finish could not be posted/i)).toBeTruthy();
  });

  it('says a run that finished was not moved on in the ticket, never that a comment failed', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('forbidden', 'workflow_completed')} />);
    expect(screen.getByText(/ticket was not updated/i)).toBeTruthy();
    expect(screen.getByText(/run finished, but the ticket could not be updated/i)).toBeTruthy();
    expect(screen.queryByText(/did not finish/i)).toBeNull();
    expect(screen.queryByText(/could not be posted/i)).toBeNull();
    expect(screen.queryByText(/comment/i)).toBeNull();
  });

  it.each(TICKET_FAILURE_CLASSES)(
    'says nothing about a comment for a finished run, whatever the class (%s)',
    (failure) => {
      render(<TrackerWritebackNote contextSnapshot={snapshot(failure, 'workflow_completed')} />);
      expect(screen.getByText(/run finished, but the ticket could not be updated/i)).toBeTruthy();
      expect(screen.queryByText(/comment/i)).toBeNull();
    }
  );

  it('says an out-of-scope ticket was left alone on purpose', () => {
    render(
      <TrackerWritebackNote contextSnapshot={snapshot('out_of_scope', 'workflow_completed')} />
    );
    expect(screen.getByText(/repository this run does not target/i)).toBeTruthy();
  });

  it('does not hedge about the status for out_of_scope: nothing was written', () => {
    render(
      <TrackerWritebackNote contextSnapshot={snapshot('out_of_scope', 'workflow_completed')} />
    );
    expect(screen.queryByText(/may not have been moved/i)).toBeNull();
  });

  describe.each(['no_repository', 'no_transition'])('the write-only class %s', (failure) => {
    it.each(['workflow_completed', 'workflow_failed'])(
      'states plainly that nothing was written, with no hedge or claim of refusal (%s)',
      (event) => {
        render(<TrackerWritebackNote contextSnapshot={snapshot(failure, event)} />);
        const text = screen.getByRole('note').textContent ?? '';
        expect(text).toMatch(/did not write to it|named like the one the platform looks for/i);
        expect(text).not.toMatch(/refused|may not/i);
      }
    );
  });

  it('words the no_repository note for a finished run and a failed one', () => {
    const { rerender } = render(
      <TrackerWritebackNote contextSnapshot={snapshot('no_repository', 'workflow_completed')} />
    );
    expect(screen.getByText(/could not resolve a repository from the ticket id/i)).toBeTruthy();
    expect(screen.getByText(/run finished, but the ticket could not be updated/i)).toBeTruthy();
    rerender(
      <TrackerWritebackNote contextSnapshot={snapshot('no_repository', 'workflow_failed')} />
    );
    expect(screen.getByText(/saying the run did not finish could not be posted/i)).toBeTruthy();
  });

  it('words the no_transition note for a finished run', () => {
    render(
      <TrackerWritebackNote contextSnapshot={snapshot('no_transition', 'workflow_completed')} />
    );
    const text = screen.getByRole('note').textContent ?? '';
    expect(text).toMatch(/no transition to a status named like the one the platform looks for/i);
    expect(text).toMatch(/project may name its statuses differently/i);
    expect(text).not.toMatch(/workflow has no move/i);
  });

  it('keeps the status hedge for other classes on a finished run', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('forbidden', 'workflow_completed')} />);
    expect(screen.getByText(/may not have been moved/i)).toBeTruthy();
  });

  it('does not claim the tracker refused a finished run is unknown either', () => {
    render(<TrackerWritebackNote contextSnapshot={snapshot('unknown', 'workflow_completed')} />);
    expect(screen.getByText(/reason is not known/i)).toBeTruthy();
    expect(screen.queryByText(/refused/i)).toBeNull();
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

  it('never renders an event that is not one of the two, or text from its own record', () => {
    const { container } = render(
      <TrackerWritebackNote contextSnapshot={snapshot('forbidden', '<b>x</b>')} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('never renders text that is not from its own table', () => {
    const { container } = render(
      <TrackerWritebackNote contextSnapshot={snapshot('<img src=x onerror=alert(1)>')} />
    );
    expect(container.firstChild).toBeNull();
  });
});
