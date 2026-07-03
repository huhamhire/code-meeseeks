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

  // The guide under /zh/guide/ is generated from docs/guide/ (single source of
  // truth, not maintained here). Its cross-links may carry anchor slugs that
  // don't match VitePress's, so scope dead-link tolerance to that subtree and to
  // anchor fragments — landing/nav links are still checked.
  ignoreDeadLinks: [/^\/zh\/guide\//, /#/],

  themeConfig: {
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: `${REPO}/tree/master/docs/guide` },
          { text: 'Roadmap', link: `${REPO}/blob/master/docs/ROADMAP.md` },
          { text: 'Download', link: `${REPO}/releases` },
        ],
        footer: {
          message: 'Released under the Apache License 2.0.',
          copyright: `An unofficial, independent open-source tool. Not affiliated with Rick and Morty.`,
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
          { text: '路线图', link: `${REPO}/blob/master/docs/ROADMAP.md` },
          { text: '下载', link: `${REPO}/releases` },
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
          message: '基于 Apache License 2.0 发布。',
          copyright: '非官方、独立的开源工具，与 Rick and Morty 无任何关联。',
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
