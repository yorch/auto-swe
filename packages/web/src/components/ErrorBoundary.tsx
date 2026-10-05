'use client';

import React from 'react';
import { ErrorPanel } from '@/components/ErrorPanel';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * When this changes the boundary clears a caught error. The shell passes the
   * pathname, so navigating away from a crashed page renders the next page
   * instead of re-rendering the crash.
   */
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, hasError: true };
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, hasError: false });
    }
  }

  /**
   * Without this, a crash is shown to the user and recorded nowhere — the one
   * failure mode nobody finds out about. There is no client-side error sink in
   * this app yet, so the console is the sink; `componentStack` is the part a
   * stack trace alone does not give you, naming the component that threw.
   */
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] uncaught render error', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorPanel
          error={this.state.error}
          onRetry={() => this.setState({ error: null, hasError: false })}
        />
      );
    }

    return this.props.children;
  }
}
