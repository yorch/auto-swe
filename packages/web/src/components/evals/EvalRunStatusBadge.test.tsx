// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvalRunStatusBadge } from './EvalRunStatusBadge';

describe('EvalRunStatusBadge', () => {
  it('shows a plain verdict as it is', () => {
    render(<EvalRunStatusBadge partial={false} status="SUCCESS" />);
    expect(screen.getByText('Passed')).toBeTruthy();
  });

  it.each(['SUCCESS', 'REGRESSION'])('labels a partial %s as partial', (status) => {
    render(<EvalRunStatusBadge partial status={status} />);
    const label = status === 'SUCCESS' ? 'Passed' : 'Regression';
    expect(screen.getByText(`${label} (partial)`)).toBeTruthy();
  });

  it('does not decorate a status that has no verdict', () => {
    render(<EvalRunStatusBadge partial status="FAILED" />);
    expect(screen.getByText('Did not finish')).toBeTruthy();
  });
});

describe('EvalRunStatusBadge meaning', () => {
  it('explains the verdict in plain words on hover', () => {
    render(<EvalRunStatusBadge status="REGRESSION" />);
    expect(screen.getByText('Regression').closest('span[title]')?.getAttribute('title')).toMatch(
      /significantly worse/
    );
  });
});
