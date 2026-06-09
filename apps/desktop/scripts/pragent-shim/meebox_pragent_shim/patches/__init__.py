"""对 pr-agent 的无侵入 monkeypatch，按目标模块分文件。每个模块导出一个 `patch(module)`，
由包根 apply() 经惰性 post-import hook 注册。pr_agent 的 import 一律在 patch 函数体内（惰性）。"""
