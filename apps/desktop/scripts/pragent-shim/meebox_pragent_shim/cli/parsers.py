"""本机 CLI 命令输出解析：把各 CLI 的 stdout 解析成 (text, usage_dict_or_None)。
usage 统一用 input_tokens / output_tokens 字段名（两家恰好一致），供 install 的 token 采集复用。"""


def _parse_claude_output(stdout):
    """解析 `claude -p --output-format json` 的 stdout，返回 (text, usage_dict_or_None)。
    成功形如 {"result": "...", "num_turns": N, "usage": {"input_tokens":..,"output_tokens":..,
    "cache_read_input_tokens":..}, "is_error": false}。非 JSON / 缺字段退化为「整段 stdout 当文本、
    usage=None」；仅 is_error=True 时抛错。

    claude -p 是 agentic 多轮：顶层 num_turns 为本次会话内部的模型轮次（可远大于 1），把它并入
    usage dict 的 num_turns 字段一并上抛（usage 同字段名供采集层统一读取，见 install.py）。"""
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
    if not isinstance(usage, dict):
        return text, None
    nt = obj.get("num_turns")
    if isinstance(nt, int):
        usage["num_turns"] = nt
    return text, usage


def _parse_codex_output(stdout):
    """解析 `codex exec --json` 的 JSONL 事件流，返回 (text, usage_dict_or_None)：
      - type==item.completed 且 item.type==agent_message → item.text 为模型回复，取最后一条；
      - type==turn.completed → usage {input_tokens, output_tokens} 为 token，并计一轮。
    turn.completed 出现次数作模型轮次 num_turns（并入 usage dict，与 claude 路径同字段名）。
    逐行容错：非 JSON 行跳过、事件缺字段不致命；text 缺失退到空串（让上层 load_yaml 兜底）。"""
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
            turns += 1
            u = ev.get("usage")
            if isinstance(u, dict):
                usage = u
    if isinstance(usage, dict) and turns:
        usage["num_turns"] = turns
    return (text if isinstance(text, str) else ""), usage
