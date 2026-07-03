# Packaging & Release (Build / Signing / CI)

## Responsibility & scope

Package the app + embedded runtime into per-platform installers and publish them. Covers electron-builder config, bundling the embedded runtime, the code-signing strategy, icons, and the CI release flow.

In scope: build / package / sign / produce artifacts / CI. Out of scope: how the embedded runtime is assembled (see [pr-agent integration & runtime](../arch/02-agent/05-pragent-runtime.md)). macOS signing details are in [macOS build & release](./mac-build.md).

## Core design

- **Build chain**: `prepare:pragent` (assemble the embedded runtime) → electron-vite `build` (main/preload/renderer) →
  electron-builder produces the package.
- **Embedded runtime bundled**: `vendor/pragent` (CPython + pinned pr-agent) goes **outside the asar** via electron-builder's `extraResources`
  (the native interpreter + `.so/.pyd` must be real files, not inside the asar); `__pycache__` is excluded to slim it down.
  The packaging platform matches the target platform (assembled by the build host).
- **Target artifacts**: Windows → NSIS x64; macOS → dmg arm64. The release focuses on **Windows x64 + macOS arm64** only;
  **Linux is not planned**, Intel / win arm64 are follow-ups if needed. (Even if electron-builder config keeps a linux section, it's out of release scope.)
- **macOS free signing route (ad-hoc)**: no Apple Developer ID ($99/yr). The afterPack hook does
  **ad-hoc recursive signing** of the `.app` (`codesign --deep --sign -`) — on Apple Silicon any Mach-O must be signed to run
  (including the embedded Python's thousands of `.so/.dylib`; empirically `--deep` covers everything, no per-file re-signing needed). **Trade-off**: not notarized, so
  first launch requires the user to manually "Open Anyway" (or use Homebrew). **Upgrade to notarization**: once the repo has the Apple signing secrets, afterPack
  detects the credentials and steps aside to electron-builder's proper signing + notarization; the workflow structure is unchanged.
- **Per-platform icons**: Windows uses `.ico`; macOS uses a **dedicated dark rounded icon** — a full-bleed transparent glyph on macOS (especially newer systems)
  gets a rounded mask and a white backing, so we ship a separate "dark squircle + inset glyph" for mac; icon sources go through Git LFS.
- **CI release**: pushing a `v*` tag triggers a matrix of `windows-latest` + `macos-14` (arm64), each building natively and attaching to that tag's Release;
  checkout must use `lfs: true` (otherwise the icon is an LFS pointer → icon conversion crashes).

## Data / interface contract

- **Trigger**: push a `v*` tag (or manual workflow_dispatch).
- **Artifact naming**: `code-meeseeks-<version>-{win-x64.exe | mac-arm64.dmg}`.
- **Optional signing credentials** (if complete, auto-switches to proper signing + notarization): cert .p12 (base64) + password, App Store Connect API key, etc.
  injected as repo secrets; missing → ad-hoc route.

## Extensions & notes

- **Local-repro gotchas** (CI unaffected, since it uses `lfs:true` + a clean env): git-lfs not installed locally → the icon is a pointer → icon conversion crashes
  (`brew install git-lfs && git lfs pull`); `prepare:pragent`'s pip times out on a weak network → `PIP_DEFAULT_TIMEOUT=120` or configure a mirror.
- **The embedded runtime is large** → signing takes time; macOS runners are free for public repos, more expensive in minutes for private ones.
- **First launch (not notarized)**: the Release notes must state the bypass (right-click Open / allow in System Settings / `xattr -dr com.apple.quarantine`),
  or provide a Homebrew Cask.
- **Upgrade to notarization**: see above; the mac section also needs hardenedRuntime + entitlements + notarize added back (entitlements are ready with
  `disable-library-validation` so the embedded Python can load third-party dylibs under the hardened runtime).

## Pre-release checklist (mandatory before tagging)

Complete these **in the same batch of changes**, flowing through `dev` → `master` with the release — miss any step and CI won't error (only `::warning::`) but will produce a wrong Release:

1. **Version** — set the `version` in [apps/desktop/package.json](../../apps/desktop/package.json) to the target version (drop the `v` prefix; prereleases carry a suffix like `0.5.0-alpha.1`). electron-builder's `artifactName: code-meeseeks-${version}-...` reads this value directly — not updating it means the installer filename won't match the tag. After the change, run `npm install` to sync the lockfile.
2. **CHANGELOG** — rename `## [Unreleased]` in [CHANGELOG.md](../../CHANGELOG.md) to `## [<version>] - <YYYY-MM-DD>`, and add a `[<version>]: …/compare/…` link reference at the bottom of the file. **Releasing consumes Unreleased — leave no empty section**; create a new one on the next development-phase changelog change. release.yml extracts the `## [<version>]` section literally to inject into the Release body — a missing section means the body falls back with no change notes. **If the stable release's content comes from a prior alpha/prerelease**: the development phase usually has no separate Unreleased (the content is already in the prerelease section), so just rename that prerelease section to the stable-version section and remove the corresponding `[<x>-alpha.N]:` link reference (the content merges into the stable section, no empty stub left); other prerelease sections with no corresponding stable version are kept.
3. **Proofread** — confirm the `## [<version>]` section covers every key point (Added / Changed / Fixed) merged into `dev` since the last version.

The tag name and the package.json version must match (`v<version>`). A prerelease tag with a `-` in the name (e.g. `-alpha.N`) is automatically marked prerelease by release.yml and does not claim Latest.

**Version-number rule (`-dev`)**: right after each stable release, `dev` immediately bumps [apps/desktop/package.json](../../apps/desktop/package.json) to **the next version's `-dev` prerelease number** (e.g. after shipping `0.6.0`, switch to `0.7.0-dev`, and `npm install` to sync the lockfile), marking the development state. `-dev` is a development marker only — **not tagged, not released**; at release time change it to the target number (`0.7.0-alpha.N` or `0.7.0`) per above. `-dev` is valid semver (`0.6.0` < `0.7.0-dev` < `0.7.0`), so it doesn't affect update checking ([update-check.ts](../../apps/desktop/src/main/utils/update-check.ts) compares with `semver.gt`, not a range) or the build.

## CHANGELOG writing style (user-facing, concise)

- The version intro `>` block goes straight into "highlights of this release", with points laid out as a **bulleted list** rather than piled into long sentences, and **no version-ordinal intros like "the first / Nth stable release"**;
- Added is categorized by **feature scenario** using an indented nested list, each point one sentence to the point;
- Refactor-type work is **merged front-and-back-end** into a single summary, without expanding implementation detail;
- Fixed **omits the "how it was fixed" mechanism**, each item one sentence stating only the symptom/impact fixed;
- Throughout, no IPC channel names, function names, file paths, or field names or other implementation details — foreground new features and improvements;
- **Install / upgrade notes** (the ⚠️ warnings in the version intro, e.g. uninstall the old version first, per-machine elevation, etc.) are security-critical and are **kept in full, not subject to trimming** — these get injected into the GitHub Release body by release.yml, and trimming them would let users miss upgrade risks;
- **Section headings are Chinese + emoji**: `### ✨ 新增 / ♻️ 变更 / 🔧 修复 / 🗑️ 移除 / 🔒 安全` (corresponding to Keep a Changelog's Added / Changed / Deprecated / Removed / Fixed / Security);
- Habitually credit external contributors' PRs (like `(#65, thanks @user)`).
