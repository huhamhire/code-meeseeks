// 顺序即各处平台展示准绳：GitHub → Bitbucket → GitLab，新平台追加末尾（见 PlatformIcon.PLATFORM_META）。
export type PlatformKind = 'github' | 'bitbucket-server' | 'gitlab';

/**
 * 各平台「PR 头」的 git 引用 refspec（fetch 进本地镜像，把 PR 源 sha 钉牢）。源分支被删 / 强推后，
 * `refs/heads/*` 已看不到 head sha，但平台保留了 PR 专属引用——据此 fetch 才能让 `git diff base...head`
 * 不报 "Invalid symmetric difference"。
 *
 * **必须按 PR 号精确取**：GitHub 的 pull 引用 / GitLab 的 merge-requests 引用默认不在 ref 广播里，
 * 通配 fetch 匹配不到（Bitbucket 的 pull-requests 引用会广播、通配可取，二者不同）；按确切编号 fetch
 * 平台才返回。remoteId 非纯数字（异常）→ 返回 null（不构造可疑 ref）。
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
 * 从一条 PR / MR 网页链接解析出 `{ group, repo, remoteId }`（用于「按 URL 打开当前平台 PR」）。
 * 仅按 **path 形态** 判定（忽略 host / query / hash / 尾缀如 `/files`、`/commits`），从而兼容自建实例、
 * 企业版与带上下文路径的部署；解析不出对应平台的 PR 形态返回 null（调用方据此报「不是该平台的 PR 链接」）。
 *
 * 各平台 path 形态：
 * - GitHub：`/{owner}/{repo}/pull/{n}`
 * - Bitbucket Server：`/projects/{KEY}/repos/{slug}/pull-requests/{n}`，个人仓库 `/users/{user}/repos/{slug}/pull-requests/{n}`（group=`~user`）
 * - GitLab：`/{namespace…}/{project}/-/merge_requests/{n}`（namespace 可多级）
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
  /** 后端 ID（用于 API/匹配） */
  name: string;
  /** 给人看的展示名 */
  displayName: string;
  /**
   * URL 友好的 slug，平台特定。Bitbucket 里 user.slug 可能与 user.name 大小写不同，
   * 走 avatar 等 URL 路径的接口必须用 slug；缺失时调用方走 name 兜底。
   */
  slug?: string;
  /**
   * 头像直链（平台返回的 avatar_url）。有则优先按此 URL 拉头像——GitHub 机器人
   * （login 形如 `foo[bot]`）没有 `github.com/<login>.png`，必须用 avatar_url 才取得到。
   */
  avatarUrl?: string;
}

/** Reviewer 在 PR 上的当前判定。Bitbucket: APPROVED / NEEDS_WORK / UNAPPROVED */
export type ReviewerStatus = 'approved' | 'needsWork' | 'unapproved';

export interface Reviewer extends PlatformUser {
  status: ReviewerStatus;
}

/**
 * 一条阻止合并的原因（merge check 否决项）。跨平台中性形状：
 * - Bitbucket: `/merge` 端点 vetoes[]，summary=summaryMessage，detail=detailedMessage
 * - GitHub: required status / required reviews 未满足项
 * - GitLab: detailed_merge_status 的具体阻塞原因
 */
export interface MergeVeto {
  /**
   * 稳定否决原因码（中性、不本地化）。GitHub / GitLab 等把派生原因归一到 `@meebox/platform-core`
   * 的 `MergeVetoCode`，前端按码 i18n（`mergeVeto.<code>`）。后台不拼面向用户的中文/本地化文案。
   * 服务端直给人读文案（如 Bitbucket）时可不带 code、改用 `summary`。
   */
  code?: string;
  /** 服务端直给的人读原因（如 Bitbucket summaryMessage）；无 `code` 时展示用。 */
  summary?: string;
  /** 详细原因，hover / 展开展示，可能缺省（Bitbucket detailedMessage） */
  detail?: string;
}

/**
 * 远端对 PR 的"可合并状态"判定。冲突在这里收敛成一种维度，PR.hasConflict
 * 只是 `conflicted` 的派生镜像（保留兼容现有冲突角标）。
 *
 * Bitbucket 一次 `/merge` 请求即可拿全：canMerge / conflicted / vetoes 同源，无额外开销。
 */
