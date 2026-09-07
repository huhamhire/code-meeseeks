import { Component, type ErrorInfo, type ReactNode } from 'react';
import { invoke } from '../../api';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback; if omitted, uses the default gray-background notice card */
  fallback?: (err: Error, reset: () => void) => ReactNode;
  /** Name the failing region for easier console locating (e.g. "DiffPane") */
  label?: string;
}

interface ErrorBoundaryState {
  err: Error | null;
}

/**
 * React render-phase error boundary. Catches synchronous errors thrown during the subtree's render / effect-mount phase,
 * showing a fallback instead of a whole-page white screen; does not catch async promise rejection / window onerror
 * (those go through monaco-setup.ts's global filter).
 *
 * Only placed at "isolatable" subtree boundaries (e.g. the DiffPane region), to avoid one panel crashing dragging down the whole app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { err: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { err };
  }

  override componentDidCatch(err: Error, info: ErrorInfo): void {
    const label = this.props.label ? `:${this.props.label}` : '';
    console.error(`[ErrorBoundary${label}] caught:`, err, info.componentStack);
    // Also relay to main so the crash lands in meebox.log: the renderer console is not written to file, and a render
    // error is not an uncaught window error either, so without this a caught crash leaves no trace on disk — which is
    // exactly what makes such a report impossible to diagnose after the fact.
    void invoke('log:write', {
      level: 'error',
      msg: `renderer render error${label}: ${err.message}`,
      meta: { stack: err.stack, componentStack: info.componentStack ?? undefined },
    }).catch(() => {
      /* the log relay must never be the thing that breaks the fallback UI */
    });
  }

  reset = (): void => {
    this.setState({ err: null });
  };

  override render(): ReactNode {
    if (this.state.err) {
      if (this.props.fallback) return this.props.fallback(this.state.err, this.reset);
      return (
        <div className="error-boundary-fallback">
          <p className="error-boundary-title">
            {this.props.label ? `${this.props.label} ` : ''}渲染异常
          </p>
          <pre className="error-boundary-msg">{this.state.err.message}</pre>
          <button type="button" className="btn btn-sm" onClick={this.reset}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
