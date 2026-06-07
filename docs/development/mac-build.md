# macOS 构建与发布（Code Meeseeks · arm64）

> 状态：**已在 macOS arm64 验证通过**（2026-06，macOS 26.5 / Apple Silicon）——
> 本机走完 `prepare:pragent` → `electron-vite build` → `electron-builder` 全链路，出 dmg、
> ad-hoc 签名、装 dmg 后 GUI 正常启动，嵌入式 python 实际 exec + `import pr_agent` 通过。
> 关联 [pr-agent 集成与运行时](../modules/04-pragent-runtime.md)。

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

[.github/workflows/release.yml](../../.github/workflows/release.yml)：推 `v*` tag 触发，矩阵
`windows-latest` + `macos-14`(arm64) 各自出包，挂到该 tag 的 Release。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

mac job 在 arm64 runner 上原生构建，afterPack 做 ad-hoc 签名。**全程不需要 Apple 账号 / 凭据。**

## 3. ad-hoc 签名机制

[build-resources/after-pack.cjs](../../apps/desktop/build-resources/after-pack.cjs)（electron-builder
`afterPack` 钩子）：

- 仅 mac 动作；win/linux 跳过。
- 无 Apple 凭据 env → 对 `.app` 递归 `codesign --force --deep --sign -`（ad-hoc）。
- 有凭据 env → 跳过，交回 electron-builder 走正式签名 + 公证（见 §6）。

## 4. 嵌入式 Python 签名（已验证：`--deep` 足够）

`vendor/pragent` 经 `extraResources` 进 `<App>.app/Contents/Resources/pragent/`，内含
python 二进制 + 上千个 `.dylib/.so`。担心点是 `codesign --deep` 是否真能递归签到所有
Resources 下的散装 Mach-O（漏签 → 运行时 `code signature invalid` / python 子进程崩）。

**arm64 实测结论：`after-pack.cjs` 的 `--force --deep --sign -` 已完整覆盖。** 验证：
对 `Contents/Resources/pragent` 下全部 Mach-O（python3.12 解释器 + 散装 `.so/.dylib`，
本次 43 个）逐个 `codesign --verify --strict` → 0 失败；包内嵌入式 python 直接 exec +
`import pr_agent` → exit 0。**无需 sweep 补签**，保持现配置。

> 兜底（若将来某发布遇到个别 `.so` 漏签）：在 `after-pack.cjs` 改成"先 sweep 后整签"——
> 遍历 `Contents/Resources/pragent` 下所有 Mach-O 逐个 `codesign --force --sign -`，再签整个
> `.app`。目前不需要。

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
   （[entitlements.mac.plist](../../apps/desktop/build-resources/entitlements.mac.plist) 已备好：
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
- ~~嵌入式 python 是否需要 sweep 补签~~ —— **已验证 `--deep` 足够，无需 sweep**（§4）。
- 未公证 → 依赖用户绕过 / Homebrew，对非技术用户有门槛（§5）。
- Intel(x64) 暂不出（仅 arm64）；需要时 electron-builder.yml mac.arch 加 x64。

### 本地复现踩坑（仅本机，CI 不受影响）

CI 用 `actions/checkout` 的 `lfs: true` + GitHub runner 网络，下列两点不会触发；在自己 mac
上手动 `electron-builder` 时可能遇到：

- **图标 LFS 指针**：`assets/icons/icon.png` 走 Git LFS。本机若没装 git-lfs，checkout 得到的是
  131 字节指针文件 → electron-builder 转图标 `LoadImage` 崩。解：`brew install git-lfs && git lfs pull`。
- **pip 连 pypi 超时**：`prepare:pragent` 用嵌入式解释器 `pip install pr-agent`，pip 默认 15s
  超时，内网/慢网下 `aiohttp` 等会报 `from versions: none`（实为连不上索引，非版本不存在）。
  解：`PIP_DEFAULT_TIMEOUT=120 npm run prepare:pragent`（或配 pip 镜像）。
