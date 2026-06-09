# meebox 嵌入式运行时 monkeypatch shim。
#
# 本文件由 assemble-pragent-runtime.mjs 拷进嵌入式 Python 的 site-packages，
# CPython 启动时经 `site` 自动 import（无需 PYTHONPATH/挂载）。见 ADR-0008 §4。
#
# 设计原则：
#   - 所有对 pr-agent 行为的改造集中在这里，上游源码保持原封。
#   - 每个补丁用 try/except 包裹，打不上则静默降级，绝不让 shim 异常阻断流程。
#   - **绝不在 sitecustomize 阶段 eager import pr_agent**：本文件在每次 python 启动
#     都会跑（探测 --version / find_spec / pip 装包等），eager import 会拖慢每次调用、
#     甚至在 pr-agent 尚未装好时报错。改用惰性 post-import hook：仅当目标模块真正
#     被 import（= 真实 pr-agent run）时才打补丁。
import importlib.abc
import importlib.util
import os
import sys


def _debug(msg: str) -> None:
    if os.environ.get("MEEBOX_SHIM_DEBUG"):
        print(f"[meebox] {msg}", file=sys.stderr)


def _warn(msg: str) -> None:
    """始终输出到 stderr（不受 MEEBOX_SHIM_DEBUG 控制）。用于版本不符等"补丁静默失效"
    的降级场景，必须让用户/日志看见。stderr 不影响 parse-output（它只解析 stdout）。"""
    print(f"[meebox] WARNING: {msg}", file=sys.stderr)


# 本 shim 的 monkeypatch 依赖 pr-agent **特定版本**的内部实现（get_line_link 渲染分支、
# get_diff_files 解码逻辑）。升级 pr-agent 可能让 patch 失配甚至误伤，故只对下面 pin 的
# 版本生效；版本不符即跳过全部 patch（安全降级，宁可少打补丁也不乱打）。
# 升级 pr-agent 时：同步此常量 + scripts/pragent-runtime.json 的 prAgent.version
# （assemble 脚本会校验两者一致），并重新验证 patch 行为。
_EXPECTED_PRAGENT_VERSION = "0.36.0"


def _pragent_version():
    """读已安装 pr-agent 版本（仅读 dist 元数据，不 import pr_agent）。拿不到返回 None。"""
    try:
        from importlib.metadata import version

        return version("pr-agent")
    except Exception:  # noqa: BLE001 - 未安装 / 元数据缺失（pip 装包途中等）
        return None


def _register_post_import(module_name, patch_fn) -> None:
    """注册一个 meta_path finder：当 module_name 被 import 后立即执行 patch_fn(module)。
    不在此处 import 该模块，保持 python 启动/探测/pip 轻量。"""

    class _Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname != module_name:
                return None
            # 临时摘掉自己，借默认机制拿到真实 spec，再包一层 loader 在 exec 后 patch
            sys.meta_path.remove(self)
            try:
                spec = importlib.util.find_spec(fullname)
            finally:
                sys.meta_path.insert(0, self)
            if spec is None or spec.loader is None:
                return None
            orig_exec = spec.loader.exec_module

            def exec_module(module):
                orig_exec(module)
                try:
                    patch_fn(module)
                    _debug(f"patched {module_name}")
                except Exception as exc:  # noqa: BLE001
                    _debug(f"patch {module_name} failed (ignored): {exc}")

            spec.loader.exec_module = exec_module
            return spec

    sys.meta_path.insert(0, _Finder())


