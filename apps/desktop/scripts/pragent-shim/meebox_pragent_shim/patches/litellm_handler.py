"""litellm handler 补丁（合并在一个 patch_fn，同模块注册多 finder 会互相遮蔽）：
  (0) CLI 模式（MEEBOX_CLI_MODE 置位）：换 chat_completion 直接调本机 CLI，绕过 litellm，随后
      return。该分支在版本守卫之前，不受 pr-agent 版本限制。
  (1) Anthropic 新型号去 temperature（仅 pin 版本）。
  (2) 包 _get_completion inline 采集真实 token usage（仅 pin 版本）。
"""
import os

from ..cli.install import _install_cli_chat_completion
from ..runtime import _EXPECTED_PRAGENT_VERSION, _debug, _pragent_version
from ..usage import _emit_usage


def patch(module) -> None:
    """(1) 新版 Anthropic 原厂模型（claude-opus-4-8 等）弃用 temperature 参数，但 pr-agent 默认
    仍发 temperature=0.2 → Anthropic API 直接报 "temperature is deprecated for this model"，
    review/describe 全失败。

    pr-agent 只对 NO_SUPPORT_TEMPERATURE_MODELS 里**精确命中**的型号不发 temperature，该列表
    硬编码且只列了 OpenAI o系列/gpt-5 等，不含任何新 Claude（上游更新滞后）。custom_reasoning_model
    虽也能去 temperature 但会把 system 并进 user（劣化 Claude 的 system prompt），不用。

    这里把模块全局 NO_SUPPORT_TEMPERATURE_MODELS 换成"额外认所有 anthropic/* 前缀模型"的智能
    容器：凡走 anthropic 原厂的模型一律不发 temperature。LiteLLMAIHandler.__init__ 里
    `self.no_support_temperature_models = NO_SUPPORT_TEMPERATURE_MODELS` 取的是模块全局名，故重绑
    全局即对之后创建的 handler 生效；只动成员判定、不碰 system/user 合并。"""
    # (0) CLI 模式：换 chat_completion 直接调本机 CLI，绕过 litellm。放在版本守卫之前，
    # 因为它只依赖 base_ai_handler 的稳定契约，跟 pr-agent 内部实现无关。装好即 return。
    if os.environ.get("MEEBOX_CLI_MODE"):
        handler_cls = getattr(module, "LiteLLMAIHandler", None)
        if handler_cls is not None:
            bin_name = (os.environ.get("MEEBOX_CLI_BIN") or "claude").strip() or "claude"
            _install_cli_chat_completion(handler_cls, bin_name)
        return

    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        # 版本不符：local_git_provider 补丁已 _warn 过总体降级，这里静默跳过避免重复噪音
        _debug(
            f"skip no-temperature patch: pr-agent {installed} != {_EXPECTED_PRAGENT_VERSION}"
        )
        return

    orig = list(getattr(module, "NO_SUPPORT_TEMPERATURE_MODELS", []))

    class _NoTempModels(list):
        def __contains__(self, model) -> bool:
            if list.__contains__(self, model):
                return True
            # 我们的 normalizeModel 给 anthropic provider 一律补 anthropic/ 前缀
            return (model or "").lower().startswith("anthropic/")

    module.NO_SUPPORT_TEMPERATURE_MODELS = _NoTempModels(orig)

    # (2) 真实 token usage 采集：包 LiteLLMAIHandler._get_completion，从其返回的
    # (content, finish_reason, response) 里取 response.usage，inline 打哨兵到 stderr。
    # 不用 litellm 的 callback —— 那是后台 logging worker 异步触发，CLI 退出过快会丢；
    # 这里 inline 在 pr-agent 的 await 链里，必在进程退出前执行，可靠。
    handler_cls = getattr(module, "LiteLLMAIHandler", None)
    if handler_cls is not None and hasattr(handler_cls, "_get_completion"):
        _orig_get_completion = handler_cls._get_completion

        async def _get_completion_with_usage(self, **kwargs):
            # 输出封顶（编排器 chat 通道经 MEEBOX_CHAT_MAX_TOKENS 设；pr-agent 工具 run 的 env 不含
            # 该项，故 /describe /review 不受限）。"thinking" 在场（Claude 扩展思考）时不覆盖其 max_tokens
            # （否则会低于 thinking budget 报错）；已有 max_tokens 也不覆盖。
            mt = os.environ.get("MEEBOX_CHAT_MAX_TOKENS")
            if mt and "thinking" not in kwargs and "max_tokens" not in kwargs:
                try:
                    kwargs["max_tokens"] = int(mt)
                except (TypeError, ValueError):
                    _debug(f"ignore invalid MEEBOX_CHAT_MAX_TOKENS={mt!r}")
            result = await _orig_get_completion(self, **kwargs)
            try:
                if isinstance(result, tuple) and len(result) >= 3:
                    _emit_usage(result[2])
            except Exception as exc:  # noqa: BLE001
                _debug(f"usage wrap failed (ignored): {exc}")
            return result

        handler_cls._get_completion = _get_completion_with_usage
