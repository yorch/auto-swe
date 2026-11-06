// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
vi.mock('@/hooks/useRepositories', () => ({
  useMovePreviewEnvToSecrets: () => ({
    isError: false,
    isPending: false,
    isSuccess: false,
    mutate,
  }),
}));

import { PreviewEnvToSecrets } from './PreviewEnvToSecrets';

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

describe('PreviewEnvToSecrets', () => {
  it('says nothing when the recipe has no env', () => {
    const { container } = render(
      <PreviewEnvToSecrets envNames={[]} onMoved={vi.fn()} repositoryId="r1" />
    );
    expect(container.textContent).toBe('');
  });

  it('names the plain-text env and hands the moved recipe back', () => {
    const onMoved = vi.fn();
    mutate.mockImplementation((_v, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({ moved: ['API_KEY'], previewConfig: { secrets: ['API_KEY'] } })
    );
    render(<PreviewEnvToSecrets envNames={['API_KEY']} onMoved={onMoved} repositoryId="r1" />);
    expect(screen.getByText(/API_KEY/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move env values to setup secrets' }));
    expect(onMoved).toHaveBeenCalledWith({ secrets: ['API_KEY'] });
  });
});
