"""load_yaml robustness patch (version-guarded): on parse failure, strip the anchor marker / reflow multi-line block scalars and retry,
to keep an occasional malformed YAML from the model from crashing the whole /review."""
from ..runtime import _EXPECTED_PRAGENT_VERSION, _debug, _pragent_version


def _reflow_unindented_multiline(text):
    """Fix the model's most common malformed-YAML pattern: a multi-line free-text value (Chinese issue_content / issue_header etc.)
    written as "key: inline first line" + continuation lines **flush left (column 1)**, without a block scalar `|`. YAML treats the
    continuation as a new key → `could not find expected ':'`, and pr-agent's own fallback can't recover it (its first fallback only
    appends `|` for a fixed key list, and doesn't reflow continuation indentation).

    Here we reflow "key: inline value + the immediately following non-key / non-list-item lines" as a whole into a `key: |-` block scalar
    with uniform indentation, preserving the value intact as a multi-line string. Called only after the original parse fails; any non-match is kept as-is (no regression)."""
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
        # Collect continuation lines: until the next key line / list-item / end of file
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
            ci = " " * (len(indent) + len(dash) + 2)  # block scalar content must be deeper than the key column
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
    """pr-agent parses the LLM output as YAML (pr_agent.algo.utils.load_yaml). The model occasionally produces malformed YAML →
    safe_load + pr-agent's own fallback all fail → load_yaml returns None → pr_reviewer iterating None crashes
    (argument of type 'NoneType' is not iterable), failing the whole review. Two high-frequency malformations:
      1. our injected anchor `[file: ...]` marker occupies a line on its own in a mapping context, and `[` is taken as the start of a flow sequence;
      2. a multi-line free-text value (Chinese issue_content etc.) with continuation lines flush left, without a block scalar `|` (see _reflow_unindented_multiline).

    Wrap load_yaml: if the original logic succeeds, return as-is (doesn't affect the normal path + line-number fallback); on failure, try in order
    "strip marker", "reflow multi-line block scalar", "both combined", handing each candidate back to the original load_yaml (including its own try_fix_yaml).
    Only return None if all fail. Inline markers / valid YAML are unaffected.

    pr_reviewer uses `from pr_agent.algo.utils import load_yaml`; utils is imported before tools, and this patch
    replaces module.load_yaml after utils finishes exec, so tools' later import gets the wrapped version."""
    installed = _pragent_version()
    if installed != _EXPECTED_PRAGENT_VERSION:
        _debug(f"skip load_yaml patch: pr-agent {installed} != {_EXPECTED_PRAGENT_VERSION}")
        return

    import re as _re

    # loguru global singleton (the same one pr_agent.log uses). Used to temporarily suppress
    # pr_agent.algo.utils's failure logs during the "first probe + repair" phase; if import fails, degrade to no suppression (not fatal).
    try:
        from loguru import logger as _loguru_logger
    except Exception:  # noqa: BLE001
        _loguru_logger = None

    orig_load_yaml = module.load_yaml
    # whole line is only `[file: ...]` (including indented / path-only forms), consuming the trailing newline
    marker_line_re = _re.compile(r"(?m)^[ \t]*\[file:[^\]\n]*\][ \t]*$\n?")
    # aggressive fallback: from `[file:`, consuming up to `]` or line end (closing `]` optional), removed wherever it appears **anywhere**.
    # Uniformly covers: whole-line-only, inline (`issue text [file:...]`), value position, and unclosed
    # markers where the model truncated and dropped `]`. Malformations missed by marker_line_re (only the whole-line-only closed form) all fall to it.
    marker_any_re = _re.compile(r"\[file:[^\]\n]*\]?")

    def _repair_candidates(response_text):
        """Generate repair candidates, from cheapest to most costly; each handed back to the original load_yaml (which internally reruns try_fix_yaml).
        The marker is only a line-number fallback (the anchor's main source is the meebox:/// link from get_line_link); the recovery path stripping
        it doesn't affect the main anchor, prioritizing keeping the whole /review from failing entirely over one malformed marker."""
        stripped = marker_line_re.sub("", response_text)
        # more aggressive: clear markers anywhere / unclosed (marker_line_re only clears the whole-line-only closed form)
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
        # "first probe + repair" phase silence: orig will inevitably fail to parse the original text with a marker and log WARNING+ERROR, but these
        # malformations we can repair afterward, so those two logs are misleading noise (making the user think /review crashed). So temporarily suppress
        # pr_agent.algo.utils's logs; only when all repairs fail do we let the **original error** through (a real failure should be visible).
        # This shim runs in an isolated python subprocess for a single review, with no concurrency, so the global disable/enable switch is safe.
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
                    except Exception:  # noqa: BLE001 - a repair attempt failing is not fatal, continue to the next
                        d = None
                    if d:
                        _debug("load_yaml recovered via meebox repair")
                        return d
        finally:
            if _loguru_logger is not None:
                _loguru_logger.enable("pr_agent.algo.utils")
        # all repairs failed → logs restored, rerun orig once to make the real error visible, and return its result (None/empty)
        return orig_load_yaml(response_text, *args, **kwargs)

    module.load_yaml = load_yaml
