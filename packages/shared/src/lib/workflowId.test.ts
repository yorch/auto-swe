import { describe, expect, it } from 'vitest';
import { generateWorkflowId } from './workflowId.js';

describe('generateWorkflowId', () => {
  it('keeps the id it always had for a repository on the instance host', () => {
    // No override: nothing already running may change id.
    expect(generateWorkflowId('T-1', 'acme', 'api')).toBe('eng-acme-api-T-1');
    expect(generateWorkflowId('T-1', 'acme', 'api', null)).toBe('eng-acme-api-T-1');
  });

  it('separates the same owner/name on another GitHub host', () => {
    expect(generateWorkflowId('T-1', 'acme', 'api', 'https://ghe.corp')).toBe(
      'eng-ghe.corp-acme-api-T-1'
    );
    expect(generateWorkflowId('T-1', 'acme', 'api', 'https://GHE.corp:8443')).toBe(
      'eng-ghe.corp:8443-acme-api-T-1'
    );
  });
});
