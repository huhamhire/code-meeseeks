import { z } from 'zod';

export const CloneSettingsSchema = z
  .object({
    /**
     * git clone 协议。
     * - pat (默认): HTTPS，URL 里嵌 `<当前用户名>:<PAT>` (Bitbucket Server 约定)
     * - ssh: scp-like `git@<host>:<project>/<repo>.git`，端口/密钥走系统 ssh config
     */
    protocol: z.enum(['pat', 'ssh']).default('pat'),
  })
  .default({});

export const BitbucketServerConnectionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('bitbucket-server'),
  base_url: z.string().url(),
  display_name: z.string(),
  auth: z.object({
    type: z.literal('pat'),
    token: z.string(),
  }),
  clone: CloneSettingsSchema,
});

/** github.com 官方 REST API base。GitHub 连接的 base_url 留空时默认走这里。 */
export const GITHUB_DOTCOM_API_BASE = 'https://api.github.com';

export const GitHubConnectionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('github'),
  /**
   * GitHub REST API base。**可选**：留空 / 缺省时默认 `https://api.github.com`（github.com）；
   * GitHub Enterprise Server 填 `https://<ghe-host>/api/v3`。clone / web host 由 adapter
   * 推导（api.github.com → github.com；GHE → 同 host）。
   */
  base_url: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().default(GITHUB_DOTCOM_API_BASE),
  ),
  display_name: z.string(),
  auth: z.object({
    type: z.literal('pat'),
    token: z.string(),
  }),
  clone: CloneSettingsSchema,
});

/** gitlab.com 官方 REST API v4 base。GitLab 连接的 base_url 留空时默认走这里。 */
export const GITLAB_DOTCOM_API_BASE = 'https://gitlab.com/api/v4';

export const GitLabConnectionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('gitlab'),
  /**
   * GitLab REST API v4 base。**可选**：留空 / 缺省时默认 `https://gitlab.com/api/v4`（gitlab.com）；
   * 自建 / GitLab Self-Managed 填 `https://<host>/api/v4`。clone / web host 由 adapter 推导
   * （去掉 `/api/v4` 取实例 host），CE 与 EE 经 edition 探测在能力位上降级（审批）。
   */
  base_url: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().default(GITLAB_DOTCOM_API_BASE),
  ),
  display_name: z.string(),
  auth: z.object({
    type: z.literal('pat'),
    token: z.string(),
  }),
  clone: CloneSettingsSchema,
});

export const ConnectionSchema = z.discriminatedUnion('kind', [
  GitHubConnectionSchema,
  BitbucketServerConnectionSchema,
  GitLabConnectionSchema,
]);

/**
 * 单条 LLM 预设。多条 profile 共存，由 `llm.active_id` 切换当前生效。
 * pr-agent 内部用 litellm；provider 决定走 OPENAI__* / ANTHROPIC__* 等哪族环境变量。
 * `openai-compatible` 覆盖 vLLM / DeepSeek / 中转 / 本地 Ollama 的 OpenAI 兼容端点（/v1）
 * 等所有 OpenAI API 协议兼容的方案。
 */
/**
 * 兼容迁移：已废弃的 `ollama` provider → `openai-compatible`。Ollama 自带 OpenAI 兼容端点
 * `/v1`，统一走更标准、更稳的 OpenAI 路径（litellm `openai/` + OPENAI__API_BASE）。base_url
 * 补足 `/v1`（旧 ollama 默认是原生 API 根 `http://localhost:11434`，无 `/v1`）。
 */
function migrateLegacyLlmProvider(val: unknown): unknown {
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    if (o.provider === 'ollama') {
      const raw = typeof o.base_url === 'string' && o.base_url.trim() ? o.base_url.trim() : '';
      const base = (raw || 'http://localhost:11434').replace(/\/+$/, '');
      return {
        ...o,
        provider: 'openai-compatible',
        base_url: /\/v\d+$/.test(base) ? base : `${base}/v1`,
      };
    }
  }
  return val;
}

