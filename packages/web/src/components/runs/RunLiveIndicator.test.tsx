// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLiveIndicator } from './RunLiveIndicator';

afterEach(cleanup);

describe('RunLiveIndicator', () => {
  it('says Live while a run is going and polling', () => {
    render(<RunLiveIndicator fullPayloads={false} onResume={() => {}} status="RUNNING" />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says Paused, and offers to resume, once full payloads stop the polling', () => {
    const onResume = vi.fn();
    render(<RunLiveIndicator fullPayloads onResume={onResume} status="RUNNING" />);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText(/not refreshing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume live updates' }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('waits for a payload switch in flight', () => {
    render(<RunLiveIndicator busy fullPayloads onResume={() => {}} status="RUNNING" />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows nothing for a finished run, even with full payloads', () => {
    const { container } = render(
      <RunLiveIndicator fullPayloads onResume={() => {}} status="SUCCESS" />
    );
    expect(container.firstChild).toBeNull();
    const second = render(
      <RunLiveIndicator fullPayloads={false} onResume={() => {}} status="FAILED" />
    );
    expect(second.container.firstChild).toBeNull();
  });
});
