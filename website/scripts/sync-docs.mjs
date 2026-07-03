// Sync the user guide from docs/guide/ into the VitePress site (zh locale).
//
// The repo `docs/guide/` is the single source of truth; this copies it into
// `zh/guide/` at dev/build time (that dir is gitignored — never edit it by hand).
// Links that escape the guide (e.g. ../arch/, ../../README) point at pages the
// site does not host, so they are rewritten to absolute GitHub URLs; intra-guide
// links stay relative for VitePress to resolve.

import { readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'

const CWD = process.cwd() // website/
const SRC = path.resolve(CWD, '../docs/guide')
const DEST = path.resolve(CWD, 'zh/guide')
const REPO_BLOB = 'https://github.com/huhamhire/code-meeseeks/blob/master'

// Rewrite a single markdown link target.
function rewriteTarget(target) {
  if (/^(https?:)?\/\//.test(target) || target.startsWith('#') || target.startsWith('/')) {
    return target
  }
  const [rel, hash] = target.split('#')
  if (!rel) return target // pure anchor
  // Resolve relative to docs/guide/ within the repo.
  const resolved = path.posix.normalize(path.posix.join('docs/guide', rel))
  if (resolved.startsWith('docs/guide/')) {
    return target // stays inside the guide → keep relative
  }
  // Escapes the guide → link to the file on GitHub.
  return `${REPO_BLOB}/${resolved}${hash ? '#' + hash : ''}`
}

function rewriteLinks(md) {
  return md.replace(/\]\(([^)]+)\)/g, (_m, target) => `](${rewriteTarget(target)})`)
}

async function main() {
  await rm(DEST, { recursive: true, force: true })
  await mkdir(DEST, { recursive: true })

  const entries = await readdir(SRC, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const md = rewriteLinks(await readFile(path.join(SRC, entry.name), 'utf8'))
    // README.md is the guide index → index.md
    const outName = entry.name === 'README.md' ? 'index.md' : entry.name
    await writeFile(path.join(DEST, outName), md, 'utf8')
    count++
  }
  console.log(`[sync-docs] copied ${count} guide file(s) → zh/guide/`)
}

main().catch((err) => {
  console.error('[sync-docs] failed:', err)
  process.exit(1)
})
