"""已适配的本机 CLI 命令规格表：argv flags（prompt 一律走 stdin）+ 输出解析器 + 需剥离的
计费 env。新增命令在此登记一套即可；renderer 侧白名单校验须同步（见 LlmProfileForm.validateProfile）。"""
from .parsers import _parse_claude_output, _parse_codex_output

# `low_effort_flags`：低算力档要追加的 argv（仅 Agent 编排通道经 MEEBOX_CLI_REASONING 开启，
# 见 install.py）。含尾部 `-`（stdin）的命令会把这些 flags 插到 `-` 之前，保持 `-` 在末位。
_CLI_SPECS = {
    # claude：-p 单轮非交互 + JSON（一段含结果与 usage）；默认不传 --model，用本机默认模型/登录态。
    # 低算力档：--model haiku（最快最省，适合编排通道的路由 / 判读 / 收尾 / 对话），与 /review 走默认
    # 模型形成差异化；haiku 别名自动解析到当前账户可用的最新 haiku。
    "claude": {
        "flags": ["-p", "--output-format", "json"],
        "low_effort_flags": ["--model", "haiku"],
        "parser": _parse_claude_output,
        "strip_env": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    },
    # codex：exec 非交互 + --json（JSONL 事件流）；末位 `-` 让 stdin 作完整 prompt；
    # --skip-git-repo-check 容许临时目录运行，--sandbox read-only 只读不改文件。
    # 默认禁用 web_search / image_gen：评审与编排在只读临时目录里跑，这两个工具用不到，
    # 关掉既收敛工具面、又省 ~3K tokens（工具定义不再随每次请求下发）。键值：
    #   web_search 是字符串枚举（disabled / cached / live），用 `-c web_search=disabled`；
    #   image_gen 是 feature flag，用 `-c features.image_generation=false`（等价 --disable image_generation）。
    # 低算力档：-c model_reasoning_effort=low（codex 默认推理较重，编排通道无需，调低提速）。
    # 不用 minimal：gpt-5.x-codex 不支持 minimal（仅 none/low/medium/high/xhigh，传 minimal 报 400），
    # 且 minimal 还与 web_search / image_gen 互斥；low 普遍受支持、与工具兼容，作低算力档更稳。
    "codex": {
        "flags": [
            "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
            "-c", "web_search=disabled", "-c", "features.image_generation=false", "-",
        ],
        "low_effort_flags": ["-c", "model_reasoning_effort=low"],
        "parser": _parse_codex_output,
        "strip_env": ("OPENAI_API_KEY", "CODEX_API_KEY"),
    },
}
