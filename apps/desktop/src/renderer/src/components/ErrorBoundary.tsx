import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 可选自定义 fallback；不传走默认灰底提示卡 */
  fallback?: (err: Error, reset: () => void) => ReactNode;
  /** 命名出错区域便于 console 定位 (例: "DiffPane") */
  label?: string;
}

interface ErrorBoundaryState {
  err: Error | null;
}

/**
 * React 渲染期错误屏障。catch 子树 render / effect-mount 阶段抛出的同步错误，
 * 显示 fallback 而不是整页白屏；不 catch 异步 promise rejection / window onerror
 * （那些走 monaco-setup.ts 的全局过滤器）。
 *
 * 仅放在"可隔离"的子树边界（如 DiffPane 区域），避免一个面板挂掉拖死全应用。
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
