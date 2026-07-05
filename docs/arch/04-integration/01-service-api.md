# Local API service

## Responsibilities & boundaries

Provide a **local HTTP API** inside the main process that exposes the app's existing PR discovery / browsing / Agent
capabilities over a language-agnostic wire protocol to **external agents / tools / scripts** (via the [CLI](02-cli.md) or
direct HTTP calls). It is the **second front-end** after the renderer's IPC — the same main-process service layer behind a
different inbound protocol.

Responsible for: the service-listener toggle and lifecycle, bearer-token authentication, request routing and response
enveloping, and mapping internal capabilities onto a stable HTTP contract.

The exposed **write operations** are limited to review actions: approve / needswork (remote review decisions) and top-level
comment (posting a comment), reusing the GUI's same-source controller (see "Write boundary" below). There is also
`POST …/refresh`, which triggers one local polling refresh — though it uses POST, it has **no remote write side effect**
(pure remote read + local persist), so it is not a review write action and is unrelated to the ban on merge / change-type
tools.

**Not responsible for**:

- **Merge and pr-agent change-type tools** — merge (merging a PR), pr-agent's publish, and other mutating tools are not
  exposed; if needed the caller implements them itself via the platform API (see "Write boundary" below).
- **Multi-user / remote-service shape** — it remains a single-user local app; the API is only a local (or optionally LAN)
  inbound channel and introduces no account system.
- Business logic itself — it reuses the same service layer as the IPC controllers, without a separate implementation on the
  HTTP side.

## Core design

### Off by default, authentication enforced

- **Disabled by default**: `config.yaml` gains a `service` section, with `enabled` defaulting to `false`. When off, the main
  process listens on no port — zero external surface.
- **Mandatory bearer token**: enabling the listener requires a token — every request must carry
  `Authorization: Bearer <token>`; missing / mismatched is rejected outright (401 + error code). There is **no "disable auth"
  option**. When the toggle is first turned on and the token is empty, a high-strength random token is **auto-generated**
  (`crypto.randomBytes` → base64url / hex), guaranteeing that "enabled" and "has a token" are atomically bound.
- **Constant-time comparison**: token verification uses constant-time comparison to avoid a timing side channel.
- **Token storage follows the existing credential policy**: the token is stored in plaintext in `config.yaml` (same as
  platform tokens / LLM keys / proxy passwords, read/written through the `SecretStore` abstraction, never entering logs /
  exception traces) — a known risk mitigated by tightened file permissions. When migrating to a keychain in the future it
  moves along with the existing credentials.

### Listen address and port

- **Loopback only by default**: `host` defaults to `127.0.0.1`, reachable only locally. This is the secure default for the
  vast majority of "local external-agent integration" scenarios.
- **Optional `0.0.0.0`**: can be configured to listen on all interfaces (for same-subnet remote agents / CI nodes to connect).
  This is an **explicit high-risk option** — the settings page and docs must give a security warning (the token is the only
  line of defense; a firewall / reverse proxy is recommended). When bound to `0.0.0.0`, token strength and secrecy are
  especially critical.
- **Fixed secure default port**: defaults to `18765` (changeable in config). Choosing 10000+ both avoids the crowded 8xxx
  development / system-service range (3000 / 5173 / 8000 / 8080 / 8888, etc.) and sits **below the ephemeral port range**
  (Windows 49152+ / Linux 32768+) — a fixed listen port landing in the ephemeral range could contend with the system's
  transient outbound sockets, whereas `18765` is in the registered-port range with no such risk. If binding fails because the
  port is taken, log the error and warn non-fatally (without blocking app startup).

### HTTP implementation: minimal dependencies

- Use Node's built-in `http` to start the server + a **minimal hand-written router** (matching by method + path pattern),
  **without pulling in a heavy framework like express** — consistent with the project's "prefer reuse, minimal dependencies";
  the endpoint count is limited and needs no framework.
- Shared middle stages: JSON body parsing (with a max body limit), request timeout, auth verification, error → response
  enveloping, and access logging (recording method / path / status / latency, but **not** the token or sensitive body).

