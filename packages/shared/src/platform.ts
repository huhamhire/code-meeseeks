// The order is the platform display standard everywhere: GitHub → Bitbucket → GitLab, new platforms appended at the end (see PlatformIcon.PLATFORM_META).
export type PlatformKind = 'github' | 'bitbucket-server' | 'gitlab';

/**
 * The git ref refspec for each platform's "PR head" (fetch into the local mirror, pinning the PR source sha). After the source branch is deleted / force-pushed,
 * `refs/heads/*` no longer shows the head sha, but the platform keeps a PR-specific ref — fetching by it is what lets `git diff base...head`
 * not report "Invalid symmetric difference".
 *
 * **Must fetch precisely by PR number**: GitHub's pull refs / GitLab's merge-requests refs are not in the ref advertisement by default,
 * so a wildcard fetch can't match them (Bitbucket's pull-requests refs are advertised and reachable by wildcard; the two differ); the platform only returns them when fetched
 * by exact number. remoteId not being pure digits (abnormal) → return null (do not construct a suspicious ref).
 */
export function pullRequestHeadRefspec(platform: PlatformKind, remoteId: string): string | null {
  const n = remoteId.trim();
  if (!/^\d+$/.test(n)) return null;
  switch (platform) {
    case 'github':
      return `+refs/pull/${n}/head:refs/pull/${n}/head`;
    case 'gitlab':
      return `+refs/merge-requests/${n}/head:refs/merge-requests/${n}/head`;
    case 'bitbucket-server':
      return `+refs/pull-requests/${n}/from:refs/pull-requests/${n}/from`;
  }
}

/**
 * Parse `{ group, repo, remoteId }` from a PR / MR web link (used for "open the current platform's PR by URL").
 * Judged only by the **path shape** (ignoring host / query / hash / trailing segments like `/files`, `/commits`), for compatibility with self-hosted instances,
 * enterprise editions, and deployments with a context path; return null when the corresponding platform's PR shape can't be parsed (the caller reports "not a PR link for this platform" accordingly).
 *
 * Path shapes per platform:
 * - GitHub: `/{owner}/{repo}/pull/{n}`
 * - Bitbucket Server: `/projects/{KEY}/repos/{slug}/pull-requests/{n}`, personal repo `/users/{user}/repos/{slug}/pull-requests/{n}` (group=`~user`)
 * - GitLab: `/{namespace…}/{project}/-/merge_requests/{n}` (namespace may be multi-level)
 */
export function parsePullRequestUrl(
  platform: PlatformKind,
  url: string,
): { group: string; repo: string; remoteId: string } | null {
  let path: string;
  try {
    path = new URL(url.trim()).pathname;
  } catch {
    return null;
  }
  switch (platform) {
    case 'github': {
      const m = path.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      return m ? { group: m[1]!, repo: m[2]!, remoteId: m[3]! } : null;
    }
    case 'bitbucket-server': {
      const proj = path.match(/\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/);
      if (proj) return { group: proj[1]!, repo: proj[2]!, remoteId: proj[3]! };
      const user = path.match(/\/users\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/);
      return user ? { group: `~${user[1]!}`, repo: user[2]!, remoteId: user[3]! } : null;
    }
    case 'gitlab': {
      const marker = '/-/merge_requests/';
      const idx = path.indexOf(marker);
      if (idx < 0) return null;
      const idMatch = path.slice(idx + marker.length).match(/^(\d+)/);
      const left = path.slice(0, idx).replace(/^\/+|\/+$/g, '');
      if (!idMatch || !left) return null;
      const segs = left.split('/');
      const repo = segs.pop()!;
      if (segs.length === 0 || !repo) return null;
      return { group: segs.join('/'), repo, remoteId: idMatch[1]! };
    }
  }
}

export interface RepoRef {
  /** Bitbucket: project key; GitHub: org/user; GitLab: namespace */
  projectKey: string;
  repoSlug: string;
}

export interface PlatformUser {
  /** Backend ID (for API/matching) */
  name: string;
  /** Human-facing display name */
  displayName: string;
  /**
   * URL-friendly slug, platform-specific. In Bitbucket, user.slug may differ in case from user.name;
   * endpoints that use URL paths such as avatar must use slug; when missing, the caller falls back to name.
   */
  slug?: string;
  /**
   * Direct avatar link (the avatar_url returned by the platform). If present, prefer fetching the avatar by this URL — GitHub bots
   * (login shaped like `foo[bot]`) have no `github.com/<login>.png`, so avatar_url is required to fetch it.
   */
  avatarUrl?: string;
}

/** The reviewer's current verdict on the PR. Bitbucket: APPROVED / NEEDS_WORK / UNAPPROVED */
export type ReviewerStatus = 'approved' | 'needsWork' | 'unapproved';

export interface Reviewer extends PlatformUser {
  status: ReviewerStatus;
}

/**
 * A reason that blocks merging (a merge check veto item). Cross-platform neutral shape:
 * - Bitbucket: `/merge` endpoint vetoes[], summary=summaryMessage, detail=detailedMessage
 * - GitHub: unmet required status / required reviews items
 * - GitLab: the specific blocking reason from detailed_merge_status
 */
