"""已适配的本机 CLI 命令规格表：argv flags（prompt 一律走 stdin）+ 输出解析器 + 需剥离的
计费 env。新增命令在此登记一套即可；renderer 侧白名单校验须同步（见 LlmProfileForm.validateProfile）。"""
from .parsers import _parse_claude_output, _parse_codex_output

# `low_effort_flags`：低算力档要追加的 argv（仅 Agent 编排通道经 MEEBOX_CLI_REASONING 开启，
# 见 install.py）。含尾部 `-`（stdin）的命令会把这些 flags 插到 `-` 之前，保持 `-` 在末位。
_CLI_SPECS = {
    # claude：-p 单轮非交互 + JSON（一段含结果与 usage）；不传 --model，用本机默认模型/登录态。
    # claude `-p` 无推理档 flag（思考随模型默认），低算力档暂留空（按需可改 --model 提速）。
    "claude": {
        "flags": ["-p", "--output-format", "json"],
        "low_effort_flags": [],
        "parser": _parse_claude_output,
        "strip_env": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    },
    # codex：exec 非交互 + --json（JSONL 事件流）；末位 `-` 让 stdin 作完整 prompt；
    # --skip-git-repo-check 容许临时目录运行，--sandbox read-only 只读不改文件。
    # 低算力档：-c model_reasoning_effort=minimal（codex 默认推理较重，编排通道无需，调低提速）。
    "codex": {
        "flags": ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"],
        "low_effort_flags": ["-c", "model_reasoning_effort=minimal"],
        "parser": _parse_codex_output,
        "strip_env": ("OPENAI_API_KEY", "CODEX_API_KEY"),
    },
}
