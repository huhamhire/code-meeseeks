# Outbound network & proxy

## Responsibilities & boundaries

Make all **outbound network** controllable in enterprise-intranet / restricted networks: once the switch is on, everything egresses uniformly through one **HTTP proxy**, except local addresses (loopback) and the hosts the user lists as bypassed, which connect directly. It covers three egress classes:

- **LLM calls** (the LLM client embedded in pr-agent) — the primary target; without it, the whole review is unusable on an intranet.
- **Code-platform REST** (polling / comments / avatars / attachments / merge / connection probing).
- **git over HTTPS** (clone / fetch).

**Out of scope**: proxying git over **SSH** — an HTTP proxy doesn't apply directly to SSH, and there is no uniform cross-platform means (macOS/Linux have `nc`, Windows doesn't). SSH users configure `ProxyCommand` in their own `~/.ssh/config`.

Phase one supports only an **HTTP proxy** (including Basic Auth); socks5 is not implemented yet, but the config leaves a protocol-extension slot.

## Core design

- **A single global proxy + a bypass list**: switch on → all three egresses (LLM, code platform, git(HTTPS)) go through the proxy; `localhost / 127.0.0.1 / ::1` (including a local Ollama and other local services) auto-connect directly, as does anything the user lists in `no_proxy`. Routing is still a single global decision per host — there is no per-egress or per-request policy.
- **Why a bypass list is not optional**: the proxy is the way *out* of a network, but part of what the app reaches commonly lives *inside* it — a self-hosted code platform, its git remote, an internal model server. Sending those through the proxy wastes a hop at best and makes them unreachable at worst, and the user cannot fix that by turning the proxy off, since the LLM egress still needs it. So the bypass has to be per-host and user-controlled. Loopback stays built in and is prepended to whatever the user configured: a local service must never be proxied, and that guarantee should not depend on the user having typed it.
- **The bypass syntax mirrors `NO_PROXY`, deliberately**: the subprocess egresses (git, pr-agent, local CLIs) are handed the rules as the `NO_PROXY` environment variable and interpret them with **their own** libraries — the app does not get to decide how git matches a host. Any syntax richer than what those libraries share would therefore apply in-process and not in the subprocess, so the same config would bypass on one egress and proxy on the other: a divergence nearly impossible to diagnose from the UI. Hence the supported subset (domain + subdomains, IP literal, `*`, case-insensitive, port ignored) and the deliberate exclusion of **CIDR ranges**, which only some implementations honour. Matching lives in `shared/no-proxy.ts`, shared by both paths so they cannot drift apart.
- **Minimal config surface**: it exposes switch / host / port / Basic Auth (username, password) / bypass list. The loopback part of the bypass is built-in behavior, not exposed. The protocol field goes into config but the UI doesn't render it (currently http only), leaving room to add socks5 later — a new protocol value is non-breaking to existing configs.
- **Three injection forms, consumed per egress** (this is the core of this module):
  - **Subprocess egress** (pr-agent, git) recognizes the `HTTP(S)_PROXY` / `NO_PROXY` environment variables → inject this set of env into the subprocess (`NO_PROXY` = built-in loopback + the user's bypass list; the subprocess's own library applies it).
  - **In-process fetch egress** (code-platform REST goes through Node's undici fetch) **does not recognize** proxy env vars by default and must be handed an explicit dispatcher (proxy Agent) → when constructing the platform client, wrap a fetch with a proxy dispatcher around targets that are **not bypassed** and inject it; a bypassed target / the switch being off injects nothing (using the default direct connection). Bypass is evaluated in-process here, against the same rules the env path hands out.
  - This unifies into one central component that, per the proxy config, produces the following items, each egress only consuming rather than implementing its own:
    - subprocess env;
    - undici proxy dispatcher / fetch;
    - bypass determination (loopback + configured rules);
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
  no_proxy: ''         # bypass list in NO_PROXY syntax; normalized to one comma-separated line on write
```

IPC channels:

- `config:setProxy`: input `{ proxy }` → normalize `no_proxy` + write to disk + in-memory sync + rebuild adapter (REST takes effect immediately). Normalization happens here rather than in the form, so the value stored is canonical regardless of how the config arrived (IPC or a hand-edited `config.yaml`) — what the user reads back is what is actually matched.
- `config:testProxy`: input `{ proxy }` → returns `{ ok, reason? }`, verifying connectivity by trying to reach an external address through that proxy; proxy auth failure (407) is classified as a failure with a reason.

Proxy URL form: `http://[username:password@]host:port` (credentials URL-encoded).

## Extension & caveats

- **Adding socks5**: append `socks5` to the protocol enum; the undici proxy Agent doesn't support socks, so the REST egress needs to switch to a socks-based dispatcher; the subprocess egress (pr-agent / git) supports socks natively via its underlying library. At that point the UI reveals the protocol choice.
- **The type of proxy-aware fetch**: Node `fetch`'s `dispatcher` is not in the standard `RequestInit` type, so the injection point needs a type assertion.
- **Must merge the existing env when replacing subprocess env**: the git wrapper library sets env by wholesale replacement, so missing the merge would lose `PATH`/`HOME`.
- **Code platform defaults to following the global proxy**: an intranet platform that the proxy cannot reach is resolved by adding its host to `no_proxy`, which covers both its REST egress and its git remote in one rule. A dedicated "platform direct connection" switch is therefore not needed — it would be a second, narrower way to express what the bypass list already expresses.
- **Plaintext credentials**: the proxy password, like the existing config, is stored in plaintext with no extra encryption; for a developer audience, with a documented risk warning.