export interface MergeVeto {
  /**
   * Stable veto reason code (neutral, not localized). GitHub / GitLab etc. normalize derived reasons to `@meebox/platform-core`'s
   * `MergeVetoCode`, and the frontend does i18n by code (`mergeVeto.<code>`). The backend does not assemble user-facing Chinese/localized text.
   * When the server directly provides human-readable text (such as Bitbucket), code may be omitted in favor of `summary`.
   */
  code?: string;
  /** Human-readable reason provided directly by the server (such as Bitbucket summaryMessage); used for display when there is no `code`. */
  summary?: string;
  /** Detailed reason, shown on hover / expand, may be absent (Bitbucket detailedMessage) */
  detail?: string;
}

/**
 * The remote's "mergeable status" verdict on the PR. Conflict is converged here into one dimension; PR.hasConflict
 * is just a derived mirror of `conflicted` (kept for compatibility with the existing conflict badge).
 *
 * Bitbucket gets it all in one `/merge` request: canMerge / conflicted / vetoes share the same source, no extra cost.
 */
export interface MergeStatus {
  /** Whether the remote judges it currently directly mergeable (Bitbucket canMerge). When false, vetoes give the itemized reasons */
  canMerge: boolean;
  /** Whether a merge conflict exists (Bitbucket conflicted / outcome=CONFLICTED*) */
  conflicted: boolean;
  /**
   * The itemized reasons blocking merge (Bitbucket vetoes). Usually empty when canMerge=true.
   * E.g.: required reviewers not all approved, failing builds, branch protection rules, etc.
   */
  vetoes: MergeVeto[];
}

export interface PullRequest {
  remoteId: string;
  title: string;
  description: string;
  author: PlatformUser;
  state: 'open' | 'merged' | 'declined';
  draft: boolean;
  sourceRef: { displayId: string; sha: string };
  targetRef: { displayId: string; sha: string };
  repo: RepoRef;
  url: string;
  /** ISO timestamps */
  createdAt: string;
  updatedAt: string;
  reviewers: Reviewer[];
  /**
   * Remote mergeable status: whether it can merge + itemized blocking reasons (including conflict).
   * Bitbucket uses the `/merge` endpoint; canMerge / conflicted / vetoes share the same source, fetched all at once.
   */
  mergeStatus: MergeStatus;
  /**
   * Whether a merge conflict exists on the remote. **Derived mirror** = `mergeStatus.conflicted`;
   * the standalone field is kept for compatibility with the existing conflict badge (PrItem) reading it directly; new code should prefer reading
   * `mergeStatus`. The adapter must keep the two consistent when writing.
   */
  hasConflict: boolean;
  /**
   * Total remote comment count (with / without replies depending on platform, see {@link PlatformCapabilities.commentCountIncludesReplies}).
   * Returned for free with the PR discovery list (no extra request): Bitbucket = `properties.commentCount` (top-level only),
   * GitHub = `comments + review_comments` (includes inline replies), GitLab = `user_notes_count` (includes replies).
   * poller uses this (together with `updatedAt`) to judge whether a PR may have new comments → deciding whether to fetch comments to scan unread / notify.
   * Omitted when the platform doesn't provide it (poller falls back to judging by `updatedAt` alone).
   */
  commentCount?: number;
}

export interface PingResult {
  ok: boolean;
  serverVersion?: string;
  user?: PlatformUser;
  /** Human-readable reason given when ok=false (shown on the settings page) */
  reason?: string;
}

export interface PrCommentAnchor {
  /** Current path (for a renamed file, the dst side) */
  path: string;
  /** Anchor line number */
  line: number;
  /** 'old' = anchor to base / FROM; 'new' = anchor to head / TO */
  side: 'old' | 'new';
  /** The diff role of the anchored line */
  lineType: 'added' | 'removed' | 'context';
}

/**
 * A single commit on the PR. Cross-platform neutral shape; Bitbucket / GitHub / GitLab all map to this one.
 *
 * `parents` length tells whether it's a merge commit (>1 = merge). `url` is for UI navigation.
 */
export interface PrCommit {
  /** Full 40-char SHA-1 */
  sha: string;
  /** Short SHA (Bitbucket displayId / GitHub sha[:7]), shown by default in UI */
  abbreviatedSha: string;
  /** Full commit message (including body). UI shows the first line as the subject, hover/expand for the body */
  message: string;
  author: PlatformUser;
  /** ISO; author = the person who wrote the code */
  authoredAt: string;
  /** Usually = author but changes in rebase / amend etc. scenarios; optional */
  committer?: PlatformUser;
  /** ISO; committer = the person who actually committed it */
  committedAt: string;
  /** Parent commit SHA list; length >1 means a merge commit */
  parents: string[];
  /** Platform-side commit detail page URL, optional */
  url?: string;
}

