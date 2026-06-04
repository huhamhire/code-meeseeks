// 组装 pr-agent 嵌入式运行时到 apps/desktop/vendor/pragent/（见 ADR-0008）。
//
// 流程：
//   1. 读 pragent-runtime.json（pin 的 PBS tag + python 主次版本 + pr-agent 版本）
//   2. 按 tag + 主次版本 + 宿主平台三元组，从 GitHub release 解析 install_only 资产
//   3. 下载 tar.gz + 其 .sha256 sidecar，校验完整性
//   4. 清空 vendor/pragent → 解压（得到 vendor/pragent/python/...）
//   5. 用嵌入式解释器 pip install pr-agent==<ver>（装进它自己隔离的 site-packages）
//   6. 把 sitecustomize.py shim 拷进 site-packages
//   7. 写 VERSION，做 `import pr_agent` 冒烟
//
// 设计：零系统二进制依赖（不依赖 curl / 系统 tar）。
//   - 网络走 node fetch；通过 undici ProxyAgent honor HTTP(S)_PROXY env（Node 自带
//     fetch 默认不读代理，内网/代理环境连 GitHub CDN 会超时——这里补上）。
//   - 解压走 node-tar（跨平台，不依赖系统 tar）。
// 幂等：VERSION 与期望一致则跳过（除非 --force）。需要 Node 22+。
//
// 可选 env：GITHUB_TOKEN / GH_TOKEN（避开 API 限流，CI 推荐）；HTTP(S)_PROXY / ALL_PROXY
//   （自动用于所有请求）；PRPILOT_PRAGENT_FORCE=1 等价 --force。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { x as tarExtract } from 'tar';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..'); // apps/desktop
const VENDOR_DIR = join(APP_DIR, 'vendor', 'pragent');
const MANIFEST_PATH = join(__dirname, 'pragent-runtime.json');
const SHIM_PATH = join(__dirname, 'sitecustomize.py');
const UA = 'pr-pilot-runtime-assembler';

const FORCE = process.argv.includes('--force') || process.env.PRPILOT_PRAGENT_FORCE === '1';

function log(msg) {
  console.log(`[pragent-runtime] ${msg}`);
}

function fail(msg) {
  console.error(`[pragent-runtime] ERROR: ${msg}`);
  process.exit(1);
}

// 取显式传入的代理：`--proxy <url>` 或 `--proxy=<url>`。优先级高于环境变量。
function getProxyArg() {
  const i = process.argv.indexOf('--proxy');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith('--proxy='));
  return eq ? eq.slice('--proxy='.length) : null;
}

// 让 fetch 走代理（Node 22 fetch 无内置代理支持，需 undici ProxyAgent 路由）。
// 来源优先级：--proxy 入参 > HTTPS_PROXY/HTTP_PROXY/ALL_PROXY env。都没有则直连。
function configureProxy() {
  const proxy =
    getProxyArg() ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (proxy) {
    setGlobalDispatcher(new ProxyAgent(proxy));
    log(`经代理 ${proxy}`);
  }
}

/** 宿主平台 → PBS 三元组 + 解释器在归档内的相对路径段。 */
function hostTarget() {
  const { platform, arch } = process;
  if (platform === 'win32' && arch === 'x64')
    return { triple: 'x86_64-pc-windows-msvc', pythonRel: ['python', 'python.exe'] };
  if (platform === 'darwin' && arch === 'arm64')
    return { triple: 'aarch64-apple-darwin', pythonRel: ['python', 'bin', 'python3'] };
  if (platform === 'darwin' && arch === 'x64')
    return { triple: 'x86_64-apple-darwin', pythonRel: ['python', 'bin', 'python3'] };
  if (platform === 'linux' && arch === 'x64')
    return { triple: 'x86_64-unknown-linux-gnu', pythonRel: ['python', 'bin', 'python3'] };
  fail(`不支持的宿主平台 ${platform}/${arch}（初版仅 win x64；mac arm64 后续）`);
}

function ghHeaders() {
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** 拉某 release 的全部资产（assets_url 分页，跟随 Link: rel=next）。 */
async function listReleaseAssets(repo, tag) {
  const relUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const relRes = await fetch(relUrl, { headers: ghHeaders() });
  if (!relRes.ok) fail(`拉 release 失败 ${relUrl}: HTTP ${relRes.status}`);
  const release = await relRes.json();
  const assets = [];
  let url = `${release.assets_url}?per_page=100`;
  while (url) {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) fail(`拉 assets 失败 ${url}: HTTP ${res.status}`);
    assets.push(...(await res.json()));
    url = parseNextLink(res.headers.get('link'));
  }
  return assets;
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) fail(`下载失败 ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) fail(`拉取失败 ${url}: HTTP ${res.status}`);
  return res.text();
}

function sha256File(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', rej);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
  });
}

/** 在嵌入式解释器里跑一条命令，失败即 fail（allowFail 时仅返回布尔）。 */
function runPython(pythonExe, args, { allowFail = false } = {}) {
  const r = spawnSync(pythonExe, args, { stdio: 'inherit' });
  if (r.error) {
    if (allowFail) return false;
    fail(`执行失败 ${pythonExe} ${args.join(' ')}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) fail(`非零退出 (${r.status}) ${pythonExe} ${args.join(' ')}`);
  return r.status === 0;
}

