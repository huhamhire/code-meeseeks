# 嵌入式 pr-agent 运行时（开发环境准备）

把一份**可重定位的 CPython + 预装好的 pr-agent** 组装到 `apps/desktop/vendor/pragent/`，
让应用无需用户预装 Python / Docker 即可跑 pr-agent（见 [docs/arch/04](../../../docs/arch/04-pragent-runtime.md)）。

## 用法

```bash
# 在 apps/desktop 下
npm run prepare:pragent          # 幂等：已就绪则跳过
npm run prepare:pragent -- --force   # 强制重建
```

或经 Nx：`npx nx run @meebox/desktop:"prepare:pragent"`。

打包（`pack` / `dist`）已通过 Nx `dependsOn` 自动先跑它。

## 产物布局

```
apps/desktop/vendor/pragent/         # gitignore，不入库
├── python/                          # python-build-standalone（含 pip/stdlib/ssl）
│   └── .../site-packages/
│       ├── pr_agent/ ...            # pip install pr-agent==<manifest 版本>
│       ├── sitecustomize.py         # 薄加载器（CPython 启动经 site 自动 import）
│       └── meebox_pragent_shim/     # monkeypatch shim 包（无侵入补丁，见 docs/arch/04-pragent-runtime.md）
└── VERSION                          # 组装指纹（幂等判定 + 记录 sha256）
```

## 版本来源

- Python / pr-agent 版本 pin 在 [`pragent-runtime.json`](./pragent-runtime.json)。
- pr-agent 版本须与 `sitecustomize.py` 的 `_EXPECTED_PRAGENT_VERSION` 对齐（assemble 期强校验）。
- 脚本按 pin 的 `tag` + `pythonMajorMinor` + 宿主平台三元组，从 GitHub release 解析
  `install_only` 资产，下载后用官方 `.sha256` sidecar 校验完整性。

## 前置

- Node 22+（全局 fetch）；系统 `tar`（Windows 10+/macOS/Linux 自带）；首次需联网。
- 可选 `GITHUB_TOKEN` 避开 API 限流（CI 推荐）。
- 初版仅支持 **Windows x64**；macOS arm64 后续（脚本已留平台分支）。
