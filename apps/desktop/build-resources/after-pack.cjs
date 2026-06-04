// electron-builder afterPack 钩子 —— macOS 免费发布路线的 ad-hoc 签名。
//
// 背景：Apple Silicon(arm64) 上任何 Mach-O 必须带有效签名才能执行；未签名的
// 嵌入式 python 解释器 / .dylib / .so 会在 spawn 时直接崩。没有 Apple Developer ID
// 时无法公证，但可以用 ad-hoc 身份(`codesign -s -`)免费签名让二进制能跑。
//
// 行为：
//   - 仅在打 macOS 包时动作；win / linux 直接跳过。
//   - 若检测到真实签名凭据(env)，跳过 —— 交回 electron-builder 走正式签名 + 公证。
//   - 否则对整个 .app 递归 ad-hoc 签名（含 Contents/Resources/pragent 下的嵌入式 python）。
//
// 注意：ad-hoc 签名只让二进制能运行，不去除 Gatekeeper 警告（仍需用户首次"仍要打开"
// 或走 Homebrew）。见 docs/mac-build.md。

const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // 有真证书 / 公证凭据时不做 ad-hoc，让 electron-builder 接管正式签名 + 公证
  const hasRealIdentity = Boolean(
    process.env.CSC_LINK ||
      process.env.CSC_NAME ||
      process.env.APPLE_API_KEY ||
      process.env.APPLE_ID,
  );
  if (hasRealIdentity) {
    console.log('[after-pack] 检测到 Apple 签名凭据，跳过 ad-hoc（走正式签名 + 公证）');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`[after-pack] ad-hoc 递归签名（免费路线，不公证）: ${appPath}`);

  // --force 覆盖既有签名；--deep 递归签 bundle 内嵌套代码（含嵌入式 python 的 Mach-O）。
  // ad-hoc 身份为 "-"。若个别 .so 仍报签名无效，见 docs/mac-build.md §嵌入式 python 补签。
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  console.log('[after-pack] ad-hoc 签名完成');
};
