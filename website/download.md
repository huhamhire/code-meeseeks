---
title: Download
outline: [2, 2]
---

# Download

<DownloadPanel />

## First launch

The installers are not signed with a paid code-signing certificate (this is free, open-source software), so the OS shows a one-time security prompt on first launch. This is expected — the source is public and auditable.

::: tip 🪟 Windows — SmartScreen
Running the `.exe` may trigger **“Windows protected your PC”** (Microsoft Defender SmartScreen) for an unrecognized publisher. Click **More info**, then **Run anyway**. You only need to do this once.
:::

::: tip 🍎 macOS — Gatekeeper
The app is ad-hoc signed and not Apple-notarized (no paid Apple Developer account), so Gatekeeper blocks the first launch. Fix it once, either way:

- **Right-click** the app in Applications → **Open** → **Open** in the dialog; or
- **System Settings → Privacy & Security** → scroll to the blocked-app notice → **Open Anyway**.

After confirming once, it launches normally from then on.
:::

## FAQ

::: details 🔒 Does my code leave my machine?
Only what you configure: the PR diff and your rules go to the LLM provider you set up, and Code Meeseeks talks to the Git platform you connect. Nothing else is reported. Wire up a local model (e.g. local Ollama) and nothing ever leaves your machine.
:::

::: details 📦 Do I need to install Python or Docker?
No. pr-agent and its Python runtime are embedded in the installer — it works right after installation.
:::

::: details 🧩 Which platforms and models are supported?
Platforms: GitHub (incl. Enterprise Server), Bitbucket Server / Data Center, and GitLab (incl. Self-Managed). Models: any OpenAI-compatible / litellm-supported provider — OpenAI, Anthropic, DeepSeek, and more — or a local model.
:::

::: details 🤖 Is this a CI review bot?
No. Code Meeseeks is a desktop tool for the individual reviewer — every comment is confirmed or edited by you before it is published. Automated in-CI review is what pr-agent itself is for.
:::

::: details 💸 What about token cost?
Agentic review and AutoPilot chain several model calls per PR, so token use is higher than a single manual review. Per-step usage is shown on the review timeline so you can watch it, whether you use a pay-as-you-go API or a local CLI / subscription account.
:::

::: details ⚖️ Is it free and open source?
Yes — licensed under Apache-2.0. The source is public, auditable, and buildable yourself.
:::