/**
 * The aggregation of one emoji reaction on a comment (cross-platform neutral). Native reaction identifiers vary by platform (GitHub's fixed 8
 * content values, GitLab award_emoji names, Bitbucket emoticon shortnames), all normalized to a **Unicode emoji
 * character** as the key — UI renders it directly, consistent across platforms. The native name ↔ emoji mapping is held privately by each platform adapter
 * (it knows its own API best); shared only recognizes the emoji character + {@link REACTION_PICKER} candidate set.
 */
export interface PrReaction {
  /** Normalized Unicode emoji character (such as `👍`). */
  emoji: string;
  /** Total reaction count for this emoji. */
  count: number;
  /** Whether the current PAT user has already reacted with this emoji (determines UI highlight + click toggle direction). */
  mine: boolean;
}

/**
 * The 8 reaction emojis GitHub fixedly supports (display order is this order). GitHub Reactions API has only these 8, so the `fixed`
 * mode's picker uses it. Each adapter is responsible for translating the character into its own native name.
 */
export const REACTION_PICKER = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'] as const;

/** A reaction picker item: emoji character + platform native shortcode (gemoji-style name, shared by GitLab award name / Bitbucket
 *  emoticon shortname) + search keywords (lowercase English, space-separated). */
export interface ReactionEmoji {
  emoji: string;
  /** gemoji-style shortcode (no colons); in free mode the adapter maps char→native name by it. */
  code: string;
  /** Search keywords (lowercase English, space-separated; includes code synonyms). */
  keywords: string;
}

/**
 * The **built-in curated large set** for free-mode (GitLab / Bitbucket) reactions: ~150 high-frequency emojis, code uses gemoji-style
 * shortcode (same source as GitLab award name / Bitbucket emoticon shortname), reliable to write. Deliberately a built-in curated set rather than full
 * Unicode — this avoids both the bundle bloat of a third-party large lexicon and the "emoji newer than the instance's Twemoji version fails to write" problem, while covering common ones
 * (including alien etc.). Read normalization does not depend on this table (Bitbucket uses twemoji url codepoints, GitLab looks up by award name).
 * The first {@link REACTION_POPULAR} are the default display set; the rest are reached via search. To extend: append a row to the corresponding group.
 */
