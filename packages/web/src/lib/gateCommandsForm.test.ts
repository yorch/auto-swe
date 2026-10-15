import { describe, expect, it } from 'vitest';
import { GATE_COMMANDS_RULE, gateCommandsForm, gateCommandsPatch } from './gateCommandsForm';

describe('gateCommandsForm', () => {
  it('holds one entry per gate, blank where the repository has no override', () => {
    expect(gateCommandsForm({ runTests: 'npm test' })).toEqual({
      runBuild: '',
      runLint: '',
      runPerfBench: '',
      runTests: 'npm test',
      runTypecheck: '',
      runVulnScan: '',
    });
    expect(gateCommandsForm(null).runLint).toBe('');
  });
});

describe('gateCommandsPatch', () => {
  it('sends nothing while the form holds the stored set, blanks aside', () => {
    const form = { ...gateCommandsForm({ runTests: 'npm test' }), runLint: '   ' };
    expect(gateCommandsPatch({ runTests: 'npm test' }, form)).toBeUndefined();
    expect(gateCommandsPatch(null, gateCommandsForm(null))).toBeUndefined();
  });

  it('sends the full set without blank gates when one changes', () => {
    const form = { ...gateCommandsForm({ runTests: 'npm test' }), runLint: 'pnpm lint' };
    expect(gateCommandsPatch({ runTests: 'npm test' }, form)).toEqual({
      runLint: 'pnpm lint',
      runTests: 'npm test',
    });
  });

  it('sends null when every override is cleared', () => {
    expect(gateCommandsPatch({ runTests: 'npm test' }, gateCommandsForm(null))).toBeNull();
  });

  it('says who may change them', () => {
    expect(GATE_COMMANDS_RULE).toMatch(/platform admin/);
    expect(GATE_COMMANDS_RULE).toMatch(/admin of the repository's team/);
  });
});
