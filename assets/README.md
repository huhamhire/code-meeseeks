# assets — 产品资源

存放品牌 / UI 源资源（图标、图片等）。二进制图片经 **Git LFS** 跟踪（规则见根
`.gitattributes`），避免仓库膨胀；SVG 等文本资源走普通 git。

## 结构

- `icons/` — 产品图标源（建议 1024×1024 PNG）及导出的 `.ico` / `.icns`
- `images/` — 其它图片素材（截图、插图等）

## 图标接入

产品图标源放 `icons/`，导出 Windows `.ico`（含 16/32/48/256）到
`apps/desktop/build/icon.ico`，electron-builder 会自动用作应用 / 安装包图标
（macOS 用 `.icns`）。

## LFS 提示

- 首次 clone 后若图片显示为指针文本，执行 `git lfs pull`。
- 新增图片直接 `git add`；命中 `.gitattributes` 扩展名即自动入 LFS，无需手动 `git lfs track`。
- 校验某文件是否走 LFS：`git check-attr filter -- assets/icons/foo.png`。
