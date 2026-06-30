# meebox 嵌入式运行时 monkeypatch shim —— 薄加载器。
#
# CPython 启动时经 `site` 自动 import 本模块（名为 sitecustomize，无需 PYTHONPATH/挂载）。
# 真正的补丁实现按领域拆在同目录的 `meebox_pragent_shim` 包里（patches/ 与 cli/）。
# 本文件只负责：调用 apply() 注册全部惰性 post-import hook，并整体兜底——shim 绝不能让
# 解释器/agent 崩。**绝不在此 eager import pr_agent**（本文件每次 python 启动都会跑：
# 探测 --version / find_spec / pip 装包等，eager import 会拖慢甚至在 pr-agent 未装好时报错）。
#
# 由 assemble-pragent-runtime.mjs 把本文件 + meebox_pragent_shim/ 整体拷进 site-packages。
# 详见 docs/arch/02-agent/03-pragent-runtime.md。
try:
    from meebox_pragent_shim import apply

    apply()
except Exception as exc:  # noqa: BLE001 - shim 绝不能让解释器/agent 崩
    try:
        import os
        import sys

        if os.environ.get("MEEBOX_SHIM_DEBUG"):
            print(f"[meebox] sitecustomize loader error (ignored): {exc}", file=sys.stderr)
    except Exception:  # noqa: BLE001
        pass
