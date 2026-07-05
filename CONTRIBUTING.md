# Contributing to Code Meeseeks

Thanks for your interest in contributing! This page is the entry point for contributors. For the deeper engineering handbook (repo structure, module boundaries, conventions), see [AGENTS.md](AGENTS.md); for environment setup and build steps, see the [Development guide](docs/development/README.md).

> **Language**: developer- and design-facing docs and code artifacts are in English — the developer/contributor docs under [`docs/development/`](docs/development/README.md), the module design docs under [`docs/arch/`](docs/arch/README.md) (with a terminology [glossary](docs/arch/glossary.md)), commit messages, and PR descriptions. Only the user-facing surfaces are bilingual: the user guide ([`docs/guide/`](docs/guide/README.md)), the [README](README.md), and the [CHANGELOG](CHANGELOG.md) — English canonical + a Chinese mirror.

## Getting set up

See the [Development guide](docs/development/README.md) for prerequisites (Node ≥ 20, npm ≥ 10, Git + Git LFS), installing dependencies, assembling the embedded pr-agent runtime, and running in dev mode.

The standalone Go CLI under [`cli/`](cli/README.md) is a separate module with its own workflow — see [AGENTS.md · CLI](AGENTS.md).

## Branch strategy

- `master` is the release branch — **never commit to it directly**.
- Branch all features and fixes off `dev`, open a PR **targeting `dev`**, and let it merge into `dev` first.
- Releases are cut on `master` by tagging `v*` (see [Packaging & release](docs/development/packaging-release.md)).

## Commit messages

- Use **[Conventional Commits](https://www.conventionalcommits.org/)** with a scope, in **English**, e.g. `feat(desktop): …`, `fix(review): …`, `docs(readme): …`, `build(mac): …`.
- Keep each commit cohesive; do not mix unrelated changes. Stage explicit file paths (avoid `git add -A` / `.`), since a shared working tree may hold others' in-progress edits.

## Pull requests

- Write the PR title and description in **English**.
- Target `dev` (see branch strategy above).
- Add fitting labels from the existing set (`gh label list`: `enhancement` / `documentation` / `bug` / …).

## Before you submit

Run the same checks CI does — all four must pass (lint is zero-tolerance, `--max-warnings=0`):

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

If you changed the Go CLI under `cli/`, also run (from `cli/`):

```bash
go vet ./...
go test ./...
go build ./...
```

## Documentation conventions

- **User guide** — [`docs/guide/`](docs/guide/README.md), bilingual (English canonical at the root, Chinese mirror under `zh-CN/`). When you change one locale, update the other.
- **Module design docs** — [`docs/arch/`](docs/arch/README.md), in English (terminology locked by [`glossary.md`](docs/arch/glossary.md)).
- **Developer/contributor docs** — [`docs/development/`](docs/development/README.md), in English.

See [AGENTS.md](AGENTS.md) for the full set of engineering conventions (IPC, i18n, error codes, platform ordering, and more).
