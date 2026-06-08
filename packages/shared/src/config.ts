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

export const GitHubConnectionSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('github'),
  /**
   * GitHub REST API base。github.com 用 `https://api.github.com`；GitHub Enterprise
   * Server 用 `https://<ghe-host>/api/v3`。clone / web host 由 adapter 推导
   * （api.github.com → github.com；GHE → 同 host）。
   */
  base_url: z.string().url(),
  display_name: z.string(),
  auth: z.object({
    type: z.literal('pat'),
    token: z.string(),
  }),
  clone: CloneSettingsSchema,
});

export const ConnectionSchema = z.discriminatedUnion('kind', [
  BitbucketServerConnectionSchema,
  GitHubConnectionSchema,
]);

/**
 * 单条 LLM 预设。多条 profile 共存，由 `llm.active_id` 切换当前生效。
 * pr-agent 内部用 litellm；provider 决定走 OPENAI__* / ANTHROPIC__* / OLLAMA__*
 * 哪族环境变量。`openai-compatible` 覆盖 vLLM / DeepSeek / 中转 / Ollama OpenAI
 * mode 等所有 OpenAI API 协议兼容的方案。
 */
export const LlmProfileSchema = z.object({
  /** 稳定 id，UI 选中 / 引用用；新建时 renderer 生成 (uuid 或 timestamp) */
  id: z.string().min(1),
  /** 给人看的名字，可空，UI 会拿 provider+model 做后备显示 */
  label: z.string().default(''),
  provider: z
    .enum([
      'openai',
      'openai-compatible',
      'deepseek',
      'anthropic',
      'ollama',
      'dashscope',
      'volcengine-ark',
      'cli',
    ])
    .default('openai-compatible'),
  /** OpenAI 系: api_base；Ollama: api_base。非必填留空 */
  base_url: z.string().default(''),
  /**
   * pr-agent 的 `config.model`，litellm 接受 `<provider>/<name>` 前缀
   * （如 `ollama/qwen2.5`、`anthropic/claude-3-5-sonnet`），也接受裸名
   * (`gpt-4o`) 走 OpenAI。
   */
  model: z.string().default(''),
  /** 主密钥；Ollama 之类不需要鉴权的留空 */
  api_key: z.string().default(''),
});

export type LlmProvider =
  | 'openai'
  | 'openai-compatible'
  | 'deepseek'
  | 'anthropic'
  | 'ollama'
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
   * pr-agent 生成内容时使用的自然语言 (ISO locale，如 'zh-CN' / 'en-US')。
   * 透传到容器 `CONFIG__RESPONSE_LANGUAGE`。一期默认 zh-CN，UI 暂不暴露切换 ——
   * 后续如果做多语言再加 Settings 入口
   */
  language: z.string().default('zh-CN'),
  workspace: z
    .object({
      repos_dir: z.string().default('~/.code-meeseeks/repos'),
    })
    .default({}),
  /**
   * 个性化规则：rules.dir 下的每个 .md 文件 = 一条规则，frontmatter (YAML) 声明
   * applies_to (project / repo / target_branch 正则) / tools / priority，body
   * 是注入给 pr-agent 的 extra_instructions。
   *
   * dir 留空 = 不启用（默认）。建议指向一个 git repo，让团队共享规约。
   * enabled 是全局开关，应急关闭用，跟 dir 互斥不一样：dir 配了但 enabled=false
   * 时跳过加载
   */
  rules: z
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
   * pr-agent 运行时策略选择。
   * - 'auto'（默认）：优先嵌入式运行时（随 app 打包，正常安装恒可用），缺失则
   *   回退探测 local-cli → docker；
   * - 显式 'embedded' / 'local-cli' / 'docker'：强制该策略，便于高级用户切到
   *   自有 Docker / 系统 CLI。
   */
  pr_agent: z
    .object({
      strategy: z.enum(['auto', 'embedded', 'local-cli', 'docker']).default('auto'),
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
