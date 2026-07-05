// Copy shared screenshots into the VitePress public dir at build time.
// Single source of truth is the repo's assets/images/; the public/ copies are
// gitignored (never committed twice). VitePress can only serve /-rooted assets
// from its own public/, hence the copy rather than a cross-dir reference.

import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const CWD = process.cwd() // website/
const SRC = path.resolve(CWD, '../assets/images')
const DEST = path.resolve(CWD, 'public')
const FILES = ['screenshot.light.png', 'screenshot.dark.png']

async function main() {
  await mkdir(DEST, { recursive: true })
  for (const f of FILES) {
    await copyFile(path.join(SRC, f), path.join(DEST, f))
  }
  console.log(`[sync-assets] copied ${FILES.length} screenshot(s) → public/`)
}

main().catch((err) => {
  console.error('[sync-assets] failed:', err)
  process.exit(1)
})
