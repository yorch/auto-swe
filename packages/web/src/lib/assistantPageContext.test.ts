import { describe, expect, it } from 'vitest';
import { pageContextFor } from './assistantPageContext';

describe('pageContextFor', () => {
  it.each([
    ['/runs/0b1c-2d', { entityId: '0b1c-2d', entityType: 'run', route: '/runs/0b1c-2d' }],
    [
      '/workflows/library/tpl-1/runs',
      { entityId: 'tpl-1', entityType: 'template', route: '/workflows/library/tpl-1/runs' },
    ],
    ['/workflows/wf-9', { entityId: 'wf-9', entityType: 'workflow', route: '/workflows/wf-9' }],
    ['/epics/eng-x-1', { entityId: 'eng-x-1', entityType: 'epic', route: '/epics/eng-x-1' }],
    [
      '/docs/configuration',
      { entityId: 'configuration', entityType: 'doc', route: '/docs/configuration' },
    ],
  ])('names the entity on %s', (path, expected) => {
    expect(pageContextFor(path)).toEqual(expected);
  });

  it.each(['/workflows/library', '/docs/search', '/govern/approvals', '/'])(
    'sends the route alone for %s',
    (path) => {
      expect(pageContextFor(path)).toEqual({ route: path });
    }
  );

  it('drops a query string and an id that is not an id', () => {
    expect(pageContextFor('/runs/abc?tab=trace')).toMatchObject({ entityId: 'abc' });
    expect(pageContextFor('/runs/a%20b')).toEqual({ route: '/runs/a%20b' });
    expect(pageContextFor('/runs/%E0%A4%A')).toEqual({ route: '/runs/%E0%A4%A' });
  });
});