def _patch_local_git_provider_binary_safe(module) -> None:
    """LocalGitProvider.get_diff_files 对每个 diff 文件无脑 .decode('utf-8')，遇到二进制
    文件（图片 / 编译产物 / UTF-16 等，如 0xff 开头）抛 UnicodeDecodeError 崩掉整个 review。
    换成二进制安全版：解码失败的文件跳过（review 不处理二进制），其余逻辑与上游一致。"""
    # 版本守卫：只对 pin 的 pr-agent 版本打补丁；不符则整组跳过（含 get_line_link）。
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _warn(
            f"pr-agent {installed} 与 meebox 补丁适配的 {_EXPECTED_PRAGENT_VERSION} 不符，"
            "已跳过补丁（/review 行号定位、二进制安全 diff 失效）。如为有意升级，请同步 "
            "sitecustomize.py 的 _EXPECTED_PRAGENT_VERSION + pragent-runtime.json 并重新验证。"
        )
        return
    from pr_agent.algo.types import EDIT_TYPE, FilePatchInfo

    def get_diff_files(self):
        diffs = self.repo.head.commit.diff(
            self.repo.merge_base(self.repo.head, self.repo.branches[self.target_branch_name]),
            create_patch=True,
            R=True,
        )
        diff_files = []
        for diff_item in diffs:
            try:
                original_file_content_str = (
                    diff_item.a_blob.data_stream.read().decode("utf-8")
                    if diff_item.a_blob is not None
                    else ""
                )
                new_file_content_str = (
                    diff_item.b_blob.data_stream.read().decode("utf-8")
                    if diff_item.b_blob is not None
                    else ""
                )
                patch_str = diff_item.diff.decode("utf-8")
            except (UnicodeDecodeError, ValueError):
                # 二进制文件无法 utf-8 解码 → 跳过该文件
                continue
            edit_type = EDIT_TYPE.MODIFIED
            if diff_item.new_file:
                edit_type = EDIT_TYPE.ADDED
            elif diff_item.deleted_file:
                edit_type = EDIT_TYPE.DELETED
            elif diff_item.renamed_file:
                edit_type = EDIT_TYPE.RENAMED
            diff_files.append(
                FilePatchInfo(
                    original_file_content_str,
                    new_file_content_str,
                    patch_str,
                    diff_item.b_path,
                    edit_type=edit_type,
                    old_filename=None
                    if diff_item.a_path == diff_item.b_path
                    else diff_item.a_path,
                )
            )
        self.diff_files = diff_files
        return diff_files

    module.LocalGitProvider.get_diff_files = get_diff_files

    # get_line_link: 基类默认 `return ''`，LocalGitProvider 未实现 → /review 的
    # key_issues 渲染（convert_to_markdown_v2）走"无 link + 非 GFM"分支，把
    # relevant_file/start_line/end_line 抹掉（见 ROADMAP M5 anchor 根因）。补成
    # meebox:///<url-encoded-file>#L<s>-L<e>，使其走 [**header**](link) 分支，
    # parse-output 据链接取结构化 anchor（与真实 provider 同源，不依赖模型自报 marker）。
    from urllib.parse import quote

    def get_line_link(self, relevant_file, relevant_line_start, relevant_line_end=None):
        f = quote((relevant_file or "").lstrip("/"), safe="/")
        if not f:
            return ""
        if not relevant_line_start:
            return f"meebox:///{f}"
        if relevant_line_end and relevant_line_end != relevant_line_start:
            return f"meebox:///{f}#L{relevant_line_start}-L{relevant_line_end}"
        return f"meebox:///{f}#L{relevant_line_start}"

    module.LocalGitProvider.get_line_link = get_line_link


def _emit_usage(response) -> None:
    """从 litellm response 读**真实 usage**（API 返回，非预估），以哨兵行 `@@MEEBOX_USAGE@@ {json}`
    打到 stderr。主进程 onLine 据此累加（见 ipc.ts）。只取 token、不取 cost。全程容错。"""
    try:
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if usage is None:
            return

        def _g(key):
            return usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)

        import json

        rec = {
            "prompt_tokens": _g("prompt_tokens"),
            "completion_tokens": _g("completion_tokens"),
            "total_tokens": _g("total_tokens"),
        }
        if rec["prompt_tokens"] is None and rec["completion_tokens"] is None:
            return  # 没有任何可用数字（如流式 MockResponse）→ 不打
        print(f"@@MEEBOX_USAGE@@ {json.dumps(rec)}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        _debug(f"emit usage failed (ignored): {exc}")


def _emit_usage_tokens(prompt_tokens, completion_tokens) -> None:
    """CLI 模式下从 CLI 返回的 JSON usage 直接构造 `@@MEEBOX_USAGE@@` 哨兵（与 _emit_usage 同
    格式，主进程 onLine 同一套累加逻辑）。两个数都为 None 则不打。"""
    try:
        if prompt_tokens is None and completion_tokens is None:
            return
        import json

        rec = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": (prompt_tokens or 0) + (completion_tokens or 0),
        }
        print(f"@@MEEBOX_USAGE@@ {json.dumps(rec)}", file=sys.stderr, flush=True)
    except Exception as exc:  # noqa: BLE001
        _debug(f"emit cli usage failed (ignored): {exc}")


