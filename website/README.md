# Code Meeseeks Website

Brand website for Code Meeseeks, built with [VitePress](https://vitepress.dev/). English is the default locale; Simplified Chinese lives under `/zh/`.

This is a **standalone sub-project** — it is not part of the npm workspace or Nx (the `workspaces` globs only cover `apps/*` and `packages/*`), so it keeps its own `package.json` / lockfile and is built and deployed on its own, like `cli/`.

## Local development

```bash
cd website
npm install
npm run dev        # local dev server with hot reload
npm run build      # production build → .vitepress/dist
npm run preview    # preview the production build
```

Node >= 20 (22 recommended), same as the rest of the repo.

## Structure

```
website/
├── .vitepress/config.ts   # site config + i18n (en root, /zh/)
├── index.md               # English landing (home layout)
├── zh/index.md            # Chinese landing
└── public/                # static assets (favicon, images)
```

## Deployment

Deployed to GitHub Pages via [`.github/workflows/pages.yml`](../.github/workflows/pages.yml):
build runs on every PR touching `website/**` or `docs/**` (as a check), and deploy runs on push to `master`. The workflow is decoupled from the `v*` release pipeline.

The site serves under `/code-meeseeks/` by default (GitHub Pages project site). When a custom domain is configured, set `SITE_BASE=/` for the build.

## Content sync

Per the [Roadmap](../docs/ROADMAP.md) content-sync convention, each kind of content has a single source of truth:

- **Positioning / features** — source of truth is the repo README; the landing page paraphrases at marketing altitude, it does not copy verbatim.
- **User guide** — source of truth is `docs/guide/`; when the site hosts docs it builds from there rather than keeping a second copy.
