# Outbound network & proxy

## Responsibilities & boundaries

Make all **outbound network** controllable in enterprise-intranet / restricted networks: once the switch is on, everything egresses uniformly through one **HTTP proxy**; local addresses (loopback) connect directly. It covers three egress classes:

- **LLM calls** (the LLM client embedded in pr-agent) — the primary target; without it, the whole review is unusable on an intranet.
- **Code-platform REST** (polling / comments / avatars / attachments / merge / connection probing).
- **git over HTTPS** (clone / fetch).

**Out of scope**: proxying git over **SSH** — an HTTP proxy doesn't apply directly to SSH, and there is no uniform cross-platform means (macOS/Linux have `nc`, Windows doesn't). SSH users configure `ProxyCommand` in their own `~/.ssh/config`.

Phase one supports only an **HTTP proxy** (including Basic Auth); socks5 is not implemented yet, but the config leaves a protocol-extension slot.

## Core design

- **A single global proxy + loopback direct connection**: switch on → all three egresses (LLM, code platform, git(HTTPS)) go through the proxy; only `localhost / 127.0.0.1 / ::1` (including a local Ollama and other local services) auto-connect directly. There is no complex "selectively proxy per host" policy — in the user's environment the proxy is the uniform egress channel, simple and consistent.
- **Minimal config surface**: it exposes only switch / host / port / Basic Auth (username, password). The loopback bypass is built-in behavior, not exposed. The protocol field goes into config but the UI doesn't render it (currently http only), leaving room to add socks5 later — a new protocol value is non-breaking to existing configs.
- **Three injection forms, consumed per egress** (this is the core of this module):
  - **Subprocess egress** (pr-agent, git) recognizes the `HTTP(S)_PROXY` / `NO_PROXY` environment variables → inject this set of env into the subprocess (`NO_PROXY` always includes loopback).
  - **In-process fetch egress** (code-platform REST goes through Node's undici fetch) **does not recognize** proxy env vars by default and must be handed an explicit dispatcher (proxy Agent) → when constructing the platform client, wrap a fetch with a proxy dispatcher around **non-loopback** targets and inject it; loopback / off cases inject nothing (using the default direct connection).
  - This unifies into one central component that, per the proxy config, produces the following items, each egress only consuming rather than implementing its own:
    - subprocess env;
    - undici proxy dispatcher / fetch;
    - loopback determination;
    - connectivity self-check.
- **No cost fetching, no network price-table pulls**: token usage is taken solely from the API return value, so the underlying LLM library's remote price table is useless and would time out on a weak network — force using only the local price table, with no network at all (see [pr-agent runtime](../02-agent/05-pragent-runtime.md)).
- **Takes effect immediately**: change the proxy config → write to disk + update in-memory config + rebuild the platform adapter (REST takes effect immediately); the pr-agent / git egresses read the latest config on their next operation, with no restart.

## Data / interface contract

Config (`config.yaml` top-level `proxy`):

```yaml
proxy:
  enabled: false       # master switch; false = all direct, equivalent to historical behavior
  protocol: http       # protocol enum, reserved for extension; phase one is http only
  host: ''             # proxy address
  port: 8080
  username: ''         # Basic Auth, may be empty
  password: ''         # may be empty (stored in plaintext, same as config's existing policy)
```

IPC channels:

- `config:setProxy`: input `{ proxy }` → write to disk + in-memory sync + rebuild adapter (REST takes effect immediately).
- `config:testProxy`: input `{ proxy }` → returns `{ ok, reason? }`, verifying connectivity by trying to reach an external address through that proxy; proxy auth failure (407) is classified as a failure with a reason.

Proxy URL form: `http://[username:password@]host:port` (credentials URL-encoded).

## Extension & caveats

- **Adding socks5**: append `socks5` to the protocol enum; the undici proxy Agent doesn't support socks, so the REST egress needs to switch to a socks-based dispatcher; the subprocess egress (pr-agent / git) supports socks natively via its underlying library. At that point the UI reveals the protocol choice.
- **The type of proxy-aware fetch**: Node `fetch`'s `dispatcher` is not in the standard `RequestInit` type, so the injection point needs a type assertion.
- **Must merge the existing env when replacing subprocess env**: the git wrapper library sets env by wholesale replacement, so missing the merge would lose `PATH`/`HOME`.
- **Code platform defaults to following the global proxy**: if an intranet platform is collaterally harmed by the proxy (unreachable), that is an edge case — add a "platform direct connection" switch as needed later; not done for now.
- **Plaintext credentials**: the proxy password, like the existing config, is stored in plaintext with no extra encryption; for a developer audience, with a documented risk warning.
