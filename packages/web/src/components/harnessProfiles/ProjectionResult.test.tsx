// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectionResult } from './ProjectionResult';

describe('ProjectionResult', () => {
  it('renders nothing without a projection', () => {
    const { container } = render(<ProjectionResult projection={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists created, updated and refused skills', () => {
    render(
      <ProjectionResult
        projection={{
          created: ['kit:a'],
          failed: false,
          refused: [{ name: 'kit:c', reason: 'hand edited' }],
          updated: ['kit:b'],
        }}
      />
    );
    expect(screen.getByText('kit:a')).toBeTruthy();
    expect(screen.getByText('kit:b')).toBeTruthy();
    expect(screen.getByText('kit:c: hand edited')).toBeTruthy();
  });

  it('says that a failed projection did not undo the approval', () => {
    render(
      <ProjectionResult projection={{ created: [], failed: true, refused: [], updated: [] }} />
    );
    expect(screen.getByText(/The approval stands/)).toBeTruthy();
  });

  it('says there is nothing to project', () => {
    render(
      <ProjectionResult projection={{ created: [], failed: false, refused: [], updated: [] }} />
    );
    expect(screen.getByText(/no skills to project/)).toBeTruthy();
  });
});
