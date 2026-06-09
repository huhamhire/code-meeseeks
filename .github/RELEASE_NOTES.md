> ⚠️ **早期预览版（0.x）**：功能、配置与数据格式可能发生不兼容变更，稳定性未经充分验证。
> 请勿用于关键生产评审流程，使用前自行评估风险并备份数据。

## 版本变更

%%CHANGELOG_SECTION%%

> 完整历史见 [CHANGELOG](https://github.com/huhamhire/code-meeseeks/blob/master/CHANGELOG.md)。

## 安装说明

安装包开箱即用，已内置评审所需运行环境，**安装后即可使用，无需额外配置**。

**首次打开**：本版**未做代码签名公证**（开源免费路线），系统会拦截未知开发者的应用：

- **macOS**：右键点 App 选「打开 → 仍要打开」；或「系统设置 → 隐私与安全性 → 仍要打开」。
  也可终端执行 `xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"`。
- **Windows**：SmartScreen 弹窗点「更多信息 → 仍要运行」。

## 许可

本项目 [Apache-2.0](https://github.com/huhamhire/code-meeseeks/blob/master/LICENSE)。安装包内含的
第三方组件许可归集为 **`THIRD-PARTY-NOTICES.md`**，已随安装包内置（位于 App 资源目录，macOS 为
`Code Meeseeks.app/Contents/Resources/`，Windows 为安装目录 `resources/`）。
