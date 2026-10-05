// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { DiffRenderer } from './DiffRenderer';

beforeEach(() => stubDialogPrototype());

describe('DiffRenderer expand', () => {
  it('opens the full diff in a near-full-viewport dialog', () => {
    render(<DiffRenderer content={'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y\n'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    const dialog = document.querySelector('dialog');
    expect(dialog?.className).toContain('w-[96vw]');
  });
});
