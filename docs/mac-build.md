# macOS 构建与发布（Code Meeseeks · arm64）

> 状态：配置已就绪，**待在 macOS arm64 机器 / CI 上验证**（无法在 Windows 交叉构建 mac）。
> 关联 [ADR-0008](./adr/0008-pragent-packaging-and-runtime.md)（嵌入式 Python 运行时）。

作为开源项目，**不申请 Apple Developer ID（$99/年）**，走**免费 ad-hoc 路线**：

- **本地开发**：在你自己的 mac 上 ad-hoc 出包即可跑。
- **发布**：GitHub Actions（公开仓库 macOS runner 免费）自动出包、ad-hoc 签名、挂 Release。
- **代价**：包**未公证**，用户首次打开需手动"仍要打开"（或走 Homebrew）。这是免费路线唯一的体验损失。

> 关键认知：Apple Silicon 上**任何 Mach-O 必须有签名才能运行**——ad-hoc 签名（`codesign -s -`，
> 免费、无需账号）满足"能跑"，公证（需 Developer ID + Apple 公证服务）只负责"去掉 Gatekeeper 警告"。
> 两者独立。我们做前者，跳过后者。

---

## 1. 本地开发

```bash
# 仅运行（不签名，dev electron 直接跑）
npm --prefix apps/desktop run dev

# 本地出包测试（在 mac 上）：dist 会跑 prepare:pragent + build + electron-builder
#   afterPack 钩子自动 ad-hoc 递归签名（含嵌入式 python），arm64 上即可启动
npm --prefix apps/desktop run dist
# 产物：apps/desktop/release/code-meeseeks-<version>-mac-arm64.dmg
```

`prepare:pragent` 会组装 `aarch64-apple-darwin` 的 CPython + pr-agent 到
`apps/desktop/vendor/pragent/`（解释器 `python/bin/python3`，main 的 `resolveEmbeddedPython`
已按平台分支）。

## 2. 发布（GitHub Actions）

[.github/workflows/release.yml](../.github/workflows/release.yml)：推 `v*` tag 触发，矩阵
`windows-latest` + `macos-14`(arm64) 各自出包，挂到该 tag 的 Release。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

mac job 在 arm64 runner 上原生构建，afterPack 做 ad-hoc 签名。**全程不需要 Apple 账号 / 凭据。**

## 3. ad-hoc 签名机制

[build-resources/after-pack.cjs](../apps/desktop/build-resources/after-pack.cjs)（electron-builder
`afterPack` 钩子）：

- 仅 mac 动作；win/linux 跳过。
- 无 Apple 凭据 env → 对 `.app` 递归 `codesign --force --deep --sign -`（ad-hoc）。
- 有凭据 env → 跳过，交回 electron-builder 走正式签名 + 公证（见 §6）。

## 4. ⚠️ 嵌入式 Python 签名（重点验证项）

`vendor/pragent` 经 `extraResources` 进 `<App>.app/Contents/Resources/pragent/`，内含
python 二进制 + 上千个 `.dylib/.so`。`codesign --deep` 理论上会递归签到，但 python 树庞大，
实测可能有 Resources 下的散装 `.so` 漏签 → 运行时 `code signature invalid` / python 子进程崩。

**若验证时遇到**，在 `after-pack.cjs` 里改成"先 sweep 后整签"：遍历
`Contents/Resources/pragent` 下所有 Mach-O 文件逐个 `codesign --force --sign -`，再签整个 `.app`。
先按现配置（`--deep`）验证，确有问题再上 sweep（避免无谓复杂度）。

## 5. 用户首次打开（未公证 → 绕过 Gatekeeper）

Release 说明里需写明（任选其一）：

- **右键 → 打开 → 仍要打开**（首次）；或
- **系统设置 → 隐私与安全性 → 仍要打开**（macOS Sequoia 起右键方式部分场景失效，走这里）；或
- 终端去隔离属性：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"
  ```

**Homebrew Cask**（面向技术用户，体验更顺）：发一个 cask 指向 GitHub Release 的 dmg，
`brew install --cask code-meeseeks` 安装时自动处理隔离属性。后续可加。

## 6. 升级到公证（将来若申请 Developer ID，可选）

workflow **无需改结构**，只需：

1. 仓库配 secrets：`MAC_CSC_LINK`(证书 .p12 base64) / `MAC_CSC_KEY_PASSWORD` /
   `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`。
2. electron-builder.yml `mac:` 加回 `hardenedRuntime: true` + `entitlements` /
   `entitlementsInherit: build-resources/entitlements.mac.plist` + `notarize: true`。
   （[entitlements.mac.plist](../apps/desktop/build-resources/entitlements.mac.plist) 已备好：
   `disable-library-validation` 让嵌入式 python 在 hardened runtime 下能加载第三方 dylib。）

afterPack 检测到凭据 env 会自动让位，electron-builder 接管正式签名 + 公证，产出双击即开的 dmg。

## 7. 验证清单（mac 上）

```bash
APP="apps/desktop/release/mac-arm64/Code Meeseeks.app"
codesign -dv --verbose=4 "$APP"            # ad-hoc 路线：Signature=adhoc
codesign --verify --deep --strict "$APP"   # 递归校验（含嵌入 python）通过
```

装 dmg → 首次按 §5 绕过 → 启动应用：
- 窗口/Dock 显示新图标。
- 状态栏 `PR Agent: <ver>`（embedded 绿）。
- 跑一次 `/review` → 确认嵌入式 python 子进程**没崩**（这是 ad-hoc 签名是否覆盖到 python 的真正判据）。

## 8. 风险 / 待办

- 嵌入式运行时体积大 → 签名耗时；CI 上 mac runner 对公开仓库免费，私有仓库分钟数贵 10x。
- 嵌入式 python 是否需要 sweep 补签 —— 现用 `--deep`，**待 mac 验证后定**（§4）。
- 未公证 → 依赖用户绕过 / Homebrew，对非技术用户有门槛（§5）。
- Intel(x64) 暂不出（仅 arm64）；需要时 electron-builder.yml mac.arch 加 x64。
