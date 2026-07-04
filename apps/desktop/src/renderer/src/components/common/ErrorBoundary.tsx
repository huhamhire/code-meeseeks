import { Component, type ErrorInfo, type ReactNode } from 'react';

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
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}] caught:`,
      err,
      info.componentStack,
    );
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
