# CLI 命令行工具（meebox）

`meebox` 是随发布提供的跨平台命令行工具，经本机的「本地 API 服务」访问应用能力，便于把 PR 浏览与
评审 Agent 操作接入脚本、CI 或外部 agent。命令行只做**浏览与评审操作**，不含评论发送等写操作。

## 1. 开启本地 API 服务

CLI 依赖应用内的本地 API 服务，默认关闭，需先在 **设置 → 集成** 开启：

- 打开「本地 API 服务」开关（首次开启会自动生成一枚访问令牌）。
- **监听地址**：默认 `http://127.0.0.1:18765`（仅本机可达）。如需被同网段的其他机器 / CI 访问，可把
  host 改为 `0.0.0.0` 或本机局域网 IP——此时**令牌是唯一防线**，请妥善保密并配合防火墙。
- **访问令牌**：可显示 / 复制 / 重新生成；重新生成后旧令牌立即失效。

## 2. 获取 CLI

从 [GitHub Release](https://github.com/huhamhire/code-meeseeks/releases) 下载对应平台的压缩包
（`meebox-cli-<版本>-<系统>-<架构>.zip` / `.tar.gz`），解压后把 `meebox` 可执行文件放到 `PATH` 中。

覆盖平台：Windows x64、macOS arm64、Linux x64 / arm64。

## 3. 连接方式

`meebox` 按以下优先级解析 API 地址与令牌（高 → 低）：

1. 命令行参数：`--api-url` / `--token`
2. 环境变量：`MEEBOX_API_URL` / `MEEBOX_TOKEN`
3. CLI 配置文件：`~/.code-meeseeks/cli.yaml`（字段 `api_url` / `token`）
4. **本机自动发现**：同机同用户时，自动读应用配置 `~/.code-meeseeks/config.yaml` 的服务监听设置

因此**在开启服务的本机上零配置即可用**——直接运行命令，自动读取本机地址与令牌：

```bash
meebox pr list
```

远端访问（服务监听 `0.0.0.0`）需显式提供地址与令牌：

```bash
meebox --api-url http://<主机>:18765 --token <令牌> pr list
# 或经环境变量
export MEEBOX_API_URL=http://<主机>:18765
export MEEBOX_TOKEN=<令牌>
meebox pr list
```

## 4. 命令

```text
meebox [全局参数] <组> <命令> [参数]
```

| 命令 | 用途 |
| --- | --- |
| `meebox categories` | 列出当前平台可用的分类标签（一级发现分类 + 二级状态 / 合并态筛选） |
| `meebox pr list [--primary <一级>] [--secondary <二级>] [--query <检索>]` | PR 列表（不分页），支持按分类与关键字过滤 |
| `meebox pr show <id>` | PR 描述详情 |
| `meebox pr diff <id> [--file <路径>] [--side base\|head]` | 无 `--file` 列变更文件；有则取该文件内容 |
| `meebox pr activity <id>` | 活动时间线（评论 / 提交 / 评审决断） |
| `meebox pr commits <id>` | 提交列表 |
| `meebox pr reviewers <id>` | 评审人审批状态 |
| `meebox agent status <id>` | 评审 Agent 当前执行状态 |
| `meebox agent history <id>` | 历史会话 |
| `meebox agent review <id>` | 执行一次自动评审 |
| `meebox agent instruct <id> <指令> [参数]` | 发送评审指令（`describe` / `review` / `ask` / `improve`） |
| `meebox agent chat <id> <消息>` | 发送自然语言消息（可触发 Agent 任务） |

其中 `<id>` 为 PR 的本地标识，由 `meebox pr list` 输出获得。

## 5. 输出格式

全局参数 `--output`：

- **`yaml`（默认）**：结构化又易读（类 kubectl `-o yaml`），适合人在终端查看。
- **`json`**：适合脚本 / 外部 agent 机器解析。

```bash
meebox pr list --output json | jq '.[].title'
```

**退出码**：`0` 成功；非 0 表错误（`2` 鉴权失败、`3` 资源不存在、`1` 其他）；错误信息打到 `stderr`。

## 网络代理

`meebox` 遵循标准的 HTTP 代理环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，大小写均可），无需额外配置：

- 访问**本机**服务（`127.0.0.1` / `localhost`）自动直连、不走代理。
- 访问**远端**服务（如经 `0.0.0.0` 暴露的机器）时，若设了 `HTTP_PROXY` 则经其出网；可用 `NO_PROXY` 排除特定主机。

## 注意事项

- **只读取向**：CLI 不提供评论发送、审批、合并等写操作；有此需求请自行对接代码平台。
- **令牌安全**：令牌明文存于 `~/.code-meeseeks/config.yaml`（同其他凭据）；监听 `0.0.0.0` 暴露到局域网时尤需保密，
  并及时通过「重新生成」吊销泄露的令牌。
