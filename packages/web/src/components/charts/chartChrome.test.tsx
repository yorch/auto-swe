// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartFrame, EmptyChart } from './chartChrome';

describe('ChartFrame', () => {
  it('names the drawing and offers the same data as a table', () => {
    render(
      <ChartFrame
        ariaLabel="Daily cost. 3 days."
        table={{ columns: ['Date', 'Cost (USD)'], rows: [['3 Jun', '$1.00']] }}
      >
        <svg />
      </ChartFrame>
    );
    expect(screen.getByRole('img', { name: 'Daily cost. 3 days.' })).toBeTruthy();
    expect(screen.getByText('View as table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Cost (USD)' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '$1.00' })).toBeTruthy();
  });
});

describe('EmptyChart', () => {
  it('is a compact sentence, not a chart-sized void', () => {
    render(<EmptyChart hint="Start work to see trends." label="No runs yet." />);
    expect(screen.getByText('No runs yet.')).toBeTruthy();
    expect(screen.getByText('Start work to see trends.')).toBeTruthy();
  });
});

describe('chart accessibility layer', () => {
  it('turns off Recharts focusable svg on every chart (ChartFrame supplies the label and table)', async () => {
    const { globSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../..');
    const files = globSync('{components,app}/**/*.tsx', { cwd: root }).filter(
      (file) => !file.endsWith('.test.tsx')
    );
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8');
      for (const match of source.matchAll(
        /<(Bar|Line|Area|Pie|Composed|Radar|Scatter)Chart\b[^>]*>/g
      )) {
        if (!match[0].includes('accessibilityLayer={false}')) {
          offenders.push(`${file}: ${match[0].slice(0, 40)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
