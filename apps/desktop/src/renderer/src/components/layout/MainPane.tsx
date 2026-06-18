import type { ReactNode } from 'react';

/**
 * 主内容区（layout 薄壳）：仅提供语义化 `<main>` 槽位，内容由上层（App）按当前业务决定。
 * 不感知 PR 等具体领域，便于后续扩展非 PR 的主区业务——往这个槽里塞别的面板即可。
 */
export function MainPane({ children }: { children: ReactNode }) {
  return <main className="main">{children}</main>;
}
