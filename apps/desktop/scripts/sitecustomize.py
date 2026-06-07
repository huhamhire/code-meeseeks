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


def _patch_litellm_no_temperature(module) -> None:
    """新版 Anthropic 原厂模型（claude-opus-4-8 等）弃用 temperature 参数，但 pr-agent 默认
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


def _patch_load_yaml_strip_anchor_markers(module) -> None:
    """模型按我们的 anchor 指令把 `[file: <path>, lines: <s>-<e>]` marker 放到自成一行的位置。
    若该行落在 YAML mapping 上下文（没嵌在 block scalar 里），`[` 被 YAML 当作 flow 序列起始 →
    safe_load 报 "could not find expected ':'"，pr-agent 自带 fallback 也救不回，load_yaml 返回
    None → pr_reviewer 迭代 None 崩（argument of type 'NoneType' is not iterable），整个 review 失败。

    包一层 load_yaml：先按原逻辑解析（marker 安全嵌在 block scalar 里时正常返回，行号兜底不丢）；
    仅当原始解析失败（返回空）时，剥掉这些**独占一行**的 marker 再试一次——宁可丢这条行号兜底
    （meebox 链接仍给可靠 path），也不让整个 review 崩。inline 的 marker 不动（不会破 YAML）。

    pr_reviewer 用 `from pr_agent.algo.utils import load_yaml`，而 utils 先于 tools 被 import，
    本 patch 在 utils exec 完后替换 module.load_yaml，故 tools 后续 import 拿到的是包装版。"""
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
        cleaned = marker_line_re.sub("", response_text)
        if cleaned != response_text:
            _debug("retry load_yaml after stripping standalone [file:...] markers")
            return orig_load_yaml(cleaned, *args, **kwargs)
        return data

    module.load_yaml = load_yaml


def _apply_patches() -> None:
    # local_git_provider 两个补丁合并在一个 patch_fn 里（同模块注册多个 finder 会互相
    # 遮蔽，只有 meta_path[0] 那个生效）：二进制安全 get_diff_files + get_line_link anchor。
    _register_post_import(
        "pr_agent.git_providers.local_git_provider",
        _patch_local_git_provider_binary_safe,
    )
    # Anthropic 新型号弃用 temperature：把全 anthropic/* 纳入"不发 temperature"集合。
    _register_post_import(
        "pr_agent.algo.ai_handlers.litellm_ai_handler",
        _patch_litellm_no_temperature,
    )
    # anchor marker 独占一行会破 YAML：load_yaml 解析失败时剥掉 marker 重试，避免 review 崩。
    _register_post_import(
        "pr_agent.algo.utils",
        _patch_load_yaml_strip_anchor_markers,
    )


try:
    _apply_patches()
    _debug("sitecustomize shim loaded")
except Exception as exc:  # noqa: BLE001 - shim 绝不能让解释器/agent 崩
    _debug(f"sitecustomize shim error (ignored): {exc}")