const LlmProfileObject = z.object({
  /** 稳定 id，UI 选中 / 引用用；新建时 renderer 生成 (uuid 或 timestamp) */
  id: z.string().min(1),
  /** 给人看的名字，可空，UI 会拿 provider+model 做后备显示 */
  label: z.string().default(''),
  provider: z
    .enum(['openai', 'openai-compatible', 'deepseek', 'anthropic', 'dashscope', 'volcengine-ark', 'cli'])
    .default('openai-compatible'),
  /** OpenAI 系 / 本地服务: api_base。非必填留空 */
  base_url: z.string().default(''),
  /**
   * pr-agent 的 `config.model`，litellm 接受 `<provider>/<name>` 前缀
   * （如 `openai/qwen2.5`、`anthropic/claude-3-5-sonnet`），也接受裸名
   * (`gpt-4o`) 走 OpenAI。
   */
  model: z.string().default(''),
  /** 主密钥；本地 / 不需要鉴权的服务留空 */
  api_key: z.string().default(''),
});

/** 旧 `ollama` profile 在校验前迁移为 `openai-compatible`（见 migrateLegacyLlmProvider）。 */
export const LlmProfileSchema = z.preprocess(migrateLegacyLlmProvider, LlmProfileObject);

export type LlmProvider =
  | 'openai'
  | 'openai-compatible'
  | 'deepseek'
  | 'anthropic'
  | 'dashscope' // 阿里百炼（DashScope，OpenAI 兼容入口，含千问 / Qwen / DeepSeek-on-DashScope）
  | 'volcengine-ark' // 火山方舟（Volcengine Ark，OpenAI 兼容入口，含豆包 / Doubao 等）
  | 'cli'; // 本地命令行：由本机已安装的 agentic CLI（一期 claude code）执行评审，不直连 API
export type LlmProfile = z.infer<typeof LlmProfileSchema>;

/**
 * 出站网络代理。一期仅 HTTP 代理：开关打开后 LLM / Bitbucket Server
 * REST / git HTTPS 统一走代理，仅 loopback/本地（含本地 Ollama）自动直连；SSH 走用户
 * 自配 ~/.ssh/config。配置面只暴露 地址/端口/Basic Auth。
 * `protocol` 为枚举预留扩展位（一期仅 'http'；追加 socks5 等对存量配置非破坏性）。
 */
export const ProxySchema = z.object({
  enabled: z.boolean().default(false),
  protocol: z.enum(['http']).default('http'),
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(8080),
  username: z.string().default(''),
  password: z.string().default(''),
});
export type ProxyConfig = z.infer<typeof ProxySchema>;