export interface MergeStatus {
  /** 远端判定当前是否可直接合并（Bitbucket canMerge）。false 时 vetoes 给出逐条原因 */
  canMerge: boolean;
  /** 是否存在 merge conflict（Bitbucket conflicted / outcome=CONFLICTED*） */
  conflicted: boolean;
  /**
   * 阻止合并的逐条原因（Bitbucket vetoes）。canMerge=true 时通常为空。
   * 例：必填 reviewer 未全部 approve、未通过的 build、分支保护规则等。
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
   * 远端可合并状态：能否合并 + 逐条阻塞原因（含冲突）。
   * Bitbucket 走 `/merge` 端点，canMerge / conflicted / vetoes 同源一次拉全。
   */
  mergeStatus: MergeStatus;
  /**
   * 远端是否存在 merge conflict。**派生镜像** = `mergeStatus.conflicted`，
   * 保留独立字段是为了兼容现有冲突角标 (PrItem) 的直接读取；新代码优先读
   * `mergeStatus`。adapter 写入时两者必须保持一致。
   */
  hasConflict: boolean;
  /**
   * 远端评论总数（含 / 不含回复视平台而定，见 {@link PlatformCapabilities.commentCountIncludesReplies}）。
   * 随 PR 发现列表免费返回（无额外请求）：Bitbucket = `properties.commentCount`（仅顶层）、
   * GitHub = `comments + review_comments`（含行内回复）、GitLab = `user_notes_count`（含回复）。
   * poller 据此（与 `updatedAt` 并用）判定 PR 是否可能有新评论 → 决定是否拉评论扫描未读 / 通知。
   * 平台不提供时省略（poller 退回仅按 `updatedAt` 判定）。
   */
  commentCount?: number;
}

export interface PingResult {
  ok: boolean;
  serverVersion?: string;
  user?: PlatformUser;
  /** 当 ok=false 时给出的人读原因（设置页显示） */
  reason?: string;
}

export interface PrCommentAnchor {
  /** 当前路径（renamed 文件给 dst 端） */
  path: string;
  /** 锚定行号 */
  line: number;
  /** 'old' = 锚到 base / FROM；'new' = 锚到 head / TO */
  side: 'old' | 'new';
  /** 锚点对应行的 diff 角色 */
  lineType: 'added' | 'removed' | 'context';
}

/**
 * PR 上的单条提交。跨平台中性形状；Bitbucket / GitHub / GitLab 都映射到这一份。
 *
 * `parents` 长度可判定是否 merge commit (>1 = merge)。`url` 给 UI 跳转用。
 */
export interface PrCommit {
  /** 完整 40-char SHA-1 */
  sha: string;
  /** 短 SHA (Bitbucket displayId / GitHub sha[:7])，UI 默认展示 */
  abbreviatedSha: string;
  /** 完整 commit message (含正文)。UI 展示首行作为 subject，hover/展开看 body */
  message: string;
  author: PlatformUser;
  /** ISO；author = 写代码的人 */
  authoredAt: string;
  /** 通常 = author 但 rebase / amend 等场景会变；可选 */
  committer?: PlatformUser;
  /** ISO；committer = 实际落库的人 */
  committedAt: string;
  /** 父提交 SHA 列表；长度 >1 表示 merge commit */
  parents: string[];
  /** 平台侧 commit 详情页 URL，可选 */
  url?: string;
}

/**
 * 评论上一种 emoji 反应的聚合（跨平台中性）。各平台原生反应标识不一（GitHub 固定 8 种
 * content、GitLab award_emoji 名、Bitbucket emoticon shortname），统一归一为 **Unicode emoji
 * 字符**作 key —— UI 直接渲染、跨平台一致。原生名 ↔ emoji 的映射由各平台 adapter 私有持有
 * （它最了解自己的 API），shared 只认 emoji 字符 + {@link REACTION_PICKER} 候选集。
 */
export interface PrReaction {
  /** 规范化 Unicode emoji 字符（如 `👍`）。 */
  emoji: string;
  /** 该 emoji 的反应总数。 */
  count: number;
  /** 当前 PAT 用户是否已用该 emoji 反应（决定 UI 高亮 + 点击切换方向）。 */
  mine: boolean;
}

/**
 * GitHub 固定支持的 8 种反应 emoji（展示顺序即此序）。GitHub Reactions API 仅这 8 种，故 `fixed`
 * 模式的选择器用它。各 adapter 负责把字符翻成自家原生名。
 */
export const REACTION_PICKER = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'] as const;

/** 反应选择器一项：emoji 字符 + 平台原生 shortcode（gemoji 风格名，GitLab award 名 / Bitbucket
 *  emoticon shortname 通用）+ 检索关键词（小写英文，空格分隔）。 */