def _resolve_cli_exe(bin_name):
    """用 shutil.which 解析命令真实路径。Windows 据 PATHEXT 命中 .cmd/.bat（不能被 CreateProcess
    直接拉起，须经 cmd /c）。返回 (exe_path_or_None, needs_cmd_wrapper)。"""
    import shutil

    exe = shutil.which(bin_name)
    if not exe:
        return None, False
    needs_cmd = sys.platform == "win32" and exe.lower().endswith((".cmd", ".bat"))
    return exe, needs_cmd


def _parse_claude_output(stdout):
    """解析 `claude -p --output-format json` 的 stdout，返回 (text, usage_dict_or_None)。
    成功形如 {"result": "...", "usage": {"input_tokens":..,"output_tokens":..}, "is_error": false}。
    非 JSON / 缺字段退化为「整段 stdout 当文本、usage=None」；仅 is_error=True 时抛错。"""
    import json

    s = (stdout or "").strip()
    if not s:
        return "", None
    try:
        obj = json.loads(s)
    except Exception:  # noqa: BLE001 - 非 JSON → 原样当文本
        return s, None
    if not isinstance(obj, dict):
        return s, None
    if obj.get("is_error"):
        raise RuntimeError(f"claude CLI 返回错误: {str(obj.get('result') or obj)[:500]}")
    text = obj.get("result")
    if not isinstance(text, str):
        text = s
    usage = obj.get("usage")
    return text, (usage if isinstance(usage, dict) else None)


def _parse_codex_output(stdout):
    """解析 `codex exec --json` 的 JSONL 事件流，返回 (text, usage_dict_or_None)：
      - type==item.completed 且 item.type==agent_message → item.text 为模型回复，取最后一条；
      - type==turn.completed → usage {input_tokens, output_tokens} 为 token。
    逐行容错：非 JSON 行跳过、事件缺字段不致命；text 缺失退到空串（让上层 load_yaml 兜底）。"""
    import json

    text = None
    usage = None
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:  # noqa: BLE001 - 非 JSON 行（日志等）跳过
            continue
        if not isinstance(ev, dict):
            continue
        etype = ev.get("type")
        if etype == "item.completed":
            item = ev.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                txt = item.get("text")
                if isinstance(txt, str):
                    text = txt  # 取最后一条 agent_message 作最终回复
        elif etype == "turn.completed":
            u = ev.get("usage")
            if isinstance(u, dict):
                usage = u
    return (text if isinstance(text, str) else ""), usage


# 已适配的本机 CLI 命令规格：argv flags（prompt 一律走 stdin）+ 输出解析器 + 需剥离的计费 env。
# 新增命令在此登记一套即可；renderer 侧白名单校验须同步（见 LlmProfileForm.validateProfile）。
_CLI_SPECS = {
    # claude：-p 单轮非交互 + JSON（一段含结果与 usage）；不传 --model，用本机默认模型/登录态。
    "claude": {
        "flags": ["-p", "--output-format", "json"],
        "parser": _parse_claude_output,
        "strip_env": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    },
    # codex：exec 非交互 + --json（JSONL 事件流）；末位 `-` 让 stdin 作完整 prompt；
    # --skip-git-repo-check 容许临时目录运行，--sandbox read-only 只读不改文件。
    "codex": {
        "flags": ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"],
        "parser": _parse_codex_output,
        "strip_env": ("OPENAI_API_KEY", "CODEX_API_KEY"),
    },
}


