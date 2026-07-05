> ⚠️ **Early preview (0.x)**: features, configuration, and data formats may change incompatibly, and stability is not fully verified.
> Do not use it for critical production review workflows — assess the risk and back up your data first.

## What's changed

%%CHANGELOG_SECTION%%

> 📖 This version on the website changelog (English · 简体中文): %%CHANGELOG_URL%%

## Installation

The installers are ready to use — the review runtime is bundled in, so **no extra setup is needed after installing**.

**First launch**: this build is **not code-signed / notarized** (a free, open-source path), so the OS blocks apps from unidentified developers:

- **macOS**: right-click the app → "Open" → "Open"; or System Settings → Privacy & Security → "Open Anyway".
  You can also run `xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"` in a terminal.
- **Windows**: on the SmartScreen prompt, click "More info" → "Run anyway".

## License

This project is licensed under [Apache-2.0](https://github.com/huhamhire/code-meeseeks/blob/master/LICENSE). The third-party
component licenses bundled in the installer are collected into **`THIRD-PARTY-NOTICES.md`**, shipped inside the package (in the
app resources directory — `Code Meeseeks.app/Contents/Resources/` on macOS, the install dir's `resources/` on Windows).
