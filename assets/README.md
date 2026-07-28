# assets — product resources

Source brand / UI resources (icons, images, etc.). Binary images are tracked via **Git LFS** (rules in the root
`.gitattributes`) to keep the repo from bloating; text resources such as SVG go through plain git.

## Structure

- `icons/` — product icon sources (1024×1024 PNG recommended) plus the exported `.ico` / `.icns`
- `images/` — other image assets (screenshots, illustrations, etc.)

## Icon wiring

The product icon source `icons/icon.png` (1024×1024) and the exported Windows `icons/icon.ico` (containing 16/32/48/256)
are referenced explicitly by electron-builder (`win.icon: ../../assets/icons/icon.ico`); macOS / Linux use `icon.png`
directly (converted to `.icns` at mac build time).

> Not placed under `apps/desktop/build/`: that directory is ignored by `.gitignore`, so icons live in this resource
> directory and are referenced explicitly.

Regenerate the `.ico` (after changing the PNG):

```bash
npx --yes png-to-ico assets/icons/icon.png > assets/icons/icon.ico
```

## LFS notes

- If images show up as pointer text after a fresh clone, run `git lfs pull`.
- Add a new image with a plain `git add`; matching a `.gitattributes` extension puts it into LFS automatically, with no
  manual `git lfs track`.
- Check whether a file goes through LFS: `git check-attr filter -- assets/icons/foo.png`.
