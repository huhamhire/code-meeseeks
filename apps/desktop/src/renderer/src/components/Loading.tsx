import { useEffect, useState } from 'react';

/**
 * 延迟显示的居中 loading：组件挂载后 delayMs 内不出现，超过才显 spinner。
 *
 * 重型组件（Monaco、ChatPane 内容、diff 文件树）在 async init 完成前先渲染空骨架、
 * 各段 ready 时间错开 → 多次布局跳变（可感知抖动）。本组件在 init 期间盖住该区域，
 * ready 后由调用方卸载它即可一次性 reveal。
 *
 * **延迟显示**是关键：桌面端切 PR 多在 150ms 内命中本地缓存，快路径下本组件挂载即
 * 很快被卸载、spinner 从不出现 → 零闪烁；只有真慢的场景（Monaco 冷挂载 / 大 diff）
 * 才落到 spinner。复用既有 `.spinner` 视觉，不引入新语言。
 */
export function PaneLoading({
  delayMs = 150,
  label,
  overlay = false,
}: {
  delayMs?: number;
  label?: string;
  /** 绝对定位铺满父容器（父需 position:relative），用于盖在 Monaco 编辑器之上。 */
  overlay?: boolean;
}) {
  // delayMs<=0：确定要盖（如 Monaco overlay），第 0 帧即显，不走延迟。
  const [show, setShow] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);
  if (!show) return null;
  return (
    <div
      className={overlay ? 'pane-loading pane-loading-overlay' : 'pane-loading'}
      role="status"
      aria-live="polite"
    >
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="muted">{label}</span> : null}
    </div>
  );
}
