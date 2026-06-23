"""嵌入式运行时 monkeypatch 的基础设施：惰性 post-import hook 注册、版本守卫、日志。

绝不在本模块（或其加载链）eager import pr_agent —— sitecustomize 在每次 python 启动都会
加载本包，eager import 会拖慢每次调用、甚至在 pr-agent 尚未装好时报错。各 patch 对 pr_agent
的 import 一律放在 patch 函数体内（惰性），仅当目标模块真正被 import 时才执行。
"""
import importlib.abc
import importlib.util
import os
import sys

# 本 shim 的 monkeypatch 依赖 pr-agent **特定版本**的内部实现（get_line_link 渲染分支、
# get_diff_files 解码逻辑、load_yaml 等）。升级 pr-agent 可能让 patch 失配甚至误伤，故只对
# 下面 pin 的版本生效；版本不符即跳过相关 patch（安全降级，宁可少打补丁也不乱打）。
# 升级 pr-agent 时：同步此常量 + scripts/pragent-runtime.json 的 prAgent.version
# （assemble 脚本会校验两者一致，并据本文件抽取该常量），并重新验证 patch 行为。
_EXPECTED_PRAGENT_VERSION = "0.36.0"

# 系统上下文「缓存断点」标记：assembleSystemContext（TS, packages/agent/src/assemble.ts）在**全局稳定
# 前缀**（SOUL/AGENTS/工具目录/记忆/用户档）与 **PR/运行相关尾部** 之间插入此串（连同两侧 --- 分隔）。
# shim 据此把稳定前缀单独标 Anthropic 提示缓存（1h），尾部保持纯文本；消费端（litellm 分块 / CLI 拼接）
# 分割或剥除后，标记**绝不**进入发给模型的 prompt。两处常量须逐字一致。
CACHE_BREAK = "\n\n---\n\n[[MEEBOX:CACHE_BREAK]]\n\n---\n\n"


def split_cache_break(system):
    """按缓存断点切分 system → (stable_prefix, variable_tail)。无断点返回 (None, system)。"""
    stable, sep, variable = system.partition(CACHE_BREAK)
    if not sep:
        return None, system
    return stable, variable


def strip_cache_break(system):
    """剥除缓存断点标记（不分块的消费端用，如 CLI prompt 拼接），塌成单个 --- 分隔。"""
    return system.replace(CACHE_BREAK, "\n\n---\n\n")


def _debug(msg) -> None:
    if os.environ.get("MEEBOX_SHIM_DEBUG"):
        print(f"[meebox] {msg}", file=sys.stderr)


def _warn(msg) -> None:
    """始终输出到 stderr（不受 MEEBOX_SHIM_DEBUG 控制）。用于版本不符等"补丁静默失效"的降级
    场景，必须让用户/日志看见。stderr 不影响 parse-output（它只解析 stdout）。"""
    print(f"[meebox] WARNING: {msg}", file=sys.stderr)


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
