# macOS Build & Release (Code Meeseeks · arm64)

> Status: **verified on macOS arm64** (2026-06, macOS 26.5 / Apple Silicon) —
> the full `prepare:pragent` → `electron-vite build` → `electron-builder` chain was run locally, producing a dmg,
> ad-hoc signed; after installing the dmg the GUI launches normally and the embedded Python actually execs +
> `import pr_agent` passes. Related: [pr-agent integration & runtime](../arch/02-agent/05-pragent-runtime.md).

As an open-source project, we **do not enroll in the Apple Developer ID ($99/yr)** and take the **free ad-hoc route**:

- **Local development**: an ad-hoc build on your own Mac runs fine.
- **Release**: GitHub Actions (macOS runners are free for public repos) builds, ad-hoc signs, and attaches to the Release automatically.
- **Trade-off**: the package is **not notarized**, so first-launch requires the user to manually "Open Anyway" (or use Homebrew). This is the only UX cost of the free route.

> Key insight: on Apple Silicon, **any Mach-O must be signed to run** — ad-hoc signing (`codesign -s -`,
> free, no account needed) satisfies "can run", while notarization (needs a Developer ID + Apple's notary service) only
> handles "remove the Gatekeeper warning". The two are independent. We do the former and skip the latter.

---

## 1. Local development

```bash
# Run only (no signing; dev electron runs directly)
npm --prefix apps/desktop run dev

# Local build test (on a Mac): dist runs prepare:pragent + build + electron-builder
#   the afterPack hook auto ad-hoc recursively signs (including the embedded Python), so it launches on arm64
npm --prefix apps/desktop run dist
# Output: apps/desktop/release/code-meeseeks-<version>-mac-arm64.dmg
```

`prepare:pragent` assembles the `aarch64-apple-darwin` CPython + pr-agent into
`apps/desktop/vendor/pragent/` (interpreter at `python/bin/python3`; the main process's `resolveEmbeddedPython`
already branches per platform).

## 2. Release (GitHub Actions)

[.github/workflows/release.yml](../../.github/workflows/release.yml): pushing a `v*` tag triggers a matrix of
`windows-latest` + `macos-14` (arm64), each building its own package and attaching to that tag's Release.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The mac job builds natively on an arm64 runner, with afterPack doing the ad-hoc signing. **No Apple account / credentials needed at any point.**

## 3. Ad-hoc signing mechanism

[build-resources/after-pack.cjs](../../apps/desktop/build-resources/after-pack.cjs) (the electron-builder
`afterPack` hook):

- Mac-only action; skipped on win/linux.
- No Apple credential env → recursively `codesign --force --deep --sign -` (ad-hoc) the `.app`.
- With credential env → skipped, handing back to electron-builder for proper signing + notarization (see §6).

## 4. Embedded Python signing (verified: `--deep` is sufficient)

`vendor/pragent` goes into `<App>.app/Contents/Resources/pragent/` via `extraResources`, containing the
Python binary + thousands of `.dylib/.so`. The concern was whether `codesign --deep` really recurses into every
loose Mach-O under Resources (a missed signature → runtime `code signature invalid` / the Python subprocess crashes).

**Empirical conclusion on arm64: `after-pack.cjs`'s `--force --deep --sign -` covers everything.** Verified by:
running `codesign --verify --strict` on every Mach-O under `Contents/Resources/pragent` (the python3.12 interpreter +
loose `.so/.dylib`, 43 this time) → 0 failures; and the bundled embedded Python execs +
`import pr_agent` → exit 0. **No sweep re-signing needed** — keep the current config.

> Fallback (if a future release hits a missed `.so` signature): change `after-pack.cjs` to "sweep first, then sign the whole" —
> iterate over every Mach-O under `Contents/Resources/pragent`, `codesign --force --sign -` each, then sign the whole
> `.app`. Not needed today.

## 5. First launch for users (not notarized → bypass Gatekeeper)

State this in the Release notes (any one of):

- **Right-click → Open → Open Anyway** (first time); or
- **System Settings → Privacy & Security → Open Anyway** (since macOS Sequoia the right-click path fails in some cases — use this); or
- Remove the quarantine attribute in a terminal:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"
  ```

**Homebrew Cask** (for technical users, a smoother experience): publish a cask pointing at the GitHub Release dmg;
`brew install --cask code-meeseeks` handles the quarantine attribute automatically on install. Can be added later.

## 6. Upgrading to notarization (optional, if a Developer ID is obtained later)

The workflow **needs no structural change**, only:

1. Configure repo secrets: `MAC_CSC_LINK` (cert .p12, base64) / `MAC_CSC_KEY_PASSWORD` /
   `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`.
2. In electron-builder.yml `mac:`, add back `hardenedRuntime: true` + `entitlements` /
   `entitlementsInherit: build-resources/entitlements.mac.plist` + `notarize: true`.
   ([entitlements.mac.plist](../../apps/desktop/build-resources/entitlements.mac.plist) is ready:
   `disable-library-validation` lets the embedded Python load third-party dylibs under the hardened runtime.)

When afterPack detects the credential env it steps aside automatically, electron-builder takes over proper signing +
notarization, and the result is a double-click-to-open dmg.

## 7. Verification checklist (on a Mac)

```bash
APP="apps/desktop/release/mac-arm64/Code Meeseeks.app"
codesign -dv --verbose=4 "$APP"            # ad-hoc route: Signature=adhoc
codesign --verify --deep --strict "$APP"   # recursive verification (incl. embedded Python) passes
```

Install the dmg → bypass on first launch per §5 → start the app:
- The new icon shows in the window/Dock.
- The status bar shows `PR Agent: <ver>` (embedded, green).
- Run one `/review` → confirm the embedded Python subprocess **does not crash** (the real test of whether ad-hoc signing reached Python).

## 8. Risks / TODO

- The embedded runtime is large → signing takes time; mac runners are free for public repos, ~10x more expensive in minutes for private ones.
- ~~Whether the embedded Python needs sweep re-signing~~ — **verified `--deep` is sufficient, no sweep needed** (§4).
- Not notarized → relies on the user bypassing / Homebrew, a barrier for non-technical users (§5).
- Intel (x64) not shipped for now (arm64 only); add `x64` to electron-builder.yml `mac.arch` when needed.

### Local-repro gotchas (local only, CI unaffected)

CI uses `actions/checkout` with `lfs: true` + the GitHub runner network, so the two below don't trigger there; you may hit them
when running `electron-builder` manually on your own Mac:

- **Icon LFS pointer**: `assets/icons/icon.png` is a Git LFS asset. Without git-lfs installed locally, checkout yields a
  131-byte pointer file → electron-builder's icon conversion `LoadImage` crashes. Fix: `brew install git-lfs && git lfs pull`.
- **pip pypi timeout**: `prepare:pragent` uses the embedded interpreter to `pip install pr-agent`; pip's default 15s
  timeout means `aiohttp` etc. report `from versions: none` on an intranet/slow network (actually "can't reach the index",
  not "version doesn't exist"). Fix: `PIP_DEFAULT_TIMEOUT=120 npm run prepare:pragent` (or configure a pip mirror).
