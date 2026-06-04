# pr-pilot 嵌入式运行时 monkeypatch shim。
#
# 本文件由 assemble-pragent-runtime.mjs 拷进嵌入式 Python 的 site-packages，
# CPython 启动时经 `site` 自动 import（无需 PYTHONPATH/挂载）。见 ADR-0008 §4。
#
# 设计原则：所有对 pr-agent 行为的改造都集中在这里，上游源码保持原封；每个补丁
# 必须用 try/except 包裹，打不上则静默降级，绝不让 shim 异常阻断 pr-agent 主流程。
#
# 阶段 1：故意留空（仅打通基础设施）。后续补丁（如 LocalGitProvider.get_line_link
# 注入结构化 anchor、litellm token 捕获）加进 _apply_patches，并配套 parser /
# CI smoke test 一起上（见 ROADMAP M5「/review finding anchor 根因修复」）。
import os
import sys


def _apply_patches() -> None:
    # 占位：阶段 1 不启用任何补丁。
    #
    # 注意：get_line_link 补丁会把 /review 的 issue 行变成 `[**header**](prpilot://…)`，
    # 必须与 parse-output.ts 的 header 解析改动同批上线，否则会打破现有 finding 解析。
    # 因此这里暂不启用，留到对应任务统一开。
    return


try:
    _apply_patches()
    if os.environ.get("PRPILOT_SHIM_DEBUG"):
        print("[pr-pilot] sitecustomize shim loaded", file=sys.stderr)
except Exception as exc:  # noqa: BLE001 - shim 绝不能让解释器/agent 崩
    if os.environ.get("PRPILOT_SHIM_DEBUG"):
        print(f"[pr-pilot] sitecustomize shim error (ignored): {exc}", file=sys.stderr)
