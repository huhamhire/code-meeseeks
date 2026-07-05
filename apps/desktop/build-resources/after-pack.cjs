// electron-builder afterPack hook — ad-hoc signing for the macOS free release route.
//
// Background: on Apple Silicon(arm64) any Mach-O must carry a valid signature to execute; unsigned
// embedded python interpreter / .dylib / .so crash directly on spawn. Without an Apple Developer ID
// notarization is impossible, but an ad-hoc identity (`codesign -s -`) can sign for free so the binaries run.
//
// Behavior:
//   - Only acts when packaging macOS; win / linux skip directly.
//   - If real signing credentials (env) are detected, skip — handing back to electron-builder for proper signing + notarization.
//   - Otherwise recursively ad-hoc sign the whole .app (including the embedded python under Contents/Resources/pragent).
//
// Note: ad-hoc signing only lets the binaries run, it does not remove the Gatekeeper warning (users still need "Open anyway" on first launch
// or go via Homebrew). See docs/mac-build.md.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // With a real certificate / notarization credentials, skip ad-hoc and let electron-builder take over proper signing + notarization
  const hasRealIdentity = Boolean(
    process.env.CSC_LINK ||
      process.env.CSC_NAME ||
      process.env.APPLE_API_KEY ||
      process.env.APPLE_ID,
  );
  if (hasRealIdentity) {
    console.log('[after-pack] Apple signing credentials detected, skipping ad-hoc (using proper signing + notarization)');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`[after-pack] ad-hoc recursive signing (free route, not notarized): ${appPath}`);

  // --force overwrites the existing signature; --deep recursively signs nested code inside the bundle (including the embedded python Mach-O).
  // The ad-hoc identity is "-". If an individual .so still reports an invalid signature, see docs/mac-build.md §embedded python re-signing.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  console.log('[after-pack] ad-hoc signing done');
};
