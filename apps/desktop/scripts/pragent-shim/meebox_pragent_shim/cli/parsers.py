"""Local CLI command output parsing: parse each CLI's stdout into (text, usage_dict_or_None).
usage uniformly uses the input_tokens / output_tokens field names (which happen to match across both), reused by install's token collection."""


def _parse_claude_output(stdout):
    """Parse the stdout of `claude -p --output-format json`, returning (text, usage_dict_or_None).
    On success it looks like {"result": "...", "num_turns": N, "usage": {"input_tokens":..,"output_tokens":..,
    "cache_read_input_tokens":..}, "is_error": false}. Non-JSON / missing fields degrade to "the whole stdout as text,
    usage=None"; only raises when is_error=True.

    claude -p is agentic multi-turn: the top-level num_turns is the number of model turns within this session (which can be far greater than 1); merge it into
    the usage dict's num_turns field and surface it together (usage uses the same field name for the collection layer to read uniformly, see install.py)."""
    import json

    s = (stdout or "").strip()
    if not s:
        return "", None
    try:
        obj = json.loads(s)
    except Exception:  # noqa: BLE001 - non-JSON → treat as text as-is
        return s, None
    if not isinstance(obj, dict):
        return s, None
    if obj.get("is_error"):
        raise RuntimeError(f"claude CLI returned an error: {str(obj.get('result') or obj)[:500]}")
    text = obj.get("result")
    if not isinstance(text, str):
        text = s
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return text, None
    nt = obj.get("num_turns")
    if isinstance(nt, int):
        usage["num_turns"] = nt
    return text, usage


def _parse_codex_output(stdout):
    """Parse the JSONL event stream of `codex exec --json`, returning (text, usage_dict_or_None):
      - type==item.completed and item.type==agent_message → item.text is the model reply, take the last one;
      - type==turn.completed → usage {input_tokens, output_tokens} are the tokens, and count one turn.
    The number of turn.completed occurrences serves as the model turn count num_turns (merged into the usage dict, same field name as the claude path).
    Line-by-line tolerant: non-JSON lines are skipped, missing event fields are not fatal; missing text falls back to an empty string (let the upper-layer load_yaml handle the fallback)."""
    import json

    text = None
    usage = None
    turns = 0
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:  # noqa: BLE001 - skip non-JSON lines (logs, etc.)
            continue
        if not isinstance(ev, dict):
            continue
        etype = ev.get("type")
        if etype == "item.completed":
            item = ev.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                txt = item.get("text")
                if isinstance(txt, str):
                    text = txt  # take the last agent_message as the final reply
        elif etype == "turn.completed":
            turns += 1
            u = ev.get("usage")
            if isinstance(u, dict):
                usage = u
    if isinstance(usage, dict) and turns:
        usage["num_turns"] = turns
    return (text if isinstance(text, str) else ""), usage
