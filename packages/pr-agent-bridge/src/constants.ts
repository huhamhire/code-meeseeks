import type { ReviewRunTool } from '@meebox/shared';

/**
 * 包内共享常量统一收口：子进程超时兜底、强制 UTF-8 的 spawn env、pr-agent local provider 产出文件名。
 * 散落各处的同类常量集中于此，便于统一复用与调参。
 */

// /review 在长 PR + 推理型模型 (DeepSeek-v4 / Claude thinking) 下常跑 3-8 min；5 min 经常打 timeout。
// 设到 10 min 让绝大多数真实 PR 能跑完，仍能兜住卡死的子进程不让它无限挂着。需要更长的话调用方可在
// opts.timeoutMs 显式覆盖。
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// chat 通道单次默认 5 min：编排 / 判定调用通常远快于 /review，但推理型模型仍可能慢。
export const DEFAULT_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
// 运行时探测（spawn `--version` 量级）默认 5s 超时兜底：足够且不拖慢启动。
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * 强制 UTF-8 的 spawn env：嵌入式 Python 在中文 Windows 上默认用系统码页 (GBK/cp936) 做 stdio / 文件
 * 编码，pr-agent 输出含 emoji (如 🔍 section 标题) 时会 'gbk' codec can't encode 崩掉。PYTHONUTF8=1
 * 覆盖 stdio + fs + 默认 open() 编码，PYTHONIOENCODING 兜底。所有 spawn 的 python 子进程统一带上。
 */
export const UTF8_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } as const;

/**
 * pr-agent local provider 各 tool 的产出落盘文件名（worktree 根的相对路径）：
 *   /describe → description.md（publish_description）
 *   /review   → review.md     （publish_comment）
 *   /ask      → review.md     （共用同一文件，publish_comment 覆盖）
 *   /improve  → improve.md    （汇总建议走 publish_comment，经 LOCAL__REVIEW_PATH 重定向与 review.md 分流）
 * 既供 buildToolEnv 设 LOCAL__REVIEW_PATH，也供调用方 run 结束后读取产出文件——两处共用此表保持同步。
 */
export const PRAGENT_LOCAL_OUTPUT: Record<ReviewRunTool, string> = {
  describe: 'description.md',
  review: 'review.md',
  ask: 'review.md',
  improve: 'improve.md',
};
