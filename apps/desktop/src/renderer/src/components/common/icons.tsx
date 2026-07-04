// Inline SVG icons reused across components. Uniform currentColor stroke, follows theme color / parent element's text color,
// offline with no network dependency. Pass size when a different size is needed (viewBox fixed at 16, just scale).

interface IconProps {
  size?: number;
  /** Some icons need an external class (e.g. ChevronIcon's tree-chevron rotation animation); the rest ignore it. */
  className?: string;
}

/**
 * git pull-request / branch merge glyph: two branches converging + an arrow pointing to the merge point.
 * Used both as the PR list branch row prefix and for the "merge" button / mergeable chip — same semantics, same graphic.
 */
export function PullRequestIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <line x1="4" y1="5.6" x2="4" y2="10.4" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 10.4 V7 a3 3 0 0 0 -3 -3 H6.5" />
      <path d="M8 2 L6 4 L8 6" />
    </svg>
  );
}

/** Close cross: for the modal top-right generic close button, icon needs no i18n. */
export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

/** Triangle warning (exclamation): states needing user attention such as merge conflicts. Used on file tree conflict file rows. */
export function ConflictIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M8 2 L14.5 13.5 H1.5 Z" />
      <line x1="8" y1="6.5" x2="8" y2="9.5" />
      <line x1="8" y1="11.5" x2="8" y2="11.6" />
    </svg>
  );
}

/** Folder: for the choose directory button */
export function FolderIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 4.5 A1 1 0 0 1 2.5 3.5 H6 l1.5 1.5 H13.5 A1 1 0 0 1 14.5 6 V11.5 A1 1 0 0 1 13.5 12.5 H2.5 A1 1 0 0 1 1.5 11.5 Z" />
    </svg>
  );
}

/** Pencil: for the edit button */
export function PencilIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 2.5 13.5 5 5.5 13 2.5 13.5 3 10.5 Z" />
      <line x1="9.5" y1="4" x2="12" y2="6.5" />
    </svg>
  );
}

/** Open eye: for the key/token "shown" state */
export function EyeIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.8 8C3.2 4.9 12.8 4.9 14.2 8 12.8 11.1 3.2 11.1 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

/** Closed eye (with slash): for the key/token "hidden" state */
export function EyeOffIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.8 8C3.2 4.9 12.8 4.9 14.2 8 12.8 11.1 3.2 11.1 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
      <line x1="3" y1="13" x2="13" y2="3" />
    </svg>
  );
}

/** Trash can: for the delete button */
export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <path d="M3.5 4 4 13 A1 1 0 0 0 5 14 H11 A1 1 0 0 0 12 13 L12.5 4" />
      <path d="M6 4 V2.5 A0.5 0.5 0 0 1 6.5 2 H9.5 A0.5 0.5 0 0 1 10 2.5 V4" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="11.5" />
      <line x1="9.5" y1="6.5" x2="9.5" y2="11.5" />
    </svg>
  );
}

/** Paper plane (horizontal, Lucide send-horizontal style): for the send / submit button */
export function SendIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 2 L14 8 L2 14 L5 8 Z" />
      <path d="M5 8 L14 8" />
    </svg>
  );
}

/** Solid rounded square: stop / cancel (media stop-key visual convention). Fill version, no stroke */
export function StopIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

/** `?` inside a circle: prefix for the /ask user question chip (distinguishes it from the answer) */
export function QuestionIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M6 6.2a2 2 0 1 1 2.7 1.9c-.6.2-.7.7-.7 1.2v.4" />
      <line x1="8" y1="12" x2="8" y2="12.2" />
    </svg>
  );
}

/** Loop arrow (refresh-cw style): retry action, small size embedded in chips. Distinct in semantics from SyncIcon (double arrow) */
export function RetryIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 3.5v3.5h-3.5" />
      <path d="M13 7.5A5 5 0 1 0 11.5 11.5" />
    </svg>
  );
}

/** Forward / share arrow (social media "share" solid curved arrow): for the finding card "quote" button. */
export function ShareIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11 8V4l8 7-8 7v-4c-4.5 0-7.5 1.5-9 5 .5-6 3.5-10 9-11z" />
    </svg>
  );
}

/** Puzzle piece (extension / plugin): common metaphor for integration / extension. For the settings "integrations" section navigation. */
export function PuzzleIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V19c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V21H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" />
    </svg>
  );
}

/** Comment: a speech bubble with text lines. For the finding card "edit into comment draft" action (distinct from ChatIcon: contains text lines). */
export function CommentIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11A1 1 0 0 1 14.5 4.5v6A1 1 0 0 1 13.5 11.5H6L3 13.5V11.5H2.5A1 1 0 0 1 1.5 10.5v-6A1 1 0 0 1 2.5 3.5z" />
      <line x1="4.5" y1="6.4" x2="11.5" y2="6.4" />
      <line x1="4.5" y1="8.6" x2="9" y2="8.6" />
    </svg>
  );
}

