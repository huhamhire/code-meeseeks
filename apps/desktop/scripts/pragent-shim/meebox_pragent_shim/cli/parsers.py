"""本机 CLI 命令输出解析：把各 CLI 的 stdout 解析成 (text, usage_dict_or_None)。
usage 统一用 input_tokens / output_tokens 字段名（两家恰好一致），供 install 的 token 采集复用。"""


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
