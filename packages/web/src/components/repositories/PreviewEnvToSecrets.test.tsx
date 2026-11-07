// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
const hooks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/hooks/useRepositories', () => ({
  useMovePreviewEnvToSecrets: () => ({
    isError: false,
    isPending: false,
    isSuccess: false,
    mutate,
    ...hooks.state,
  }),
}));

import { PreviewEnvToSecrets } from './PreviewEnvToSecrets';

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

describe('PreviewEnvToSecrets', () => {
  it('says nothing when the recipe has no secret-looking env', () => {
    const { container } = render(
      <PreviewEnvToSecrets env={{ PORT: '3000' }} onMoved={vi.fn()} repositoryId="r1" />
    );
    expect(container.textContent).toBe('');
  });

  it('names the secret-looking env, moves only those, and hands the moved recipe back', () => {
    const onMoved = vi.fn();
    mutate.mockImplementation((_v, opts: { onSuccess: (r: unknown) => void }) =>
      opts.onSuccess({ moved: ['API_KEY'], previewConfig: { secrets: ['API_KEY'] } })
    );
    render(
      <PreviewEnvToSecrets
        env={{ API_KEY: 'value-1234567', PORT: '3000' }}
        onMoved={onMoved}
        repositoryId="r1"
      />
    );
    expect(screen.getByText(/API_KEY/)).toBeTruthy();
    expect(screen.queryByText(/PORT/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move env values to setup secrets' }));
    expect(mutate).toHaveBeenCalledWith(['API_KEY'], expect.anything());
    expect(onMoved).toHaveBeenCalledWith({ secrets: ['API_KEY'] });
  });

  it('drops the prompt for values already moved, while the saved env is still stale', () => {
    hooks.state = { data: { moved: ['API_KEY'] }, isSuccess: true };
    render(
      <PreviewEnvToSecrets
        env={{ API_KEY: 'value-1234567', PORT: '3000' }}
        onMoved={vi.fn()}
        repositoryId="r1"
      />
    );
    expect(screen.queryByRole('button', { name: 'Move env values to setup secrets' })).toBeNull();
    expect(screen.getByText('Moved API_KEY.')).toBeTruthy();
    hooks.state = {};
  });
});
