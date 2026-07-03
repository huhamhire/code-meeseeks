<script setup>
import { ref, computed, onMounted } from 'vue'
import { useData } from 'vitepress'
import { detectOS } from '../os'
import { useLatestRelease } from '../composables/useLatestRelease'

const REPO = 'huhamhire/code-meeseeks'
const RELEASES_URL = `https://github.com/${REPO}/releases`
const GUIDE_URL = `https://github.com/${REPO}/tree/master/docs/guide`
const CLI_GUIDE_URL = `https://github.com/${REPO}/tree/master/cli`
const CLI_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/huhamhire/code-meeseeks/main/tools/cli/install.sh | bash'

// UI glyphs for the copy button.
const CLIPBOARD_ICON =
  'M16 1H4a2 2 0 00-2 2v14h2V3h12V1zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11v14z'
const CHECK_ICON = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'

// Platform glyphs (24×24, currentColor). Apple / Linux from simple-icons (CC0);
// Windows is the four-pane mark.
const ICON = {
  windows:
    'M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801',
  apple:
    'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701',
  linux:
    'M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z',
  desktop:
    'M2 4.5A1.5 1.5 0 0 1 3.5 3h17A1.5 1.5 0 0 1 22 4.5v10a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 14.5zM11 16h2v2h4v2H7v-2h4z',
  terminal: 'M4 7l2-2 7 7-7 7-2-2 5-5zM12 17h8v2h-8z',
}
function iconFor(goos) {
  if (goos === 'darwin' || goos === 'macos') return ICON.apple
  if (goos === 'windows') return ICON.windows
  if (goos === 'linux') return ICON.linux
  return ''
}

const { lang } = useData()
const zh = computed(() => String(lang.value).toLowerCase().startsWith('zh'))
const t = computed(() => (zh.value ? STR.zh : STR.en))

const { state, release, desktop, cli } = useLatestRelease()
const os = ref('unknown')
const tab = ref('gui') // gui | cli
const copied = ref(false)

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(CLI_INSTALL)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    /* clipboard unavailable — ignore */
  }
}

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

