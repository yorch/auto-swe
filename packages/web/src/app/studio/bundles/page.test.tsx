// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BUNDLE_FILE_BYTES, readBundleFile } from '@/lib/bundleFile';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import StudioBundlesPage from './page';

const BUNDLE = {
  entities: {},
  metadata: { contentHash: 'sha256:abc', name: 'pack', version: '1' },
};

const PREVIEW = {
  blockedReason: null,
  contentHash: 'sha256:abc',
  entities: {
    agents: [{ action: 'create', name: 'helper', protected: false }],
    scannerPatterns: [],
    skills: [],
    templates: [],
  },
  installedVersion: null,
  name: 'pack',
  signedBy: 'acme',
  source: null,
  trustState: 'VERIFIED',
  version: '1',
  warnings: [],
};

const fileOf = (content: string, name = 'pack.bundle.json') =>
  new File([content], name, { type: 'application/json' });

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('readBundleFile', () => {
  it('parses a JSON object', async () => {
    expect(await readBundleFile(fileOf(JSON.stringify(BUNDLE)))).toEqual({
      bundle: BUNDLE,
      ok: true,
    });
  });

  it('names a file that is not valid JSON', async () => {
    const r = await readBundleFile(fileOf('{ nope'));
    expect(r).toEqual({ message: 'pack.bundle.json is not valid JSON.', ok: false });
  });

  it('refuses a JSON value that is not an object', async () => {
    expect((await readBundleFile(fileOf('[1]'))).ok).toBe(false);
  });

  it('refuses a file over the size cap without reading it', async () => {
    const big = fileOf('{}');
    Object.defineProperty(big, 'size', { value: MAX_BUNDLE_FILE_BYTES + 1 });
    const r = await readBundleFile(big);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('larger than 5 MB');
  });
});

describe('Install from file', () => {
  const routes = {
    'GET /api/v1/platform/bundles': () => ({ data: [] }),
    'POST /api/v1/platform/bundles/install': () => ({
      data: {
        counts: { agents: 1, scannerPatterns: 0, skills: 0, templates: 0 },
        trustState: 'VERIFIED',
        warnings: [],
      },
    }),
    'POST /api/v1/platform/bundles/preview': () => ({ data: PREVIEW }),
  };

  it('previews the file, then installs it against the previewed hash', async () => {
    const fetchSpy = setupFetchMock(routes);
    render(withQuery(<StudioBundlesPage />));
    fireEvent.change(screen.getByLabelText('Bundle file (.json)'), {
      target: { files: [fileOf(JSON.stringify(BUNDLE))] },
    });
    expect(await screen.findByText('helper')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install bundle' }));
    expect(await screen.findByText(/Installed pack 1: 1 agents/)).toBeTruthy();
    expect(bodyOf(fetchSpy, '/bundles/install')).toEqual({
      bundle: BUNDLE,
      expectedContentHash: 'sha256:abc',
      overwriteProtected: false,
    });
  });

  it('shows a clear error for invalid JSON and sends nothing', async () => {
    const fetchSpy = setupFetchMock(routes);
    render(withQuery(<StudioBundlesPage />));
    fireEvent.change(screen.getByLabelText('Bundle file (.json)'), {
      target: { files: [fileOf('{ nope')] },
    });
    expect(await screen.findByText('pack.bundle.json is not valid JSON.')).toBeTruthy();
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some((c) => String(c[0]).endsWith('/preview'))).toBe(false)
    );
  });

  it('shows a clear error for an oversize file', async () => {
    setupFetchMock(routes);
    render(withQuery(<StudioBundlesPage />));
    const big = fileOf('{}');
    Object.defineProperty(big, 'size', { value: MAX_BUNDLE_FILE_BYTES + 1 });
    fireEvent.change(screen.getByLabelText('Bundle file (.json)'), { target: { files: [big] } });
    expect(await screen.findByText(/larger than 5 MB/)).toBeTruthy();
  });
});