def _install_cli_chat_completion(handler_cls, bin_name) -> None:
    """CLI 模式把 LiteLLMAIHandler.chat_completion 整体替换成「调本机 CLI 子进程」版本，完全绕过
    litellm / 直连 API。pr-agent 只依赖 chat_completion 返回 (text, finish_reason) 这个稳定契约
    （base_ai_handler 定义），故本替换与 pr-agent 具体版本无关，**不受版本守卫限制**。

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
    argv = ((["cmd", "/c", exe] if needs_cmd else [exe]) + spec["flags"]) if (spec and exe) else None

    async def chat_completion(self, model, system, user, temperature=0.2, img_path=None):
        if spec is None:
            raise RuntimeError(
                f"不支持的本地 CLI 命令 '{bin_name}'（当前已适配 claude / codex）。"
            )
        if argv is None:
            raise RuntimeError(
                f"找不到本地 CLI 命令 '{bin_name}'：请确认已安装、已登录，且 '{bin_name}' 在 PATH 中。"
            )
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


def _patch_litellm_handler(module) -> None:
    """对 pr-agent 的 litellm handler 模块打补丁（合并在一个 patch_fn，同模块注册多 finder 会
    互相遮蔽）。

    (0) **CLI 模式**（MEEBOX_CLI_MODE 置位）：直接把 chat_completion 换成调本机 CLI 的版本，绕过
        litellm，随后 return —— 去 temperature / usage-wrap 两个 litellm 补丁此时无意义。该分支
        在版本守卫之前，不受 pr-agent 版本限制。

    其余两个补丁（仅在 pin 版本生效）：(1) Anthropic 新型号去 temperature；(2) 包 _get_completion
    inline 采集真实 token usage。

    (1) 新版 Anthropic 原厂模型（claude-opus-4-8 等）弃用 temperature 参数，但 pr-agent 默认
    仍发 temperature=0.2 → Anthropic API 直接报 "temperature is deprecated for this model"，
    review/describe 全失败。

    pr-agent 只对 NO_SUPPORT_TEMPERATURE_MODELS 里**精确命中**的型号不发 temperature，该列表
    硬编码且只列了 OpenAI o系列/gpt-5 等，不含任何新 Claude（上游更新滞后）。custom_reasoning_model
    虽也能去 temperature 但会把 system 并进 user（劣化 Claude 的 system prompt），不用。

    这里把模块全局 NO_SUPPORT_TEMPERATURE_MODELS 换成"额外认所有 anthropic/* 前缀模型"的智能
    容器：凡走 anthropic 原厂的模型一律不发 temperature（Anthropic 不传时默认即可，省去逐型号
    追新维护），既修当下报错也兼容未来新型号。LiteLLMAIHandler.__init__ 里
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
            result = await _orig_get_completion(self, **kwargs)
            try:
                if isinstance(result, tuple) and len(result) >= 3:
                    _emit_usage(result[2])
            except Exception as exc:  # noqa: BLE001
                _debug(f"usage wrap failed (ignored): {exc}")
            return result

        handler_cls._get_completion = _get_completion_with_usage


