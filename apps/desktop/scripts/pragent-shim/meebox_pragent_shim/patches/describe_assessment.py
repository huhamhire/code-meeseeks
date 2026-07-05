"""describe enhancement (version-guarded): inject an assessment field into the /describe prompt schema,
making the community-edition /describe produce a "thinking suggestions (alternative implementation approaches +
opinionated recommendation)" section — mirroring Qodo Merge's High-Level Assessment (the community edition has
no such field natively).

No rendering change needed: pr_description._prepare_pr_answer routes unknown keys through the generic
`### **Key**` branch, so assessment auto-renders into a `### **Assessment**` section in description.md, mapped by
the app's parse-output to sectionKey='assessment' by header.

Injection method: rewrite get_settings().pr_description_prompt.system at runtime (dynaconf set). The anchors are
the end of the title field in the schema + right after the title in the example output; if an anchor is missing,
skip (safe degradation on version drift).
"""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _debug, _pragent_version

# Insert right after the title field of the PRDescription schema (anchored to a unique substring at the end of the title field line)
_SCHEMA_ANCHOR = 'that captures the PR\'s main theme")'
_SCHEMA_FIELD = (
    '\n    assessment: str = Field(description="A high-level assessment in GFM markdown, mirroring '
    "this exact structure: (1) the intro line \\'The following are alternative approaches to this PR:\\'; "
    "(2) then 2-4 plausible ALTERNATIVE implementation approaches, EACH formatted as a <details> block "
    "with BLANK LINES inside so the body is parsed as markdown (this exact layout, blank lines required): "
    "a line '<details><summary>N. concise approach title (you MAY use `inline code` for identifiers in the "
    "summary; keep it short)</summary>', then a blank line, then 1-3 sentences explaining the approach and its main "
    "trade-off (you MAY use `inline code` for identifiers in this body), then a blank line, then the line "
    "'</details>'; (3) after the last </details> leave ONE blank line, then a paragraph starting with "
    "**Recommendation:** that compares the current approach against the alternatives and recommends one. "
    'Be objective and specific to this PR. Leave empty for trivial changes.")'
)

# Insert right after the title in the example output (best-effort; missing is not fatal)
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
        _debug(f"describe assessment: failed to read prompt (skipped): {exc}")
        return
    if not isinstance(prompt, str) or "assessment:" in prompt or "assessment: str" in prompt:
        return  # already injected / abnormal shape → idempotent skip
    if _SCHEMA_ANCHOR not in prompt:
        _debug("describe assessment: schema anchor not matched (version drift), skipping")
        return
    new = prompt.replace(_SCHEMA_ANCHOR, _SCHEMA_ANCHOR + _SCHEMA_FIELD, 1)
    if _EXAMPLE_ANCHOR in new:
        new = new.replace(_EXAMPLE_ANCHOR, _EXAMPLE_ANCHOR + _EXAMPLE_FIELD, 1)
    try:
        settings.set("pr_description_prompt.system", new)
    except Exception as exc:  # noqa: BLE001
        _debug(f"describe assessment: failed to write back prompt (skipped): {exc}")
        return
    _debug("describe assessment field injected into /describe prompt")
