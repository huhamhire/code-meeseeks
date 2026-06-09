# 安装与首次使用

## 系统要求

- **操作系统**：Windows 10 / 11（x64）或 macOS（Apple Silicon / arm64）。当前不提供 Intel Mac 与 Linux 安装包。
- **git**：本机需已安装 git，并在 PATH 中。客户端克隆仓库、读取本地 diff 都依赖系统 git。
- 评审与生成内容需要一个可用的 LLM（见 [LLM 配置](02-llm.md)）；嵌入式运行时已随应用打包，无需另装 Python 或 Docker。

## 安装

从项目的 GitHub Releases 页面下载对应平台的安装包：

- **Windows**：`code-meeseeks-<版本>-win-x64.exe`（NSIS 安装程序），双击按提示安装。
- **macOS**：`code-meeseeks-<版本>-mac-arm64.dmg`，打开后将应用拖入「应用程序」。

### macOS 首次打开

当前 macOS 包为 ad-hoc 签名、未做公证，首次打开会被系统拦下。任选一种方式放行：

- 在「应用程序」中**右键点击应用 → 打开 → 仍要打开**；
- 或 **系统设置 → 隐私与安全性**，在拦截提示处点「仍要打开」；
- 或在终端执行 `xattr -dr com.apple.quarantine "/Applications/Code Meeseeks.app"`。

## 首次使用

首次启动会自动创建数据目录并打开**配置向导**，按引导最快进入可用状态：

1. 配置一条**代码平台连接**——详见 [代码平台配置](01-code-platform.md)。
2. （可选）配置 **LLM**——详见 [LLM 配置](02-llm.md)。不配也能浏览 PR，但 `/describe`、`/review` 需要可用的 LLM。

完成向导后，客户端开始轮询，列出待你评审的 PR。

## 接下来

- 选中一个 PR：查看 diff，运行 `/describe`、`/review`，并进行评论 / 审批 / 合并。
- 处于内网 / 受限网络：先配置[网络代理](03-proxy.md)。
- 已有 Claude / Codex 等订阅：可用[本地 CLI 模式](02-llm.md#本地-cli-模式)以本机登录态执行评审。