export const REACTION_EMOJIS: readonly ReactionEmoji[] = [
  // —— High-frequency reactions (shown by default) ——
  { emoji: '👍', code: 'thumbsup', keywords: 'thumbsup +1 yes like approve good up' },
  { emoji: '👎', code: 'thumbsdown', keywords: 'thumbsdown -1 no dislike bad down' },
  { emoji: '😄', code: 'smile', keywords: 'smile happy joy' },
  { emoji: '😆', code: 'laughing', keywords: 'laughing lol haha satisfied' },
  { emoji: '😂', code: 'joy', keywords: 'joy tears laugh funny lol' },
  { emoji: '🤣', code: 'rofl', keywords: 'rofl rolling laugh floor' },
  { emoji: '🙂', code: 'slightly_smiling_face', keywords: 'slightly smiling face' },
  { emoji: '😉', code: 'wink', keywords: 'wink' },
  { emoji: '😍', code: 'heart_eyes', keywords: 'heart eyes love adore' },
  { emoji: '🥰', code: 'smiling_face_with_three_hearts', keywords: 'love hearts adore' },
  { emoji: '😎', code: 'sunglasses', keywords: 'sunglasses cool' },
  { emoji: '🤔', code: 'thinking', keywords: 'thinking hmm consider' },
  { emoji: '😕', code: 'confused', keywords: 'confused unsure' },
  { emoji: '😢', code: 'cry', keywords: 'cry sad tear' },
  { emoji: '😭', code: 'sob', keywords: 'sob cry sad bawling' },
  { emoji: '😡', code: 'rage', keywords: 'rage angry mad' },
  { emoji: '😱', code: 'scream', keywords: 'scream shock fear' },
  { emoji: '🤯', code: 'exploding_head', keywords: 'mind blown exploding head' },
  { emoji: '🥳', code: 'partying_face', keywords: 'party celebrate' },
  { emoji: '🤩', code: 'star_struck', keywords: 'star struck amazed excited' },
  { emoji: '😴', code: 'sleeping', keywords: 'sleeping tired zzz' },
  { emoji: '❤️', code: 'heart', keywords: 'heart love red' },
  { emoji: '🧡', code: 'orange_heart', keywords: 'orange heart' },
  { emoji: '💛', code: 'yellow_heart', keywords: 'yellow heart' },
  { emoji: '💚', code: 'green_heart', keywords: 'green heart' },
  { emoji: '💙', code: 'blue_heart', keywords: 'blue heart' },
  { emoji: '💜', code: 'purple_heart', keywords: 'purple heart' },
  { emoji: '💔', code: 'broken_heart', keywords: 'broken heart' },
  { emoji: '🔥', code: 'fire', keywords: 'fire lit hot flame' },
  { emoji: '⭐', code: 'star', keywords: 'star favorite' },
  { emoji: '✨', code: 'sparkles', keywords: 'sparkles shiny clean' },
  { emoji: '🎉', code: 'tada', keywords: 'tada party celebrate hooray' },
  { emoji: '🎊', code: 'confetti_ball', keywords: 'confetti celebrate' },
  { emoji: '🚀', code: 'rocket', keywords: 'rocket ship launch fast' },
  { emoji: '👀', code: 'eyes', keywords: 'eyes look watch see' },
  { emoji: '🙏', code: 'pray', keywords: 'pray thanks please' },
  { emoji: '👏', code: 'clap', keywords: 'clap applause bravo' },
  { emoji: '🙌', code: 'raised_hands', keywords: 'raised hands hooray celebrate' },
  { emoji: '🤝', code: 'handshake', keywords: 'handshake deal agree' },
  { emoji: '💪', code: 'muscle', keywords: 'muscle strong flex' },
  { emoji: '👌', code: 'ok_hand', keywords: 'ok perfect okay' },
  { emoji: '✅', code: 'white_check_mark', keywords: 'check done yes complete approve' },
  { emoji: '❌', code: 'x', keywords: 'x no cross wrong fail' },
  { emoji: '⚠️', code: 'warning', keywords: 'warning caution alert' },
  // —— More faces ——
  { emoji: '😀', code: 'grinning', keywords: 'grinning happy smile' },
  { emoji: '😅', code: 'sweat_smile', keywords: 'sweat smile relief nervous' },
  { emoji: '😊', code: 'blush', keywords: 'blush shy happy' },
  { emoji: '😇', code: 'innocent', keywords: 'innocent angel halo' },
  { emoji: '😘', code: 'kissing_heart', keywords: 'kiss love' },
  { emoji: '😋', code: 'yum', keywords: 'yum tasty delicious' },
  { emoji: '😛', code: 'stuck_out_tongue', keywords: 'tongue playful' },
  { emoji: '🤪', code: 'zany_face', keywords: 'zany goofy crazy' },
  { emoji: '😐', code: 'neutral_face', keywords: 'neutral meh' },
  { emoji: '😏', code: 'smirk', keywords: 'smirk smug' },
  { emoji: '🙄', code: 'roll_eyes', keywords: 'roll eyes whatever' },
  { emoji: '😬', code: 'grimacing', keywords: 'grimace awkward' },
  { emoji: '😌', code: 'relieved', keywords: 'relieved calm' },
  { emoji: '😔', code: 'pensive', keywords: 'pensive sad down' },
  { emoji: '🤤', code: 'drooling_face', keywords: 'drool want' },
  { emoji: '😷', code: 'mask', keywords: 'mask sick' },
  { emoji: '🤢', code: 'nauseated_face', keywords: 'nausea sick gross' },
  { emoji: '🥵', code: 'hot_face', keywords: 'hot overheated' },
  { emoji: '🥶', code: 'cold_face', keywords: 'cold freezing' },
  { emoji: '😵', code: 'dizzy_face', keywords: 'dizzy stunned' },
  { emoji: '🤠', code: 'cowboy_hat_face', keywords: 'cowboy howdy' },
  { emoji: '🤡', code: 'clown_face', keywords: 'clown joker' },
  { emoji: '👽', code: 'alien', keywords: 'alien ufo extraterrestrial' },
  { emoji: '👾', code: 'space_invader', keywords: 'space invader game alien' },
  { emoji: '🤖', code: 'robot', keywords: 'robot bot ai' },
  { emoji: '👻', code: 'ghost', keywords: 'ghost boo spooky' },
  { emoji: '💀', code: 'skull', keywords: 'skull dead' },
  { emoji: '💩', code: 'hankey', keywords: 'poop crap shit' },
  { emoji: '🎃', code: 'jack_o_lantern', keywords: 'pumpkin halloween' },
  // —— Gestures ——
  { emoji: '🤞', code: 'crossed_fingers', keywords: 'crossed fingers luck hope' },
  { emoji: '✌️', code: 'v', keywords: 'victory peace v' },
  { emoji: '🤟', code: 'love_you_gesture', keywords: 'love you ily' },
  { emoji: '🤘', code: 'metal', keywords: 'metal rock horns' },
  { emoji: '🤙', code: 'call_me_hand', keywords: 'call me shaka' },
  { emoji: '👈', code: 'point_left', keywords: 'point left' },
  { emoji: '👉', code: 'point_right', keywords: 'point right' },
  { emoji: '👆', code: 'point_up_2', keywords: 'point up' },
  { emoji: '👇', code: 'point_down', keywords: 'point down' },
  { emoji: '✋', code: 'raised_hand', keywords: 'raised hand stop high five' },
  { emoji: '🖖', code: 'vulcan_salute', keywords: 'vulcan spock live long' },
  { emoji: '👊', code: 'fist_oncoming', keywords: 'fist bump punch' },
  { emoji: '✊', code: 'fist_raised', keywords: 'fist raised power' },
  { emoji: '🤲', code: 'palms_up_together', keywords: 'palms up beg pray' },
  { emoji: '🤳', code: 'selfie', keywords: 'selfie photo' },
  // —— Animals ——
  { emoji: '🐶', code: 'dog', keywords: 'dog puppy' },
  { emoji: '🐱', code: 'cat', keywords: 'cat kitten' },
  { emoji: '🐭', code: 'mouse', keywords: 'mouse' },
  { emoji: '🐰', code: 'rabbit', keywords: 'rabbit bunny' },
  { emoji: '🦊', code: 'fox_face', keywords: 'fox' },
  { emoji: '🐻', code: 'bear', keywords: 'bear' },
  { emoji: '🐼', code: 'panda_face', keywords: 'panda' },
  { emoji: '🐨', code: 'koala', keywords: 'koala' },
  { emoji: '🐯', code: 'tiger', keywords: 'tiger' },
  { emoji: '🦁', code: 'lion', keywords: 'lion' },
  { emoji: '🐷', code: 'pig', keywords: 'pig' },
  { emoji: '🐸', code: 'frog', keywords: 'frog' },
  { emoji: '🐵', code: 'monkey_face', keywords: 'monkey' },
  { emoji: '🐔', code: 'chicken', keywords: 'chicken' },
  { emoji: '🐧', code: 'penguin', keywords: 'penguin' },
  { emoji: '🦄', code: 'unicorn', keywords: 'unicorn' },
  { emoji: '🐝', code: 'bee', keywords: 'bee honeybee' },
  { emoji: '🐢', code: 'turtle', keywords: 'turtle' },
  { emoji: '🐙', code: 'octopus', keywords: 'octopus' },
  { emoji: '🐳', code: 'whale', keywords: 'whale' },
  { emoji: '🐟', code: 'fish', keywords: 'fish' },
  // —— Food ——
  { emoji: '🍎', code: 'apple', keywords: 'apple fruit' },
  { emoji: '🍌', code: 'banana', keywords: 'banana fruit' },
  { emoji: '🍉', code: 'watermelon', keywords: 'watermelon fruit' },
  { emoji: '🍓', code: 'strawberry', keywords: 'strawberry fruit' },
  { emoji: '🍑', code: 'peach', keywords: 'peach fruit butt' },
  { emoji: '🍒', code: 'cherries', keywords: 'cherry fruit' },
  { emoji: '🥑', code: 'avocado', keywords: 'avocado' },
  { emoji: '🍕', code: 'pizza', keywords: 'pizza food' },
  { emoji: '🍔', code: 'hamburger', keywords: 'burger food' },
  { emoji: '🍟', code: 'fries', keywords: 'fries food' },
  { emoji: '🍿', code: 'popcorn', keywords: 'popcorn movie' },
  { emoji: '🍩', code: 'doughnut', keywords: 'donut food sweet' },
  { emoji: '🍪', code: 'cookie', keywords: 'cookie food sweet' },
  { emoji: '🎂', code: 'birthday', keywords: 'cake birthday' },
  { emoji: '🍰', code: 'cake', keywords: 'cake dessert' },
  { emoji: '🍫', code: 'chocolate_bar', keywords: 'chocolate sweet' },
  { emoji: '☕', code: 'coffee', keywords: 'coffee tea drink' },
  { emoji: '🍺', code: 'beer', keywords: 'beer drink' },
  { emoji: '🍻', code: 'beers', keywords: 'beers cheers drink' },
  { emoji: '🍷', code: 'wine_glass', keywords: 'wine drink' },
  // —— Nature ——
  { emoji: '☀️', code: 'sunny', keywords: 'sun sunny weather' },
  { emoji: '🌙', code: 'crescent_moon', keywords: 'moon night' },
  { emoji: '🌈', code: 'rainbow', keywords: 'rainbow' },
  { emoji: '⚡', code: 'zap', keywords: 'zap lightning bolt fast' },
  { emoji: '❄️', code: 'snowflake', keywords: 'snow cold winter' },
  { emoji: '🌊', code: 'ocean', keywords: 'wave ocean water' },
  { emoji: '🌍', code: 'earth_africa', keywords: 'earth world globe' },
  { emoji: '🌳', code: 'deciduous_tree', keywords: 'tree nature' },
  { emoji: '🌵', code: 'cactus', keywords: 'cactus' },
  { emoji: '🌹', code: 'rose', keywords: 'rose flower' },
  { emoji: '🌻', code: 'sunflower', keywords: 'sunflower flower' },
  { emoji: '🌸', code: 'cherry_blossom', keywords: 'blossom flower sakura' },
  { emoji: '🍀', code: 'four_leaf_clover', keywords: 'clover luck' },
  // —— Activities / objects ——
  { emoji: '⚽', code: 'soccer', keywords: 'soccer football ball' },
  { emoji: '🏀', code: 'basketball', keywords: 'basketball ball' },
  { emoji: '🎯', code: 'dart', keywords: 'dart target bullseye' },
  { emoji: '🎮', code: 'video_game', keywords: 'game controller' },
  { emoji: '🎸', code: 'guitar', keywords: 'guitar music' },
  { emoji: '🎤', code: 'microphone', keywords: 'mic sing' },
  { emoji: '🎨', code: 'art', keywords: 'art paint palette' },
  { emoji: '📱', code: 'iphone', keywords: 'phone mobile' },
  { emoji: '💻', code: 'computer', keywords: 'laptop computer' },
  { emoji: '⌨️', code: 'keyboard', keywords: 'keyboard' },
  { emoji: '🖥️', code: 'desktop_computer', keywords: 'desktop computer monitor' },
  { emoji: '💾', code: 'floppy_disk', keywords: 'save floppy disk' },
  { emoji: '📷', code: 'camera', keywords: 'camera photo' },
  { emoji: '🔋', code: 'battery', keywords: 'battery power' },
  { emoji: '💡', code: 'bulb', keywords: 'bulb idea light' },
  { emoji: '🔍', code: 'mag', keywords: 'search magnify find' },
  { emoji: '🔒', code: 'lock', keywords: 'lock secure' },
  { emoji: '🔑', code: 'key', keywords: 'key' },
  { emoji: '🔨', code: 'hammer', keywords: 'hammer build fix' },
  { emoji: '🔧', code: 'wrench', keywords: 'wrench fix tool' },
  { emoji: '⚙️', code: 'gear', keywords: 'gear settings config' },
  { emoji: '🧪', code: 'test_tube', keywords: 'test tube experiment' },
  { emoji: '🔬', code: 'microscope', keywords: 'microscope science' },
  { emoji: '💉', code: 'syringe', keywords: 'syringe shot vaccine' },
  { emoji: '💊', code: 'pill', keywords: 'pill medicine' },
  { emoji: '📝', code: 'memo', keywords: 'memo note write' },
  { emoji: '📌', code: 'pushpin', keywords: 'pin pushpin' },
  { emoji: '📎', code: 'paperclip', keywords: 'paperclip attach' },
  { emoji: '✂️', code: 'scissors', keywords: 'scissors cut' },
  { emoji: '🗑️', code: 'wastebasket', keywords: 'trash delete bin' },
  { emoji: '📦', code: 'package', keywords: 'package box ship' },
  { emoji: '📚', code: 'books', keywords: 'books read library' },
  { emoji: '💰', code: 'moneybag', keywords: 'money bag cash' },
  { emoji: '💎', code: 'gem', keywords: 'gem diamond jewel' },
  { emoji: '🚗', code: 'car', keywords: 'car auto' },
  { emoji: '✈️', code: 'airplane', keywords: 'plane airplane fly travel' },
  { emoji: '🛸', code: 'flying_saucer', keywords: 'ufo flying saucer alien' },
  { emoji: '⚓', code: 'anchor', keywords: 'anchor boat' },
  { emoji: '🐛', code: 'bug', keywords: 'bug defect insect' },
  { emoji: '💯', code: '100', keywords: '100 hundred score perfect' },
  { emoji: '👋', code: 'wave', keywords: 'wave hello hi bye' },
  { emoji: '🤷', code: 'shrug', keywords: 'shrug whatever idk' },
];

