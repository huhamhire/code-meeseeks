---
layout: home

hero:
  name: Code Meeseeks
  text: AI code review, on your terms
  tagline: A local, semi-automated AI code-review desktop client for the individual reviewer — built on pr-agent. The human decides, rules stay local, data stays local.
  image:
    src: /logo.png
    alt: Code Meeseeks
  actions:
    - theme: brand
      text: Download
      link: https://github.com/huhamhire/code-meeseeks/releases
    - theme: alt
      text: View on GitHub
      link: https://github.com/huhamhire/code-meeseeks

features:
  - icon: 🧑‍⚖️
    title: The human decides
    details: Every comment is confirmed or edited by you before it reaches the remote. The AI only drafts — you keep the final call.
  - icon: 🔒
    title: Data stays local
    details: Repository mirrors, PR metadata, and comment drafts all live on your machine. Wire up a local model and nothing ever leaves it.
  - icon: 🌍
    title: GitHub · Bitbucket · GitLab
    details: Unified access across platforms, including self-hosted GitHub Enterprise and GitLab Self-Managed, adapting to each platform's capabilities.
  - icon: 🤖
    title: Agentic review
    details: Command-driven pr-agent plus autonomous orchestration, AutoPilot pre-review, and a re-review loop — with an observable, interruptible process.
  - icon: ⚙️
    title: Your models, your rules
    details: Multiple LLM providers (OpenAI, Anthropic, DeepSeek, and any OpenAI-compatible endpoint) and a personalized rules directory you fully control.
  - icon: 🔌
    title: CLI & integration
    details: A local API and the cross-platform meebox CLI let external agents, scripts, and CI fold PR review into automated workflows.
---

<figure class="screenshot-frame">
  <img src="/screenshot-placeholder.svg" alt="Code Meeseeks UI preview" />
  <figcaption>Interface preview — a polished screenshot is on the way.</figcaption>
</figure>

## Download

Grab the installer for your platform from the [Releases page](https://github.com/huhamhire/code-meeseeks/releases). pr-agent is embedded — there is no extra runtime to install.

| Platform    | Installer                                     | Status      |
| ----------- | --------------------------------------------- | ----------- |
| Windows x64 | `code-meeseeks-<version>-win-x64.exe` (NSIS)  | ✅ Available |
| macOS arm64 | `code-meeseeks-<version>-mac-arm64.dmg`       | ✅ Available |

::: tip macOS first launch
The installer is ad-hoc signed and not Apple-notarized (this is free, open-source software without a paid Apple Developer account). On first open, right-click the app → **Open**, or go to **System Settings → Privacy & Security → Open Anyway**. Confirm once and it launches normally.
:::

## FAQ

::: details Does my code leave my machine?
Only what you configure: the PR diff and your rules go to the LLM provider you set up, and Code Meeseeks talks to the Git platform you connect. Nothing else is reported. Wire up a local model (e.g. local Ollama) and nothing ever leaves your machine.
:::

::: details Do I need to install Python or Docker?
No. pr-agent and its Python runtime are embedded in the installer — it works right after installation.
:::

::: details Which platforms and models are supported?
Platforms: GitHub (incl. Enterprise Server), Bitbucket Server / Data Center, and GitLab (incl. Self-Managed). Models: any OpenAI-compatible / litellm-supported provider — OpenAI, Anthropic, DeepSeek, and more — or a local model.
:::

::: details Is this a CI review bot?
No. Code Meeseeks is a desktop tool for the individual reviewer — every comment is confirmed or edited by you before it is published. Automated in-CI review is what pr-agent itself is for.
:::

::: details What about token cost?
Agentic review and AutoPilot chain several model calls per PR, so token use is higher than a single manual review. Per-step usage is shown on the review timeline so you can watch it, whether you use a pay-as-you-go API or a local CLI / subscription account.
:::

::: details Is it free and open source?
Yes — licensed under Apache-2.0. The source is public, auditable, and buildable yourself.
:::