/** Circular ban (no-entry): circle + slash. For the finding card "reject" action. */
export function BanIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <line x1="3.8" y1="3.8" x2="12.2" y2="12.2" />
    </svg>
  );
}

/** Speech bubble: chat panel trigger / empty state. Pass size for large scenarios (e.g. 28) */
export function ChatIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11A1 1 0 0 1 14.5 4.5v6A1 1 0 0 1 13.5 11.5H6L3 13.5V11.5H2.5A1 1 0 0 1 1.5 10.5v-6A1 1 0 0 1 2.5 3.5z" />
    </svg>
  );
}

/** Image placeholder (frame + mountains + sun): the comment "upload image attachment" button. */
export function ImageIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <circle cx="5.5" cy="6" r="1.1" />
      <path d="M2.25 12 L6 8.25 L8.5 10.75 L10.75 8.5 L13.75 11.5" />
    </svg>
  );
}

/** Smiley + plus: the comment "add emoji reaction" button (viewBox 24 to align with lucide stroke proportions). */
export function SmilePlusIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 11v1a10 10 0 1 1-9-10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
      <path d="M16 5h6" />
      <path d="M19 2v6" />
    </svg>
  );
}

/** File tree (three horizontal lines with bullets): DiffView exit search / tree mode indicator */
export function FileTreeIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="6" y1="8" x2="13" y2="8" />
      <line x1="6" y1="12" x2="13" y2="12" />
      <circle cx="3" cy="8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Magnifying glass: enter search mode */
export function SearchIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="13.5" y2="13.5" />
    </svg>
  );
}

/** Right-pointing chevron: tree node expand / collapse. className for rotation animation (FileTree passes tree-chevron) */
export function ChevronIcon({ size = 10, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="5 3 11 8 5 13" />
    </svg>
  );
}

/** Globe with lat/long grid: open in remote browser */
export function GlobeIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <ellipse cx="8" cy="8" rx="3" ry="6.5" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
}

/** Head-and-shoulders silhouette: author row prefix / blame view / account indicator (unified "person" icon, merging the original PersonIcon, BlameIcon, UserIcon) */
export function PersonIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </svg>
  );
}

/** Whitespace visualization (·→·): show space / tab */
export function WhitespaceIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="0.8" fill="currentColor" />
      <path d="M6 8 h6 m-2 -2 l2 2 l-2 2" />
    </svg>
  );
}

/** Checkmark inside a circle: approved */
export function ApproveIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.3l2.2 2.2L11 6.5" />
    </svg>
  );
}

/** Exclamation inside a circle: needs work */
export function NeedsWorkIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v4.2" />
      <circle cx="8" cy="11.3" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Plain checkmark glyph (no outer ring): for solid colored-background badges, keeping only the inner symbol. */
export function CheckGlyphIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.2 8.4l2.6 2.6L12 5.4" />
    </svg>
  );
}

/** Copy glyph: foreground sheet + top-left backing sheet, standard "copy to clipboard" semantics. */
export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" />
    </svg>
  );
}

/** Plain exclamation glyph (no outer ring): for solid colored-background badges, keeping only the inner symbol. */
export function AlertGlyphIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3.6v5" />
      <circle cx="8" cy="11.6" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** git commit glyph: a solid node on a horizontal line (for activity timeline commit events). */
export function CommitIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="1.5" y1="8" x2="5" y2="8" />
      <line x1="11" y1="8" x2="14.5" y2="8" />
      <circle cx="8" cy="8" r="2.8" />
    </svg>
  );
}

/** Robot head: AutoPilot enabled state. Antenna + head frame + two eyes + ears on both sides. */
export function RobotIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5.5" width="10" height="7.5" rx="1.6" />
      <path d="M8 3.2v2.3" />
      <circle cx="8" cy="2.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="6" cy="9" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="0.85" fill="currentColor" stroke="none" />
      <path d="M1.6 8.5v2" />
      <path d="M14.4 8.5v2" />
    </svg>
  );
}

/** Bell: the settings page "notifications" section icon. Bell body + top button + bottom clapper. */
export function BellIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.2v1.1" />
      <path d="M4 7c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8c0 2.6.6 3.6 1.2 4.3H2.8C3.4 10.6 4 9.6 4 7Z" />
      <path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0" />
    </svg>
  );
}

/** CPU / chip: the settings page "model" section icon (LLM model). Outer frame + core + pins on all four sides. */
export function CpuIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
      <rect x="6.3" y="6.3" width="3.4" height="3.4" rx="0.6" />
      <path d="M6 4V2M10 4V2M6 14v-2M10 14v-2M4 6H2M4 10H2M14 6h-2M14 10h-2" />
    </svg>
  );
}

/** Solid four-pointed star (AI's common sparkle): review suggestion badge (manual / AutoPilot treated alike). The four edges curve inward toward the center,
 *  the four points are centered and symmetric, and the SVG guarantees the glyph is centered and consistent across platforms. */
