/**
 * 把 main 进程 / 适配器 / fetch 抛出的原始异常翻成用户能读懂的文案。
 *
 * 设计原则：
 * - **不把原始 message 隐藏掉**，detail 字段保留原文便于诊断
 * - 只识别常见模式给个 title 标签，未匹配的直接落到"未知错误"标签
 * - 不在这里 console.error，调用方决定是否记日志
 */
export interface FormattedError {
  /** 短标签，UI 顶部色字或图标旁文案，如"连接超时" */
  title: string;
  /** 详情，给用户看的人话或原始 message */
  detail: string;
  /** 给可观测性 / 自动重试逻辑用的归类 */
  kind: 'timeout' | 'network' | 'auth' | 'not-found' | 'platform' | 'unknown';
}

const MATCHERS: Array<{ re: RegExp; title: string; kind: FormattedError['kind']; hint?: string }> =
  [
    {
      re: /Connect Timeout|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT/i,
      title: '连接超时',
      kind: 'timeout',
      hint: '无法连接到远端 (Bitbucket Server)，请检查网络 / VPN / 代理',
    },
    {
      re: /UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT/i,
      title: '网络中断',
      kind: 'network',
      hint: '远端连接被重置 / 中断，请稍后重试',
    },
    {
      re: /ENOTFOUND|getaddrinfo|EAI_AGAIN/i,
      title: '域名解析失败',
      kind: 'network',
      hint: '主机名无法解析，检查 base_url / DNS / 代理',
    },
    {
      re: /ECONNREFUSED/i,
      title: '连接被拒绝',
      kind: 'network',
      hint: '目标端口未监听，确认 base_url 是否正确',
    },
    {
      re: /(?:^|\D)40[13]\b|Unauthorized|Forbidden/i,
      title: '鉴权失败',
      kind: 'auth',
      hint: 'Personal Access Token (PAT) 可能已过期或权限不足，去 Settings 检查',
    },
    {
      re: /(?:^|\D)404\b|Not Found/i,
      title: '资源不存在',
      kind: 'not-found',
      hint: '远端找不到该资源，可能 PR 已被删 / 重命名',
    },
    {
      re: /fetch failed/i,
      title: '远端请求失败',
      kind: 'platform',
    },
    {
      re: /Invalid symmetric difference expression/i,
      title: '本地镜像没找到 PR 引用的 commit',
      kind: 'platform',
      hint: '远端 PR 的 head / base sha 在本地 bare 镜像里不可达。通常发生在：刚从 partial clone 升到完整 clone 但旧镜像没重建，或 PR 源分支已删/强推。删除该 repo 的 bare 镜像目录 (`~/.code-meeseeks/repos/<host>/<proj>/<repo>/bare`) 后重选此 PR 会自动重 clone',
    },
    {
      re: /unknown revision or path not in the working tree/i,
      title: '本地镜像缺少该 commit',
      kind: 'platform',
      hint: '同步过的本地镜像找不到这个 sha，可能远端被强推过；删 bare 镜像目录后重 clone',
    },
    {
      re: /no such path .* in [0-9a-f]{7,}/i,
      title: '路径在该 commit 不存在',
      kind: 'not-found',
      hint: '通常是 PR 中重命名/删除后又恢复的边界状态；这种文件 blame 不可用是正常的',
    },
  ];

export function formatBackendError(err: unknown): FormattedError {
  const raw = err instanceof Error ? err.message : String(err);
  for (const m of MATCHERS) {
    if (m.re.test(raw)) {
      return {
        title: m.title,
        detail: m.hint ? `${m.hint}\n\n原始：${raw}` : raw,
        kind: m.kind,
      };
    }
  }
  return { title: '未知错误', detail: raw, kind: 'unknown' };
}
