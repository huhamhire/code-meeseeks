"""litellm handler 补丁（合并在一个 patch_fn，同模块注册多 finder 会互相遮蔽）：
  (0) CLI 模式（MEEBOX_CLI_MODE 置位）：换 chat_completion 直接调本机 CLI，绕过 litellm，随后
      return。该分支在版本守卫之前，不受 pr-agent 版本限制。
  (1) Anthropic 新型号去 temperature（仅 pin 版本）。
  (2) 包 _get_completion inline 采集真实 token usage（仅 pin 版本）。
"""
import os

from ..cli.install import _install_cli_chat_completion
from ..runtime import (
    _EXPECTED_PRAGENT_VERSION,
    _debug,
    _pragent_version,
    split_cache_break,
)
from ..usage import _emit_usage

# Anthropic 提示缓存最小可缓存粒度约 1k token；稳定前缀低于此不标缓存（含极小的判读 system）。
_CACHE_MIN_CHARS = 4000
# 全局稳定前缀用 1h 扩展 TTL：跨所有 PR/运行在 1h 内命中，写入 2× 由大量命中摊薄；需带 beta 头。
_CACHE_TTL = "1h"
_CACHE_BETA_FLAG = "extended-cache-ttl-2025-04-11"


def _add_cache_beta_header(kwargs: dict) -> None:
    """合入 1h 缓存所需 anthropic-beta 头（不覆盖既有标志）。"""
    headers = kwargs.get("extra_headers")
    if not isinstance(headers, dict):
        headers = {}
    existing = headers.get("anthropic-beta")
    if not existing:
        headers["anthropic-beta"] = _CACHE_BETA_FLAG
    elif _CACHE_BETA_FLAG not in existing:
        headers["anthropic-beta"] = f"{existing},{_CACHE_BETA_FLAG}"
    kwargs["extra_headers"] = headers


def _apply_system_prompt_cache(kwargs: dict) -> None:
    """为 Anthropic 给 system 的稳定前缀标 cache_control(1h 扩展 TTL)；并在任何情况下剥除 CACHE_BREAK 标记。
    Anthropic 提示缓存按**前缀**、**服务端**生效（不依赖暖会话），跨所有 PR/运行在 1h 内命中（写入 2× 由命中摊薄）。
    覆盖两类 Anthropic 调用：

    1) 编排 chat 通道（MEEBOX_CHAT_CACHE 置位、system 含 assembleSystemContext 插入的 CACHE_BREAK）：按断点把
       全局稳定前缀（SOUL/AGENTS/工具/记忆/用户）单独标缓存、PR/运行相关尾部保持纯文本。
    2) pr-agent 工具 run（/review /describe /improve /ask，**无** CACHE_BREAK）：system 即 pr-agent 的指令 +
       输出格式（约 12k 字符，仅随配置/语言/规则变、跨 PR 稳定；可变的 diff 在 user 侧），整段标缓存 → 同配置下
       跨运行 1h 内命中。

    非 Anthropic（OpenAI/DeepSeek 等）：自带自动前缀缓存、无需显式标，仅剥除 CACHE_BREAK 标记拼回纯文本；前缀
    过小（< _CACHE_MIN_CHARS，如精简判读 system）也不标。
    """
    msgs = kwargs.get("messages")
    if not isinstance(msgs, list):
        return
    is_anthropic = (kwargs.get("model") or "").lower().startswith("anthropic/")
    chat_cache_on = bool(os.environ.get("MEEBOX_CHAT_CACHE"))
    for m in msgs:
        if m.get("role") != "system" or not isinstance(m.get("content"), str):
            continue
        stable, variable = split_cache_break(m["content"])
        if stable is not None:
            # 含 CACHE_BREAK（编排 chat）：稳定前缀标缓存、尾部纯文本
            if chat_cache_on and is_anthropic and len(stable) >= _CACHE_MIN_CHARS:
                m["content"] = [
                    {
                        "type": "text",
                        "text": stable,
                        "cache_control": {"type": "ephemeral", "ttl": _CACHE_TTL},
                    },
                    {"type": "text", "text": variable},
                ]
                _add_cache_beta_header(kwargs)
            else:
                # 非 anthropic / 未开缓存 / 前缀过小：去标记拼回纯文本（自动前缀缓存仍可命中）。
                m["content"] = f"{stable}\n\n---\n\n{variable}"
            return
        # 无 CACHE_BREAK（pr-agent 工具 run）：Anthropic 把整段稳定 system 标缓存（diff 在 user 侧、不进缓存）。
        if is_anthropic and len(m["content"]) >= _CACHE_MIN_CHARS:
            m["content"] = [
                {
                    "type": "text",
                    "text": m["content"],
                    "cache_control": {"type": "ephemeral", "ttl": _CACHE_TTL},
                },
            ]
            _add_cache_beta_header(kwargs)
        return


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
    # 抑制 litellm 往 **stdout** 打的「Provider List: …」等装饰性提示（ANSI 红字）。编排 chat 通道以子进程
    # stdout 作模型回复：litellm 在 cost/token 计量里对未进本地 model_cost 表的新模型（如 claude-opus-4-8）
    # 调 get_llm_provider 失败时会先 print 该提示再抛错（错误被上游吞掉、不影响最终结果），但 print 已污染
    # stdout、漏进评审总结。置 suppress_debug_info=True 关掉这些 print（真实 usage 由我们自己的 hook 采集，
    # 不依赖这些输出）。全局生效、与 pr-agent 版本无关，故放在版本守卫与 CLI 分支之前。
    try:
        import litellm

        litellm.suppress_debug_info = True
    except Exception:  # noqa: BLE001 - litellm 未就绪等，纯装饰性抑制失败不致命
        pass
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
            _apply_system_prompt_cache(kwargs)
            result = await _orig_get_completion(self, **kwargs)
            try:
                if isinstance(result, tuple) and len(result) >= 3:
                    _emit_usage(result[2])
            except Exception as exc:  # noqa: BLE001
                _debug(f"usage wrap failed (ignored): {exc}")
            return result

        handler_cls._get_completion = _get_completion_with_usage
