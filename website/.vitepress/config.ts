import { defineConfig } from 'vitepress'

const REPO = 'https://github.com/huhamhire/code-meeseeks'
const description =
  'A local, semi-automated AI code-review desktop client for the individual reviewer, built on pr-agent.'

// GitHub Pages project site serves under /<repo>/ by default.
// Set SITE_BASE=/ when a custom domain (CNAME) is configured.
const base = process.env.SITE_BASE ?? '/code-meeseeks/'

export default defineConfig({
  base,
  title: 'Code Meeseeks',
  description,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  metaChunk: true,

  // README.md is the dev-facing readme (repo-relative links), not a site page.
  srcExclude: ['README.md'],

  // The guide under /guide/ and /zh/guide/ is generated from docs/guide/ (single
  // source of truth, not maintained here). Its cross-links may carry anchor slugs
  // that don't match VitePress's, so scope dead-link tolerance to those subtrees
  // and to anchor fragments — landing/nav links are still checked.
  ignoreDeadLinks: [/^\/guide\//, /^\/zh\/guide\//, /#/],

  // base-aware so favicons resolve on the GitHub Pages project sub-path too.
  head: [
    ['link', { rel: 'icon', href: `${base}favicon.ico`, sizes: '48x48' }],
    ['link', { rel: 'icon', type: 'image/png', href: `${base}logo.png` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}logo.png` }],
  ],

  // Use Dart Sass's modern API (silences the legacy-js-api deprecation warning).
  vite: {
    css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
  },

  themeConfig: {
    logo: '/logo.png',
    socialLinks: [{ icon: 'github', link: REPO }],
    // Local search: the root (English) locale uses the built-in defaults; the zh
    // locale needs its own UI-chrome translations (placeholder, no-results,
    // keyboard hints) — the search index is per-locale, but the modal text isn't
    // localized unless declared here (key must match the `locales` key: `zh`).
    search: {
      provider: 'local',
      options: {
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '清除查询条件',
                backButtonTitle: '关闭搜索',
                noResultsText: '无法找到相关结果',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '回车',
                  navigateText: '切换',
                  navigateUpKeyAriaLabel: '上箭头',
                  navigateDownKeyAriaLabel: '下箭头',
                  closeText: '关闭',
                  closeKeyAriaLabel: 'esc',
                },
              },
            },
          },
        },
      },
    },
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/' },
          { text: 'Download', link: '/download' },
          { text: 'FAQ', link: '/faq' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'User Guide',
              items: [
                { text: 'Overview', link: '/guide/' },
                { text: 'Installation & first use', link: '/guide/00-getting-started' },
                { text: 'Code platform setup', link: '/guide/01-code-platform' },
                { text: 'LLM setup', link: '/guide/02-llm' },
                { text: 'Network proxy setup', link: '/guide/03-proxy' },
                { text: 'Config file reference', link: '/guide/04-config-reference' },
                { text: 'Custom review rules', link: '/guide/05-rules' },
                { text: 'CLI tool', link: '/guide/06-cli' },
              ],
            },
          ],
        },
        footer: {
          message: 'Released under the Apache License 2.0.',
          copyright:
            'Built on the community edition of <a href="https://docs.pr-agent.ai/" target="_blank" rel="noreferrer">PR-Agent</a> (Qodo), bundled under its own license.<br>An unofficial, independent open-source tool — not affiliated with Rick and Morty.',
        },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      description: '面向 Reviewer 个人的本地化、半自动 AI 代码评审桌面客户端，基于 pr-agent 构建。',
      themeConfig: {
        nav: [
          { text: '使用说明', link: '/zh/guide/' },
          { text: '下载', link: '/zh/download' },
          { text: '常见问题', link: '/zh/faq' },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '使用说明',
              items: [
                { text: '概览', link: '/zh/guide/' },
                { text: '安装与首次使用', link: '/zh/guide/00-getting-started' },
                { text: '代码平台配置', link: '/zh/guide/01-code-platform' },
                { text: 'LLM 配置', link: '/zh/guide/02-llm' },
                { text: '网络代理配置', link: '/zh/guide/03-proxy' },
                { text: '配置文件参考', link: '/zh/guide/04-config-reference' },
                { text: '自定义评审规则', link: '/zh/guide/05-rules' },
                { text: 'CLI 命令行工具', link: '/zh/guide/06-cli' },
              ],
            },
          ],
        },
        footer: {
          message: '采用 Apache License 2.0 发布。',
          copyright:
            '基于 <a href="https://docs.pr-agent.ai/" target="_blank" rel="noreferrer">PR-Agent</a> 社区版（Qodo）构建，按其自身许可证分发。<br>非官方、独立的开源工具，与 Rick and Morty 无任何关联。',
        },
        docFooter: { prev: '上一页', next: '下一页' },
        outline: { label: '本页目录' },
        lastUpdated: { text: '最后更新于' },
        langMenuLabel: '切换语言',
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '菜单',
        darkModeSwitchLabel: '主题',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
      },
    },
  },
})
