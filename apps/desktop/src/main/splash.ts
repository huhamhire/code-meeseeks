import { app, BrowserWindow } from 'electron';
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

/**
 * 启动闪屏：独立的无边框轻量窗口，加载内联 data URL（品牌 logo + 纯 CSS spinner），
 * 几十 ms 即可呈现，遮住主窗口首帧前的渲染层加载空窗。主窗口 ready-to-show 时关闭。
 * logo 经 base64 内联（见 resolveSplashLogo），data URL 自包含、dev/打包行为一致。
 */
export function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 280,
    height: 240,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const logo = resolveSplashLogo();
  const logoEl = logo ? `<img class="logo" src="${logo}" alt="" />` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;}
    body{background:#1e1e1e;color:#fff;-webkit-user-select:none;user-select:none;
      font-family:system-ui,'Segoe UI',Roboto,sans-serif;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;}
    .logo{width:72px;height:72px;border-radius:16px;}
    .name{font-size:17px;font-weight:600;letter-spacing:.3px;}
    .row{display:flex;align-items:center;gap:8px;color:#9d9d9d;font-size:12px;}
    .ring{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.16);
      border-top-color:#0e639c;animation:spin .8s linear infinite;}
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
