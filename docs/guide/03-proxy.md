# Network Proxy Setup

**English** · [简体中文](zh-CN/03-proxy.md)

On a corporate intranet / restricted network, route all **outbound traffic** through a single **HTTP proxy**. Configure it under **Settings → Proxy**.

## Coverage

Once the toggle is on, these three egress paths all go through the proxy:

- **LLM calls** (the LLM client embedded in pr-agent) — without it, the entire review flow is unusable on an intranet.
- **Code platform REST** (polling / comments / avatars / attachments / merge / connection probes).
- **git over HTTPS** (clone / fetch).

**Local addresses connect directly, automatically**: `localhost / 127.0.0.1 / ::1` (including a local Ollama and other local services) bypass the proxy.

## Settings

| Field | Description |
| --- | --- |
| Toggle | Master switch; off = everything connects directly (default) |
| Host / Port | Proxy host and port |
| Username / Password | Basic Auth, may be left empty |

> Saving takes effect immediately: the platform client is rebuilt right away and REST goes through the new proxy at once; the LLM / git egress paths read the latest config on their next operation.
> After configuring, click "Test" and the client will try to reach an external address through the proxy to verify connectivity (a proxy auth failure, 407, reports the reason).

## Notes

- **SSH clone does not use the proxy**: an HTTP proxy does not apply directly to SSH, and there is no uniform cross-platform mechanism for it. If your clone protocol is SSH, configure `ProxyCommand` yourself in `~/.ssh/config`.
- **Local CLI mode also uses the proxy**: when reviewing with [local CLI mode](02-llm.md#local-cli-mode), the CLI subprocess inherits the proxy environment variables, so its outbound traffic goes through the proxy automatically.
- **socks5 is not yet supported**: this first phase supports HTTP proxies only (including Basic Auth).
- **Platform caught in the crossfire**: if an intranet code platform becomes unreachable precisely because it is routed through the proxy, that is an edge case; there is currently no separate "platform direct connection" toggle.