/** Default display set size (the first N of REACTION_EMOJIS, high-frequency ones ordered first). */
const REACTION_POPULAR_COUNT = 44;

const _codeByEmoji = new Map(REACTION_EMOJIS.map((e) => [e.emoji, e.code]));
const _emojiByCode = new Map(REACTION_EMOJIS.map((e) => [e.code, e.emoji]));
// Read-compatibility aliases: GitLab/Bitbucket occasionally use +1 / -1 as award/emoticon names.
_emojiByCode.set('+1', '👍');
_emojiByCode.set('-1', '👎');

/** emoji character → platform write shortcode (GitLab award name / Bitbucket emoticon); returns undefined when unknown. */
export function emojiToReactionCode(emoji: string): string | undefined {
  return _codeByEmoji.get(emoji);
}

/** shortcode (including +1/-1 aliases) → emoji character; returns undefined when unknown (used for read normalization fallback). */
export function reactionCodeToEmoji(code: string): string | undefined {
  return _emojiByCode.get(code);
}

/** The high-frequency reactions shown by default in the free-mode picker (when there's no search term). */
export const REACTION_POPULAR: readonly ReactionEmoji[] = REACTION_EMOJIS.slice(
  0,
  REACTION_POPULAR_COUNT,
);

/**
 * Free-mode picker search: an empty query returns {@link REACTION_POPULAR}; otherwise match by keyword substring within the built-in curated set,
 * truncated to limit (default 60).
 */
