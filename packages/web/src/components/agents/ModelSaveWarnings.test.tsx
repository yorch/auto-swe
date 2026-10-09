// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelSaveWarnings } from './ModelSaveWarnings';

describe('ModelSaveWarnings', () => {
  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<ModelSaveWarnings />);
    expect(container.textContent).toBe('');
    const empty = render(<ModelSaveWarnings catalogWarnings={[]} credentialWarnings={[]} />);
    expect(empty.container.textContent).toBe('');
  });

  it('renders each list under its own label', () => {
    render(
      <ModelSaveWarnings
        catalogWarnings={['Unpriced.', 'Deprecated.']}
        credentialWarnings={['No apiBase.']}
      />
    );
    expect(screen.getByText('Model catalog: Unpriced. Deprecated.')).toBeTruthy();
    expect(screen.getByText('Credentials: No apiBase.')).toBeTruthy();
  });
});
