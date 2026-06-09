"""本机 CLI provider：把评审请求转交本机已安装并授权的命令行工具代为调用模型，绕过 litellm。
各命令的差异（argv / 输出解析 / 需剥离的计费 env）集中在 specs.py，按命令名取用。"""
