<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'

const { lang } = useData()
const zh = computed(() => String(lang.value).toLowerCase().startsWith('zh'))

// Conceptual icons from Lucide (ISC), monochrome currentColor stroke.
const PATHS = {
  gavel:
    '<path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3l8.384-8.381"/><path d="m16 16 6-6"/><path d="m21.5 10.5-8-8"/><path d="m8 8 6-6"/><path d="m8.5 7.5 8 8"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  sliders:
    '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>',
  terminal: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
}
function icon(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`
}

const EN = [
  {
    icon: 'gavel',
    title: 'The human decides',
    points: ["You confirm or edit every comment before it's published", 'The AI only drafts — you keep the final call'],
  },
  {
    icon: 'lock',
    title: 'Data stays local',
    points: ['Repo mirrors, PR metadata & drafts stay on your machine', 'Wire up a local model and nothing ever leaves it'],
  },
  {
    icon: 'globe',
    title: 'Multi-platform access',
    points: ['GitHub · Bitbucket · GitLab, incl. self-hosted Enterprise / Self-Managed', "Adapts to each platform's capabilities"],
  },
  {
    icon: 'bot',
    title: 'Agentic review',
    points: [
      'Command-driven pr-agent + autonomous orchestration',
      'AutoPilot pre-review & re-review loop',
      'Observable, interruptible process',
    ],
  },
  {
    icon: 'sliders',
    title: 'Your models, your rules',
    points: ['Many LLM providers (OpenAI, Anthropic, DeepSeek…)', 'A personalized rules directory you fully control'],
  },
  {
    icon: 'terminal',
    title: 'CLI & integration',
    points: ['Local API + cross-platform meebox CLI', 'Fold PR review into agents, scripts & CI'],
  },
]

const ZH = [
  {
    icon: 'gavel',
    title: '决策权在人',
    points: ['每条评论都需你二次确认 / 编辑后才发布', 'AI 只做草稿，最终决定权始终在你手里'],
  },
  {
    icon: 'lock',
    title: '数据在本地',
    points: ['仓库副本、PR 元数据、草稿都存本机', '接入本地模型即可全程不出本机'],
  },
  {
    icon: 'globe',
    title: '多平台接入',
    points: ['GitHub · Bitbucket · GitLab，含自建 Enterprise / Self-Managed', '按平台能力自适应降级'],
  },
  {
    icon: 'bot',
    title: 'Agentic 评审',
    points: ['指令驱动 pr-agent + 自主编排', 'AutoPilot 预评审 + 复评闭环', '过程可观测，可中途追加、随时停止'],
  },
  {
    icon: 'sliders',
    title: '你的模型，你的规则',
    points: ['多 LLM Provider（OpenAI / Anthropic / DeepSeek…）', '完全自控的个性化规则目录'],
  },
  {
    icon: 'terminal',
    title: 'CLI 与外部集成',
    points: ['本地 API + 跨平台 meebox CLI', '把 PR 评审纳入 agent、脚本、CI'],
  },
]

const features = computed(() => (zh.value ? ZH : EN))
</script>

<template>
  <div class="hf">
    <div v-for="(f, i) in features" :key="i" class="hf-card">
      <div class="hf-head">
        <span class="hf-icon" v-html="icon(f.icon)" />
        <h3 class="hf-title">{{ f.title }}</h3>
      </div>
      <ul class="hf-points">
        <li v-for="p in f.points" :key="p">{{ p }}</li>
      </ul>
    </div>
  </div>
</template>
