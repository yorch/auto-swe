// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvalRunStatusBadge } from './EvalRunStatusBadge';

describe('EvalRunStatusBadge', () => {
  it('shows a plain verdict as it is', () => {
    render(<EvalRunStatusBadge partial={false} status="SUCCESS" />);
    expect(screen.getByText('SUCCESS')).toBeTruthy();
  });

  it.each(['SUCCESS', 'REGRESSION'])('labels a partial %s as partial', (status) => {
    render(<EvalRunStatusBadge partial status={status} />);
    expect(screen.getByText(`${status} (partial)`)).toBeTruthy();
  });

  it('does not decorate a status that has no verdict', () => {
    render(<EvalRunStatusBadge partial status="FAILED" />);
    expect(screen.getByText('FAILED')).toBeTruthy();
  });
});
