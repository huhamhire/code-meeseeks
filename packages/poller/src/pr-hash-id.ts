import crypto from 'node:crypto';
import type { PlatformKind } from '@meebox/shared';

/**
 * PR 在 meebox 状态体系里的稳定身份。多平台中性化字段，方便 M5 接入 GitHub /
 * GitLab / Gitea 时直接复用同一份 schema，不必各家自己造名:
 *
 *   platform × connection × group × repo × remoteId
 *
 * 字段语义映射 (各平台对齐到同一抽象):
 * | 抽象      | Bitbucket Server | GitHub             | GitLab          | Gitea          |
 * |-----------|------------------|--------------------|-----------------|----------------|
 * | platform  | bitbucket-server | github             | gitlab          | gitea          |
 * | group     | projectKey       | owner (org/user)   | namespace       | owner          |
 * | repo      | repoSlug         | name               | name            | name           |
 * | remoteId  | PR id (数字)     | PR number          | MR iid          | PR id          |
 *
 * `connectionId` 是 meebox 本地标识，跟用户在 config.yaml 里给某个连接起的 id
 * 一致；它的角色是"分账户/分凭据" (用户可能有两个 BBS 内网账号)，跟 platform 维度
 * 互补 (BBS 跨账户的同 host 不撞 id 也是靠 connectionId 区分)。
 *
 * 仅 `<connectionId>:<remoteId>` 不够 —— BBS PR id 在仓库维度递增，同一 connection
 * 下两个不同 repo 完全可能撞 id (例如 proj-A/repo-x#42 和 proj-A/repo-y#42)。
 *
 * `url` 是远端 PR 完整 URL 快照 (可选)，便于离线场景仍能直接跳转 / 调试；不参与哈希。
 */
export interface PrIdentity {
  platform: PlatformKind;
  connectionId: string;
  group: string;
  repo: string;
  /** 字符串形态，跟 remote API 取回的形状一致 (BBS 是数字 PR id 字符串化) */
  remoteId: string;
  /** 远端 PR URL 快照；仅作信息字段，不参与 hash */
  url?: string;
}

/**
 * 把 PR 身份信息哈希为定长 12 位 hex 字符串，用作 localId / state 目录名。
 *
 * 选择 12 hex (~48 bit)：单用户使用量远低于 2^24，碰撞概率仍可忽略；又比
 * 完整 sha1 (40 chars) 短得多，目录列表 / 日志可读。
 *
 * 输入规范化：用 `|` 当分隔符 (URL-safe + 不会出现在 connection id / group / repo
 * / remote id 里)。任何字段含 `|` 视为输入异常 (上层应该挡)，这里不做兜底替换以免
 * 引入碰撞。`url` 不进哈希源 (URL 在不同 BBS 路径下可能变化但 PR 还是同一个)。
 *
 * 哈希源顺序：platform / connection / group / repo / remoteId —— 最稳定字段在前
 * 让前缀有判别力 (debug 时 prefix-match 也能命中)。
 */
export function prHashId(identity: PrIdentity): string {
  const canonical = [
    identity.platform,
    identity.connectionId,
    identity.group,
    identity.repo,
    identity.remoteId,
  ].join('|');
  return crypto.createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 12);
}
