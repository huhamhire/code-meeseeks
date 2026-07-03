---
title: 常见问题
aside: false
outline: false
pageClass: mb-grid
---

# 常见问题

<div class="faq">

### 🔒 我的代码会离开本机吗？

只有你配置的内容会外发。PR diff 与你的规则发给你自行配置的 LLM 服务商，Code Meeseeks 只与你接入的 Git 平台通信——此外不上报任何数据。

接入本地模型（如本地 Ollama）即可全程不出本机。

### 📦 需要额外装 Python 或 Docker 吗？

不需要。pr-agent 及其 Python 运行时已内嵌进安装包，装完即用。

### 🧩 支持哪些平台与模型？

平台：GitHub（含 Enterprise Server）、Bitbucket Server / Data Center、GitLab（含 Self-Managed）。

模型：任意 OpenAI 兼容 / litellm 支持的服务商——OpenAI、Anthropic、DeepSeek 等，或本地模型。

### 🤖 这是 CI 里的评审 bot 吗？

不是。Code Meeseeks 是面向 Reviewer 个人的桌面工具——每条评论都需你二次确认 / 编辑后才会发布。

CI 中自动评审是 pr-agent 本身的定位。

### 💸 token 成本如何？

Agentic 评审与 AutoPilot 会对每个 PR 串联多次模型调用，token 消耗高于单次手动评审。

每步用量都在评审时间线上分步展示，便于观察——无论用按量计费 API 还是本地 CLI / 订阅账户。

### ⚖️ 是免费开源的吗？

是，采用 Apache-2.0 许可。源码完全公开、可自行审计与构建。

### 🎬 与《瑞克和莫蒂》有关联吗？

没有。Code Meeseeks 是非官方、独立的开源工具——与《_Rick and Morty_》及其权利方无任何关联，亦未获授权或认可。

「Rick and Morty」「Mr. Meeseeks」等名称与角色的商标归各自权利人所有（Adult Swim / Warner Bros. Discovery）。本项目名称与图标仅为致敬。

</div>
