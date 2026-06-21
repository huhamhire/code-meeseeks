"""CLI 模式：把 LiteLLMAIHandler.chat_completion 整体替换成「调本机 CLI 子进程」版本，
完全绕过 litellm / 直连 API。由 patches.litellm_handler 在 MEEBOX_CLI_MODE 置位时调用。"""
import os
import sys

from ..runtime import _debug, strip_cache_break
from ..usage import _emit_usage_tokens
from .specs import _CLI_SPECS


def _resolve_cli_exe(bin_name):
    """用 shutil.which 解析命令真实路径。Windows 据 PATHEXT 命中 .cmd/.bat（不能被 CreateProcess
    直接拉起，须经 cmd /c）。返回 (exe_path_or_None, needs_cmd_wrapper)。"""
    import shutil

    exe = shutil.which(bin_name)
    if not exe:
        return None, False
    needs_cmd = sys.platform == "win32" and exe.lower().endswith((".cmd", ".bat"))
    return exe, needs_cmd


def _install_cli_chat_completion(handler_cls, bin_name) -> None:
    """把 chat_completion 换成调本机 CLI 子进程的版本。pr-agent 只依赖 chat_completion 返回
    (text, finish_reason) 这个稳定契约（base_ai_handler 定义），故本替换与 pr-agent 具体版本
    无关，**不受版本守卫限制**（区别于依赖内部实现的其它 patch）。

    各命令差异（argv flags / 输出解析 / 需剥离的计费 env）集中在 _CLI_SPECS，按命令名取用：
      - prompt 经 **stdin** 喂入：review prompt 含完整 diff（数十 KB），走 argv 会撞命令行长度上限；
        system / user 拼成一段（CLI 单轮无独立 system 槽）。
      - cwd 落到中性临时目录：避免吃到被评审仓库的上下文（CLAUDE.md / AGENTS.md 等）污染输出。
      - 子进程继承父 env（PATH / HOME / 代理变量），故能找到命令、复用其登录态、出站自动走代理。
      - **凭据隔离**：剥掉对应计费 key（claude: ANTHROPIC_*；codex: OPENAI_API_KEY / CODEX_API_KEY），
        让 CLI 使用其自身登录会话，而非环境里残留的 API key。模型与额度由该 CLI 账户与用户授权决定。"""
    import asyncio
    import tempfile

    name = (bin_name or "").strip().lower()
    spec = _CLI_SPECS.get(name)
    exe, needs_cmd = _resolve_cli_exe(bin_name) if spec else (None, False)
    # 命令前缀（cmd 包装 + exe）；exe 解析失败为 None。flags 每次调用按 env 组装（低算力档）。
    cmd_prefix = (["cmd", "/c", exe] if needs_cmd else [exe]) if (spec and exe) else None

    def _build_argv():
        flags = list(spec["flags"])
        # 低算力档：仅 Agent 编排通道经 MEEBOX_CLI_REASONING=low/minimal 开启；把 low_effort_flags
        # 插到尾部 `-`（stdin 占位）之前、保持 `-` 在末位；无尾部 `-` 则直接追加。
        if os.environ.get("MEEBOX_CLI_REASONING", "").strip().lower() in ("low", "minimal"):
            extra = list(spec.get("low_effort_flags") or [])
            if extra:
                flags = flags[:-1] + extra + ["-"] if flags and flags[-1] == "-" else flags + extra
        return cmd_prefix + flags

    async def chat_completion(self, model, system, user, temperature=0.2, img_path=None):
        if spec is None:
            raise RuntimeError(
                f"不支持的本地 CLI 命令 '{bin_name}'（当前已适配 claude / codex）。"
            )
        if cmd_prefix is None:
            raise RuntimeError(
                f"找不到本地 CLI 命令 '{bin_name}'：请确认已安装、已登录，且 '{bin_name}' 在 PATH 中。"
            )
        argv = _build_argv()
        # CLI 单轮无独立 system 槽：system+user 拼一段。先剥除缓存断点标记（仅 Anthropic litellm 路径用于
        # 分块缓存；CLI 不缓存、标记不得进入 prompt）。
        system = strip_cache_break(system) if system else system
        prompt = f"{system}\n\n\n{user}" if system else user
        # 基于 os.environ 拷贝再剔除计费 key——其余（PATH/HOME/代理变量等）原样保留。
        child_env = {k: v for k, v in os.environ.items() if k not in spec["strip_env"]}
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=tempfile.gettempdir(),
                env=child_env,
            )
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"启动 CLI '{bin_name}' 失败: {exc}") from exc
        out, err = await proc.communicate(prompt.encode("utf-8"))
        if proc.returncode != 0:
            raise RuntimeError(
                f"CLI '{bin_name}' 退出码 {proc.returncode}: "
                f"{(err or b'').decode('utf-8', 'replace')[:500]}"
            )
        text, usage = spec["parser"]((out or b"").decode("utf-8", "replace"))
        if usage:
            # input_tokens(+cache_*) ≈ prompt，output_tokens ≈ completion（两家 usage 同字段名）
            prompt_tokens = usage.get("input_tokens")
            for k in ("cache_read_input_tokens", "cache_creation_input_tokens"):
                v = usage.get(k)
                if isinstance(v, int):
                    prompt_tokens = (prompt_tokens or 0) + v
            _emit_usage_tokens(prompt_tokens, usage.get("output_tokens"))
        return text, "stop"

    handler_cls.chat_completion = chat_completion
    _debug(f"installed CLI chat_completion via '{bin_name}'")
