// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamFormModal } from './TeamFormModal';

beforeEach(stubDialogPrototype);
afterEach(() => vi.unstubAllGlobals());

describe('TeamFormModal — create', () => {
  it('auto-derives a slug from the name when the slug field is left blank', async () => {
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/teams': () => ({ data: { id: 't-new' } }),
    });

    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open={true} />));

    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'Payments Platform!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // deriveSlug strips non-kebab chars + collapses dashes + trims
    expect(bodyOf(spy, '/api/v1/teams', 'POST')).toEqual({
      name: 'Payments Platform!',
      slug: 'payments-platform',
    });
  });

  it('uses the explicit slug when provided', async () => {
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/teams': () => ({ data: { id: 't-new' } }),
    });

    render(withQuery(<TeamFormModal mode={{ kind: 'create' }} onClose={onClose} open={true} />));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Anything Goes' } });
    fireEvent.change(screen.getByLabelText(/slug/i), { target: { value: 'custom-slug' } });
    fireEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, '/api/v1/teams', 'POST')).toMatchObject({ slug: 'custom-slug' });
  });
});
