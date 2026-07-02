<div align="center">

<img src="assets/icons/icon.png" alt="Code Meeseeks" width="96" />

# Code Meeseeks

**PR Agent 的桌面 GUI · 面向 Reviewer 个人的本地化、半自动 AI 代码评审客户端**

社区版 [PR-Agent](https://docs.pr-agent.ai/) 的图形界面 (GUI) · Electron 桌面应用 · 数据全部留在本地

[![Electron](https://img.shields.io/badge/Electron-2B2E3A?logo=electron&logoColor=9FEAF9)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Release](https://img.shields.io/github/v/release/huhamhire/code-meeseeks?include_prereleases&sort=semver&label=release&color=4c9a40)](https://github.com/huhamhire/code-meeseeks/releases)

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/)
[![Bitbucket](https://img.shields.io/badge/Bitbucket-0052CC?logo=bitbucket&logoColor=white)](https://bitbucket.org/)
[![GitLab](https://img.shields.io/badge/GitLab-FC6D26?logo=gitlab&logoColor=white)](https://gitlab.com/)

<sub>关键词 / Keywords：PR-Agent GUI · pr-agent desktop client · AI 代码评审 / AI code review · Pull Request &amp; Merge Request review · Bitbucket / GitHub reviewer 工具 · 本地化 / 私有部署 / self-hosted</sub>

</div>

---

> ⚠️ **早期预览版（0.x）**：项目仍在快速迭代，功能、配置与数据格式可能发生不兼容变更，稳定性未经充分验证。请勿用于关键的生产评审流程，使用前请自行评估风险并做好数据备份。

Code Meeseeks（内部开发代号 `meebox`）是命令行工具 [pr-agent](https://docs.pr-agent.ai/) 的**桌面图形界面 (GUI)**：把 AI 辅助的代码评审装进一个桌面客户端 —— 拉取评审者待评审的 PR（Pull Request / Merge Request），本地跑 pr-agent 生成评审意见，由评审者**逐条确认 / 编辑后**再发布到代码托管平台（GitHub / Bitbucket / GitLab）。

核心设计立场：

- **决策权在人** —— 所有评论必须经评审者二次确认 / 编辑才会发到远端，AI 只做草稿。
- **规则在本地** —— 评审者自行配置检查规则、风格偏好、LLM Provider。
- **数据在本地** —— 仓库副本、PR 元数据、评论草稿都存在本机工作目录，企业内网友好。

> 灵感来自 _Rick and Morty_ 里的 Mr. Meeseeks：召之即来、专做一件事、做完即走。

## 适用场景

- ✅ 承担 code review 职责的工程师 / Tech Lead
- ✅ 希望借助 AI 提升评审效率，同时保留最终决策权、不将判断完全交由 bot
- ✅ 在企业内网环境中使用自建 Bitbucket / GitLab 的团队

## 不适用场景

- ❌ 不是在 CI 中自动运行的 review bot（该定位属于 pr-agent 本身）
- ❌ 不是团队协同评审平台（无服务端，不提供多用户同步）
- ❌ 不替代代码托管平台原生的评审界面

---

## 核心特性

#### 🌍 多平台接入

- **统一接入 GitHub / Bitbucket / GitLab** —— 自建 GitHub Enterprise / GitLab Self-Managed 直接填实例地址，按平台能力自适应（如 GitLab CE/EE 审批降级）。
- **本地优先，开箱即用** —— 仓库副本、PR 元数据、评论草稿都存本机工作目录，企业内网友好；安装包内嵌 pr-agent，零外部依赖。
- **网络代理** —— LLM 调用、代码平台、git 拉取统一经 HTTP 代理，本地地址自动直连。

#### 📥 PR 发现与浏览

- **自动发现** —— 轮询拉取待评审 PR，按「待我评审 / 我创建」等分类与仓库分组，支持状态过滤与搜索。
- **未读与点名标记** —— 新分配 / 新提交 / 被 @ / 被回复标未读，其中被点名的条数单独计数。
- **历史与按需打开** —— 浏览已合并 / 已关闭的 PR，或按 URL 直接打开任意 PR（含补充评论、补跑评审）。

#### 🔍 本地 Diff 阅读

- **并排 / 内联 diff** —— 编辑器级代码阅读体验：文件树（合并冲突标注）、按变更范围 / 单 commit 查看、滚动条总览标尺、blame、跨文件代码搜索。
- **行内评论** —— 新增行与删除行均可评论；选中代码可作为上下文引用进提问。

#### 🤖 AI / Agentic 评审

- **指令驱动 pr-agent** —— `/describe`、`/review`、`/improve`、`/ask` 对话式驱动，结果结构化成可操作的评审发现。
- **复评闭环** —— 对评审建议发起 `/ask` 复评，按裁决（取代 / 保留 / 撤销）自动取代或关闭原评论。
- **Agentic 自主编排** —— 自然语言驱动的规划 + 多工具编排 + 长期 Memory，过程可观测（think → tool → think 时间线），可中途追加输入、随时停止，让评审走向可累积上下文的协作。
- **AutoPilot 预评审** —— 对待我评审·待处理的新 PR 自动预跑评审，进应用即见待确认草稿；写操作经逐项授权 + 红线校验把关（默认仅开放只读工具）。

#### ✍️ 评审闭环与协作

- **确认 → 发布** —— 评审发现转草稿、行内编辑、单条 / 批量发布到远端；远端可合并状态可视、满足条件一键合并（亦可对话 `/merge`）。
- **评论互动** —— 自己的评论可回复 / 编辑 / 删除；支持 emoji 反应、@ 提及补全、图片附件（粘贴 / 选取上传）、`:shortcode:` 表情渲染（随平台能力提供）。
- **活动时间线** —— 评论 / 提交更新 / 评审决断归并为一条时间线（GitHub / Bitbucket）。
- **消息通知** —— 新 PR、评论回复、被 @ 分类弹系统通知，仅对待处理 PR 提醒、不打扰已决断项；点击直达对应 PR 或代码行，macOS dock 角标显示待你回应的评论数。

#### ⚙️ 模型与规则

- **多 LLM Provider** —— OpenAI / openai-compatible / DeepSeek / Anthropic / 通义千问 / 火山方舟等（本地 Ollama 经 openai-compatible 的 `/v1` 接入）；也可通过本机已授权的本地 CLI 工具（如 claude / codex）调用第三方模型。
- **个性化规则** —— 每位 Reviewer 维护自己的规则目录（markdown + frontmatter，支持子目录递归组织），按项目 / 仓库 / 目标分支命中；命中的多条规则按 Ruleset 分段一并注入评审，`priority` 控制排序。
- **运行参数可调** —— 评审任务并发、输入上下文长度、Agent 策略（自动追问开关、追问 / 代码建议数量）均可在设置页调整。

#### 🔌 外部集成与 CLI

- **本地 API 服务** —— 可选开启一个本机 API，把 PR 浏览与评审 Agent 操作以接口形式开放给外部 agent / 脚本；默认仅本机可达、强制访问令牌鉴权，不开放合并与变更类工具。
- **跨平台命令行工具 `meebox`** —— 随发布提供 Windows / macOS / Linux 命令行客户端，经本地 API 浏览 PR、操作评审 Agent 并执行评审写动作（approve / needswork / comment），便于脚本与外部 agent 集成；压缩包即 agent skill 目录，可直接投放。用法见 **[CLI 命令行工具](docs/guide/06-cli.md)**。

#### 🎨 界面与体验

- **主题与外观** —— 深色 / 浅色 / 跟随系统，多款编辑器配色主题，自定义等宽字体与字号。
- **命令面板** —— `Ctrl/Cmd+Shift+P` 唤起，快速执行常用操作并归口分散功能。
- **多语言界面** —— 简体中文 / English / 日本語 / Deutsch，AI 回复语言随界面语言。
- **无边框窗口** —— 自绘标题栏（VS Code 风），展示品牌名与当前 PR 标题。

<div align="center">

<img src="assets/images/screenshot.zh-CN.png" alt="Code Meeseeks 界面预览" width="900" />

</div>

---

## 安装

到 [Releases](../../releases) 下载对应平台安装包：

| 平台        | 产物                                                 | 状态    |
| ----------- | ---------------------------------------------------- | ------- |
| Windows x64 | `code-meeseeks-<version>-win-x64.exe`（NSIS 安装包） | ✅ 可用 |
| macOS arm64 | `code-meeseeks-<version>-mac-arm64.dmg`              | ✅ 可用 |

安装包已内嵌 pr-agent，安装后即可使用，无需额外环境。

> **macOS 首次打开**：安装包为 ad-hoc 签名、未做 Apple 公证（notarization），Gatekeeper 会拦下未知开发者的 App。首次使用请右键点击 App 选「打开」，或到「系统设置 → 隐私与安全性」点「仍要打开」，确认一次后即可正常启动。
>
> 之所以未公证：本项目是**免费开源软件**，未购置 Apple Developer 付费账号（公证依赖该账号）。源码完全公开、可自行审计与构建，ad-hoc 签名不影响功能与安全。

---

## 快速上手

1. **配置连接** —— 设置页填入代码平台地址 + 鉴权信息。
2. **配置 LLM** —— 选择 Provider，填 API Key / base_url / 模型名。
3. **发现 PR** —— 应用自动轮询拉取评审者待评审的 PR，左侧列表按仓库分组。
4. **阅读 + 评审** —— 选中 PR 看 diff，点击自动评审按钮让 AI 生成评审发现；也可在对话框输入固定指令（如 `/describe`）或自然语言请求。
5. **确认 + 发布** —— 把评审发现转成草稿、编辑措辞，单条或批量发布到远端。

配置存放在 `~/.code-meeseeks/config.yaml`；仓库镜像默认在 `~/.code-meeseeks/repos/`，可在设置页改到其他目录。

> **网络代理**（可选，内网用户）：设置页「网络代理」填 HTTP 代理地址 / 端口 / Basic Auth，开启后 LLM 调用、代码平台、git 拉取统一经代理，本地地址自动直连（含「测试连通」按钮）。
>
> **SSH 方式的 git 拉取**不走此配置，请在 `~/.ssh/config` 为对应 host 自配 `ProxyCommand`。

各步的详细说明（安装与首次使用、PAT 权限与 Clone 协议、LLM 模型选择、网络代理）见 **[使用说明](docs/guide/README.md)**。

---

## 平台支持

| 平台                           | 状态                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| GitHub                         | ✅ 已验证（github.com + GitHub Enterprise Server，REST API v3） |
| Bitbucket Server / Data Center | ✅ 已支持（REST API v1，>= 7.0）                                |
| GitLab                         | ✅ 已支持（gitlab.com + Self-Managed，CE / EE，REST API v4，>= 13.8，推荐 15.6+） |

---

## 模型支持

评审能力经 pr-agent（底层 litellm）接入，**理论上兼容任意 OpenAI 兼容 / litellm 支持的模型供应商**（在设置页选模型供应商，填 API Key、base_url、模型名即可）。下表为设置页内置的厂商选项及实测状态：

| 模型供应商（厂商）  | 说明                                        | 状态                |
| ------------------- | ------------------------------------------- | ------------------- |
| `openai`            | OpenAI（GPT 系）                            | ✅ 已验证           |
| `anthropic`         | Anthropic（Claude 系）                      | ✅ 已验证           |
| `deepseek`          | DeepSeek                                    | ✅ 已验证           |
| `dashscope`         | 阿里百炼（DashScope，通义千问）             | ✅ 已验证           |
| `volcengine-ark`    | 火山方舟（Volcengine Ark，豆包）            | ✅ 已验证           |
| `openai-compatible` | OpenAI 协议兼容（vLLM / 中转 / 自建 / 本地 Ollama 的 `/v1`） | ✅ 已验证           |
| `cli`               | 通过本地 CLI 工具调用第三方模型             | ✅ 已验证           |

> **本地 CLI 模式说明**：该模式不直连模型 API，而是把评审请求转交给使用者**自行安装并授权**的本地命令行工具，由其代为调用背后的第三方模型。需先在本机完成对应 CLI 工具的安装与登录授权，应用本身不负责其凭据管理与计费。

> 💸 **成本提示**：Agentic 评审与 AutoPilot 预评审会对每个 PR 串联多次模型调用（描述、评审、必要时追问、汇总），token 消耗显著高于单次手动评审。无论使用按量计费的 API、还是有额度上限的订阅 / 本地 CLI 账户，都请留意用量节奏，自行评估成本投入；每步的 token 用量已在评审时间线上分步展示，便于观察消耗。

---

## 技术栈

- **桌面壳**：Electron + Vite（electron-vite）
- **渲染层**：React + TypeScript（strict）
- **编辑器**：Monaco（并排 / 内联 diff）
- **工程**：npm workspaces + Nx 单仓多包
- **pr-agent 集成**：内嵌 Python 运行时子进程（缺失时回退系统 pr-agent CLI）

> 📚 **延伸阅读**
>
> - 已交付能力、规划与未决项见 **[Roadmap](docs/ROADMAP.md)**
> - 详细架构与各模块设计见 **[模块文档](docs/arch/README.md)**

---

## 开发

环境准备、启动调试、构建打包步骤见 **[开发指南](docs/development/README.md)**。

---

## 隐私与数据

- **本地优先**：除调用 LLM API 与访问所配置的 Git 平台外，不向任何第三方上报数据。
- **工作目录**：应用数据固定在 `~/.code-meeseeks/`，仓库镜像目录可配置。
- pr-agent 评审时仅把 PR diff + 评审者的规则发给评审者自行配置的 LLM；接入本地模型（如本地 Ollama）即可全程不出本机。

---

## 致谢

构建于 [PR-Agent](https://github.com/The-PR-Agent/pr-agent) 之上 —— Qodo 贡献给社区的开源版本（官网 [docs.pr-agent.ai](https://docs.pr-agent.ai/)）。作为第三方依赖打包，按其自身许可证分发，**不在本项目重命名 / 改动范围内**。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

打包分发的安装包内含第三方组件（PR-Agent、Electron 等），各按其自身许可证分发，归集见 [NOTICE](NOTICE)；完整第三方许可（THIRD-PARTY-NOTICES）出包时自动生成并随安装包内置（位于 App 资源目录）。

## 商标与免责声明

本项目为非官方、独立的开源工具，**与 _Rick and Morty_ 及其权利方无任何关联，亦未获其授权或认可**。「Rick and Morty」「Mr. Meeseeks」等名称、角色及相关元素的版权与商标归其各自权利人所有（Adult Swim / Warner Bros. Discovery 等）。本项目名称与图标仅出于致敬目的进行借用，不主张任何相关权利；如权利方有异议，将配合调整。

---

<div align="center">

Made on 🌏 with ♥️.

</div>
