import { ref, computed, onMounted } from 'vue'
import { withBase } from 'vitepress'

// Resolves the latest GitHub release and categorizes its assets into the
// desktop installers and the meebox CLI archives. Presentation (OS detection,
// recommendations, i18n) stays in the component.
//
// Resolution order (freshness → resilience):
//   1. sessionStorage cache (avoids re-hitting the API on same-session nav)
//   2. live GitHub API (always current)
//   3. build-time static snapshot /release-latest.json (survives API 403s,
//      e.g. many corporate-NAT visitors sharing one rate-limited IP)
const REPO = 'huhamhire/code-meeseeks'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const FALLBACK = 'release-latest.json'
const CACHE_KEY = 'mb:latest-release'
const CLI_RE = /-(windows|darwin|linux)-(amd64|arm64)\.(zip|tar\.gz)$/i

async function resolveRelease() {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY)
    if (cached) return JSON.parse(cached)
  } catch {
    /* sessionStorage unavailable — ignore */
  }

  let data = null
  try {
    const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    if (res.ok) data = await res.json()
  } catch {
    /* network / CORS — fall through to the static snapshot */
  }

  if (!data) {
    const res = await fetch(withBase(`/${FALLBACK}`))
    if (!res.ok) throw new Error(`fallback ${res.status}`)
    data = await res.json()
  }

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch {
    /* ignore quota / private-mode errors */
  }
  return data
}

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
      release.value = await resolveRelease()
      state.value = 'ok'
    } catch {
      state.value = 'error'
    }
  })

  return { state, release, desktop, cli }
}