def _reflow_unindented_multiline(text):
    """修复模型最常见的破 YAML 写法：把多行自由文本值（中文 issue_content / issue_header 等）
    写成「key: 内联首行」+ 续行**顶格（第 1 列）**，没有用块标量 `|`。YAML 把续行当成新 key →
    `could not find expected ':'`，pr-agent 自带 fallback 也救不回（其首个 fallback 只对固定 key
    列表补 `|`，且不重排续行缩进）。

    这里把「key: 内联值 + 紧随其后的非 key / 非 list-item 行」整体重排成 `key: |-` 块标量并统一
    缩进，使值完整保留为多行字符串。仅在原始解析失败后调用；任何不匹配都原样保留（无回归）。"""
    import re

    key_re = re.compile(r"^(\s*)(-\s+)?([A-Za-z_][A-Za-z0-9_ ]*):(.*)$")
    lines = text.split("\n")
    out = []
    i = 0
    n = len(lines)
    while i < n:
        m = key_re.match(lines[i])
        if not m:
            out.append(lines[i])
            i += 1
            continue
        indent, dash, key, rest = m.group(1), (m.group(2) or ""), m.group(3), m.group(4)
        rest_s = rest.strip()
        # 收集续行：直到遇到下一个 key 行 / list-item / 文件结束
        j = i + 1
        cont = []
        while j < n:
            nxt = lines[j]
            if key_re.match(nxt) or nxt.lstrip().startswith("- "):
                break
            cont.append(nxt)
            j += 1
        is_block = rest_s in ("|", "|-", "|2", ">", ">-") or rest_s.endswith(("|", "|-"))
        if any(c.strip() for c in cont) and not is_block:
            ci = " " * (len(indent) + len(dash) + 2)  # 块标量内容须比 key 列更深
            out.append(f"{indent}{dash}{key}: |-")
            if rest_s:
                out.append(ci + rest_s)
            for c in cont:
                out.append(ci + c.strip() if c.strip() else "")
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _patch_load_yaml_robust(module) -> None:
    """pr-agent 把 LLM 输出按 YAML 解析（pr_agent.algo.utils.load_yaml）。模型偶发产出破格 YAML →
    safe_load + pr-agent 自带 fallback 全失败 → load_yaml 返回 None → pr_reviewer 迭代 None 崩
    （argument of type 'NoneType' is not iterable），整个 review 失败。两类高频破格：
      1. 我们注入的 anchor `[file: ...]` marker 独占一行落在 mapping 上下文，`[` 被当 flow 序列起始；
      2. 多行自由文本值（中文 issue_content 等）续行顶格、未用块标量 `|`（见 _reflow_unindented_multiline）。

    包一层 load_yaml：原逻辑成功就原样返回（不影响正常路径 + 行号兜底）；失败时依次尝试
    「剥 marker」「重排多行块标量」「两者叠加」，每个候选都交回原 load_yaml（含其自身 try_fix_yaml）。
    全部失败才返回 None。inline marker / 合法 YAML 不受影响。

    pr_reviewer 用 `from pr_agent.algo.utils import load_yaml`，utils 先于 tools 被 import，本 patch
    在 utils exec 完后替换 module.load_yaml，故 tools 后续 import 拿到的是包装版。"""
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _debug(f"skip load_yaml patch: pr-agent {installed} != {_EXPECTED_PRAGENT_VERSION}")
        return

    import re as _re

    orig_load_yaml = module.load_yaml
    # 整行仅为 `[file: ...]`（含缩进/path-only 形式），吃掉行尾换行
    marker_line_re = _re.compile(r"(?m)^[ \t]*\[file:[^\]\n]*\][ \t]*$\n?")

    def load_yaml(response_text, *args, **kwargs):
        data = orig_load_yaml(response_text, *args, **kwargs)
        if data:
            return data
        if not isinstance(response_text, str):
            return data
        # 候选修复，按代价从小到大；每个交回原 load_yaml（其内部还会再跑 try_fix_yaml）
        stripped = marker_line_re.sub("", response_text)
        attempts = []
        if stripped != response_text:
            attempts.append(stripped)
        reflowed = _reflow_unindented_multiline(response_text)
        if reflowed != response_text:
            attempts.append(reflowed)
        if stripped != response_text:
            r2 = _reflow_unindented_multiline(stripped)
            if r2 != stripped and r2 != response_text:
                attempts.append(r2)
        for cand in attempts:
            try:
                d = orig_load_yaml(cand, *args, **kwargs)
            except Exception:  # noqa: BLE001 - 修复尝试失败不致命，继续下一个
                d = None
            if d:
                _debug("load_yaml recovered via meebox repair")
                return d
        return data

    module.load_yaml = load_yaml


def _apply_patches() -> None:
    # local_git_provider 两个补丁合并在一个 patch_fn 里（同模块注册多个 finder 会互相
    # 遮蔽，只有 meta_path[0] 那个生效）：二进制安全 get_diff_files + get_line_link anchor。
    _register_post_import(
        "pr_agent.git_providers.local_git_provider",
        _patch_local_git_provider_binary_safe,
    )
    # litellm handler 两个补丁：Anthropic 新型号去 temperature + 包 _get_completion inline 采集 token usage。
    _register_post_import(
        "pr_agent.algo.ai_handlers.litellm_ai_handler",
        _patch_litellm_handler,
    )
    # load_yaml 健壮化：解析失败时剥 anchor marker / 重排多行块标量后重试，避免 review 崩。
    _register_post_import(
        "pr_agent.algo.utils",
        _patch_load_yaml_robust,
    )


try:
    _apply_patches()
    _debug("sitecustomize shim loaded")
except Exception as exc:  # noqa: BLE001 - shim 绝不能让解释器/agent 崩
    _debug(f"sitecustomize shim error (ignored): {exc}")
