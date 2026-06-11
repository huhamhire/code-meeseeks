<div align="center">

<img src="assets/icons/icon.png" alt="Code Meeseeks" width="96" />

# Code Meeseeks

**PR Agent 的桌面 GUI · 面向 Reviewer 个人的本地化、半自动 AI 代码评审客户端**

社区版 [PR-Agent](https://docs.pr-agent.ai/) 的图形界面 (GUI) · Electron 桌面应用 · 数据全部留在本地

<sub>关键词 / Keywords：PR-Agent GUI · pr-agent desktop client · AI 代码评审 / AI code review · Pull Request &amp; Merge Request review · Bitbucket / GitHub reviewer 工具 · 本地化 / 私有部署 / self-hosted</sub>

</div>

---

> ⚠️ **早期预览版（0.x）**：项目仍在快速迭代，功能、配置与数据格式可能发生不兼容变更，稳定性未经充分验证。请勿用于关键的生产评审流程，使用前请自行评估风险并做好数据备份。

Code Meeseeks（内部开发代号 `meebox`）是命令行工具 [pr-agent](https://docs.pr-agent.ai/) 的**桌面图形界面 (GUI)**：把 AI 辅助的代码评审装进一个桌面客户端 —— 拉取评审者待评审的 PR（Pull Request / Merge Request），本地跑 pr-agent 生成评审意见，由评审者**逐条确认 / 编辑后**再发布到代码托管平台（Bitbucket / GitHub）。

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

- 🔌 **开箱即用，零外部依赖** —— 安装包内嵌可重定位的 Python 运行时 + 固定版本 pr-agent，**无需自行安装 Python 或 Docker**。
- 📥 **PR 自动发现** —— 轮询拉取评审者待评审的 Open PR，按仓库分组、状态过滤、搜索。
- 🔍 **本地 Diff 阅读** —— Monaco 并排 / 内联 diff、文件树、行内评论、blame、跨文件代码搜索。
- 🤖 **AI 评审** —— `/describe`、`/review`、`/improve`、`/ask` 对话式驱动 pr-agent，结果结构化成可操作的 findings。
- 📐 **个性化规则** —— 每位 Reviewer 维护自己的规则目录（markdown + frontmatter），按项目 / 仓库 / 目标分支命中后注入评审。
- ✍️ **确认 → 发布闭环** —— finding 转草稿，行内编辑，单条 / 批量发布到远端；自己的评论支持回复 / 编辑 / 删除。
- 🔀 **合并状态** —— 展示远端可合并状态，满足条件时一键合并。
- 🧩 **多 LLM Provider** —— OpenAI / openai-compatible / DeepSeek / Anthropic / Ollama / 通义千问 / 火山方舟等；也可通过本机已授权的本地 CLI 工具调用第三方模型。
- 🌐 **多语言界面** —— 简体中文 / English / 日本語 / Deutsch；设置页与首启向导即时切换，空配置自动匹配系统语言（AI 回复语言随之）。

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
4. **阅读 + 评审** —— 选中 PR 看 diff，在对话框输入 `/review` 让 AI 生成 findings。
5. **确认 + 发布** —— 把 finding 转成草稿、编辑措辞，单条或批量发布到远端。

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
| GitLab                         | 🚧 规划中                                                       |

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
| `ollama`            | Ollama（本地模型）                          | 🚧 理论可行，未验证 |
| `openai-compatible` | OpenAI API 协议兼容（vLLM / 中转 / 自建等） | 🚧 理论可行，未验证 |
| `cli`               | 通过本地 CLI 工具调用第三方模型             | ✅ 已验证           |

> **本地 CLI 模式说明**：该模式不直连模型 API，而是把评审请求转交给使用者**自行安装并授权**的本地命令行工具，由其代为调用背后的第三方模型。需先在本机完成对应 CLI 工具的安装与登录授权，应用本身不负责其凭据管理与计费。

---

## 路线图

围绕「让本地化、半自动评审更省心」展开的几个核心方向（排序不代表优先级，欢迎在 issue 中讨论）：

- [ ] **多代码平台适配** —— 在统一适配层上继续扩展 GitLab，自建与公有云托管一并接入。
- [ ] **高阶 Agent 能力** —— 复杂任务的分步规划 + 长期 Memory，让评审从单轮问答走向可累积上下文、多步工具调用的协作。
- [ ] **AutoPilot 预评审** —— 轮询发现新 PR 后按评审者配置的规则自动跑一遍预评审，进应用即见待确认草稿，省去逐个手动触发（决策权仍在评审者，发布前仍需确认）。

更细的分期里程碑见 **[Roadmap](docs/ROADMAP.md)**。

---

## 技术栈

- **桌面壳**：Electron + Vite（electron-vite）
- **渲染层**：React + TypeScript（strict）
- **编辑器**：Monaco（并排 / 内联 diff）
- **工程**：npm workspaces + Nx 单仓多包
- **pr-agent 集成**：内嵌 Python 运行时子进程（缺失时回退系统 pr-agent CLI）

详细架构、数据模型、分期里程碑见 **[Roadmap](docs/ROADMAP.md)**；各模块设计见 **[模块文档](docs/arch/README.md)**。

---

## 开发

环境准备、启动调试、构建打包步骤见 **[开发指南](docs/development/README.md)**。

---

## 隐私与数据

- **本地优先**：除调用 LLM API 与访问所配置的 Git 平台外，不向任何第三方上报数据。
- **工作目录**：应用数据固定在 `~/.code-meeseeks/`（config / state / logs），仓库镜像目录可配置。
- pr-agent 评审时仅把 PR diff + 评审者的规则发给评审者自行配置的 LLM。

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