export function StarIcon({ size = 11 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1 Q9 7 15 8 Q9 9 8 15 Q7 9 1 8 Q7 7 8 1 Z" />
    </svg>
  );
}

/** Robot head + slash: AutoPilot disabled state. */
export function RobotOffIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5.5" width="10" height="7.5" rx="1.6" />
      <path d="M8 3.2v2.3" />
      <circle cx="8" cy="2.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="6" cy="9" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="0.85" fill="currentColor" stroke="none" />
      <path d="M1.6 8.5v2" />
      <path d="M14.4 8.5v2" />
      <path d="M2.3 2.3l11.4 11.4" />
    </svg>
  );
}

/** Double sparkles: AI auto-review action. Two four-pointed stars, distinct from the tool commands' `/` trigger */
export function AutoReviewIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.6 2l1 2.7 2.7 1-2.7 1-1 2.7-1-2.7-2.7-1 2.7-1z" />
      <path d="M4.4 9.1l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
    </svg>
  );
}

/** Bidirectional loop arrows (Lucide refresh-cw-2 style): sync status. Distinct in semantics from RetryIcon (single arrow, retry action) */
export function SyncIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6.5a5 5 0 0 1 9-1.5" />
      <polyline points="12 2 12 5 9 5" />
      <path d="M13 9.5a5 5 0 0 1-9 1.5" />
      <polyline points="4 14 4 11 7 11" />
    </svg>
  );
}

/** Database cylinder (Lucide database, viewBox 24): represents prompt cache hit volume (cache_read) */
export function DatabaseIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

/** Loop arrow (Lucide repeat, viewBox 24): represents model interaction rounds (agentic multi-turn) */
export function RepeatIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

/** Gear (Lucide settings, viewBox 24): settings button */
export function SettingsIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * Panel toggle: rectangle + thin divider bar. `side` decides whether the divider / collapsed-state solid block is on the left (sidebar) or right (chat panel) —
 * the original SidebarIcon and its mirrored ChatPanelIcon merged into one parameterized icon. When collapsed, the divider side becomes solid.
 */
export function PanelToggleIcon({
  side,
  collapsed,
  size = 14,
}: IconProps & { side: 'left' | 'right'; collapsed: boolean }) {
  const dividerX = side === 'left' ? 6.5 : 9.5;
  const fillX = side === 'left' ? 2 : 9.5;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1={dividerX} y1="3" x2={dividerX} y2="13" />
      {collapsed && <rect x={fillX} y="3" width="4.5" height="10" fill="currentColor" />}
    </svg>
  );
}

/**
 * Completion badge: large ring + checkmark. Used by the onboarding completion step. The path carries the `onboarding-check-path` class
 * for the CSS stroke animation (stroke-dashoffset). Defaults to 76px (viewBox 52).
 */
export function SuccessBadgeIcon({ size = 76 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" fill="none" aria-hidden="true">
      <circle cx="26" cy="26" r="24" stroke="currentColor" strokeWidth="3" opacity="0.35" />
      <path
        className="onboarding-check-path"
        d="M15 27l7.5 7.5L38 18.5"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** GitHub Octocat mark (follows text color, for the "about" link's GitHub / Star entry). */
export function GitHubMarkIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.52.1.71-.23.71-.5l-.01-1.77c-2.92.64-3.54-1.25-3.54-1.25-.48-1.22-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.06.07 1.61 1.09 1.61 1.09.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.66-1.4-2.33-.27-4.78-1.17-4.78-5.18 0-1.15.41-2.08 1.08-2.82-.11-.27-.47-1.34.1-2.79 0 0 .88-.28 2.88 1.07a10 10 0 0 1 5.24 0c2-1.35 2.88-1.07 2.88-1.07.57 1.45.21 2.52.1 2.79.67.74 1.08 1.67 1.08 2.82 0 4.02-2.46 4.9-4.8 5.16.38.33.71.97.71 1.96l-.01 2.9c0 .28.19.61.72.5A10.5 10.5 0 0 0 12 1.5z"
      />
    </svg>
  );
}

/** GitHub issue glyph: hollow circle + solid dot. For the "submit feedback / Issue" entry. */
export function IssueIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** History glyph: clock + counterclockwise rewind arrow. For the "closed / history" PR scope toggle. */
export function HistoryIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M2.4 8a5.6 5.6 0 1 1 1.7 4" />
      <polyline points="1.4 9.6 4.1 12 6.4 11" />
      <path d="M8 5.2V8l2 1.4" />
    </svg>
  );
}

/** Tag / release glyph: a tag with a hole. For the "release history" entry. */
export function TagIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.6 2.2H3.2a1 1 0 0 0-1 1v4.4a1 1 0 0 0 .3.7l6 6a1 1 0 0 0 1.4 0l4.1-4.1a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-.4-.3 1 1 0 0 0-.4-.6z" />
      <circle cx="5" cy="5" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}
