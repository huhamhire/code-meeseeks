# CLI 命令行工具（meebox）

`meebox` 是随发布提供的跨平台命令行工具，经本机的「本地 API 服务」访问应用能力，便于把 PR 浏览与
评审 Agent 操作接入脚本、CI 或外部 agent。命令行提供**浏览与评审操作**，含评审决断（approve / needswork）
与发评论；不含合并（merge）等高影响写操作。

## 1. 开启本地 API 服务

CLI 依赖应用内的本地 API 服务，默认关闭，需先在 **设置 → 集成** 开启：

- 打开「本地 API 服务」开关（首次开启会自动生成一枚访问令牌）。
- **监听地址**：默认 `http://127.0.0.1:18765`（仅本机可达）。如需被同网段的其他机器 / CI 访问，可把
  host 改为 `0.0.0.0` 或本机局域网 IP——此时**令牌是唯一防线**，请妥善保密并配合防火墙。
- **访问令牌**：可显示 / 复制 / 重新生成；重新生成后旧令牌立即失效。

## 2. 获取 CLI

**macOS / Linux 一键安装**——自动下载最新版、校验 SHA-256、装到 `PATH`：

```bash
curl -fsSL https://raw.githubusercontent.com/huhamhire/code-meeseeks/main/tools/cli/install.sh | bash
```

脚本自动探测系统 / 架构并拉取匹配的 Release 压缩包，把 `meebox` 装到 `/usr/local/bin`（不可写则回退
`~/.local/bin`）。可用环境变量 `MEEBOX_VERSION`（装指定版本）、`MEEBOX_BIN_DIR`（指定安装目录）调整。
无需单独安装 `SKILL.md`——它已内嵌进二进制（`meebox skill` 可打印）。

