import { useEffect, useState } from 'react';
import { invoke } from '../../api';

interface AvatarProps {
  connectionId: string;
  /** Platform user slug (Bitbucket's user.name is the slug) */
  slug: string;
  /** Fallback for initials; also used as title / alt */
  displayName: string;
  /** Direct avatar link (platform avatar_url); if present, prefer fetching by it — GitHub bots are only reachable via it. */
  avatarUrl?: string;
  size?: number;
}

/**
 * Circular user avatar. Prefers the platform avatar fetched by the main process (returns synchronously on in-memory cache hit),
 * falling back to initials + hash color block on fetch failure / loading / null.
 */
export function Avatar({ connectionId, slug, displayName, avatarUrl, size = 22 }: AvatarProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(() => readCached(connectionId, slug));

  useEffect(() => {
    if (dataUrl !== null) return; // already cached or already loaded by this component
    let cancelled = false;
    fetchAvatar(connectionId, slug, avatarUrl).then((url) => {
      if (!cancelled && url) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
    //   re-fetch only when (connectionId, slug) changes
  }, [connectionId, slug, avatarUrl, dataUrl]);

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

/** "Kyle Wong" → "KW"; Chinese「张三」→「张」; single-word fallback uppercases the first character */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // Contains CJK: take the first CJK character
  const cjk = /[一-鿿]/.exec(trimmed);
  if (cjk) return cjk[0]!;
  const parts = trimmed.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** Name → stable HSL background color (same name always same color, enough contrast for white text) */
function colorFromName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${String(hue)}, 45%, 38%)`;
}

// Module-level cache: dedup across components, avoid one IPC per PrItem for the same author
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(connectionId: string, slug: string): string {
  return `${connectionId}|${slug}`;
}

function readCached(connectionId: string, slug: string): string | null {
  return cache.get(cacheKey(connectionId, slug)) ?? null;
}

async function fetchAvatar(
  connectionId: string,
  slug: string,
  avatarUrl?: string,
): Promise<string | null> {
  const key = cacheKey(connectionId, slug);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = invoke('app:userAvatar', { connectionId, slug, avatarUrl })
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