export function searchReactionEmojis(query: string, limit = 60): ReactionEmoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...REACTION_POPULAR];
  const out: ReactionEmoji[] = [];
  for (const e of REACTION_EMOJIS) {
    if (e.keywords.includes(q)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Input for a comment image attachment upload (main converts the IPC ArrayBuffer to Uint8Array before passing to the adapter). */
export interface CommentAttachmentUpload {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Comment attachment upload result: a markdown snippet that can be inserted directly into the comment body (such as `![name](url)` / `attachment:` form). */
export interface CommentAttachmentResult {
  markdown: string;
}

export interface PrComment {
  remoteId: string;
  author: PlatformUser;
  body: string;
  /** ISO */
  createdAt: string;
  /** ISO */
  updatedAt: string;
  /** null = PR top-level summary comment; set = inline comment anchored to a specific file line */
  anchor: PrCommentAnchor | null;
  /** Nested replies (Bitbucket uses comment.comments[]) */
  replies: PrComment[];
  /**
   * Remote version number (optimistic lock). Bitbucket uses 0/1/2... monotonically increasing; DELETE / PUT must carry the current version in the query,
   * otherwise 409 conflict. GitHub / GitLab have no such semantics; set to `0` as a "no concurrency token needed"
   * sentinel — so canEdit/canDelete decisions and the edit/delete IPC's `version: number` contract pass uniformly,
   * while their edit/delete APIs ignore the value.
   */
  version?: number;
  /**
   * The main-side prejudgment of "whether the current PAT user can delete it". Combines:
   *   - author.name === currentUser.name (PAT cache)
   *   - replies.length === 0 (Bitbucket refuses to delete ones with a reply)
   *   - version field present (optimistic lock required for DELETE)
   *
   * The renderer no longer compares author names / checks replies / checks version itself — it reads this flag directly.
   * Across PRs / connections, main decides using the cachedUser of the PR's owning adapter,
   * so the renderer doesn't need to pass through currentUserName
   */
  canDelete?: boolean;
  /**
   * The main-side prejudgment of "whether it can be edited". Bitbucket differs from canDelete in not requiring reply.length===0
   * (comments with a reply may still change their body); otherwise same source: author match + has version
   */
  canEdit?: boolean;
  /**
   * Comment kind (multi-platform abstraction): 'summary' = PR-level discussion; 'inline' = anchored to a file line.
   * Currently whether anchor is null already distinguishes them; this field is the explicit label during normalization for GitHub (issue/review comments split across two APIs) /
   * GitLab (note/discussion), convenient for UI and write-back. Optional, not filled for old data.
   */
  kind?: 'summary' | 'inline';
  /**
   * Thread identifier (abstraction of the reply target). Bitbucket=parent comment id, GitHub=review-comment id,
   * GitLab=discussion id. Passed through to the adapter on reply; Bitbucket currently just uses remoteId.
   */
  threadId?: string;
  /** Platform native id (for write-back / idempotency; same source as remoteId but kept semantically independent for extension room). */
  nativeId?: string;
  /**
   * The emoji reaction aggregation on the comment (see {@link PrReaction}). Omitted or an empty array when the platform doesn't support it / the comment has no reactions.
   * Filled only when the platform's `commentReactions` capability is truthy; the renderer renders the reaction bar under the comment bubble accordingly.
   */
  reactions?: PrReaction[];
}

/**
 * The verdict type of a PR review decision event. `dismissed` = the decision was revoked/invalidated (GitHub DISMISSED),
 * semantically close to an active `unapproved` (withdrawing approval) but from a different source; the distinction is kept for UI text.
 */
export type PrActivityKind = 'approved' | 'needsWork' | 'unapproved' | 'dismissed';

/**
 * A "review decision" event on the PR activity timeline (with timestamp). Cross-platform neutral shape, mapped by each adapter from the native activity stream:
 * GitHub `/pulls/{n}/reviews` (state + submitted_at); Bitbucket `/activities`
 * (action=APPROVED/REVIEWED/UNAPPROVED + createdDate); GitLab system note (approved/
 * unapproved; unavailable when CE has no approval).
 *
 * Carries only "decision-type" events beyond comments / commits — comments go through {@link PrComment}, commits through {@link PrCommit},
 * and the renderer merges the three streams by time into one timeline. Returns an empty array when the platform can't get historical events.
 */
export interface PrActivityEvent {
  /** Platform-side event id (for dedup / React key) */
  remoteId: string;
  kind: PrActivityKind;
  /** The user who triggered this decision */
  actor: PlatformUser;
  /** ISO */
  createdAt: string;
  /** Body accompanying the decision (GitHub review body may carry an explanation); omitted when absent */
  body?: string;
}

/**
 * The PR's diff base shas (used as the inline comment publish anchor). GitHub uses `headSha` as commit_id;
 * GitLab assembles position from all three; Bitbucket doesn't need it (ignored). The adapter can fetch it internally by prId,
 * or the caller (already holding PR meta + local mirror sha) can pass it in, avoiding an extra API call per publish.
 */
export interface PrDiffRefs {
  /** head (latest of the source branch) sha */
  headSha: string;
  /** base (target branch / merge-base) sha */
  baseSha: string;
  /** The start sha needed by GitLab position; may be empty on other platforms */
  startSha?: string;
}

/**
 * Platform capability descriptor (multi-platform adaptation, see docs/arch/01-platform/01-adapter.md §2 / §3).
 * Explicitly declares capabilities that can't be equivalently implemented across all platforms; the UI shows/hides/greys-out accordingly (degradation rules see §2), and the business layer tunes strategy accordingly,
 * avoiding try/catch guessing or `if (platform === ...)` at call sites.
 */
export interface PlatformCapabilities {
  /** Supported review verdicts (GitLab CE may be [] or ['approved','unapproved']) */
  reviewStatuses: ReadonlyArray<ReviewerStatus>;
  /** Whether inline comments are supported */
  inlineComments: boolean;
  /** Whether multi-line inline comments are supported */
  inlineMultiline: boolean;
  /** Whether comment edit/delete requires a version optimistic lock (Bitbucket only) */
  commentOptimisticLock: boolean;
  /**
   * Whether comments support uploading image attachments (paste / pick). GitLab (/uploads), Bitbucket (attachments) are true;
   * GitHub has no public attachment upload API → false (UI hides the paste-upload entry, notes it's unsupported). When true, the renderer intercepts image paste
   * → uploads via the adapter → backfills markdown into the body.
   */
  commentAttachments: boolean;
  /**
   * Comment emoji reaction support mode:
   * - `false`: unsupported, the UI hides the whole block.
   * - `'fixed'`: fixed set only (GitHub Reactions' 8) → the picker uses {@link REACTION_PICKER}, no search.
   * - `'free'`: any emoji supported (GitLab Award Emoji / Bitbucket emoticon) → the picker uses the built-in curated set
   *   ({@link searchReactionEmojis} search + {@link REACTION_POPULAR} default).
   * Each adapter translates the emoji character into a native name per its own API (fixed uses a built-in 8-mapping; free uses {@link emojiToReactionCode}).
   */
  commentReactions: false | 'fixed' | 'free';
  /**
   * Whether a single newline in a comment body renders as a hard-break (single `\n` → `<br>`). GitHub / Bitbucket comment contexts
   * do (`true`); GitLab uses standard CommonMark (single `\n` as a soft break = space, `false`). The renderer
   * decides whether to enable remark-breaks accordingly, so local rendering matches each platform's web.
   */
  commentHardBreaks: boolean;
  /** Merge veto item fidelity: 'full' itemized available (Bitbucket/GitLab); 'partial' only approximate (GitHub) */
  mergeVetoFidelity: 'full' | 'partial';
  /** Whether the discovery endpoint is heavily rate-limited (GitHub search 30/min) → this platform's polling interval is lengthened separately */
  discoveryRateLimited: boolean;
  /**
   * PR discovery categories the platform provides (GitHub dashboard's four). In one round the poller fetches all these categories and tags PRs,
   * and the renderer filters tabs locally accordingly. Empty / omitted = the platform has only a single "review-requested" discovery, no category tabs.
   */
  discoveryFilters?: ReadonlyArray<PrDiscoveryFilter>;
  /** Whether comment threads can be "resolved / Resolve" + collapsed (GitHub/GitLab have it, Bitbucket doesn't) */
  resolvableThreads: boolean;
  /** Whether inline code suggestion "one-click apply" is supported (GitHub/GitLab have it, Bitbucket doesn't) */
  suggestions: boolean;
  /** Whether decisions + inline comments can be submitted as a group (pending review); maps to the local draft pool → batch publish */
  reviewGrouping: boolean;
  /**
   * Whether a "timestamped review-decision activity event stream" ({@link PrActivityEvent}) is provided to support the activity timeline.
   * GitHub (/reviews) / Bitbucket (/activities) are `true`: that PR tab renders the "activity" timeline merging comments + commits + decisions.
   * GitLab is `false`: no unified activity event source (CE has no approval, system note parsing is fragile),
   * so the tab degrades to a pure "comments" view (retaining the original behavior and text), not mixing in commits / decisions.
   */
  activityTimeline: boolean;
  /**
   * Whether {@link PullRequest.commentCount} "includes replies" — i.e. whether adding a reply changes the count. Determines the poller's comment
   * tracking strategy:
   * - `true` (GitHub `comments + review_comments`, GitLab `user_notes_count`): the count is a reliable "includes replies" delta
   *   signal; the poller fetches comments to scan only when `commentCount` or `updatedAt` changes — saving requests.
   * - `false` (Bitbucket `properties.commentCount` counts only top-level comments, replies don't count, and `updatedDate` also doesn't jump on comments):
   *   no free "includes replies" signal at all; the poller fetches a comment scan as a fallback every round for **pending PRs**, otherwise it would miss "reply"-type notifications.
   */
  commentCountIncludesReplies: boolean;
}

/**
 * PR discovery filter category (runtime filter, not persisted). Currently only the GitHub adapter uses it to switch search qualifiers,
 * aligned with GitHub dashboard's four; other platforms ignore this parameter and keep their own "review-requested" semantics.
 * - `review-requested` (default): PRs requesting the current user's review.
 * - `created`: PRs created by the current user.
 * - `assigned`: PRs assigned to the current user.
 * - `mentioned`: PRs mentioning the current user.
 */
export type PrDiscoveryFilter = 'review-requested' | 'created' | 'assigned' | 'mentioned';

/** Options when discovering PRs; filter defaults to review-requested. */
export interface ListPendingOptions {
  filter?: PrDiscoveryFilter;
}
