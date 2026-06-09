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
