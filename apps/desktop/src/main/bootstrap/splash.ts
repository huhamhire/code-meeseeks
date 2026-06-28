import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * 读取品牌 logo 并转成 base64 data URI，内联进 splash data URL（splash 是独立 data URL
 * 文档，无法走 file:// 相对路径引用资源，故必须内联）。两路探测：
 * - 打包态：`<resources>/icon.png`（electron-builder extraResources copy）
 * - dev：仓库 `assets/icons/icon.png`
 * 两路都读不到（如 LFS 未拉取）则返回 null，splash 优雅回退为纯 spinner。
 */
function resolveSplashLogo(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), '../../assets/icons/icon.png'),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      // LFS 指针文件不是合法 PNG（无 \x89PNG magic）→ 跳过，避免 splash 显示裂图
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) continue;
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

// 闪屏明暗两套配色，跟随有效主题、对齐默认的 2026 主题（底 / 文字取 2026 editor background / foreground，
// accent 仍用语义 accent —— chrome-sync 不覆盖 accent）：
// 暗 = dark-2026 底 #121314 + 文字 #BBBEBF + $vscode-blue-700 accent；浅 = light-2026 底 #FFFFFF + 深文字 + $vscode-blue-800。
const SPLASH_COLORS = {
  dark: { bg: '#121314', text: '#BBBEBF', sub: '#6f7172', ring: 'rgba(255,255,255,.16)', accent: '#0e639c' },
  light: { bg: '#FFFFFF', text: '#202020', sub: '#6e6e6e', ring: 'rgba(0,0,0,.14)', accent: '#005fb8' },
};

/**
 * 启动闪屏：独立的无边框轻量窗口，加载内联 data URL（品牌 logo + 纯 CSS spinner），
 * 几十 ms 即可呈现，遮住主窗口首帧前的渲染层加载空窗。主窗口 ready-to-show 时关闭。
 * logo 经 base64 内联（见 resolveSplashLogo），data URL 自包含、dev/打包行为一致。
 * 配色随有效主题（`dark`）切换，避免浅色主题下启动闪屏仍是深色。
 */
export function createSplash(dark: boolean): BrowserWindow {
  const c = dark ? SPLASH_COLORS.dark : SPLASH_COLORS.light;
  const width = 280;
  const height = 240;
  // 与主窗口同源：按光标所在显示器的 workArea 居中（workArea 已扣掉 mac 菜单栏 / 刘海）。不用
  // Electron 的 center:true——它按整屏 bounds（含顶部不可用区）算中点、且固定主显示器，会让 splash 偏高、多屏错位。
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);
  const splash = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: c.bg,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const logo = resolveSplashLogo();
  const logoEl = logo ? `<img class="logo" src="${logo}" alt="" />` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;}
    body{background:${c.bg};color:${c.text};-webkit-user-select:none;user-select:none;
      font-family:system-ui,'Segoe UI',Roboto,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;}
    .logo{width:72px;height:72px;border-radius:16px;}
    .name{font-size:17px;font-weight:600;letter-spacing:.3px;}
    .row{display:flex;align-items:center;gap:8px;color:${c.sub};font-size:12px;}
    .ring{width:14px;height:14px;border-radius:50%;border:2px solid ${c.ring};
      border-top-color:${c.accent};animation:spin .8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}
  </style></head><body>
    ${logoEl}<div class="name">Code Meeseeks</div>
    <div class="row"><div class="ring"></div><span>启动中…</span></div>
  </body></html>`;
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show();
  });
  return splash;
}
