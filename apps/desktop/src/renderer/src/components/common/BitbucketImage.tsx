import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { invoke } from '../../api';

/**
 * react-markdown's default url sanitize only allows the http/https/mailto/tel protocols;
 * non-whitelisted protocols → src is swallowed to empty. Bitbucket comment markdown references
 * inline attachments with `attachment:9/16854`, which must pass through so BitbucketImage receives the raw src and fetches via the IPC proxy
 */
export function transformBitbucketUrl(url: string): string {
  if (url.startsWith('attachment:')) return url;
  // Others keep react-markdown's default safe behavior
  return /^(https?:|mailto:|tel:|#|\/)/.test(url) ? url : '';
}

/**
 * Inline image in the comment body: Bitbucket private attachment URLs require PAT auth, and a native `<img>`
 * cannot send an Authorization header to fetch private resources → goes through the main-side IPC `comments:fetchAttachment`
 * to proxy-fetch the bytes and convert to a data URL for display.
 *
 * **Not cached** (user decision — comment images have a low chance of repeated loading, unlike avatars which use disk cache). Calls IPC once per
 * mount.
 *
 * Uses the factory makeBitbucketImageFor(localId, prWebUrl) to wrap the component used as ReactMarkdown components.img —
 * the closure captures localId for the IPC; prWebUrl is the PR web address, and on proxy failure the fallback link points to it
 * (rendering comments and images with session in the system browser) rather than to the unreachable asset URL (relative paths would resolve to localhost)
 */
export function makeBitbucketImageFor(localId: string, prWebUrl?: string) {
  return function BitbucketImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
    const { t } = useTranslation();
    const { src, alt } = props;
    const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [nativeError, setNativeError] = useState(false);
    const [zoomed, setZoomed] = useState(false);

    useEffect(() => {
      if (!src) {
        setFailed(true);
        return;
      }
      let cancelled = false;
      setFailed(false);
      setNativeError(false);
      setResolvedSrc(null);
      void (async () => {
        try {
          // 8s timeout to prevent the main-side fetch from hanging / an unregistered handler keeping the loading placeholder up forever
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
      // The attachment: protocol cannot be loaded by the browser; on fail show explicit "load failed" text instead of
      // a broken icon; on http/https URL fail, fall back to native <img> (may be a cross-host public image)
      if (src.startsWith('attachment:')) {
        return (
          <span className="bitbucket-image-failed muted" aria-label={t('bitbucketImage.loadFailedAria')}>
            🖼️ {t('bitbucketImage.attachmentFailed', { name: alt || t('bitbucketImage.attachment') })}
          </span>
        );
      }
      // Proxy fetch fails (e.g. GitLab <17.4 private uploads only recognize the browser session, PAT cannot proxy): first try native browser
      // loading (public images can succeed); if native also fails, degrade to a link — pointing to the PR web page (viewing
      // comments and images with session in the system browser), avoiding a broken icon and avoiding relative /uploads paths being resolved to localhost.
      if (nativeError) {
        const fallbackHref = prWebUrl ?? (/^https?:\/\//.test(src) ? src : null);
        if (fallbackHref) {
          return (
            <a
              href={fallbackHref}
              target="_blank"
              rel="noreferrer"
              className="bitbucket-image-failed muted"
              aria-label={t('bitbucketImage.loadFailedAria')}
            >
              🖼️ {alt || t('bitbucketImage.attachment')} · {t('bitbucketImage.openInBrowser')}
            </a>
          );
        }
        return (
          <span className="bitbucket-image-failed muted" aria-label={t('bitbucketImage.loadFailedAria')}>
            🖼️ {t('bitbucketImage.attachmentFailed', { name: alt || t('bitbucketImage.attachment') })}
          </span>
        );
      }
      return (
        <img
          src={src}
          alt={alt ?? ''}
          className="bitbucket-image bitbucket-image-fallback"
          onError={() => setNativeError(true)}
        />
      );
    }
    if (!resolvedSrc) {
      return (
        <span className="bitbucket-image-loading muted" aria-label={t('bitbucketImage.loadingAria')}>
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
 * Full-screen large image preview: clicking a BitbucketImage thumbnail → portal renders a full-screen
 * overlay into document.body. Click the background / Esc to close. The img itself stopPropagation to prevent closing on img click
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
  const { t } = useTranslation();
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
        aria-label={t('bitbucketImage.closeZoomAria')}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
