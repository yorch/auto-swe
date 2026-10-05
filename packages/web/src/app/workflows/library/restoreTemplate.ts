import { ApiError } from '@/lib/api';

/**
 * Restores an archived template. One with no active version can only return to draft. Otherwise
 * it is activated, unless the active version is an unreviewed AI draft: that cannot serve runs,
 * and so is one with lint errors: activating is refused and the template goes back to draft, where
 * it can be reviewed or fixed.
 */
export async function restoreTemplate(
  activeVersion: number | null,
  setStatus: (status: 'ACTIVE' | 'DRAFT') => Promise<unknown>
): Promise<void> {
  if (activeVersion === null) {
    await setStatus('DRAFT');
    return;
  }
  try {
    await setStatus('ACTIVE');
  } catch (err) {
    if (
      !(
        err instanceof ApiError &&
        (err.code === 'REVIEW_REQUIRED' || err.code === 'SPEC_HAS_ERRORS')
      )
    ) {
      throw err;
    }
    await setStatus('DRAFT');
  }
}
