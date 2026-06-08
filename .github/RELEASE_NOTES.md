> ⚠️ **早期预览版（alpha）**：功能、配置与数据格式可能发生不兼容变更，稳定性未经充分验证。
> 请勿用于关键生产评审流程，使用前自行评估风险并备份数据。

## 下载

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | `code-meeseeks-<version>-win-x64.exe`（NSIS 安装包） |
| macOS arm64（Apple Silicon） | `code-meeseeks-<version>-mac-arm64.dmg` |

安装包已内嵌 Python 运行时 + pr-agent，安装后即可使用，**无需自装 Python / Docker**。

## 首次打开（重要）

本版**未做代码签名公证**（开源免费路线），系统会拦截未知开发者的应用：

- **macOS**：右键点 App 选「打开 → 仍要打开」；或「系统设置 → 隐私与安全性 → 仍要打开」。
  也可终端执行 `xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"`。
- **Windows**：SmartScreen 弹窗点「更多信息 → 仍要运行」。

## 校验完整性（可选）

每个安装包附带同名 `.sha256`。校验：

- macOS：`shasum -a 256 -c code-meeseeks-<version>-mac-arm64.dmg.sha256`
- Windows（PowerShell）：`Get-FileHash code-meeseeks-<version>-win-x64.exe -Algorithm SHA256`

## 变更内容

完整变更见 [CHANGELOG](https://github.com/huhamhire/code-meeseeks/blob/master/CHANGELOG.md)。

## 许可

本项目 [Apache-2.0](https://github.com/huhamhire/code-meeseeks/blob/master/LICENSE)。安装包内含的
第三方组件许可归集为 **`THIRD-PARTY-NOTICES.md`**，已随安装包内置（位于 App 资源目录，macOS 为
`Code Meeseeks.app/Contents/Resources/`，Windows 为安装目录 `resources/`）。
