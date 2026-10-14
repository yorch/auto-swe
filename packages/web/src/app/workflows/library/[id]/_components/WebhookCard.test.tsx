// @vitest-environment jsdom

import type { WorkflowTemplateDetail } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { WebhookCard } from './WebhookCard';

const base: WorkflowTemplateDetail = {
  activeVersion: 1,
  activeVersionSpec: null,
  createdAt: '',
  description: '',
  experimentSplit: null,
  experimentVersion: null,
  id: 'tpl-1',
  isDefault: false,
  lastRun: null,
  name: 'deploy hook',
  status: 'ACTIVE',
  team: { id: 't1', name: 'Payments', slug: 'payments' },
  updatedAt: '',
  versionCount: 1,
  versions: [],
  webhookConfigured: true,
  webhookSignatureRequiredByPolicy: false,
  webhookSigning: {
    configured: false,
    lastFour: null,
    previousExpiresAt: null,
    requireSignature: false,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('WebhookCard — signing', () => {
  it('shows an unsigned webhook and generates a secret, shown once', async () => {
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-templates/tpl-1': () => ({ data: base }),
      'POST /api/v1/workflow-templates/tpl-1/webhook/signing-secret/rotate': () => ({
        data: {
          signingSecret: 'whsec_fresh',
          webhookSigning: { ...base.webhookSigning, configured: true },
        },
      }),
    });
    render(withQuery(<WebhookCard canManage template={base} />));

    expect(screen.getByText('Unsigned')).toBeTruthy();
    // Requiring signatures needs a secret first.
    expect(
      (screen.getByRole('switch', { name: 'Require signed calls' }) as HTMLButtonElement).disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Generate signing secret' }));
    expect(await screen.findByText('whsec_fresh')).toBeTruthy();
    expect(screen.getByText('Copy this signing secret now. It is shown only once.')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('toggles require-signature on a signed webhook', async () => {
    const signed: WorkflowTemplateDetail = {
      ...base,
      webhookSigning: { ...base.webhookSigning, configured: true, lastFour: 'abcd' },
    };
    const fetchSpy = setupFetchMock({
      'GET /api/v1/workflow-templates/tpl-1': () => ({ data: signed }),
      'PUT /api/v1/workflow-templates/tpl-1/webhook/require-signature': () => ({
        data: { webhookSigning: { ...signed.webhookSigning, requireSignature: true } },
      }),
    });
    render(withQuery(<WebhookCard canManage template={signed} />));

    expect(screen.getByText(/Secret set/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Require signed calls' }));
    await vi.waitFor(() =>
      expect(bodyOf(fetchSpy, '/webhook/require-signature', 'PUT')).toEqual({ required: true })
    );
  });

  it('cannot remove the secret while signatures are required, and says when policy requires them', () => {
    stubDialogPrototype();
    setupFetchMock({});
    const required: WorkflowTemplateDetail = {
      ...base,
      webhookSignatureRequiredByPolicy: true,
      webhookSigning: { ...base.webhookSigning, configured: true, requireSignature: true },
    };
    render(withQuery(<WebhookCard canManage template={required} />));
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText('required')).toBeTruthy();
  });

  it('warns that policy refuses every call when no secret exists', () => {
    setupFetchMock({});
    render(
      withQuery(
        <WebhookCard
          canManage={false}
          template={{ ...base, webhookSignatureRequiredByPolicy: true }}
        />
      )
    );
    expect(screen.getByText('required by policy')).toBeTruthy();
    expect(screen.getByText(/every call is refused/)).toBeTruthy();
    // Not a manager: no signing controls.
    expect(screen.queryByRole('button', { name: 'Generate signing secret' })).toBeNull();
  });
});
