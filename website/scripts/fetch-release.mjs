// Build-time snapshot of the latest GitHub release, written to
// public/release-latest.json (gitignored). The download panel prefers the live
// API for freshness but falls back to this static file when the unauthenticated
// API is rate-limited (403) — e.g. many corporate-NAT visitors sharing one IP.
//
// Uses GITHUB_TOKEN when present (CI passes the Actions token → 1000 req/h),
// and never fails the build: if the fetch can't complete, the panel just relies
// on the live API as before.

import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const REPO = 'huhamhire/code-meeseeks'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const OUT = path.resolve(process.cwd(), 'public/release-latest.json')

async function main() {
  const headers = { Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  try {
    const res = await fetch(API, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    // Keep only the fields the panel reads.
    const slim = {
      tag_name: data.tag_name,
      html_url: data.html_url,
      assets: (data.assets ?? []).map((a) => ({
        name: a.name,
        size: a.size,
        browser_download_url: a.browser_download_url,
      })),
    }
    await mkdir(path.dirname(OUT), { recursive: true })
    await writeFile(OUT, JSON.stringify(slim), 'utf8')
    console.log(`[fetch-release] wrote fallback for ${slim.tag_name} (${slim.assets.length} assets)`)
  } catch (err) {
    console.warn(`[fetch-release] skipped (${err.message}); panel will rely on the live API`)
  }
}

main()