function pythonStdout(pythonExe, code) {
  const r = spawnSync(pythonExe, ['-c', code], { encoding: 'utf8' });
  if (r.status !== 0) fail(`python -c 失败: ${r.stderr || r.error?.message || ''}`);
  return r.stdout.trim();
}

async function main() {
  configureProxy();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const { repo, tag, pythonMajorMinor: mm, variant } = manifest.pythonBuildStandalone;
  const prAgentVersion = manifest.prAgent.version;
  const { triple, pythonRel } = hostTarget();
  const pythonExe = join(VENDOR_DIR, ...pythonRel);

  const versionKey = `pbs:${tag} py:${mm} triple:${triple} pr-agent:${prAgentVersion}`;
  const versionFile = join(VENDOR_DIR, 'VERSION');

  // 幂等：VERSION 命中且解释器在位 → 跳过
  if (!FORCE && existsSync(versionFile) && existsSync(pythonExe)) {
    const prev = JSON.parse(await readFile(versionFile, 'utf8'));
    if (prev.key === versionKey) {
      log(`已就绪，跳过（${versionKey}）。--force 可强制重建。`);
      return;
    }
    log(`VERSION 不匹配（旧: ${prev.key}），重建。`);
  }

  // 1+2. 解析资产
  log(`解析 release ${repo}@${tag} 的 ${triple} ${variant} (py ${mm}) 资产…`);
  const assets = await listReleaseAssets(repo, tag);
  const mmEsc = mm.replace(/\./g, '\\.');
  const assetRe = new RegExp(`^cpython-${mmEsc}\\.\\d+\\+${tag}-${triple}-${variant}\\.tar\\.gz$`);
  const asset = assets.find((a) => assetRe.test(a.name));
  if (!asset) fail(`release ${tag} 里找不到匹配 ${assetRe} 的资产`);
  const shaAsset = assets.find((a) => a.name === `${asset.name}.sha256`);
  log(`命中资产 ${asset.name}`);

  // 3. 下载到临时文件 + 校验
  const tarPath = join(tmpdir(), `prpilot-${asset.name}`);
  log('下载归档…');
  await downloadToFile(asset.browser_download_url, tarPath);
  const actualSha = await sha256File(tarPath);
  if (shaAsset) {
    const sidecar = await fetchText(shaAsset.browser_download_url);
    const expected = (sidecar.trim().match(/[a-f0-9]{64}/i) ?? [])[0]?.toLowerCase();
    if (!expected) fail(`sidecar 里没解析出 sha256: ${sidecar.slice(0, 80)}`);
    if (expected !== actualSha) fail(`sha256 不匹配！期望 ${expected} 实际 ${actualSha}`);
    log(`sha256 校验通过 (${actualSha.slice(0, 12)}…)`);
  } else {
    log(`WARN: 无 .sha256 sidecar，仅记录实际值 ${actualSha.slice(0, 12)}…（未校验）`);
  }

  // 4. 清空 + 解压（node-tar，不依赖系统 tar）
  log(`清空 ${VENDOR_DIR} 并解压…`);
  await rm(VENDOR_DIR, { recursive: true, force: true });
  await mkdir(VENDOR_DIR, { recursive: true });
  await tarExtract({ file: tarPath, cwd: VENDOR_DIR });
  await rm(tarPath, { force: true });
  if (!existsSync(pythonExe)) fail(`解压后找不到解释器 ${pythonExe}`);

  // 5. pip install pr-agent（装进嵌入式解释器自己的 site-packages）
  log('确保 pip…');
  runPython(pythonExe, ['-m', 'ensurepip', '--upgrade'], { allowFail: true });
  log(`pip install pr-agent==${prAgentVersion}（依赖较多，耗时数分钟）…`);
  runPython(pythonExe, [
    '-m',
    'pip',
    'install',
    '--no-input',
    '--no-warn-script-location',
    `pr-agent==${prAgentVersion}`,
  ]);

  // 6. 注入 sitecustomize shim
  const sitePackages = pythonStdout(
    pythonExe,
    'import sysconfig;print(sysconfig.get_paths()["purelib"])',
  );
  await writeFile(join(sitePackages, 'sitecustomize.py'), await readFile(SHIM_PATH));
  log(`已注入 sitecustomize.py → ${sitePackages}`);

  // 7. 冒烟 + 写 VERSION
  const prAgentFile = pythonStdout(pythonExe, 'import pr_agent;print(pr_agent.__file__)');
  log(`冒烟 OK：import pr_agent → ${prAgentFile}`);
  await writeFile(
    versionFile,
    `${JSON.stringify({ key: versionKey, asset: asset.name, sha256: actualSha, builtOn: `${process.platform}/${process.arch}` }, null, 2)}\n`,
  );
  log(`完成 → ${VENDOR_DIR}`);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
