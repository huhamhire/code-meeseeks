# Error codes & error propagation

## Responsibilities & boundaries

Uniformly converge **errors that the backend (main process + internal libraries) throws to the frontend and ultimately shows to the user** onto **error codes** as their carrier; localization is the **frontend**'s job (look up the i18n copy by code). The backend no longer assembles user-facing localized strings itself.

- **In scope**: the "encode + propagate + fall back" contract for errors that cross IPC to the render layer and need to be shown to the user; the error-code namespace and registry.
- **Out of scope**:
  - **Internal exceptions for developer troubleshooting / backend logs** — still English, no i18n (see [i18n](../03-gui/04-i18n.md) and `AGENTS.md` "in-package exceptions in English" / "backend logs in English"). Error codes are user-facing; they don't replace technical exceptions.
  - The language of LLM-generated content and pr-agent output templates (see [i18n](../03-gui/04-i18n.md)).

> Boundary test: **"does this error cross IPC to be shown to the user"**. Yes → error code + frontend i18n; No (pure developer-facing / logs) → English technical exception.

## Core design

### 1. Error-code format

```
E + <two-letter domain tag> + <four digits>      7 chars total, regex ^E[A-Z]{2}\d{4}$
```

Examples: `EAG0001`, `EUI0001`, `ECF0001`, `ENT0407`.

- **Domain tags** (two uppercase letters):

  | Tag | Domain |
  | --- | --- |
  | `AG` | Agent (review orchestration / AutoPilot / pr-agent calls, etc.) |
  | `UI` | GUI (render-layer interaction / windows / display) |
  | `CF` | Config (config & secrets / settings / wizard) |
  | `NT` | Network (outbound requests / proxy / platform API / version check, etc.) |
  | `PR` | PR / draft (draft pool / publish loop / PR-level operations, etc.) |

  A new domain is **always appended at the end** (same reasoning as the platform display-order convention): pick an unused two-uppercase-letter tag, register it, and add a row to this table.

- **Four digits**: each domain is assigned `0001`–`9999` **in order**, with the registry as the single source of truth (no reuse, no semantic reassignment). Each domain reserves `0000` as the **"uncategorized" fallback code** (e.g. `EAG0000` = an uncategorized Agent error).

### 2. Unified error object (AppError)

Business domains are uniformly wrapped in a single error type **`AppError`** (extending `Error`):

- `code`: the error code (the format above), which determines the semantics and the frontend i18n key.
- `meta?`: an **extension parameter object** carrying two kinds of content (only **serializable scalars** string / number / boolean — no large objects, no sensitive values):
  - i18n interpolation params (e.g. `{ tool: 'review' }`);
  - diagnostic fields (e.g. `{ status: 407 }`).
- `message` (developer-facing): a short English description + the code, for backend logs and stack reading (backend logs stay English, not affecting the user copy).

The business side throws uniformly with `throw new AppError(code, meta?)`, no longer assembling localized strings itself. The construction and encode/decode of `AppError` are centralized in the **shared layer** (main / renderer / internal libraries share one copy), guaranteeing both ends agree on the code and the wire format.

### 3. Transport contract (across IPC)

**Key constraint**: Electron's IPC passes errors via **structured clone**, and **only `Error.message` is reliably preserved** (`name`/`stack` are present in most cases; **the custom properties `code`/`meta` are dropped**). So `code` and `meta` **must be encoded into `message`** to reach the frontend reliably.

- **Wire format**: when an `AppError` crosses IPC, its `message` is a **normalized encoded string** — led by a fixed sentinel prefix, followed by single-line JSON of `{code, meta}`, e.g.:

  ```
  @meebox/err {"code":"EAG0002","msg":"EAG0002","meta":{"tool":"review"}}
  ```

  The render layer **locates the sentinel in the received message and parses the JSON after it** (tolerating the `Error invoking remote method '…': ` prefix Electron adds to the message — it only reads the tail starting from the sentinel).
