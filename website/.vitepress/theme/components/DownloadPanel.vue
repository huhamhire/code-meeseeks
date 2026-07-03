<script setup>
import { ref, computed, onMounted } from 'vue'
import { useData } from 'vitepress'

const REPO = 'huhamhire/code-meeseeks'
const RELEASES_URL = `https://github.com/${REPO}/releases`
const API = `https://api.github.com/repos/${REPO}/releases/latest`

const { lang } = useData()
const zh = computed(() => String(lang.value).toLowerCase().startsWith('zh'))

const t = computed(() => (zh.value ? STR.zh : STR.en))

const state = ref('loading') // loading | ok | error
const release = ref(null)
const os = ref('unknown')

const desktop = computed(() => {
  const a = release.value?.assets ?? []
  return {
    windows: a.find((x) => x.name.endsWith('.exe')),
    macos: a.find((x) => x.name.endsWith('.dmg')),
  }
})

const cli = computed(() => {
  const a = release.value?.assets ?? []
  const re = /-(windows|darwin|linux)-(amd64|arm64)\.(zip|tar\.gz)$/i
  return a
    .filter((x) => x.name.startsWith('meebox-cli-') && re.test(x.name))
    .map((x) => {
      const m = x.name.match(re)
      return { ...x, goos: m[1].toLowerCase(), goarch: m[2].toLowerCase() }
    })
})

const recommendedDesktop = computed(() => {
  if (os.value === 'windows') return desktop.value.windows
  if (os.value === 'macos') return desktop.value.macos
  return null
})

const recommendedCli = computed(() => {
  const list = cli.value
  if (os.value === 'windows') return list.find((x) => x.goos === 'windows')
  if (os.value === 'macos') return list.find((x) => x.goos === 'darwin')
  if (os.value === 'linux') return list.find((x) => x.goos === 'linux' && x.goarch === 'amd64')
  return null
})

function detectOS() {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent || ''
  const plat = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  if (plat.includes('win') || /Windows/i.test(ua)) return 'windows'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (plat.includes('mac') || /Mac OS X/i.test(ua)) return 'macos'
  if (/Android/i.test(ua)) return 'android'
  if (plat.includes('linux') || /Linux|X11/i.test(ua)) return 'linux'
  return 'unknown'
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function osLabel(goos, goarch) {
  const o = { windows: 'Windows', darwin: 'macOS', linux: 'Linux' }[goos] ?? goos
  let arch = goarch === 'amd64' ? 'x64' : 'ARM64'
  if (goos === 'darwin' && goarch === 'arm64') arch = zh.value ? 'Apple 芯片' : 'Apple silicon'
  return `${o} · ${arch}`
}

onMounted(async () => {
  os.value = detectOS()
  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(String(res.status))
    release.value = await res.json()
    state.value = 'ok'
  } catch {
    state.value = 'error'
  }
})

const STR = {
  en: {
    loading: 'Fetching the latest release…',
    errorTitle: 'Could not reach GitHub',
    errorBody: 'See all installers and archives on the Releases page.',
    releasesLink: 'Open Releases',
    latest: 'Latest release',
    notes: 'Release notes',
    recommended: 'Recommended for your system',
    desktop: 'Desktop app',
    cliTitle: 'Command-line tool (meebox)',
    cliIntro:
      'Cross-platform CLI to browse PRs and drive review agents via the local API. The archive doubles as a drop-in agent skill.',
    cliGuide: 'CLI guide',
    download: 'Download',
    linuxNoDesktop: 'No desktop build for Linux yet — use the meebox CLI below.',
    unknown: 'Pick your platform below.',
    winHint: 'Run the .exe installer (NSIS).',
    macHint: 'Open the .dmg → drag to Applications. First launch: right-click → Open (ad-hoc signed, not notarized).',
    cliHint: 'Unzip and put meebox on your PATH, or drop the folder into your agent’s skills directory.',
    embedded: 'pr-agent is embedded — no extra runtime to install.',
  },
  zh: {
    loading: '正在获取最新版本…',
    errorTitle: '无法连接 GitHub',
    errorBody: '可在 Releases 页面查看全部安装包与压缩包。',
    releasesLink: '打开 Releases',
    latest: '最新版本',
    notes: '更新说明',
    recommended: '为你的系统推荐',
    desktop: '桌面应用',
    cliTitle: '命令行工具（meebox）',
    cliIntro:
      '跨平台 CLI，经本地 API 浏览 PR、驱动评审 Agent；压缩包同时即 agent skill 目录，可直接投放。',
    cliGuide: 'CLI 使用说明',
    download: '下载',
    linuxNoDesktop: '暂未提供 Linux 桌面版——请使用下方 meebox CLI。',
    unknown: '请在下方选择你的平台。',
    winHint: '运行 .exe 安装程序（NSIS）。',
    macHint: '打开 .dmg 拖入「应用程序」。首次打开：右键 → 打开（ad-hoc 签名、未公证）。',
    cliHint: '解压后把 meebox 加入 PATH，或将整个目录投放到 agent 的 skills 目录。',
    embedded: '安装包已内嵌 pr-agent，无需额外运行时。',
  },
}
</script>