export const ConfigSchema = z.object({
  /**
   * UI 与 pr-agent 输出使用的语言 (ISO locale，如 'zh-CN' / 'en-US' / 'ja-JP' / 'de-DE')。
   * **默认空串 = 自动**：由 `resolveLanguage` 按操作系统偏好语言匹配，无合适项回落英语。
   * 非空则按显式选择。透传到容器 `CONFIG__RESPONSE_LANGUAGE`（经解析后的有效值）。
   */
  language: z.string().default(''),
  workspace: z
    .object({
      repos_dir: z.string().default('~/.code-meeseeks/repos'),
    })
    .default({}),
  /**
   * 高阶 Agent（见 docs/arch/06-agent.md）。Agent 目录是 Agent 的完整人格与知识来源：
   * `<agent.dir>/` 下含 SOUL.md / AGENTS.md / MEMORY.md / USER.md 与 rules/ 子目录
   * （规则正文，匹配语义见 @meebox/rules）。
   *
   * dir 留空 = 不启用（默认），Agent 退化为原生行为；建议指向一个 git repo 让团队共享。
   * enabled 是全局开关，dir 配了但 enabled=false 时跳过加载。
   */
  agent: z
    .object({
      dir: z.string().default(''),
      enabled: z.boolean().default(true),
    })
    .default({}),
  poller: z
    .object({
      interval_seconds: z.number().int().min(30).default(300),
    })
    .default({}),
  /** 出站网络代理。默认关闭 = 全部直连，等同历史行为。 */
  proxy: ProxySchema.default({}),
  /**
   * 版本更新检测。启动时（及设置页手动）查 GitHub Releases 最新稳定版与当前版本比对，
   * 有新版仅**提示**用户去下载（不自动下载 / 安装）。check_enabled=false 关闭检测。
   */
  update: z
    .object({
      check_enabled: z.boolean().default(true),
    })
    .default({}),
  /**
   * pr-agent 运行时策略选择。
   * - 'auto'（默认）：优先嵌入式运行时（随 app 打包，正常安装恒可用），缺失则
   *   回退探测系统 local-cli；
   * - 显式 'embedded' / 'local-cli'：强制该策略，便于高级用户切到自有系统 CLI。
   */
  pr_agent: z
    .object({
      strategy: z.enum(['auto', 'embedded', 'local-cli']).default('auto'),
      /**
       * 评审任务并发数（1~8，默认 2）。嵌入式 / local-cli 下每个 run 独立 worktree +
       * 独立子进程，并发安全；上限节流 LLM 限流 / 本机资源。**高级参数，不在设置页暴露**，
       * 仅 config.yaml 手改。
       */
      max_concurrency: z.number().int().min(1).max(8).default(2),
    })
    .default({}),
  connections: z.array(ConnectionSchema).default([]),
  /**
   * 当前**启用**的唯一连接 id（同时只启用一条，见设置页）。空串 / 找不到对应连接时
   * 不轮询任何连接（UI 引导用户启用一条）。connections 数组保留全部配置，仅 active
   * 这条被建 adapter 轮询；按 id 查连接的地方仍读全量，历史 PR 不受影响。
   */
  active_connection_id: z.string().default(''),
  llm: z.preprocess(
    // 兼容旧 single-config 形态：M3-C 初版用过 { provider, base_url, model, api_key }
    // 直接作为 llm 字段；现在改成 { profiles: [...], active_id }。检测旧 shape
    // 自动塞成一个 id='default' 的 profile。
    (val) => {
      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        !('profiles' in val) &&
        ('provider' in val ||
          'model' in val ||
          'api_key' in val ||
          'base_url' in val)
      ) {
        const o = val as Record<string, unknown>;
        const oldProvider = typeof o.provider === 'string' ? o.provider : '';
        // azure 已废，转成 openai-compatible (Azure 本质就是 OpenAI API + 自定义 base_url)
        const provider = (
          [
            'openai',
            'openai-compatible',
            'deepseek',
            'anthropic',
            'ollama',
            'dashscope',
            'volcengine-ark',
            'cli',
          ] as const
        ).includes(oldProvider as LlmProvider)
          ? (oldProvider as LlmProvider)
          : 'openai-compatible';
        return {
          profiles: [
            {
              id: 'default',
              label: '默认',
              provider,
              base_url: typeof o.base_url === 'string' ? o.base_url : '',
              model: typeof o.model === 'string' ? o.model : '',
              api_key: typeof o.api_key === 'string' ? o.api_key : '',
            },
          ],
          active_id: 'default',
        };
      }
      return val;
    },
    z
      .object({
        /** 用户保存的多套 LLM 预设（每条独立 provider/model/base_url/key） */
        profiles: z.array(LlmProfileSchema).default([]),
        /**
         * 当前选中的 profile id。空字符串 或 找不到对应 profile 时 pragent:run
         * 不注入任何 LLM env，pr-agent 退到读 shell 环境变量。
         */
        active_id: z.string().default(''),
      })
      .default({}),
  ),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type BitbucketServerConnection = z.infer<typeof BitbucketServerConnectionSchema>;
export type GitHubConnection = z.infer<typeof GitHubConnectionSchema>;