### Routes reuse the service layer

- HTTP route handlers obtain services through the **same process-level `ControllerContext`** (`getContext()`) as the IPC
  controllers (`ctx.pr` / `ctx.orchestrator` / `ctx.poller` / `ctx.connectionRuntime`, etc.), **without duplicating business
  logic**.
- Principle: core capabilities live in the service layer; IPC and HTTP each do only a **thin wrapper + protocol adaptation**.
  Before adding an API endpoint, first ensure the corresponding capability has a reusable method in the service layer (sinking
  inlined controller logic into the service where necessary).
- **Routes are split by domain into modules**: HTTP route handlers are placed in separate modules by business domain
  (system-level / PR / Agent); the aggregation layer only does **registration and path matching** and contains no business
  logic — symmetric with the domain split of the [CLI](02-cli.md) command tree; new endpoints go into the corresponding
  domain for easy location and extension.

### CLI version compatibility gating

The server applies CLI version gating uniformly to **all API calls** (not differentiated per endpoint):

- The CLI carries a version header `X-Meebox-CLI-Version: <version>` on every request declaring its own version (taken from
  the same source as the app; see [CLI](02-cli.md)).
- The server centrally manages the **minimum compatible CLI version**; request middleware compares: a version header that is
  **parseable and below the floor** → intercept, return `426 Upgrade Required` + error code `SV_CLIENT_TOO_OLD` (meta carries
  `minVersion` / `clientVersion`).
- **Lenient by default**: a missing version header (old CLI / non-CLI clients) or an unparseable version (e.g. a local `dev`
  build) → pass through, guaranteeing existing CLIs work by default; on a breaking wire-protocol change, raise the minimum
  version to gate out older CLIs.
- **Compare by version line, ignoring the prerelease suffix**: coerce the version to `major.minor.patch` before comparing.
  The CLI and app release from the same source; a prerelease build (e.g. `0.9.0-alpha.1`) belongs to the same version line as
  its stable release and shares the same wire protocol; in semver a prerelease ranks below its stable version, so not ignoring
  the suffix would misjudge a prerelease CLI on the same line as the floor as too old (with a floor of `0.9.0`, even
  `0.9.0-alpha.1` gets blocked). The floor is the breaking-change gate at version-line granularity and does not distinguish
  prerelease ordinals within the same line.
- On receiving this error code the CLI prints a clear "CLI too old, please upgrade" message (with both versions), rather than
  raising a raw HTTP error.

### Write boundary (allow review actions, reject merge and change-type Agent tools)

- The exposed write operations are **limited to review actions**: `POST …/approve` · `…/needswork` (remote review decisions,
  reusing `prs:setLocalStatus` — write the remote review status first, then persist locally) and `POST …/comment` (post a
  top-level comment, reusing `comments:create`). All are real remote writes.
- Agent instructions (`…/agent/instruct`) are **still limited to read-only tools** (`/describe` · `/review` · `/ask` ·
  `/improve`); change-type tools (`/publish`, etc.; see the tool registry `kind: 'mutating'`) are **hard-rejected at the API
  layer** — this is **independent of** the Agent's own grant authorization gate: even if a PR's AutoPilot grants have granted
  write permission, an instruct via the API still may not trigger write tools. Review write actions go through the dedicated
  approve / needswork / comment endpoints above, not through instruct.
- **Merge not exposed**: high-impact and irreversible on the remote, so not included in the API for now.
- **No secondary confirmation**: the API has no interactive confirmation channel; already-exposed write endpoints execute
  directly (the caller bears responsibility for authorization); actions that need interactive confirmation (e.g. merge) are
  simply not exposed.

### Lifecycle and taking effect immediately

- **Startup timing**: start the listener after the main process finishes connection / IPC initialization
  (`ControllerContext` ready), around when polling starts; only actually `listen` when `service.enabled` is true.
