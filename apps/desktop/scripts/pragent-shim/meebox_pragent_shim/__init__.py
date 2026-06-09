"""meebox 嵌入式运行时 monkeypatch shim（按领域拆分）。

入口 apply() 由薄 sitecustomize.py 调用，注册全部惰性 post-import hook：仅当目标 pr_agent
模块真正被 import（= 真实 run）时才打补丁。**绝不在此 eager import pr_agent**——本包的所有
模块对 pr_agent 的 import 都在 patch 函数体内（惰性），故 import 本包不会触发 pr_agent 加载。

所有对 pr-agent 行为的改造集中在本包，上游源码保持原封。每个补丁用 try/except 包裹（见
runtime._register_post_import），打不上则静默降级，绝不让 shim 异常阻断流程。
"""
from .patches.litellm_handler import patch as _patch_litellm_handler
from .patches.load_yaml import patch as _patch_load_yaml
from .patches.local_git_provider import patch as _patch_local_git_provider
from .runtime import _debug, _register_post_import


def apply() -> None:
    # local_git_provider 两个补丁合并在一个 patch_fn 里（同模块注册多个 finder 会互相遮蔽，
    # 只有 meta_path[0] 那个生效）：二进制安全 get_diff_files + get_line_link anchor。
    _register_post_import(
        "pr_agent.git_providers.local_git_provider",
        _patch_local_git_provider,
    )
    # litellm handler：CLI 模式分发 + Anthropic 去 temperature + 包 _get_completion 采集 token usage。
    _register_post_import(
        "pr_agent.algo.ai_handlers.litellm_ai_handler",
        _patch_litellm_handler,
    )
    # load_yaml 健壮化：解析失败时剥 anchor marker / 重排多行块标量后重试，避免 review 崩。
    _register_post_import(
        "pr_agent.algo.utils",
        _patch_load_yaml,
    )
    _debug("meebox shim loaded")
