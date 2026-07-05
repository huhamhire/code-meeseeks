import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Reads the brand logo and converts it to a base64 data URI, inlined into the splash data URL (the
 * splash is a standalone data URL document and cannot reference resources via file:// relative paths,
 * so inlining is required). Two candidate paths are detected:
 * - packaged: `<resources>/icon.png` (electron-builder extraResources copy)
 * - dev: repo `assets/icons/icon.png`
 * If neither can be read (e.g. LFS not pulled), returns null and the splash gracefully falls back to a plain spinner.
 */
function resolveSplashLogo(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), '../../assets/icons/icon.png'),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      // An LFS pointer file is not a valid PNG (no \x89PNG magic) → skip, to avoid a broken image in the splash
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) continue;
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// Splash dark/light color sets, following the effective theme and aligned with the default 2026 theme
// (bg / text taken from 2026 editor background / foreground, accent still uses the semantic accent —
// chrome-sync does not override accent):
// dark = dark-2026 bg #121314 + text #BBBEBF + $vscode-blue-700 accent; light = light-2026 bg #FFFFFF + dark text + $vscode-blue-800.
const SPLASH_COLORS = {
  dark: { bg: '#121314', text: '#BBBEBF', sub: '#6f7172', ring: 'rgba(255,255,255,.16)', accent: '#0e639c' },
  light: { bg: '#FFFFFF', text: '#202020', sub: '#6e6e6e', ring: 'rgba(0,0,0,.14)', accent: '#005fb8' },
};

/**
 * Startup splash: a standalone frameless lightweight window loading an inline data URL (brand logo +
 * pure-CSS spinner), presentable within tens of ms, covering the blank renderer-load gap before the
 * main window's first paint. Closed when the main window is ready-to-show.
 * The logo is inlined via base64 (see resolveSplashLogo); the data URL is self-contained, with
 * identical dev/packaged behavior. Colors switch with the effective theme (`dark`), to avoid a dark
 * splash under a light theme.
 * Intentionally text-free (logo + brand name + spinner only): the splash renders before i18n loads,
 * so it must not depend on any localized copy — the spinner conveys "loading" without words.
 */
export function createSplash(dark: boolean): BrowserWindow {
  const c = dark ? SPLASH_COLORS.dark : SPLASH_COLORS.light;
  const width = 280;
  const height = 240;
  // Same approach as the main window: center within the workArea of the display under the cursor
  // (workArea already excludes the mac menu bar / notch). Do not use Electron's center:true—it computes
  // the midpoint from the full-screen bounds (including the unusable top area) and pins to the primary
  // display, which makes the splash sit too high and misalign across multiple screens.
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
    .ring{width:16px;height:16px;border-radius:50%;border:2px solid ${c.ring};
      border-top-color:${c.accent};animation:spin .8s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}
  </style></head><body>
    ${logoEl}<div class="name">Code Meeseeks</div>
    <div class="ring"></div>
  </body></html>`;
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show();
  });
  return splash;
}
