// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvalLessonCorpus, EvalMemoryPins } from './EvalMemory';

describe('eval memory metadata', () => {
  it('shows per-arm modes and pinned hash', () => {
    render(
      <EvalMemoryPins
        run={{ baselineMemoryMode: 'SHADOW', candidateMemoryMode: 'ON', corpusHash: 'abc123' }}
      />
    );
    expect(screen.getByText('Candidate memory: ON')).toBeDefined();
    expect(screen.getByText('Baseline memory: SHADOW')).toBeDefined();
    expect(screen.getByText('Corpus SHA-256: abc123')).toBeDefined();
  });
  it('labels legacy runs and defaults modes to OFF', () => {
    render(<EvalMemoryPins run={{}} />);
    expect(screen.getByText('Candidate memory: OFF')).toBeDefined();
    expect(screen.getByText(/Not pinned/)).toBeDefined();
  });
  it('lists corpus lessons and source with a count', () => {
    render(
      <EvalLessonCorpus
        lessons={[
          {
            content: 'Use transactions',
            failureType: 'TEST',
            id: 'one',
            source: 'IMPORTED',
            tags: [],
          },
        ]}
      />
    );
    expect(screen.getByText('Lesson corpus (1)')).toBeDefined();
    expect(screen.getByText('Use transactions')).toBeDefined();
    expect(screen.getByText('IMPORTED · TEST')).toBeDefined();
  });
  it('shows the empty-corpus limitation', () => {
    render(<EvalLessonCorpus />);
    expect(screen.getByText(/ON and SHADOW require/)).toBeDefined();
  });
});