<template>
  <div class="dl">
    <p v-if="state === 'loading'" class="dl-muted">{{ t.loading }}</p>

    <div v-else-if="state === 'error'" class="dl-card dl-error">
      <strong>{{ t.errorTitle }}</strong>
      <p class="dl-muted">{{ t.errorBody }}</p>
      <a class="dl-btn dl-btn-brand" :href="RELEASES_URL" target="_blank" rel="noreferrer">{{ t.releasesLink }}</a>
    </div>

    <template v-else>
      <div class="dl-head">
        <span class="dl-tag">{{ t.latest }} · {{ release.tag_name }}</span>
        <a class="dl-link" :href="release.html_url" target="_blank" rel="noreferrer">{{ t.notes }} →</a>
      </div>

      <!-- Recommended -->
      <div class="dl-card dl-reco">
        <div class="dl-reco-label">{{ t.recommended }}</div>

        <template v-if="recommendedDesktop">
          <a class="dl-btn dl-btn-brand" :href="recommendedDesktop.browser_download_url">
            {{ t.download }} · {{ os === 'windows' ? 'Windows x64' : 'macOS (Apple silicon)' }}
            <span class="dl-size">{{ fmtSize(recommendedDesktop.size) }}</span>
          </a>
          <p class="dl-muted dl-hint">{{ os === 'windows' ? t.winHint : t.macHint }}</p>
        </template>

        <template v-else-if="os === 'linux' && recommendedCli">
          <p class="dl-muted">{{ t.linuxNoDesktop }}</p>
          <a class="dl-btn dl-btn-brand" :href="recommendedCli.browser_download_url">
            {{ t.download }} · meebox CLI · {{ osLabel(recommendedCli.goos, recommendedCli.goarch) }}
            <span class="dl-size">{{ fmtSize(recommendedCli.size) }}</span>
          </a>
        </template>

        <p v-else class="dl-muted">{{ t.unknown }}</p>
      </div>

      <!-- Desktop app -->
      <h3>{{ t.desktop }}</h3>
      <p class="dl-muted dl-embedded">{{ t.embedded }}</p>
      <ul class="dl-list">
        <li v-if="desktop.windows">
          <span class="dl-plat">Windows · x64</span>
          <span class="dl-file">{{ desktop.windows.name }}</span>
          <a class="dl-btn" :href="desktop.windows.browser_download_url">
            {{ t.download }} <span class="dl-size">{{ fmtSize(desktop.windows.size) }}</span>
          </a>
        </li>
        <li v-if="desktop.macos">
          <span class="dl-plat">macOS · Apple silicon</span>
          <span class="dl-file">{{ desktop.macos.name }}</span>
          <a class="dl-btn" :href="desktop.macos.browser_download_url">
            {{ t.download }} <span class="dl-size">{{ fmtSize(desktop.macos.size) }}</span>
          </a>
        </li>
      </ul>

      <!-- CLI -->
      <h3>{{ t.cliTitle }}</h3>
      <p class="dl-muted">{{ t.cliIntro }} <a class="dl-link" :href="`${RELEASES_URL.replace('/releases', '')}/tree/master/cli`" target="_blank" rel="noreferrer">{{ t.cliGuide }} →</a></p>
      <ul class="dl-list" v-if="cli.length">
        <li v-for="a in cli" :key="a.name">
          <span class="dl-plat">{{ osLabel(a.goos, a.goarch) }}</span>
          <span class="dl-file">{{ a.name }}</span>
          <a class="dl-btn" :href="a.browser_download_url">
            {{ t.download }} <span class="dl-size">{{ fmtSize(a.size) }}</span>
          </a>
        </li>
      </ul>
      <p class="dl-muted dl-hint">{{ t.cliHint }}</p>
    </template>
  </div>
</template>

<style scoped>
.dl {
  margin: 8px 0 4px;
}
.dl-muted {
  color: var(--vp-c-text-2);
}
.dl-hint {
  font-size: 13px;
  margin-top: 8px;
}
.dl-head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.dl-tag {
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 12px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.dl-link {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
.dl-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 20px;
  background: var(--vp-c-bg-soft);
}
.dl-reco {
  border-color: var(--vp-c-brand-3);
}
.dl-reco-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--vp-c-brand-1);
  font-weight: 700;
  margin-bottom: 12px;
}
.dl-error {
  border-color: var(--vp-c-warning-1, var(--vp-c-divider));
}
.dl-list {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dl-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.dl-plat {
  font-weight: 600;
  min-width: 160px;
}
.dl-file {
  flex: 1 1 200px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
  word-break: break-all;
}
.dl-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-brand-2);
  color: var(--vp-c-brand-1);
  font-weight: 600;
  font-size: 14px;
  transition: all 0.2s;
}
.dl-btn:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.dl-btn-brand {
  background: var(--vp-c-brand-3);
  border-color: var(--vp-c-brand-3);
  color: #fff;
}
.dl-btn-brand:hover {
  background: var(--vp-c-brand-2);
  border-color: var(--vp-c-brand-2);
  color: #fff;
}
.dl-size {
  font-weight: 400;
  font-size: 12px;
  opacity: 0.8;
}
.dl-embedded {
  margin-top: 4px;
}
</style>