export interface ReactionEmoji {
  emoji: string;
  /** gemoji 风格 shortcode（无冒号）；free 模式下 adapter 据此映射 char→原生名。 */
  code: string;
  /** 检索关键词（小写英文，空格分隔；含 code 同义词）。 */
  keywords: string;
}

/**
 * free 模式（GitLab / Bitbucket）反应的**内置精选大集**：~150 个高频 emoji，code 用 gemoji 风格
 * shortcode（GitLab award 名 / Bitbucket emoticon shortname 同源），写入可靠。刻意为内置精选而非全量
 * Unicode —— 既避免第三方大词表的打包冗余与「比实例 Twemoji 版本新的 emoji 写入失败」问题，又覆盖常用
 * （含 alien 等）。读取归一不依赖本表（Bitbucket 走 twemoji url 码点、GitLab 走 award 名回查）。
 * 前 {@link REACTION_POPULAR} 个为默认展示集；其余靠搜索命中。扩展：在对应分组追加一行即可。
 */
export const REACTION_EMOJIS: readonly ReactionEmoji[] = [
  // —— 高频反应（默认展示）——
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
  // —— 更多表情 ——
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
  // —— 手势 ——
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
  // —— 动物 ——
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
  // —— 食物 ——
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
  // —— 自然 ——
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
  // —— 活动 / 物品 ——
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

/** 默认展示集大小（REACTION_EMOJIS 前 N 个，按高频排序在前）。 */
const REACTION_POPULAR_COUNT = 44;

const _codeByEmoji = new Map(REACTION_EMOJIS.map((e) => [e.emoji, e.code]));
const _emojiByCode = new Map(REACTION_EMOJIS.map((e) => [e.code, e.emoji]));
// 读取兼容别名：GitLab/Bitbucket 偶用 +1 / -1 作 award/emoticon 名。
_emojiByCode.set('+1', '👍');
_emojiByCode.set('-1', '👎');

/** emoji 字符 → 平台写入用 shortcode（GitLab award 名 / Bitbucket emoticon），未知返回 undefined。 */
export function emojiToReactionCode(emoji: string): string | undefined {
  return _codeByEmoji.get(emoji);
}

/** shortcode（含 +1/-1 别名）→ emoji 字符，未知返回 undefined（读取归一回退用）。 */
export function reactionCodeToEmoji(code: string): string | undefined {
  return _emojiByCode.get(code);
}

/** free 模式选择器默认展示的高频反应（无搜索词时）。 */
export const REACTION_POPULAR: readonly ReactionEmoji[] = REACTION_EMOJIS.slice(
  0,
  REACTION_POPULAR_COUNT,
);

/**
 * free 模式选择器的搜索：空查询回 {@link REACTION_POPULAR}；否则在内置精选集里按关键词子串匹配，
 * 截断到 limit（默认 60）。
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

/** 评论图片附件上传的输入（main 端从 IPC 的 ArrayBuffer 转 Uint8Array 后传给 adapter）。 */
export interface CommentAttachmentUpload {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

/** 评论附件上传结果：可直接插入评论正文的 markdown 片段（如 `![name](url)` / `attachment:` 形式）。 */
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
  /** null = PR 顶层 summary 评论；set = inline 评论锚到具体文件行 */
  anchor: PrCommentAnchor | null;
  /** 嵌套 replies (Bitbucket 走 comment.comments[]) */
  replies: PrComment[];
  /**
   * 远端版本号 (乐观锁)。Bitbucket 走 0/1/2... 单调递增；DELETE / PUT 时必须在 query
   * 里带当前 version，否则 409 conflict。GitHub / GitLab 无此语义，置 `0` 作「无需并发令牌」
   * 哨兵——让 canEdit/canDelete 判定与编辑/删除 IPC 的 `version: number` 契约统一通过，
   * 其编辑/删除 API 忽略该值。
   */
  version?: number;
  /**
   * main 端预判的"是否可由当前 PAT 用户删除"。综合：
   *   - author.name === currentUser.name (PAT 缓存)
   *   - replies.length === 0 (Bitbucket 拒删有 reply 的)
   *   - version 字段存在 (DELETE 必备乐观锁)
   *
   * renderer 端不再自己比对作者名 / 检查 reply / 检查 version — 直接读这个 flag。
   * 跨 PR / 跨 connection 时，main 端用 PR 所属 adapter 的 cachedUser 判断，
   * renderer 不需要透传 currentUserName
   */
  canDelete?: boolean;
  /**
   * main 端预判的"是否可编辑"。Bitbucket 跟 canDelete 区别在不要求 reply.length===0
   * (带 reply 的评论也允许改 body)；其它同源：作者匹配 + 有 version
   */
  canEdit?: boolean;
  /**
   * 评论种类（多平台抽象）：'summary' = PR 级讨论；'inline' = 锚到文件行。
   * 现状 anchor 是否为 null 已能区分；本字段是 GitHub（issue/review 评论分两套 API）/
   * GitLab（note/discussion）归一时的显式标注，便于 UI 与回写。可选，旧数据不填。
   */
  kind?: 'summary' | 'inline';
  /**
   * 线程标识（回复目标的抽象）。Bitbucket=父评论 id、GitHub=review-comment id、
   * GitLab=discussion id。reply 时透传给 adapter；Bitbucket 现走 remoteId 即可。
   */
  threadId?: string;
  /** 平台原生 id（回写 / 幂等用，与 remoteId 同源但语义独立保留扩展空间）。 */
  nativeId?: string;
  /**
   * 评论上的 emoji 反应聚合（见 {@link PrReaction}）。平台不支持 / 该评论无反应时省略或为空数组。
   * 仅平台 `commentReactions` 能力为真时填充；renderer 据此在评论气泡下渲染反应条。
   */
  reactions?: PrReaction[];
}

/**
 * PR 评审决断事件的判定类型。`dismissed` = 决断被撤销/作废（GitHub DISMISSED），
 * 与主动 `unapproved`（撤回赞成）语义相近但来源不同，保留区分供 UI 文案。
 */
export type PrActivityKind = 'approved' | 'needsWork' | 'unapproved' | 'dismissed';

/**
 * PR 活动时间线上的「评审决断」事件（带时间戳）。跨平台中性形状，由各 adapter 从原生活动流
 * 映射：GitHub `/pulls/{n}/reviews`（state + submitted_at）；Bitbucket `/activities`
 * （action=APPROVED/REVIEWED/UNAPPROVED + createdDate）；GitLab 系统 note（approved/
 * unapproved，CE 无审批则取不到）。
 *
 * 仅承载评论 / 提交之外的「决断类」事件——评论走 {@link PrComment}、提交走 {@link PrCommit}，
 * 渲染层把三路按时间归并成一条时间线。平台拿不到历史事件时该方法返回空数组。
 */
export interface PrActivityEvent {
  /** 平台侧事件 id（去重 / React key 用） */
  remoteId: string;
  kind: PrActivityKind;
  /** 触发该决断的用户 */
  actor: PlatformUser;
  /** ISO */
  createdAt: string;
  /** 决断附带正文（GitHub review body 可能带说明）；无则省略 */
  body?: string;
}

/**
 * PR 的 diff 基准 sha（行内评论发布锚点用）。GitHub 用 `headSha` 作 commit_id；
 * GitLab 用三者拼 position；Bitbucket 不需要（忽略）。adapter 可按 prId 内部拉取，
 * 也可由调用方（已持 PR meta + 本地镜像 sha）传入，避免每次发布多打一次 API。
 */
export interface PrDiffRefs {
  /** head（源分支最新）sha */
  headSha: string;
  /** base（目标分支 / merge-base）sha */
  baseSha: string;
  /** GitLab position 需要的 start sha；其它平台可空 */
  startSha?: string;
}

/**
 * 平台能力描述符（多平台适配，见 docs/arch/01-platform/01-adapter.md §2 / §3）。
 * 把无法在所有平台等价实现的能力显式声明，UI 据此 显/隐/灰（降级规则见 §2），业务层据此调策略，
 * 避免在调用处 try/catch 猜或写 `if (platform === ...)`。
 */
export interface PlatformCapabilities {
  /** 支持的 review 决断（GitLab CE 可能为 [] 或 ['approved','unapproved']） */
  reviewStatuses: ReadonlyArray<ReviewerStatus>;
  /** 是否支持行内评论 */
  inlineComments: boolean;
  /** 是否支持多行行内评论 */
  inlineMultiline: boolean;
  /** 评论删改是否需要 version 乐观锁（仅 Bitbucket） */
  commentOptimisticLock: boolean;
  /**
   * 评论是否支持上传图片附件（粘贴 / 选取）。GitLab（/uploads）、Bitbucket（attachments）为真；
   * GitHub 无公开附件上传 API → 为假（UI 隐藏粘贴上传入口、提示不支持）。为真时渲染层拦截图片粘贴
   * → 经 adapter 上传 → 回填 markdown 到正文。
   */
  commentAttachments: boolean;
  /**
   * 评论 emoji 反应支持模式：
   * - `false`：不支持，UI 整块隐藏。
   * - `'fixed'`：仅固定集（GitHub Reactions 的 8 种）→ 选择器用 {@link REACTION_PICKER}，无搜索。
   * - `'free'`：支持任意 emoji（GitLab Award Emoji / Bitbucket emoticon）→ 选择器用内置精选集
   *   （{@link searchReactionEmojis} 搜索 + {@link REACTION_POPULAR} 默认）。
   * 各 adapter 据自家 API 把 emoji 字符翻成原生名（fixed 内置 8 映射；free 用 {@link emojiToReactionCode}）。
   */
  commentReactions: false | 'fixed' | 'free';
  /**
   * 评论正文单换行是否按 hard-break 渲染（单 `\n` → `<br>`）。GitHub / Bitbucket 评论上下文
   * 是（`true`）；GitLab 走标准 CommonMark（单 `\n` 作软换行 = 空格，`false`）。renderer 据此
   * 决定是否启用 remark-breaks，使本地渲染与各平台 web 一致。
   */
  commentHardBreaks: boolean;
  /** 合并否决项保真度：'full' 逐条可得（Bitbucket/GitLab）；'partial' 只能近似（GitHub） */
  mergeVetoFidelity: 'full' | 'partial';
  /** 发现端点是否强限流（GitHub search 30/分）→ 该平台轮询间隔单独拉长 */
  discoveryRateLimited: boolean;
  /**
   * 平台提供的 PR 发现分类（GitHub 仪表盘四类）。poller 一轮把这些分类都抓回来、给 PR 打标，
   * renderer 据此本地过滤标签页。为空 / 省略 = 平台只有单一「待我评审」发现，无分类标签。
   */
  discoveryFilters?: ReadonlyArray<PrDiscoveryFilter>;
  /** 评论线程是否可「解决 / Resolve」+ 折叠（GitHub/GitLab 有，Bitbucket 无） */
  resolvableThreads: boolean;
  /** 是否支持行内代码 suggestion「一键应用」（GitHub/GitLab 有，Bitbucket 无） */
  suggestions: boolean;
  /** 决断 + 行内评论是否可成组提交（pending review）；映射到本地草稿池→批量发布 */
  reviewGrouping: boolean;
  /**
   * 是否提供「带时间戳的评审决断活动事件流」（{@link PrActivityEvent}）以支撑活动时间线。
   * GitHub（/reviews）/ Bitbucket（/activities）为 `true`：该 PR 标签页渲染评论 + 提交 + 决断
   * 归并的「活动」时间线。GitLab 为 `false`：无统一活动事件源（CE 无审批、系统 note 解析脆弱），
   * 标签页退化为纯「评论」视图（沿用原行为与文案），不混入提交 / 决断。
   */
  activityTimeline: boolean;
  /**
   * {@link PullRequest.commentCount} 是否「含回复」——即新增一条回复是否会让该计数变化。决定 poller 评论
   * 跟踪策略：
   * - `true`（GitHub `comments + review_comments`、GitLab `user_notes_count`）：计数是可靠的「含回复」增量
   *   信号；poller 仅在 `commentCount` 或 `updatedAt` 变化时才拉评论扫描——省请求。
   * - `false`（Bitbucket `properties.commentCount` 仅数顶层评论，回复不计、且 `updatedDate` 也不随评论跳变）：
   *   无任何免费的「含回复」信号；poller 对**待处理 PR** 每轮兜底拉一次评论扫描，否则会漏掉「回复」类通知。
   */
  commentCountIncludesReplies: boolean;
}

/**
 * PR 发现筛选分类（运行时筛选，不持久化）。目前仅 GitHub 适配器据此切换 search 限定词，
 * 对齐 GitHub 仪表盘的四类；其他平台忽略此参数、维持各自的「待我评审」语义。
 * - `review-requested`（默认）：请求当前用户评审的 PR。
 * - `created`：当前用户创建的 PR。
 * - `assigned`：指派给当前用户的 PR。
 * - `mentioned`：提及当前用户的 PR。
 */
export type PrDiscoveryFilter = 'review-requested' | 'created' | 'assigned' | 'mentioned';

/** 发现 PR 时的可选项；filter 缺省按 review-requested。 */
export interface ListPendingOptions {
  filter?: PrDiscoveryFilter;
}
