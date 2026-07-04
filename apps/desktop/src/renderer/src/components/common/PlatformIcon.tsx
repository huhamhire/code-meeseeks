// Code platform brand icons. Follows the inline SVG convention of icons.tsx, but platform logos use their own brand colors
// (rather than currentColor), so the first-launch wizard's platform selection list is instantly distinguishable. viewBox unified at 24.

import type { JSX } from 'react';
import type { PlatformKind } from '@meebox/shared';

interface PlatformIconProps {
  size?: number;
}

/** Bitbucket: blue "bucket" mark (simplified glyph, not an official asset) */
export function BitbucketIcon({ size = 24 }: PlatformIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2.6 3.2a.6.6 0 0 0-.6.7l2.86 17.1a.82.82 0 0 0 .8.68h13.7a.6.6 0 0 0 .6-.5l2.86-17.27a.6.6 0 0 0-.6-.7H2.6zm12.07 11.7H9.36L8.04 8.6h7.78l-1.15 6.3z"
        fill="#2684FF"
      />
      <path
        d="M22.78 8.6h-7l-1.1 6.3H9.36l-4.8 5.7c.15.13.34.2.54.2h13.7a.6.6 0 0 0 .6-.5l3.38-11.7z"
        fill="#0052CC"
      />
    </svg>
  );
}

/**
 * GitHub: Octocat cat-head silhouette (monochrome brand logo). fill switches with the theme — on dark the official inverted-white invertocat,
 * on light the official near-black (see --github-logo in _theme.scss). The SVG fill **attribute** does not resolve var(), so the variable is injected
 * via the CSS fill **property** (style).
 */
export function GitHubIcon({ size = 24 }: PlatformIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        style={{ fill: 'var(--github-logo)' }}
        d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.52.1.71-.23.71-.5l-.01-1.77c-2.92.64-3.54-1.25-3.54-1.25-.48-1.22-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.06.07 1.61 1.09 1.61 1.09.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.66-1.4-2.33-.27-4.78-1.17-4.78-5.18 0-1.15.41-2.08 1.08-2.82-.11-.27-.47-1.34.1-2.79 0 0 .88-.28 2.88 1.07a10 10 0 0 1 5.24 0c2-1.35 2.88-1.07 2.88-1.07.57 1.45.21 2.52.1 2.79.67.74 1.08 1.67 1.08 2.82 0 4.02-2.46 4.9-4.8 5.16.38.33.71.97.71 1.96l-.01 2.9c0 .28.19.61.72.5A10.5 10.5 0 0 0 12 1.5z"
      />
    </svg>
  );
}

/** GitLab: tanuki fox mark (simple-icons path, brand orange #FC6D26 instantly recognizable) */
export function GitLabIcon({ size = 24 }: PlatformIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#FC6D26"
        d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.919 1.263a.455.455 0 0 0-.867 0L1.386 9.452.044 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.625-8.443a.92.92 0 0 0 .33-1.024"
      />
    </svg>
  );
}

// The single source of truth for platform display order: GitHub → Bitbucket → GitLab, new platforms are always appended at the end.
// The settings-page dropdown, usage docs (docs/guide/01-code-platform.md), and all other display orders follow this.
export const PLATFORM_META: ReadonlyArray<{
  kind: PlatformKind;
  label: string;
  /** i18n key (translated with t() on the consumer side; covers the technical subtitle and status text like "coming soon") */
  subKey: string;
  available: boolean;
  Icon: (p: PlatformIconProps) => JSX.Element;
}> = [
  {
    kind: 'github',
    label: 'GitHub',
    subKey: 'platformIcon.githubSub',
    available: true,
    Icon: GitHubIcon,
  },
  {
    kind: 'bitbucket-server',
    label: 'Bitbucket',
    subKey: 'platformIcon.bitbucketSub',
    available: true,
    Icon: BitbucketIcon,
  },
  { kind: 'gitlab', label: 'GitLab', subKey: 'platformIcon.gitlabSub', available: true, Icon: GitLabIcon },
];