**手动下载**（Windows，或不便用脚本时）：从 [GitHub Release](https://github.com/huhamhire/code-meeseeks/releases)
下载对应平台压缩包（`meebox-cli-<版本>-<系统>-<架构>.zip` / `.tar.gz`），解压后把 `meebox` 放到 `PATH`。

覆盖平台：Windows x64、macOS arm64、Linux x64 / arm64。压缩包内含 `meebox` 二进制、`LICENSE`、`README.md`
与 `SKILL.md`（作为 agent skill 投放见 [第 6 节](#6-作为-agent-skill-集成)）。

## 3. 连接方式

`meebox` 按以下优先级解析 API 地址与令牌（高 → 低）：

1. 命令行参数：`--api-url` / `--token`
2. 环境变量：`MEEBOX_API_URL` / `MEEBOX_TOKEN`
3. CLI 配置文件：`~/.code-meeseeks/cli.yaml`（字段 `api_url` / `token`）

连接信息须**显式提供**其一。令牌在设置页「集成」分区查看 / 复制。最省事的方式是用 `meebox login` 存一次令牌
（写入 `cli.yaml`），之后所有命令免传参：

```bash
meebox login --token <令牌>            # 默认连本机 http://127.0.0.1:18765
meebox login --token <令牌> --server http://<主机>:18765   # 指定远端服务
meebox pr list                          # 后续命令直接用已存的凭据
```

或用环境变量（适合 CI / shell 注入）：

```bash
export MEEBOX_API_URL=http://127.0.0.1:18765
export MEEBOX_TOKEN=<令牌>
meebox pr list
```

远端访问（服务监听 `0.0.0.0`）同样显式提供地址与令牌：

```bash
meebox --api-url http://<主机>:18765 --token <令牌> pr list
```

> CLI **不读取** GUI 主配置 `~/.code-meeseeks/config.yaml`：该文件含代码平台访问令牌等连接层机密，
> 不从中取服务令牌，避免越权触达预期外的凭据。API 地址默认 `http://127.0.0.1:18765`（未显式指定时）。

## 4. 命令

```text
meebox [全局参数] <组> <命令> [参数]
```

根层级的系统性命令 `whoami` / `version` 与具体 PR 无关；其余命令分 `pr`（PR 操作，含 `categories` 筛选词表
与 `refresh` 刷新）与 `agent`（评审 Agent 操作）两个领域组，其 PR 维度子命令用**必填参数 `--pr <id>`** 指定
PR（`id` 由 `meebox pr list` 输出获得）。

| 命令 | 用途 |
| --- | --- |
| `meebox login --token <令牌> [--server <地址>]` | 保存令牌（与可选服务地址）到 `cli.yaml`，后续命令免传参 |
| `meebox whoami` | 当前登录身份与集成平台（用户 + 平台 + 连接名） |
| `meebox version` | 客户端（CLI）+ 服务端（应用）版本；未连接服务端时仅显示客户端版本 |
| `meebox skill` | 打印内嵌的使用说明（SKILL.md），便于二进制脱离压缩包时自述用法 |
| `meebox pr categories` | 列出当前平台可用的分类标签（一级发现分类 + 二级状态 / 合并态筛选）——`pr list` 的筛选词表 |
| `meebox pr refresh` | 触发一次立即刷新（拉取最新 PR），返回本轮变化计数（新增 / 变更 / 移除等）；等同 GUI 里的手动刷新 |
| `meebox pr list [--category <一级>] [--status <二级>] [--query <检索>] [--skip N] [--limit N]` | PR 列表（精简字段 + 分页，默认 limit 100） |
| `meebox pr show --pr <id>` | PR 描述详情 |
| `meebox pr diff --pr <id> [--file <路径>] [--side base\|head]` | 无 `--file` 列变更文件；有则取该文件内容 |
| `meebox pr activity --pr <id>` | 活动时间线（评论 / 提交 / 评审决断） |
| `meebox pr commits --pr <id>` | 提交列表 |
| `meebox pr reviewers --pr <id>` | 评审人审批状态 |
| `meebox pr approve --pr <id>` | 将 PR 标记为「通过」（发送真实评审决断到平台） |
| `meebox pr needswork --pr <id>` | 将 PR 标记为「需修改」（发送真实评审决断到平台） |
| `meebox pr comment --pr <id> <消息>` | 发一条顶层评论到平台 |
| `meebox agent status --pr <id>` | 评审 Agent 当前执行状态 |
| `meebox agent history --pr <id>` | 历史会话 |
| `meebox agent review --pr <id>` | 执行一次自动评审 |
| `meebox agent instruct --pr <id> <指令> [参数]` | 发送评审指令（`describe` / `review` / `ask` / `improve`） |
| `meebox agent chat --pr <id> <消息>` | 发送自然语言消息（可触发 Agent 任务） |
| `meebox agent stop --pr <id>` | 中断该 PR 运行中的评审 Agent（整体停） |
| `meebox agent run list --pr <id>` | 列出该 PR 运行中 / 排队中的 pr-agent runs |
| `meebox agent run cancel --pr <id> --run <runId>` | 按 run id 取消单个 pr-agent 工具调用 |

其中 `<id>` 为 PR 的本地标识（列表里的 `id` 字段），由 `meebox pr list` 输出获得。

## 5. 输出格式

全局参数 `--output`：

- **`yaml`（默认）**：结构化又易读（类 kubectl `-o yaml`），适合人在终端查看。
- **`json`**：适合脚本 / 外部 agent 机器解析。

```bash
meebox pr list --output json | jq '.[].title'
```

**退出码**：`0` 成功；非 0 表错误（`2` 鉴权失败、`3` 资源不存在、`1` 其他）；错误信息打到 `stderr`。

## 6. 作为 Agent Skill 集成

`meebox` 的主要交付形态是**可直接投放的 agent skill**：发布压缩包除二进制外一并含 `SKILL.md` /
`README.md` / `LICENSE`，整个解压目录即是一个可用 skill。

- **投放即用**：把解压目录放进 agent 的 skills 目录（如 `~/.claude/skills/meebox/`）。`SKILL.md`
  （frontmatter `name: meebox`）向 agent 说明命令树、连接方式与写边界，紧邻其驱动的二进制。
- **二进制自述**：同一份 `SKILL.md` 于构建期经 `go:embed` 内嵌进二进制，`meebox skill` 可打印之——
  二进制即便脱离压缩包（如单独放入 `PATH`）也能取回用法，且内容与随包文档构建期一致。
- **仅有二进制的 fallback**：若手头只有 `meebox` 二进制（缺压缩包 / `SKILL.md` 文件），用 `meebox skill`
  即可从二进制导出说明、就地重建 skill 目录，无需另找原始文件：

  ```bash
  mkdir -p ~/.claude/skills/meebox
  cp "$(command -v meebox)" ~/.claude/skills/meebox/      # 二进制放入 skill 目录
  meebox skill > ~/.claude/skills/meebox/SKILL.md          # 从内嵌副本导出说明
  ```

  导出的内容与该二进制同源，天然匹配当前版本。
- **集成流程**：读 `SKILL.md` 了解能力 → `meebox login` 存一次凭据 → 以 `meebox pr list` / `pr show` /
  `agent review` 等浏览与驱动评审 → 用 `meebox pr approve` / `needswork` / `comment` 记录结论；机器消费统一
  取 `--output json`（其字段形状为稳定契约）。
- **边界内建**：仅开放浏览 + 评审写动作，不含合并与变更类工具（详见下「注意事项」），agent 集成天然不会触发
  高影响远端操作。
- **框架无关的接入**：`SKILL.md` 的自动发现是 Claude Code 的 skill 约定，并非跨框架标准。其它 agent / 脚本
  无需依赖该约定即可集成——直接以 shell 调用 `meebox`、用 `meebox skill` 或 `--help` 取用法、`--output json`
  取结构化结果。真正可移植的接口是「命令行 + JSON」，`SKILL.md` 自动发现只是 Claude 生态的锦上添花。

## 网络代理

`meebox` 遵循标准的 HTTP 代理环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，大小写均可），无需额外配置：

- 访问**本机**服务（`127.0.0.1` / `localhost`）自动直连、不走代理。
- 访问**远端**服务（如经 `0.0.0.0` 暴露的机器）时，若设了 `HTTP_PROXY` 则经其出网；可用 `NO_PROXY` 排除特定主机。

## 注意事项

- **写能力范围**：CLI 提供评审写动作——`pr approve` / `pr needswork`（发送真实评审决断）与 `pr comment`
  （发顶层评论）；但**不提供合并（merge）与变更类 Agent 工具（publish 等）**，有此需求请自行对接代码平台。
- **令牌安全**：服务令牌在 GUI 的 `~/.code-meeseeks/config.yaml` 明文存储；若写入 CLI 的 `~/.code-meeseeks/cli.yaml`
  同为明文。监听 `0.0.0.0` 暴露到局域网时尤需保密，并及时通过「重新生成」吊销泄露的令牌。
- **版本兼容**：若 `meebox` 版本低于应用要求的下限，任意命令都会收到「CLI 过旧、请升级」提示（含双方版本）；
  按上文「获取 CLI」重装最新版即可。CLI 与应用版本同源发布，正常同步升级不会遇到。
