import { useEffect, useState } from 'react';
import { invoke } from '../api';

interface AvatarProps {
  connectionId: string;
  /** 平台用户 slug（Bitbucket 的 user.name 即 slug） */
  slug: string;
  /** 给 initials 兜底用；也用作 title / alt */
  displayName: string;
  size?: number;
}

/**
 * 圆形用户头像。优先用 main 进程拉的 Bitbucket avatar（in-memory cache 命中即同步返回），
 * 拉失败 / 加载中 / null 时回退到 initials + hash 色块。
 */
export function Avatar({ connectionId, slug, displayName, size = 22 }: AvatarProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => readCached(connectionId, slug));

  useEffect(() => {
    if (dataUrl !== null) return; // 已有缓存或本组件已加载
    let cancelled = false;
    fetchAvatar(connectionId, slug).then((url) => {
      if (!cancelled && url) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
    //   仅在 (connectionId, slug) 变化时重拉
  }, [connectionId, slug, dataUrl]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (dataUrl) {
    return (
      <img
        className="avatar avatar-img"
        src={dataUrl}
        alt={displayName}
        title={displayName}
        style={style}
        draggable={false}
      />
    );
  }
  const initials = initialsOf(displayName);
  const bg = colorFromName(displayName);
  return (
    <span
      className="avatar avatar-initials"
      title={displayName}
      style={{ ...style, background: bg }}
      aria-label={displayName}
    >
      {initials}
    </span>
  );
}

/** "Kyle Wong" → "KW"；中文「张三」→「张」；单字 fallback 首字符大写 */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // 含 CJK：取第一个 CJK 字符
  const cjk = /[一-鿿]/.exec(trimmed);
  if (cjk) return cjk[0]!;
  const parts = trimmed.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** 名字 → 稳定的 HSL 背景色（同名永远同色，对比度足够白字） */
function colorFromName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${String(hue)}, 45%, 38%)`;
}

// 模块级缓存：跨组件去重，避免同一作者每个 PrItem 各发一次 IPC
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(connectionId: string, slug: string): string {
  return `${connectionId}|${slug}`;
}

function readCached(connectionId: string, slug: string): string | null {
  return cache.get(cacheKey(connectionId, slug)) ?? null;
}

async function fetchAvatar(connectionId: string, slug: string): Promise<string | null> {
  const key = cacheKey(connectionId, slug);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = invoke('app:userAvatar', { connectionId, slug })
    .then((r) => {
      const url = r?.dataUrl ?? null;
      cache.set(key, url);
      inflight.delete(key);
      return url;
    })
    .catch(() => {
      cache.set(key, null);
      inflight.delete(key);
      return null;
    });
  inflight.set(key, promise);
  return promise;
}