const osName = computed(
  () => ({ windows: 'Windows', macos: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android' })[os.value] ?? '',
)

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

onMounted(() => {
  os.value = detectOS()
  tab.value = os.value === 'linux' ? 'cli' : 'gui'
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
    desktopIntro: 'The full graphical client — discover, read, review, and publish PRs, all on your machine.',
    guideLink: 'User guide',
    cliTitle: 'Command-line tool (meebox)',
    cliIntro:
      'Cross-platform CLI to browse PRs and drive review agents via the local API. The archive doubles as a drop-in agent skill.',
    cliGuide: 'CLI guide',
    cliQuick: 'One-line install (macOS / Linux)',
    cliQuickNote: 'Auto-detects OS/arch, verifies SHA-256, installs meebox to your PATH. On Windows, download the archive below.',
    copy: 'Copy',
    copied: 'Copied',
    download: 'Download',
    linuxNoDesktop: 'No desktop build for Linux yet — use the meebox CLI below.',
    unknown: 'Pick your platform below.',
    firstLaunch: 'First launch',
    winHint: [
      'SmartScreen may warn “Windows protected your PC”.',
      'Click “More info” → “Run anyway”.',
      'One-time — this is an unsigned free / open-source build.',
    ],
    macHint: [
      'Gatekeeper blocks the first launch.',
      'Right-click the app → Open, or System Settings → Privacy & Security → Open Anyway.',
      'One-time — ad-hoc signed, not notarized.',
    ],
    cliHint: 'Unzip and put meebox on your PATH, or drop the folder into your agent’s skills directory.',
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
    desktopIntro: '完整图形客户端——在本机发现、阅读、评审并发布 PR。',
    guideLink: '使用说明',
    cliTitle: '命令行工具（meebox）',
    cliIntro:
      '跨平台 CLI，经本地 API 浏览 PR、驱动评审 Agent；压缩包同时即 agent skill 目录，可直接投放。',
    cliGuide: 'CLI 使用说明',
    cliQuick: '一键安装（macOS / Linux）',
    cliQuickNote: '自动探测系统 / 架构、校验 SHA-256，将 meebox 装入 PATH。Windows 请下载下方压缩包。',
    copy: '复制',
    copied: '已复制',
    download: '下载',
    linuxNoDesktop: '暂未提供 Linux 桌面版——请使用下方 meebox CLI。',
    unknown: '请在下方选择你的平台。',
    firstLaunch: '首次启动',
    winHint: [
      'SmartScreen 可能弹「Windows 已保护你的电脑」。',
      '点「更多信息」→「仍要运行」。',
      '一次即可——这是未签名的免费 / 开源构建。',
    ],
    macHint: [
      'Gatekeeper 会拦下首次启动。',
      '右键点应用 → 打开，或 系统设置 → 隐私与安全性 → 仍要打开。',
      '一次即可——ad-hoc 签名、未公证。',
    ],
    cliHint: '解压后把 meebox 加入 PATH，或将整个目录投放到 agent 的 skills 目录。',
  },
}
</script>

<template>
  <div class="dl">
    <!-- Skeleton mirroring the loaded layout (head · recommended card · tabs · rows). -->
    <div v-if="state === 'loading'" class="dl-skel" role="status" :aria-label="t.loading">
      <div class="dl-head">
        <span class="sk sk-tag"></span>
        <span class="sk sk-link"></span>
      </div>
      <div class="dl-card dl-reco">
        <span class="sk sk-label"></span>
        <span class="sk sk-btn"></span>
        <span class="sk sk-note"></span>
      </div>
      <div class="dl-skel-tabs">
        <span class="sk sk-tab"></span>
        <span class="sk sk-tab"></span>
      </div>
      <span class="sk sk-row"></span>
      <span class="sk sk-row"></span>
    </div>

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

      <!-- Recommended for the detected OS -->
      <div class="dl-card dl-reco">
        <div class="dl-reco-label">
          {{ t.recommended }}<template v-if="osName">
            · <svg v-if="iconFor(os)" class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="iconFor(os)" /></svg>
            {{ osName }}</template>
        </div>

        <template v-if="recommendedDesktop">
          <a class="dl-btn dl-btn-brand" :href="recommendedDesktop.browser_download_url">
            {{ t.download }} · {{ os === 'windows' ? 'Windows x64' : 'macOS (Apple silicon)' }}
            <span class="dl-size">{{ fmtSize(recommendedDesktop.size) }}</span>
          </a>
          <div class="custom-block info dl-note">
            <p class="custom-block-title">ℹ️ {{ t.firstLaunch }}</p>
            <ul>
              <li v-for="line in os === 'windows' ? t.winHint : t.macHint" :key="line">{{ line }}</li>
            </ul>
          </div>
        </template>

        <template v-else-if="os === 'linux' && recommendedCli">
          <p class="dl-muted">{{ t.linuxNoDesktop }}</p>
          <a class="dl-btn dl-btn-brand" :href="recommendedCli.browser_download_url">
            {{ t.download }} · meebox CLI · {{ osLabel(recommendedCli.goos, recommendedCli.goarch) }}
            <span class="dl-size">{{ fmtSize(recommendedCli.size) }}</span>
          </a>
          <p class="dl-muted dl-hint">{{ t.cliHint }}</p>
        </template>

        <p v-else class="dl-muted">{{ t.unknown }}</p>
      </div>

      <!-- GUI / CLI tabs -->
      <div class="dl-tabs" role="tablist">
        <button class="dl-tab" role="tab" :class="{ active: tab === 'gui' }" :aria-selected="tab === 'gui'" @click="tab = 'gui'">
          <svg class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON.desktop" /></svg>{{ t.desktop }}
        </button>
        <button class="dl-tab" role="tab" :class="{ active: tab === 'cli' }" :aria-selected="tab === 'cli'" @click="tab = 'cli'">
          <svg class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON.terminal" /></svg>{{ t.cliTitle }}
        </button>
      </div>

      <!-- Desktop app -->
      <div v-show="tab === 'gui'" role="tabpanel">
        <p class="dl-muted">{{ t.desktopIntro }}</p>
        <p class="dl-links">
          <a class="dl-link" :href="GUIDE_URL" target="_blank" rel="noreferrer">{{ t.guideLink }} →</a>
        </p>
        <ul class="dl-list">
          <li v-if="desktop.windows">
            <span class="dl-plat">
              <svg class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON.windows" /></svg>
              Windows · x64
            </span>
            <span class="dl-file">{{ desktop.windows.name }}</span>
            <a class="dl-btn" :href="desktop.windows.browser_download_url">
              {{ t.download }} <span class="dl-size">{{ fmtSize(desktop.windows.size) }}</span>
            </a>
          </li>
          <li v-if="desktop.macos">
            <span class="dl-plat">
              <svg class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICON.apple" /></svg>
              macOS · Apple silicon
            </span>
            <span class="dl-file">{{ desktop.macos.name }}</span>
            <a class="dl-btn" :href="desktop.macos.browser_download_url">
              {{ t.download }} <span class="dl-size">{{ fmtSize(desktop.macos.size) }}</span>
            </a>
          </li>
        </ul>
      </div>

      <!-- CLI -->
      <div v-show="tab === 'cli'" role="tabpanel">
        <p class="dl-muted">{{ t.cliIntro }}</p>
        <p class="dl-links">
          <a class="dl-link" :href="CLI_GUIDE_URL" target="_blank" rel="noreferrer">{{ t.cliGuide }} →</a>
        </p>

        <div class="dl-cmd">
          <div class="dl-cmd-label">{{ t.cliQuick }}</div>
          <div class="dl-cmd-row">
            <code>{{ CLI_INSTALL }}</code>
            <button
              class="dl-copy"
              :class="{ 'is-copied': copied }"
              :title="copied ? t.copied : t.copy"
              :aria-label="copied ? t.copied : t.copy"
              @click="copyInstall"
            >
              <svg class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="copied ? CHECK_ICON : CLIPBOARD_ICON" /></svg>
            </button>
          </div>
          <p class="dl-muted dl-hint">{{ t.cliQuickNote }}</p>
        </div>

        <ul class="dl-list" v-if="cli.length">
          <li v-for="a in cli" :key="a.name">
            <span class="dl-plat">
              <svg class="dl-ico" viewBox="0 0 24 24" aria-hidden="true"><path :d="iconFor(a.goos)" /></svg>
              {{ osLabel(a.goos, a.goarch) }}
            </span>
            <span class="dl-file">{{ a.name }}</span>
            <a class="dl-btn" :href="a.browser_download_url">
              {{ t.download }} <span class="dl-size">{{ fmtSize(a.size) }}</span>
            </a>
          </li>
        </ul>
        <p class="dl-muted dl-hint">{{ t.cliHint }}</p>
      </div>
    </template>
  </div>
</template>

