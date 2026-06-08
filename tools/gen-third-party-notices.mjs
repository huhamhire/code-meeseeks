#!/usr/bin/env node
// 生成 THIRD-PARTY-NOTICES.md —— 汇总分发产物里的第三方组件许可。
//
// 覆盖三类：
//   1. npm 生产依赖闭包（`npm ls --omit=dev --all`，即打包进安装包的 node 依赖）
//   2. 嵌入式 Python 运行时（vendor/pragent）里的 pip 包（pr-agent + 其依赖）
//   3. 运行时载体（CPython / Electron / pr-agent）——手工 curated 头部
//
// 每个组件给出 名称@版本 + 许可标识 + 源地址，并尽量附上 LICENSE 正文（<details> 折叠）。
// 用法：node tools/gen-third-party-notices.mjs  → 写到仓库根 THIRD-PARTY-NOTICES.md
// 需要先 `npm ci` + `npm --prefix apps/desktop run prepare:pragent`（否则 python 段为空）。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.md'];

function readLicenseText(dir) {
  if (!dir || !existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (LICENSE_FILES.includes(name) || /^LICEN[CS]E/i.test(name)) {
      try {
        const t = readFileSync(join(dir, name), 'utf8').trim();
        if (t) return t;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function licenseField(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object') return pkg.license.type || 'see file';
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type).join(' OR ');
  return 'UNKNOWN';
}

function repoUrl(pkg) {
  const r = pkg.repository;
  const u = typeof r === 'string' ? r : r?.url;
  return (u || pkg.homepage || '').replace(/^git\+/, '').replace(/\.git$/, '') || '';
}

// ── 1. npm 生产依赖 ───────────────────────────────────────────────
function collectNpm() {
  let json;
  // Windows 上可执行是 npm.cmd；execFileSync 不会自动补后缀
  const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const out = execFileSync(NPM, ['ls', '--omit=dev', '--all', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    json = JSON.parse(out);
  } catch (e) {
    // npm ls 对 peer/extraneous 警告会非零退出，但 stdout 仍是有效 JSON
    try {
      json = JSON.parse(e.stdout || '{}');
    } catch {
      console.error('npm ls 解析失败：', e.message);
      return [];
    }
  }
  const seen = new Map(); // name@version → entry
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps || {})) {
      if (!info || info.version == null) {
        if (info?.dependencies) walk(info.dependencies);
        continue;
      }
      const key = `${name}@${info.version}`;
      if (!seen.has(key)) {
        const dir = join(ROOT, 'node_modules', name);
        let pkg = {};
        try {
          pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        } catch {
          /* 嵌套去重的包根目录可能取不到，仅列名 */
        }
        seen.set(key, {
          name,
          version: info.version,
          license: licenseField(pkg),
          url: repoUrl(pkg),
          text: readLicenseText(dir),
        });
      }
      if (info.dependencies) walk(info.dependencies);
    }
  };
  walk(json.dependencies);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── 2. 嵌入式 Python（vendor/pragent）pip 包 ──────────────────────
function collectPython() {
  const base = join(ROOT, 'apps/desktop/vendor/pragent/python/lib');
  if (!existsSync(base)) return [];
  const pyDir = readdirSync(base).find((d) => /^python3\.\d+$/.test(d));
  if (!pyDir) return [];
  const sp = join(base, pyDir, 'site-packages');
  if (!existsSync(sp)) return [];
  const out = [];
  for (const d of readdirSync(sp)) {
    if (!d.endsWith('.dist-info')) continue;
    const infoDir = join(sp, d);
    let name = d.replace(/\.dist-info$/, '');
    let version = '';
    let license = 'UNKNOWN';
    let url = '';
    try {
      const meta = readFileSync(join(infoDir, 'METADATA'), 'utf8');
      for (const line of meta.split('\n')) {
        if (line.startsWith('Name:')) name = line.slice(5).trim();
        else if (line.startsWith('Version:')) version = line.slice(8).trim();
        else if (line.startsWith('License:') && license === 'UNKNOWN') license = line.slice(8).trim();
        else if (line.startsWith('Classifier: License ::')) license = line.split('::').pop().trim();
        else if (/^(Home-page|Project-URL):/.test(line) && !url) url = line.split(':').slice(1).join(':').trim();
        if (line.trim() === '') break; // METADATA 头部到空行结束
      }
    } catch {
      /* ignore */
    }
    out.push({ name, version, license: license || 'UNKNOWN', url, text: readLicenseText(infoDir) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function section(title, items) {
  const lines = [`## ${title}（${items.length}）`, ''];
  for (const it of items) {
    lines.push(`### ${it.name}@${it.version}`);
    lines.push('');
    lines.push(`- 许可：${it.license}`);
    if (it.url) lines.push(`- 源：${it.url}`);
    lines.push('');
    if (it.text) {
      lines.push('<details><summary>许可证全文</summary>', '', '```', it.text, '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

const npm = collectNpm();
const py = collectPython();

const header = `# 第三方声明（THIRD-PARTY-NOTICES）

本文件汇总 Code Meeseeks 分发安装包内含的第三方组件及其许可。**由 \`tools/gen-third-party-notices.mjs\`
自动生成**，请勿手改；依赖变动后重新生成。

> 运行时载体：
> - **CPython**（python-build-standalone 分发）—— Python Software Foundation License。
> - **Electron** —— MIT；内含 Chromium（BSD 等）与 Node.js（MIT 等），详见 Electron 自身的 LICENSES。
> - **pr-agent（社区版）** —— Apache License 2.0（https://github.com/qodo-ai/pr-agent）。

下面按来源分两类：npm 生产依赖闭包、嵌入式 Python（vendor/pragent）pip 包。

---

`;

writeFileSync(OUT, header + section('npm 生产依赖', npm) + '\n---\n\n' + section('嵌入式 Python 包', py) + '\n');
console.log(`已生成 ${OUT}：npm ${npm.length} 个，python ${py.length} 个`);
