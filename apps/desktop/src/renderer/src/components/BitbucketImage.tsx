import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../api';

/**
 * react-markdown 默认 url sanitize 只允许 http/https/mailto/tel 协议，
 * 非白名单协议 → src 被吞成空。BBS 评论 markdown 用 `attachment:9/16854` 引用
 * 内嵌附件，必须直通让 BitbucketImage 收到原始 src 走 IPC 代理拉
 */
export function transformBitbucketUrl(url: string): string {
  if (url.startsWith('attachment:')) return url;
  // 其他保持 react-markdown 默认安全行为
  return /^(https?:|mailto:|tel:|#|\/)/.test(url) ? url : '';
}

/**
 * 评论 body 内嵌图片：Bitbucket 私有 attachment URL 需要 PAT 鉴权，原生 `<img>`
 * 没法发 Authorization 头取私有资源 → 走 main 端 IPC `comments:fetchAttachment`
 * 代理拉 bytes 转 data URL 显示。
 *
 * **不缓存** (用户决策 — 评论图片重复加载概率低，跟头像走磁盘缓存不同)。每次
 * mount 调一次 IPC。
 *
 * 用工厂 makeBitbucketImageFor(localId) 包出 ReactMarkdown components.img 用的
 * 组件 — 闭包捕获 localId 给 IPC 用
 */
export function makeBitbucketImageFor(localId: string) {
  return function BitbucketImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
    const { src, alt } = props;
    const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);

    useEffect(() => {
      if (!src) {
        setFailed(true);
        return;
      }
      let cancelled = false;
      setFailed(false);
      setResolvedSrc(null);
      void (async () => {
        try {
          // 8s timeout 防 main 端 fetch 卡死 / handler 没注册让 loading 占位永久挂着
          const ipcPromise = invoke('comments:fetchAttachment', { localId, url: src });
          const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 8000),
          );
          const res = await Promise.race([ipcPromise, timeoutPromise]);
          if (cancelled) return;
          if (res?.dataUrl) setResolvedSrc(res.dataUrl);
          else setFailed(true);
        } catch {
          if (!cancelled) setFailed(true);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [src]);

    if (failed && src) {
      // attachment: 协议浏览器无法加载，fail 时显示明确的"加载失败"文本而不是
      // 损坏图标；http/https URL fail 时退回原生 <img> (可能是跨 host 公网图)
      if (src.startsWith('attachment:')) {
        return (
          <span className="bitbucket-image-failed muted" aria-label="图片加载失败">
            🖼️ {alt || '附件'} (加载失败)
          </span>
        );
      }
      return (
        <img
          src={src}
          alt={alt ?? ''}
          className="bitbucket-image bitbucket-image-fallback"
        />
      );
    }
    if (!resolvedSrc) {
      return (
        <span className="bitbucket-image-loading muted" aria-label="加载图片中">
          🖼️ {alt || src}
        </span>
      );
    }
    return (
      <>
        <img
          src={resolvedSrc}
          alt={alt ?? ''}
          className="bitbucket-image"
          onClick={(e) => {
            e.stopPropagation();
            setZoomed(true);
          }}
        />
        {zoomed && (
          <ImageZoomOverlay src={resolvedSrc} alt={alt ?? ''} onClose={() => setZoomed(false)} />
        )}
      </>
    );
  };
}

/**
 * 全屏大图预览：点击 BitbucketImage 缩略图 → portal 渲染到 document.body 的全屏
 * overlay。点击背景 / Esc 关闭。img 自身 stopPropagation 防点 img 关闭
 */
function ImageZoomOverlay({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="bitbucket-image-zoom-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <img
        src={src}
        alt={alt}
        className="bitbucket-image-zoom"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        className="bitbucket-image-zoom-close"
        onClick={onClose}
        aria-label="关闭大图预览 (Esc)"
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
