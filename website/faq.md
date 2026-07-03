---
title: FAQ
aside: false
outline: false
pageClass: mb-grid
---

# FAQ

<div class="faq">

### 🔒 Does my code leave my machine?

Only what you configure. The PR diff and your rules go to the LLM provider you set up, and Code Meeseeks talks to the Git platform you connect — nothing else is reported.

Wire up a local model (e.g. local Ollama) and nothing ever leaves your machine.

### 📦 Do I need to install Python or Docker?

No. pr-agent and its Python runtime are embedded in the installer — it works right after installation.

### 🧩 Which platforms and models are supported?

Platforms: GitHub (incl. Enterprise Server), Bitbucket Server / Data Center, and GitLab (incl. Self-Managed).

Models: any OpenAI-compatible / litellm-supported provider — OpenAI, Anthropic, DeepSeek, and more — or a local model.

### 🤖 Is this a CI review bot?

No. Code Meeseeks is a desktop tool for the individual reviewer — every comment is confirmed or edited by you before it is published.

Automated in-CI review is what pr-agent itself is for.

### 💸 What about token cost?

Agentic review and AutoPilot chain several model calls per PR, so token use is higher than a single manual review.

Per-step usage is shown on the review timeline so you can watch it, whether you use a pay-as-you-go API or a local CLI / subscription account.

### ⚖️ Is it free and open source?

Yes — licensed under Apache-2.0. The source is public, auditable, and buildable yourself.

### 🎬 Is this affiliated with Rick and Morty?

No. Code Meeseeks is an unofficial, independent open-source tool — not affiliated with, authorized by, or endorsed by _Rick and Morty_ or its rights holders.

Names and characters such as "Rick and Morty" and "Mr. Meeseeks" are trademarks of their respective owners (Adult Swim / Warner Bros. Discovery). The project's name and icon are an homage only.

</div>
