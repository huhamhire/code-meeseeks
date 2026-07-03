# Code Platform Setup

**English** · [简体中文](zh-CN/01-code-platform.md)

Connect your code-hosting platform so the client can discover PRs awaiting review, read diffs, and post comments / approve / merge. Currently supported:

- **GitHub** (github.com and GitHub Enterprise Server)
- **Bitbucket Server / Data Center** (REST API v1, ≥ 7.0)
- **GitLab** (gitlab.com and Self-Managed, CE / EE, REST API v4, ≥ 13.8, 15.6+ recommended)

## Adding a connection

Under **Settings → Connections** (or the first-launch wizard), create a connection and fill in:

| Field | Description |
| --- | --- |
| Display name | A human-readable name, pick anything |
| Base URL | The platform API address, see per-platform notes below |
| Access token (PAT) | A Personal Access Token issued by the platform, used for REST API auth |
| Clone protocol | `pat` (default, HTTPS clone with the token embedded) or `ssh` (uses the system `~/.ssh/config`) |

> You can configure multiple connections, but **only one is active for polling at a time**; looking up historical PRs by id is unaffected.
> Configure access tokens with least privilege. After saving a connection, click "Test" to verify connectivity.

## Clone protocol

- **pat (default)**: clone over HTTPS with the token embedded in the URL, no extra configuration needed.
- **ssh**: clone over `git@host:...`, with port / key determined by the system `~/.ssh/config`, **independent of the PAT** (the PAT is only for the REST API). A custom SSH port on GHE / Bitbucket (e.g. Bitbucket's default 7999) must be configured in your ssh config.

## Platform capability comparison

Different platforms natively support different capabilities, and the client adjusts the UI dynamically based on **the active connection's platform** — buttons or labels for unsupported operations are not rendered, or are shown disabled. The table below summarizes the main differences (✅ supported / ❌ not supported).

| Category | Capability | GitHub | Bitbucket | GitLab |
| --- | --- | :---: | :---: | :---: |
| Discovery filter | Awaiting my review (PRs / MRs that requested my review) | ✅ | ✅ | ✅ |
| Discovery filter | Authored by me (PRs / MRs where I'm the author) | ✅ | ✅ | ✅ |
| Discovery filter | Assigned to me | ✅ | ❌ | ✅ |
| Discovery filter | Mentions me (@ me in body / comments) | ✅ | ❌ | ❌ |
| Comments | Post / reply / edit / delete comments | ✅ | ✅ | ✅ |
| Comments | Inline comments | ✅ | ✅ | ✅¹ |
| Approval | Approve | ✅ | ✅ | ✅² |
| Approval | Needs work | ✅ | ✅ | ❌ |
| Approval | Dismiss | ✅ | ✅ | ✅² |
| Merge | Merge PR / MR | ✅ | ✅ | ✅ |
| Merge | Show reasons merge is blocked | ✅³ | ✅ | ✅ |

> The sidebar's "discovery category" tabs are shown per platform capability; unsupported categories don't render a tab.
>
> - ¹ GitLab's inline comments support a single-line selection only, while GitHub / Bitbucket support multi-line.
> - ² GitLab approval is an **EE (Premium / Ultimate)** feature, disabled on the community edition (CE); and GitLab approval is binary — **only "Approve / Dismiss", no "Needs work"**. See [3.2 CE / EE approval differences](#32-ce--ee-approval-differences).
> - ³ GitHub gives only an approximate mergeable status, while Bitbucket / GitLab show the precise blocking reason (conflicts / pending approval / pipeline not passed, etc.).

---

## 1. GitHub: Personal Access Token permission reference

Connecting to GitHub (github.com or GitHub Enterprise Server) requires a **Personal Access Token (PAT)**. This section gives the minimal permission set.

> The **Base URL** in the connection: for github.com **leave it empty** (defaults to `https://api.github.com`); for GitHub Enterprise Server, just enter the **instance address**, e.g. `https://<your-ghe-domain>` — `/api/v3` is appended automatically (entering a full API base by hand also works).

### 1.1 Classic Token (Classic PAT) — recommended

This client polls **across projects / repos** to discover PRs awaiting review, and the coverage is usually not fixed. A classic token is authorized by scope and automatically covers every repo you have access to, which best fits this usage — it's the recommended approach for this client.

Works with both github.com and GHE Server. Create it under: **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**.

Scopes to check:

| Scope | Purpose | When needed |
| --- | --- | --- |
| `repo` | PR read/write, comments, approval, merge, and clone for private repos | When reviewing **private** repos (most common) |
| `public_repo` | The same operations for public repos only | When reviewing **public** repos only (in place of `repo`) |
| `read:user` | Read current user info (`/user`) | Optional; in most cases you don't need to check it separately |

**Reviewing private repos → check `repo`**; reviewing public repos only → check `public_repo`.

> **Org has SAML SSO enabled**: after generating the token, click **Configure SSO / Authorize** on the token page to authorize it for the org, otherwise accessing that org's repos returns 403.

### 1.2 Fine-grained Token (Fine-grained PAT) — only for a fixed set of repos

A fine-grained token must **enumerate authorized repos one by one** — finer-grained and more secure, but it requires fixing the repo scope in advance, which doesn't fit this client's cross-project polling well (adding a project / repo means going back to grant it). **Only suitable when you review a fixed, small set of repos**; otherwise, use the classic token above.

Create it under: **Settings → Developer settings → Personal access tokens → Fine-grained tokens**.

- **Repository access**: choose the repos you want to review (or all under an org).
- **Repository permissions**:

| Permission | Level | Purpose |
| --- | --- | --- |
| Metadata | Read (mandatory, auto-included) | Basic metadata / repo visibility |
| Pull requests | **Read and write** | List PRs, read comments, post inline / regular comments, reply / edit / delete, submit reviews (approve / needs work / dismiss) |
| Contents | **Read and write** | Clone the repo (read) + **merge PRs** (merge writes the target branch, needs write) |
| Checks | Read (optional) | Makes "mergeable status" more accurate (detect required checks not passing) |
| Commit statuses | Read (optional) | Same as above, detect status checks |

Minimal working set: **Pull requests: RW + Contents: RW + Metadata: R**.
For read-only (no merge, no comments), you can drop Pull requests / Contents both to Read (but this client's comment / approve / merge will be unavailable).

> Availability of fine-grained tokens on **GitHub Enterprise Server** varies by version; older GHE supports classic tokens only — in that case use the Classic PAT (`repo`) above.

### 1.3 Quick reference: permissions per client operation

| Client operation | Endpoint | Classic | Fine-grained |
| --- | --- | --- | --- |
| Discover PRs awaiting my review | `GET /search/issues` | repo / public_repo | Pull requests: R |
| Read PR / comments / commits | `GET /pulls`, `/issues/{n}/comments`, `/pulls/{n}/commits` | same as above | Pull requests: R (+ Contents: R for commits) |
| Post / edit / delete comments, reply | `POST/PATCH/DELETE …/comments` | same as above | Pull requests: **RW** |
| Approval (approve / needs work / dismiss) | `POST …/reviews`, `PUT …/reviews/{id}/dismissals` | same as above | Pull requests: **RW** |
| Merge PR | `PUT …/pulls/{n}/merge` | same as above | Contents: **RW** |
| Clone repo (local diff) | git over HTTPS (PAT) | same as above | Contents: **R** |
| Avatars / images embedded in comments | resource URL (with token) | same as above | nothing extra needed |

### 1.4 Notes

- **You can't approve your own PR**: a GitHub restriction (returns 422). The client already disables the approve button for PRs you authored.
- **Merge requires Contents write**: if you grant Pull requests write but miss Contents write, comment / approve work but merge fails.
- **SSH clone**: when a connection's clone protocol is SSH, it uses the system `~/.ssh/config`, independent of the PAT (the PAT is only for the REST API).
- **Rate limits**: discovery uses GitHub Search (about 30 req/min), and the client throttles per platform.
- **Security**: grant the minimal necessary scope, and revoke promptly on departure / leak.

---

## 2. Bitbucket Server / Data Center

- **Base URL**: enter the server root address, e.g. `https://bitbucket.your-company.com`.
- **Access token**: create it under Bitbucket personal settings → **HTTP access tokens (Personal access tokens)**.
- **Permissions**: grant **Repository: Write** (write includes read) for the target project / repo.
  - Read-only review (no comments / no merge) can drop to **Repository: Read**, but the client's comment / approve / merge will be unavailable.
  - Merging a PR requires repo write permission.
- **Clone URL forms**: pat → `https://<user>:<PAT>@host/scm/<proj>/<repo>.git` (the username is the current logged-in user); ssh → `git@host:<proj>/<repo>.git`.

---

## 3. GitLab (gitlab.com / Self-Managed, CE / EE)

Connecting to GitLab (gitlab.com or a self-hosted Self-Managed instance) requires a **Personal Access Token (PAT)**. This section gives the minimal permission set.

> The **Base URL** in the connection: for gitlab.com **leave it empty** (defaults to `https://gitlab.com/api/v4`); for Self-Managed, just enter the **instance address**, e.g. `https://<your-gitlab-domain>` — `/api/v4` is appended automatically (entering a full API base by hand also works).

Create it under: **top-right avatar → Edit profile → Access Tokens** (or `User Settings → Access Tokens`) → Add new token, checking a scope and setting an expiry.

> **Version compatibility**: the integration uses GitLab REST API v4, covering gitlab.com SaaS and Self-Managed (CE / EE).
> - **GitLab 15.6+ recommended**: `/metadata` (15.2+) auto-detects the edition, and `detailed_merge_status` (15.6+) makes the mergeable status full-fidelity, for the most complete experience.
> - **GitLab 13.8 minimum**: "awaiting my review" discovery relies on the MR Reviewers `reviewer_username` filter (available since 13.8); on lower versions that filter is unavailable, and you can use the "authored by me / assigned to me" discovery filters instead.
> - **13.8 – 15.5 auto-degrade**: without `/metadata`, it falls back to `/version` (conservatively assuming CE, with the approval UI disabled); without `detailed_merge_status`, it falls back to `merge_status` (a slightly coarser mergeable judgment); discovery / comments / merge / clone all work normally.
> - **Approval (approve / dismiss)**: an EE Premium / Ultimate feature (the MR approvals API since 13.9), enabled via edition detection, disabled on CE — see 3.2 below.

### 3.1 Scope (minimal authorization)

A GitLab PAT is authorized by scope and automatically covers every project you have access to, fitting this client's cross-project polling for MR discovery.

| Scope | Purpose | When needed |
| --- | --- | --- |
| `api` | Full REST API read/write: MR discovery, read / post / edit / delete comments and replies, approval (EE), merge | When you need to comment / approve / merge (most common, **recommended**) |
| `read_api` | Read-only REST API | For browsing only (no comment / approve / merge), in place of `api` |
| `read_repository` | Git-over-HTTPS clone / fetch of private projects | Add this when the clone protocol is `pat` and the token was given only `read_api` |

**Recommended: check `api` alone** — it already covers REST API write operations and HTTPS clone, the most hassle-free.
Read-only browsing: `read_api` + (for pat clone, add) `read_repository`.

### 3.2 CE / EE approval differences

GitLab's MR approvals API (`approve` / `unapprove`) has been a **Premium / Ultimate (paid EE)** feature since 13.9, and GitLab approval is binary — **only "Approve / Dismiss", no "Needs work"**.

- The client detects the instance edition via `/metadata` and degrades the approval capability accordingly:
  - **EE (Premium and above)**: the approval buttons are available (approve / dismiss).
  - **CE / community edition**: no approval API, so the approval buttons are **disabled**; discovery / comments / merge work as usual.
- Mergeable status uses `detailed_merge_status`, showing merge-blocking reasons (conflicts / pending approval / pipeline not passed, etc.) with full fidelity.

### 3.3 Quick reference: permissions per client operation

| Client operation | Endpoint | Scope required |
| --- | --- | --- |
| Discover MRs awaiting my review | `GET /merge_requests?reviewer_username=…` | `read_api` / `api` |
| Read MR / comments (discussions) | `GET …/merge_requests/{iid}`, `/discussions` | `read_api` / `api` |
| Post / edit / delete comments, reply | `POST/PUT/DELETE …/discussions[/notes]` | `api` |
| Approval (approve / dismiss, EE only) | `POST …/approve`, `/unapprove` | `api` |
| Merge MR | `PUT …/merge` | `api` |
| Clone repo (local diff) | git over HTTPS (PAT) | `read_repository` (or `api`) |
| Avatars / images embedded in comments | resource URL (with token) | nothing extra needed |

### 3.4 Notes

- **Clone URL forms**: pat → `https://<user>:<PAT>@host/<group>/<repo>.git` (the username is the current logged-in user, nested groups supported); ssh → `git@host:<group>/<repo>.git`.
- **Nested groups**: paths with multiple group levels (e.g. `group/subgroup/proj`) are parsed correctly.
- **Approving your own MR**: subject to server-side settings such as the project's "prevent author approval", adjudicated per GitLab's rules; the client passes through the API result.
- **SSH clone**: when the clone protocol is SSH, it uses the system `~/.ssh/config`, independent of the PAT (the PAT is only for the REST API).
- **Security**: grant the minimal necessary scope and set an expiry, revoking promptly on departure / leak.
