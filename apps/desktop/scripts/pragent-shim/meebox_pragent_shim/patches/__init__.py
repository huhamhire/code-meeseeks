"""Non-invasive monkeypatch for pr-agent, split into one file per target module. Each module exports a
`patch(module)`, registered by the package root apply() via a lazy post-import hook. All pr_agent imports live
inside the patch function body (lazy)."""
