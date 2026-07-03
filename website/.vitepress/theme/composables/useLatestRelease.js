import { ref, computed, onMounted } from 'vue'

// Fetches the latest GitHub release and categorizes its assets into the
// desktop installers and the meebox CLI archives. Presentation (OS detection,
// recommendations, i18n) stays in the component.
const REPO = 'huhamhire/code-meeseeks'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const CLI_RE = /-(windows|darwin|linux)-(amd64|arm64)\.(zip|tar\.gz)$/i

export function useLatestRelease() {
  const state = ref('loading') // loading | ok | error
  const release = ref(null)

  const desktop = computed(() => {
    const a = release.value?.assets ?? []
    return {
      windows: a.find((x) => x.name.endsWith('.exe')),
      macos: a.find((x) => x.name.endsWith('.dmg')),
    }
  })

  const cli = computed(() => {
    const a = release.value?.assets ?? []
    return a
      .filter((x) => x.name.startsWith('meebox-cli-') && CLI_RE.test(x.name))
      .map((x) => {
        const m = x.name.match(CLI_RE)
        return { ...x, goos: m[1].toLowerCase(), goarch: m[2].toLowerCase() }
      })
  })

  onMounted(async () => {
    try {
      const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      if (!res.ok) throw new Error(String(res.status))
      release.value = await res.json()
      state.value = 'ok'
    } catch {
      state.value = 'error'
    }
  })

  return { state, release, desktop, cli }
}