- **Graceful shutdown**: on app exit (`before-quit`), close the listener, stop accepting new connections, drain in-flight
  requests, then exit.
- **Take effect immediately**: changing `enabled` / `host` / `port` / token → write to disk + sync in memory + **stop the old
  listener and start a new one** (a port / address change necessarily rebuilds; a token change takes effect immediately and
  the old token is invalidated at once). Consistent with the existing "save to take effect immediately", no app restart
  required.

### Concurrency and resources

- Read-only `GET` endpoints can be processed concurrently.
- Agent write-type actions (trigger review / instruct / chat) **reuse the existing run queue and the Orchestrator's single
  worker + concurrency cap**, without bypassing scheduling — API-triggered and GUI-triggered runs queue in the same queue,
  keeping non-preemptive semantics consistent.

## Data / interface contract

### Config (`config.yaml` top-level `service`)

```yaml
service:
  enabled: false        # master switch; off by default = not listening, zero exposure
  host: 127.0.0.1        # listen address; can be 0.0.0.0 (high risk, needs a security warning)
  port: 18765            # fixed secure default port (10000+, avoids the crowded 8xxx range and stays below the ephemeral range), changeable
  token: ''              # bearer token; auto-generated when enabled and empty; stored in plaintext (same as the existing credential policy)
```

### Authentication

- Request header: `Authorization: Bearer <token>`; missing / mismatched → `401` + error code.
- The token is read/written through `SecretStore` and is never echoed in responses / logs.

### Uniform response envelope

```jsonc
// success
{ "ok": true, "data": <T> }
// failure (reuses AppError's code + serializable meta; frontend / CLI localize by code)
{ "ok": false, "error": { "code": "ESV0001", "meta": { /* ... */ } } }
```

- HTTP status codes align with semantics: `400` validation failure / `401` unauthorized / `403` write tool rejected (a
  non-exposed write operation) / `404` resource not found / `409` conflict / `426` CLI version too old / `500` internal error.
- Adds a new **`SV` (service) error-code domain** (`E`+`SV`+four digits, see [error-code spec](../99-core/04-error-codes.md)):
  e.g. invalid token, write operation rejected, listener not ready; parallel to the existing `AG`/`PR`/`NT` domains.

### Endpoints (`/api/v1`, one-to-one with [CLI](02-cli.md) commands)

Read endpoints use `GET`, write endpoints use `POST`. The list returns a **compact projection**; other read endpoints return
the same-source structure.

