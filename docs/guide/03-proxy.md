# Network Proxy Setup

**English** · [简体中文](zh-CN/03-proxy.md)

On a corporate intranet / restricted network, route all **outbound traffic** through a single **HTTP proxy**. Configure it under **Settings → Proxy**.

## Coverage

Once the toggle is on, these three egress paths all go through the proxy:

- **LLM calls** (the LLM client embedded in pr-agent) — without it, the entire review flow is unusable on an intranet.
- **Code platform REST** (polling / comments / avatars / attachments / merge / connection probes).
- **git over HTTPS** (clone / fetch).

**Local addresses connect directly, automatically**: `localhost / 127.0.0.1 / ::1` (including a local Ollama and other local services) bypass the proxy.

**Anything else you want to keep off the proxy** goes in the **Direct connections** field — see below.

## Settings

| Field | Description |
| --- | --- |
| Toggle | Master switch; off = everything connects directly (default) |
| Host / Port | Proxy host and port |
| Username / Password | Basic Auth, may be left empty |
| Direct connections | Hosts that bypass the proxy and connect directly; empty by default |

### Direct connections (bypass list)

The proxy is a single global egress, which is a problem when part of what you reach is *inside* the network the proxy leads out of. A self-hosted code platform, its git remote, or an internal model server typically is: routing them through the proxy wastes a hop at best, and makes them unreachable at worst. List those hosts here and they connect directly while everything else still goes through the proxy.

The syntax is the conventional `NO_PROXY` one, so a value copied from an existing environment variable works as-is:

| You write | It matches |
| --- | --- |
| `corp.example.com` | that host **and its subdomains** (`git.corp.example.com`, `ci.corp.example.com`, …) |
| `.corp.example.com` | the same thing — a leading dot is accepted and means no more and no less |
| `10.0.0.5` | that address exactly (`10.0.0.50` does **not** match) |
| `*` | every host — the proxy is effectively bypassed entirely |

Write one per line, or separate with commas. Matching ignores case, and any `:port` you include is ignored — a host is either bypassed or not, regardless of port. **CIDR ranges (`10.0.0.0/8`) are not supported**: only some of the underlying tools honour them, so accepting one here would produce a rule that applies to some traffic and not the rest.

> Saving takes effect immediately: the platform client is rebuilt right away and REST goes through the new proxy at once; the LLM / git egress paths read the latest config on their next operation.
> After configuring, click "Test" and the client will try to reach an external address through the proxy to verify connectivity (a proxy auth failure, 407, reports the reason).

## Notes

- **SSH clone does not use the proxy**: an HTTP proxy does not apply directly to SSH, and there is no uniform cross-platform mechanism for it. If your clone protocol is SSH, configure `ProxyCommand` yourself in `~/.ssh/config`.
- **Local CLI mode also uses the proxy**: when reviewing with [local CLI mode](02-llm.md#local-cli-mode), the CLI subprocess inherits the proxy environment variables, so its outbound traffic goes through the proxy automatically.
- **socks5 is not yet supported**: this first phase supports HTTP proxies only (including Basic Auth).
- **Platform caught in the crossfire**: if an intranet code platform becomes unreachable precisely because it is routed through the proxy, add its host to **Direct connections** — that covers both its REST API and its git remote.
