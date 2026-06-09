import { useEffect, useId, useState } from 'react';

/**
 * Mermaid 渲染：把 ```mermaid 代码块渲染成 SVG 图（Qodo `/describe` 常生成架构图）。
 *
 * - **懒加载**：mermaid 体积大（含 d3 等），仅当真正出现 mermaid 块、组件挂载时才
 *   `import('mermaid')`，不进入口包、不增加启动成本（与 Monaco 懒加载同思路）。
 * - **securityLevel: 'strict'**：内容来自 AI / 远端 PR 描述，strict 下 mermaid 转义
 *   标签文本、禁用点击脚本，产出的 SVG 可安全注入。
 * - **失败回退**：语法错 / 渲染异常时回退展示原始代码块，图画错也能看源码。
 * - 主题 `dark`，与应用深色界面一致。
 */

// 仅声明本组件用到的最小接口，避免 import() 类型注解（且与 mermaid 内部类型解耦）。
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidLoader: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  // 失败时重置缓存：否则 rejected promise 被永久缓存，后续调用永远拿到同一个失败结果、
  // 无法重试（典型「缓存 Promise」陷阱）。
  mermaidLoader ??= import('mermaid')
    .then((m) => {
      const mermaid = m.default as unknown as MermaidApi;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      return mermaid;
    })
    .catch((e: unknown) => {
      mermaidLoader = null;
      throw e;
    });
  return mermaidLoader;
}

export function MermaidDiagram({ source }: { source: string }) {
  // mermaid.render 需要唯一 id（内部建临时 DOM 节点）；useId 保证每个实例稳定唯一，
  // 去掉 `:`（mermaid 用作 DOM id / CSS 选择器，冒号非法）
  const renderId = `mmd-${useId().replace(/:/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const out = await mermaid.render(renderId, source);
        if (!cancelled) setSvg(out.svg);
      } catch (e) {
        // 记一次日志便于排查（语法错 / 加载失败）；UI 回退到原始代码块
        console.error('[mermaid] render failed', e);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, renderId]);

  if (failed) {
    // 回退：保留原始 mermaid 源码，至少可读
    return (
      <pre className="mermaid-fallback">
        <code>{source}</code>
      </pre>
    );
  }
  if (svg === null) {
    return <div className="mermaid-loading muted">渲染图表…</div>;
  }
  // mermaid strict 模式产出的 SVG 已转义不可信内容，可安全注入
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