| Method & Path | Purpose | Reused internal capability |
| --- | --- | --- |
| `GET /api/v1/whoami` | Current identity: the user the active connection's PAT belongs to (`name`/`displayName`/`slug`) + integration platform + connection display name; each field null when there is no active connection | connection summary (current user + platform) |
| `GET /api/v1/categories` | Available category labels under the currently enabled platform: `categories` (`PrDiscoveryFilter`) + `statuses` (status / merge-state filters), trimmed per platform capability | platform capability flags + list-filter semantics |
| `POST /api/v1/refresh` | Trigger one immediate polling refresh (fetch the latest PRs across all connections, persist locally), returning this round's count summary (`PollResult`: fetched / changed / added / removed / errors); equivalent to a GUI manual refresh, no remote write side effect | `poller.tick` (same source as `prs:refresh`) |
| `GET /api/v1/version` | Server (desktop app) version (`{ version }`), so the CLI `version` command can show both client + server versions | `buildAppInfo().appVersion` (same source as `app:info`) |
| `GET /api/v1/prs` | PR list (**compact projection** `PrListItem`: field order prioritizes id/title/author/createdAt, drops description, people as slug only); query: `category` (level one) / `status` (level two) / `q` (search) / `skip`+`limit` (pagination, default limit 100) | `prs:list` + list-filter predicate + view projection |
| `GET /api/v1/prs/{id}` | Description detail (full `StoredPullRequest`: title / description / author / branch / time / status / merge state) | `StoredPullRequest` |
| `GET /api/v1/prs/{id}/diff` | Changed-file list; with `?path=&side=base\|head` fetches single-file content | `diff:listChangedFiles` / `diff:getFileContent` same source |
| `GET /api/v1/prs/{id}/activity` | Activity (timeline merging comments / commit updates / review decisions) | `diff:listActivity` same source |
| `GET /api/v1/prs/{id}/commits` | Commit list (`PrCommit[]`) | `diff:listCommits` same source |
| `GET /api/v1/prs/{id}/reviewers` | Reviewer approval status (`Reviewer[]`, with each person's `status`) | `StoredPullRequest.reviewers` |
| `GET /api/v1/prs/{id}/agent` | The Agent's current execution status (`AgentSession`: status / progress / summary / recommendation) | `agent:getSession` same source |
| `GET /api/v1/prs/{id}/agent/conversation` | Conversation history (`AgentMessage[]`) | `agent:getConversation` same source |
| `POST /api/v1/prs/{id}/agent/review` | Run auto review (the fixed review micro-flow describe→review→[follow-up ask]→summary) | `agent:run` same source |
| `POST /api/v1/prs/{id}/agent/instruct` | Send an Agent instruction (**read-only tools only**: describe / review / ask / improve; write tools hard-rejected) | read-only tool dispatch (reuses the run queue) |
| `POST /api/v1/prs/{id}/agent/chat` | Send natural-language chat (can trigger Agent planning and task execution) | `agent:ask` / `agent:enqueueMessage` same source |
| `POST /api/v1/prs/{id}/agent/stop` | Interrupt the running Agent for this PR (stops immediately at any thinking / execution stage; PR-level, not per individual run) | `agent:stop` same source |
| `POST /api/v1/prs/{id}/approve` | Review decision "approve" (write remote review status + persist locally) | `prs:setLocalStatus` same source |
| `POST /api/v1/prs/{id}/needswork` | Review decision "needs work" (write remote review status + persist locally) | `prs:setLocalStatus` same source |
| `POST /api/v1/prs/{id}/comment` | Post a top-level comment (body is the content, `400` if empty) | `comments:create` same source |

- `{id}` is the PR's `localId` — a cross-platform stable PR identifier (an internal hash, not the platform `remoteId`); in the
  list projection it is named `id` externally, and all PR-scoped endpoints locate by it.
- Step transcripts are not exposed in the initial API; they are reserved as a future extension slot (see below).

### New IPC (driven by the settings page)

- `config:setService`: write the `service` section → write to disk + sync in memory + rebuild the listener (take effect
  immediately).
- `config:generateServiceToken`: regenerate the token → write to disk + immediately invalidate the old token, returning the
  new token for the UI to display / copy.

## Extension & caveats

- **Sink into the service before adding a new endpoint**: HTTP and IPC must share the service method to avoid logic forking;
  an endpoint is a thin projection of a service capability.
- **The write boundary is a hard constraint**: review write actions go only through the dedicated approve / needswork /
  comment endpoints; the read-only-tool whitelist for the Agent `instruct` is strictly validated at the API layer,
  independent of the Agent grant gate — when adding a new Agent tool, confirm in sync its `kind` and whether it enters the
  instruct whitelist, excluding all `mutating` by default. Exposing a new write endpoint requires explicitly assessing remote
  side effects (high-impact actions like merge remain unexposed).
- **The `0.0.0.0` security warning cannot be omitted**: the settings page and usage docs must make the exposure scope and risk
  explicit; the token is the only line of defense.
- **Port conflict**: a failed listen warns non-fatally without dragging down app startup; prompt the user to change the port.
- **Progress push is a future extension slot**: the initial version relies mainly on "poll `GET .../agent` to pull status";
  if real-time progress is needed, SSE / WebSocket pushing Agent step events can be added on the same listener (reusing the
  existing `agent:stepProgress` broadcast) without changing the existing REST contract.
- **Contract stability**: the `/api/v1` prefix reserves room for version evolution; once the response envelope and error-code
  domain are published they must stay compatible (the CLI and third parties depend on them).
