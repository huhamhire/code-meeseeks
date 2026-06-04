# assets — 产品资源

存放品牌 / UI 源资源（图标、图片等）。二进制图片经 **Git LFS** 跟踪（规则见根
`.gitattributes`），避免仓库膨胀；SVG 等文本资源走普通 git。

## 结构

- `icons/` — 产品图标源（建议 1024×1024 PNG）及导出的 `.ico` / `.icns`
- `images/` — 其它图片素材（截图、插图等）

## 图标接入

产品图标源 `icons/icon.png`（1024×1024），导出的 Windows `icons/icon.ico`（含 16/32/48/256）
由 electron-builder 显式引用（`win.icon: ../../assets/icons/icon.ico`）；macOS / Linux
直接用 `icon.png`（mac 构建时转 `.icns`）。

> 不放 `apps/desktop/build/`：该目录被 `.gitignore` 忽略，故图标统一放本资源目录、显式引用。

重新生成 `.ico`（PNG 改动后）：

```bash
npx --yes png-to-ico assets/icons/icon.png > assets/icons/icon.ico
```

## LFS 提示

- 首次 clone 后若图片显示为指针文本，执行 `git lfs pull`。
- 新增图片直接 `git add`；命中 `.gitattributes` 扩展名即自动入 LFS，无需手动 `git lfs track`。
- 校验某文件是否走 LFS：`git check-attr filter -- assets/icons/foo.png`。
