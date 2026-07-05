// Sync the user guide + changelog from the repo into the VitePress site (both locales).
//
// The repo is the single source of truth; this copies content into the site at
// dev/build time (the destinations are gitignored — never edit them by hand):
//   docs/guide/*.md        (English, canonical) → guide/         (EN root locale)
//   docs/guide/zh-CN/*.md  (Chinese)            → zh/guide/      (zh locale)
//   CHANGELOG.md           (English, canonical) → changelog.md   (EN root locale)
//   CHANGELOG.zh-CN.md     (Chinese)            → zh/changelog.md (zh locale)
// Links that escape the guide (e.g. ../arch/, ../../README, or CHANGELOG's LICENSE)
// point at pages the site does not host, so they are rewritten to absolute GitHub
// URLs; intra-guide links stay relative for VitePress to resolve. The per-file
// language switcher (a "**English** · [简体中文]" line) is stripped — the site has
// its own locale menu, and the switcher's cross-locale relative links don't map
// onto the site.

import { readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'

const CWD = process.cwd() // website/
const REPO_BLOB = 'https://github.com/huhamhire/code-meeseeks/blob/master'

// One sync unit: source guide dir, where it lives in the repo (for resolving
// escaping links), and the destination dir under the site.
const LOCALES = [
  { src: path.resolve(CWD, '../docs/guide'), repoDir: 'docs/guide', dest: path.resolve(CWD, 'guide') },
  {
    src: path.resolve(CWD, '../docs/guide/zh-CN'),
    repoDir: 'docs/guide/zh-CN',
    dest: path.resolve(CWD, 'zh/guide'),
  },
]

// Standalone top-level docs synced from the repo root (single source of truth).
// repoDir '.' resolves their escaping links (e.g. CHANGELOG's LICENSE) against the
// repo root, so they rewrite to absolute GitHub URLs.
const SINGLES = [
  { src: path.resolve(CWD, '../CHANGELOG.md'), repoDir: '.', dest: path.resolve(CWD, 'changelog.md') },
  {
    src: path.resolve(CWD, '../CHANGELOG.zh-CN.md'),
    repoDir: '.',
    dest: path.resolve(CWD, 'zh/changelog.md'),
  },
]

// Matches the per-file language switcher line, both directions.
const SWITCHER_RE = /^(?:\*\*English\*\*|\[English\]\()[^\n]*(?:简体中文)[^\n]*$/

// Rewrite a single markdown link target, resolving relative links against the
// guide's location in the repo (repoDir).
function rewriteTarget(target, repoDir) {
  if (/^(https?:)?\/\//.test(target) || target.startsWith('#') || target.startsWith('/')) {
    return target
  }
  const [rel, hash] = target.split('#')
  if (!rel) return target // pure anchor
  const resolved = path.posix.normalize(path.posix.join(repoDir, rel))
  if (resolved.startsWith('docs/guide/')) {
    return target // stays inside the guide → keep relative
  }
  // Escapes the guide → link to the file on GitHub.
  return `${REPO_BLOB}/${resolved}${hash ? '#' + hash : ''}`
}

function rewriteLinks(md, repoDir) {
  return md.replace(/\]\(([^)]+)\)/g, (_m, target) => `](${rewriteTarget(target, repoDir)})`)
}

// Drop the language-switcher line (and a single adjacent blank line so we don't
// leave a stray gap under the H1).
function stripSwitcher(md) {
  const lines = md.split('\n')
  const i = lines.findIndex((l) => SWITCHER_RE.test(l.trim()))
  if (i === -1) return md
  lines.splice(i, 1)
  if (lines[i] === '' && lines[i - 1] === '') lines.splice(i, 1)
  return lines.join('\n')
}

async function syncLocale({ src, repoDir, dest }) {
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })

  const entries = await readdir(src, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue // skip zh-CN/ subdir on the EN pass
    const raw = await readFile(path.join(src, entry.name), 'utf8')
    const md = rewriteLinks(stripSwitcher(raw), repoDir)
    // README.md is the guide index → index.md
    const outName = entry.name === 'README.md' ? 'index.md' : entry.name
    await writeFile(path.join(dest, outName), md, 'utf8')
    count++
  }
  console.log(`[sync-docs] copied ${count} guide file(s) → ${path.relative(CWD, dest)}/`)
}

// Sync one standalone file (e.g. CHANGELOG): strip the switcher, rewrite escaping
// links, write to the destination page (creating the parent dir if needed).
async function syncSingle({ src, repoDir, dest }) {
  const raw = await readFile(src, 'utf8')
  const md = rewriteLinks(stripSwitcher(raw), repoDir)
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, md, 'utf8')
  console.log(`[sync-docs] copied ${path.basename(src)} → ${path.relative(CWD, dest)}`)
}

async function main() {
  for (const locale of LOCALES) await syncLocale(locale)
  for (const single of SINGLES) await syncSingle(single)
}

main().catch((err) => {
  console.error('[sync-docs] failed:', err)
  process.exit(1)
})
