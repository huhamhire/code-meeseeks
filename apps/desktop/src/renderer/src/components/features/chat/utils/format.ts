import type { TFunction } from 'i18next';
import type { ReviewRun } from '@meebox/shared';

// 时长格式化统一在 utils/time（状态栏紧凑版用 compact 选项）；此处再导出，chat 各组件就近引用。
export { formatElapsed } from '../../../../utils/time';

/** 1234 → "1.2k"；保留 1 位小数；< 1000 直接返回数字 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function runStatusLabel(status: ReviewRun['status'], t: TFunction): string {
  switch (status) {
    case 'running':
      return t('chatPane.statusRunning');
    case 'succeeded':
      return t('chatPane.statusSucceeded');
    case 'failed':
      return t('chatPane.statusFailed');
    case 'cancelled':
      return t('chatPane.statusCancelled');
  }
}

/**
 * 把时间戳格式化为 "HH:MM:SS" (当天) 或 "MM-DD HH:MM" (跨日)。用户主要看"哪一次
 * 跑的"，秒粒度足够区分相邻 run；隔天的 run 加日期标识让历史 run 列表里能立刻
 * 分组。接受 ISO 字符串 (持久化 ReviewRun.startedAt) 或毫秒时间戳 (RunningView
 * 端把 ISO 转过的 Date.getTime())
 */
export function formatStartTime(input: string | number): string {
  const d = new Date(input);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) {
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}-${da} ${hh}:${mm}`;
}

/**
 * 从 stdout 已收到的行里推断 pr-agent 当前在哪个阶段。pr-agent 在 LLM 调用前会
 * 打几条 INFO 标志位 ("Reviewing PR..." / "Tokens: ... returning full diff"
 * / ...)，LLM 调用本身是几分钟静默；从最近行命中已知模式来给用户更准的状态提示。
 *
 * 大仓库 /review 总时长可能 5min+，没有这个推断只看到 spinner + elapsed 容易
 * 误以为卡住。
 */
export function inferPhase(lines: ReadonlyArray<string>, t: TFunction): string {
  // 从后往前找最近的命中标志，越靠后的标志代表更"晚"的阶段
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/returning full diff|tokens?\s*[:：]\s*\d+/i.test(line))
      return t('chatPane.phaseWaitingLlm');
    if (/answering a pr question|reviewing pr|generating a pr description/i.test(line))
      return t('chatPane.phaseAssemblingPrompt');
    if (/pr main language/i.test(line)) return t('chatPane.phaseParsingDiff');
    if (/response language/i.test(line)) return t('chatPane.phaseInitConfig');
  }
  return t('chatPane.phaseStarting');
}
