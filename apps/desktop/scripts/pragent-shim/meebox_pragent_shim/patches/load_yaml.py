"""load_yaml 健壮化补丁（受版本守卫）：解析失败时剥 anchor marker / 重排多行块标量后重试，
避免模型偶发破格 YAML 让整个 /review 崩。"""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _debug, _pragent_version


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


def patch(module) -> None:
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

    # loguru 全局单例（pr_agent.log 用的同一个）。用于在「首探+修复」阶段临时压制
    # pr_agent.algo.utils 的失败日志；import 失败则降级为不压制（不致命）。
    try:
        from loguru import logger as _loguru_logger
    except Exception:  # noqa: BLE001
        _loguru_logger = None

    orig_load_yaml = module.load_yaml
    # 整行仅为 `[file: ...]`（含缩进/path-only 形式），吃掉行尾换行
    marker_line_re = _re.compile(r"(?m)^[ \t]*\[file:[^\]\n]*\][ \t]*$\n?")
    # 激进兜底：`[file:` 起、吃到 `]` 或行尾（闭合 `]` 可选），出现在**任意位置**都抹掉。
    # 统一覆盖：独占整行、行内（`issue text [file:...]`）、值位、以及模型截断漏 `]` 的未闭合
    # marker。marker_line_re（仅独占整行的闭合形式）漏掉的破格全归它收。
    marker_any_re = _re.compile(r"\[file:[^\]\n]*\]?")

    def _repair_candidates(response_text):
        """生成修复候选，按代价从小到大；每个交回原 load_yaml（其内部还会再跑 try_fix_yaml）。
        marker 仅是行号兜底（anchor 主源是 get_line_link 的 meebox:/// 链接），recovery 路径剥掉
        它不影响主锚点，优先保证整个 /review 不因一条破格 marker 整体失败。"""
        stripped = marker_line_re.sub("", response_text)
        # 更激进：任意位置 / 未闭合 marker 全清（marker_line_re 只清独占整行的闭合形式）
        aggressive = marker_any_re.sub("", response_text)
        attempts = []
        if stripped != response_text:
            attempts.append(stripped)
        reflowed = _reflow_unindented_multiline(response_text)
        if reflowed != response_text and reflowed not in attempts:
            attempts.append(reflowed)
        if stripped != response_text:
            r2 = _reflow_unindented_multiline(stripped)
            if r2 != stripped and r2 not in attempts:
                attempts.append(r2)
        if aggressive != response_text and aggressive not in attempts:
            attempts.append(aggressive)
            ra = _reflow_unindented_multiline(aggressive)
            if ra != aggressive and ra not in attempts:
                attempts.append(ra)
        return attempts

    def load_yaml(response_text, *args, **kwargs):
        # 「首探 + 修复」阶段静默：orig 对带 marker 的原文必然解析失败并打 WARNING+ERROR，但这些
        # 破格我们随后能修复，那两条日志是误导噪音（让用户以为 /review 挂了）。故临时压制
        # pr_agent.algo.utils 的日志；仅当所有修复都失败，才放**原始报错**出来（真失败应可见）。
        # 本 shim 跑在单次 review 的独立 python 子进程、无并发，disable/enable 全局开关安全。
        if _loguru_logger is not None:
            _loguru_logger.disable("pr_agent.algo.utils")
        try:
            data = orig_load_yaml(response_text, *args, **kwargs)
            if data:
                return data
            if isinstance(response_text, str):
                for cand in _repair_candidates(response_text):
                    try:
                        d = orig_load_yaml(cand, *args, **kwargs)
                    except Exception:  # noqa: BLE001 - 修复尝试失败不致命，继续下一个
                        d = None
                    if d:
                        _debug("load_yaml recovered via meebox repair")
                        return d
        finally:
            if _loguru_logger is not None:
                _loguru_logger.enable("pr_agent.algo.utils")
        # 全部修复失败 → 日志已恢复，重跑一次 orig 让真实报错可见，并返回其结果（None/空）
        return orig_load_yaml(response_text, *args, **kwargs)

    module.load_yaml = load_yaml