- **Non-`AppError` throws** (third-party libraries / not-yet-wrapped errors): the render layer's decode fails → they fall into the **global unknown fallback code**, with the original message retained as diagnostics (not hidden).
- **Optional: result envelope**. Besides "throwing", a new interface may also explicitly return an `{ ok: false, error: { code, meta } }` envelope (not via the exception channel). Currently throwing is the mainstay and the envelope is an optional follow-up; the frontend handles both the same (both yield `{code, meta}`).

### 4. Frontend handling (i18n + fallback)

The render layer uniformly decodes a received error into `{ code, meta }`, then localizes:

- **i18n key convention**: `errors.<CODE>` (e.g. `errors.EAG0001`), with `meta` interpolated by i18next (variable names correspond to meta fields). Each locale covers it equivalently (see [i18n](../03-gui/04-i18n.md) "equivalent translation sets" / "recursive dictionary order").
- **Fallback**: an unknown code / decode failure → generic error copy (`errors.unknown` or the like) + **show the original code** (e.g. "Error ENT0407"), which neither misleads nor hinders the user filing a report.
- **Replacing the status quo**: the current render layer does **regex pattern matching** on the English message to pick the i18n key (fragile, drifting with the message copy). After the rework: **decode AppError first → map precisely by code**; regex matching is **downgraded to a fallback** (used only for third-party / historically un-encoded errors).

### 5. Relationship to existing conventions

- **Backend logs / in-package technical exceptions**: still English, no i18n (developer-facing). `AppError.message`'s short English description serves exactly this.
- **User-facing errors that cross IPC**: go through `AppError` + code + frontend i18n.
- **Main-process i18n error copy migrates out gradually**: the error messages currently carried in the main-process i18n resources (pr-agent / proxy / version check, etc.) migrate to "code + render-layer i18n" per this spec; main-process i18n keeps only user-facing text that is **truly main-side and non-cross-IPC** (e.g. system-dialog titles). The migration proceeds in phases, not requiring a one-shot replacement.

## Data / interface contract

- **`AppError`**: `{ name: 'AppError'; code: ErrorCode; meta?: Record<string, string | number | boolean> }`, with `message` being the wire-encoded string of §3.
- **`ErrorCode` registry** (shared layer, single source of truth): enumerates all error codes and annotates their domain (and the optional meta-field convention); a new code must be registered here.
- **wire encoding**: the sentinel + JSON spec for `message` (§3), with main / renderer sharing one codec.
- **i18n resources**: the render layer's per-locale `errors.<CODE>` entries (equivalent coverage) + the `errors.unknown` fallback.

### Examples (not exhaustive; the full set is per the code registry)

**The full code table is not maintained in the docs** — the shared-layer `ERROR_CODES` registry is the single source of truth; the docs give only a few examples to help understand the form:

| Code | Domain | Semantics | meta |
| --- | --- | --- | --- |
| `EAG0002` | Agent | the `/{tool}` task for that PR is duplicate-triggered (with an interpolation param) | `tool` |
| `ENT0407` | Network | proxy auth failure (407) | — |
| `EPR0001` | PR | the draft doesn't exist (may have been deleted) | — |
| `EAG0000` | Agent | each domain's `0000` is the "uncategorized" fallback code | — |

## Extension & caveats

- **Adding a code**: pick the domain in the registry + take the next free number and register it, and add `errors.<CODE>` to each locale (keeping recursive dictionary order).
- **Adding a domain**: two uppercase letters, register, append to the domain table at the end; no reuse, no changing existing code semantics.
- **`meta` discipline**: only serializable scalars, for interpolation / diagnostics; no large objects, PII, or credentials.
- **Fallback priority**: exact code → domain `0000` → global `errors.unknown` (always show the original code).
- **Don't hurt the developer experience**: while encoded into the message, the short English description is retained so logs stay readable; technical exceptions that should be English stay English.
- **Migration strategy**: new errors always go through codes; old errors (main-process i18n / render-layer regex) are replaced gradually, with regex matching kept long-term as a fallback for third-party errors.
