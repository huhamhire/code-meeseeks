---
layout: home

hero:
  name: Code Meeseeks
  text: AI 代码评审，决策权在你
  tagline: 面向 Reviewer 个人的本地化、半自动 AI 代码评审桌面客户端，基于 pr-agent 构建。决策权在人、规则在本地、数据在本地。
  image:
    src: /logo.png
    alt: Code Meeseeks
  actions:
    - theme: brand
      text: 下载
      link: https://github.com/huhamhire/code-meeseeks/releases
    - theme: alt
      text: 在 GitHub 查看
      link: https://github.com/huhamhire/code-meeseeks

features:
  - icon: 🧑‍⚖️
    title: 决策权在人
    details: 所有评论都需你二次确认 / 编辑后才会发到远端，AI 只做草稿，最终决定权始终在你手里。
  - icon: 🔒
    title: 数据在本地
    details: 仓库副本、PR 元数据、评论草稿都存在本机；接入本地模型即可全程不出本机，企业内网友好。
  - icon: 🌍
    title: GitHub · Bitbucket · GitLab
    details: 统一接入多平台，含自建 GitHub Enterprise 与 GitLab Self-Managed，按平台能力自适应降级。
  - icon: 🤖
    title: Agentic 评审
    details: 指令驱动 pr-agent，叠加自主编排、AutoPilot 预评审与复评闭环；过程可观测，可中途追加、随时停止。
  - icon: ⚙️
    title: 你的模型，你的规则
    details: 多 LLM Provider（OpenAI / Anthropic / DeepSeek 及任意 OpenAI 兼容端点）+ 完全自控的个性化规则目录。
  - icon: 🔌
    title: CLI 与外部集成
    details: 本地 API + 跨平台 meebox CLI，让外部 agent、脚本、CI 把 PR 评审纳入自动化流程。
---

<figure class="screenshot-frame">
  <img src="/screenshot-placeholder.svg" alt="Code Meeseeks 界面预览" />
  <figcaption>界面预览 —— 正式截图即将上线。</figcaption>
</figure>

## 下载

到 [Releases 页面](https://github.com/huhamhire/code-meeseeks/releases) 下载对应平台安装包。安装包已内嵌 pr-agent，无需额外运行时。

| 平台        | 安装包                                        | 状态    |
| ----------- | --------------------------------------------- | ------- |
| Windows x64 | `code-meeseeks-<version>-win-x64.exe`（NSIS） | ✅ 可用 |
| macOS arm64 | `code-meeseeks-<version>-mac-arm64.dmg`       | ✅ 可用 |

::: tip macOS 首次打开
安装包为 ad-hoc 签名、未做 Apple 公证（本项目是免费开源软件，未购置 Apple Developer 付费账号）。首次打开请右键点击 App → **打开**，或到 **系统设置 → 隐私与安全性 → 仍要打开**，确认一次后即可正常启动。
:::

## 常见问题

::: details 我的代码会离开本机吗？
只有你配置的内容会外发：PR diff 与你的规则发给你自行配置的 LLM 服务商，Code Meeseeks 只与你接入的 Git 平台通信，此外不上报任何数据。接入本地模型（如本地 Ollama）即可全程不出本机。
:::

::: details 需要额外装 Python 或 Docker 吗？
不需要。pr-agent 及其 Python 运行时已内嵌进安装包，装完即用。
:::

::: details 支持哪些平台与模型？
平台：GitHub（含 Enterprise Server）、Bitbucket Server / Data Center、GitLab（含 Self-Managed）。模型：任意 OpenAI 兼容 / litellm 支持的服务商——OpenAI、Anthropic、DeepSeek 等，或本地模型。
:::

::: details 这是 CI 里的评审 bot 吗？
不是。Code Meeseeks 是面向 Reviewer 个人的桌面工具——每条评论都需你二次确认 / 编辑后才会发布。CI 中自动评审是 pr-agent 本身的定位。
:::

::: details token 成本如何？
Agentic 评审与 AutoPilot 会对每个 PR 串联多次模型调用，token 消耗高于单次手动评审。每步用量都在评审时间线上分步展示，便于观察——无论用按量计费 API 还是本地 CLI / 订阅账户。
:::

::: details 是免费开源的吗？
是，采用 Apache-2.0 许可。源码完全公开、可自行审计与构建。
:::
