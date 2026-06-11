"""describe 增强（受版本守卫）：往 /describe 的 prompt schema 注入一个 assessment 字段，
让社区版 /describe 产出「思路建议（替代实现方案 + 倾向性建议）」段——对齐 Qodo Merge 的
High-Level Assessment（社区版原生无此字段）。

无需改渲染：pr_description._prepare_pr_answer 对未知 key 走通用 `### **Key**` 分支，
assessment 会自动渲染成 `### **Assessment**` 段进 description.md，由 app 的 parse-output
按表头映射为 sectionKey='assessment'。

注入方式：运行期改写 get_settings().pr_description_prompt.system（dynaconf set）。锚点是
schema 里 title 字段尾 + 示例输出 title 之后；锚点缺失则跳过（版本漂移安全降级）。
"""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _debug, _pragent_version

# 紧跟 PRDescription schema 的 title 字段之后插入（锚定 title 字段行尾的唯一子串）
_SCHEMA_ANCHOR = 'that captures the PR\'s main theme")'
_SCHEMA_FIELD = (
    '\n    assessment: str = Field(description="A high-level assessment in GFM markdown, mirroring '
    "this exact structure: (1) the intro line \\'The following are alternative approaches to this PR:\\'; "
    "(2) then 2-4 plausible ALTERNATIVE implementation approaches, EACH formatted as a <details> block "
    "with BLANK LINES inside so the body is parsed as markdown (this exact layout, blank lines required): "
    "a line '<details><summary>N. concise PLAIN-TEXT approach title (NO backticks or markdown inside the "
    "summary)</summary>', then a blank line, then 1-3 sentences explaining the approach and its main "
    "trade-off (you MAY use `inline code` for identifiers in this body), then a blank line, then the line "
    "'</details>'; (3) after the last </details> leave ONE blank line, then a paragraph starting with "
    "**Recommendation:** that compares the current approach against the alternatives and recommends one. "
    'Be objective and specific to this PR. Leave empty for trivial changes.")'
)

# 紧跟示例输出的 title 之后插入（best-effort，缺失不致命）
_EXAMPLE_ANCHOR = "title: |\n  ...\n"
_EXAMPLE_FIELD = "assessment: |\n  ...\n"


def patch(module) -> None:
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _debug(f"skip describe assessment patch: pr-agent {installed} != {_EXPECTED_PRAGENT_VERSION}")
        return
    from pr_agent.config_loader import get_settings

    try:
        settings = get_settings()
        prompt = settings.pr_description_prompt.system
    except Exception as exc:  # noqa: BLE001
        _debug(f"describe assessment: 读取 prompt 失败（跳过）: {exc}")
        return
    if not isinstance(prompt, str) or "assessment:" in prompt or "assessment: str" in prompt:
        return  # 已注入 / 形态异常 → 幂等跳过
    if _SCHEMA_ANCHOR not in prompt:
        _debug("describe assessment: schema 锚点未命中（版本漂移），跳过")
        return
    new = prompt.replace(_SCHEMA_ANCHOR, _SCHEMA_ANCHOR + _SCHEMA_FIELD, 1)
    if _EXAMPLE_ANCHOR in new:
        new = new.replace(_EXAMPLE_ANCHOR, _EXAMPLE_ANCHOR + _EXAMPLE_FIELD, 1)
    try:
        settings.set("pr_description_prompt.system", new)
    except Exception as exc:  # noqa: BLE001
        _debug(f"describe assessment: 写回 prompt 失败（跳过）: {exc}")
        return
    _debug("describe assessment field injected into /describe prompt")
