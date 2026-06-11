// 组装 pr-agent 嵌入式运行时到 apps/desktop/vendor/pragent/。
//
// 流程：
//   1. 读 pragent-runtime.json（pin 的 PBS tag + python 主次版本 + pr-agent 版本）
//   2. 按 tag + 主次版本 + 宿主平台三元组，从 GitHub release 解析 install_only 资产
//   3. 下载 tar.gz + 其 .sha256 sidecar，校验完整性
//   4. 清空 vendor/pragent → 解压（得到 vendor/pragent/python/...）
//   5. 用嵌入式解释器 pip install pr-agent==<ver>（装进它自己隔离的 site-packages）
//   6. 把 shim（sitecustomize.py 薄加载器 + meebox_pragent_shim 包）拷进 site-packages
//   7. 写 VERSION，做 `import pr_agent` 冒烟
//
// 设计：零系统二进制依赖（不依赖 curl / 系统 tar）。
//   - 网络走 node fetch；通过 undici ProxyAgent honor HTTP(S)_PROXY env（Node 自带
//     fetch 默认不读代理，内网/代理环境连 GitHub CDN 会超时——这里补上）。
//   - 解压走 node-tar（跨平台，不依赖系统 tar）。
// 幂等：VERSION 与期望一致则跳过（除非 --force）。需要 Node 22+。
//
// 可选 env：GITHUB_TOKEN / GH_TOKEN（避开 API 限流，CI 推荐）；HTTP(S)_PROXY / ALL_PROXY
//   （自动用于所有请求）；MEEBOX_PRAGENT_FORCE=1 等价 --force。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
// shim 源在 pragent-shim/：薄加载器 sitecustomize.py + 领域拆分包 meebox_pragent_shim/。
const SHIM_DIR = join(__dirname, 'pragent-shim');
const SHIM_PKG_NAME = 'meebox_pragent_shim';
const SHIM_LOADER = join(SHIM_DIR, 'sitecustomize.py');
const SHIM_RUNTIME = join(SHIM_DIR, SHIM_PKG_NAME, 'runtime.py'); // _EXPECTED_PRAGENT_VERSION 所在
const UA = 'meebox-runtime-assembler';

const FORCE = process.argv.includes('--force') || process.env.MEEBOX_PRAGENT_FORCE === '1';

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

/**
 * 把 shim 拷进嵌入式解释器的 site-packages（CPython 启动经 site 自动 import sitecustomize）：
 * 薄加载器 sitecustomize.py + 领域拆分包 meebox_pragent_shim/。很轻量，故即便幂等跳过整体
 * 重建也会重跑一次——本地改了 shim 跑一次 prepare:pragent 就生效，无需 --force 全量重建。
 * 先清旧包目录再整体拷，避免改名/删文件后残留陈旧模块。返回 site-packages 路径。
 */
async function syncShim(pythonExe) {
  const sitePackages = pythonStdout(
    pythonExe,
    'import sysconfig;print(sysconfig.get_paths()["purelib"])',
  );
  await writeFile(join(sitePackages, 'sitecustomize.py'), await readFile(SHIM_LOADER));
  const pkgDst = join(sitePackages, SHIM_PKG_NAME);
  await rm(pkgDst, { recursive: true, force: true });
  await cp(join(SHIM_DIR, SHIM_PKG_NAME), pkgDst, {
    recursive: true,
    filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
  });
  return sitePackages;
}

/**
 * 在组装期就把空 `.secrets.toml` 占位写进 pr_agent/settings(_prod)/，烤进 vendor。
 * pr-agent 启动时找不到该文件会每次打两条 WARNING；我们走 env 传密钥不用 secrets.toml。
 *
 * 为何不靠执行期补（原 ipc.ts ensureEmbeddedSecrets）：装到 `C:\Program Files\…`
 * 这类只读目录时，运行期写 site-packages 会因权限失败 → 占位建不出来 → 告警照旧。
 * 组装期写入则随包分发、运行期只读也无所谓。跟 shim 一样在「跳过重建」快路径也补，
 * 重跑 prepare:pragent 即可修好旧 vendor，无需 --force 全量重建。
 */
async function ensureSecretsPlaceholders(sitePackages) {
  const body = '# meebox 占位空文件：抑制 pr-agent 缺失 .secrets.toml 的启动告警\n';
  for (const sub of ['settings', 'settings_prod']) {
    const dir = join(sitePackages, 'pr_agent', sub);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.secrets.toml'), body);
  }
}

// ── 运行时瘦身（B）：删运行时不需要的目录/文件，减少安装包小文件数（Windows 升级时
//    删旧+写新海量小文件极慢、被 Defender 逐个扫，会拖到安装器误判「应用无法关闭」）。
//    取保守通用集：纯粹运行期用不到、删了不影响 pr-agent / shim。准确性由 smokeTest 兜底。
// 目录名（任意层级整删）：stdlib 测试套件 / 字节码缓存 / GUI(tkinter,turtledemo) /
//    交互式(idlelib) / 历史迁移(lib2to3) / 运行期不用的 pip 引导(ensurepip) / 文档数据(pydoc_data)。
const SLIM_DIR_NAMES = new Set([
  '__pycache__',
  'test',
  'tests',
  'tkinter',
  'turtledemo',
  'idlelib',
  'lib2to3',
  'ensurepip',
  'pydoc_data',
]);
// 文件扩展名：字节码(随源码运行期可再生) + 类型存根(仅类型检查用)。
const SLIM_FILE_EXTS = new Set(['.pyc', '.pyo', '.pyi']);

/**
 * 递归瘦身 root：整删 SLIM_DIR_NAMES 目录、删 SLIM_FILE_EXTS 文件。幂等（已删则跳过），
 * 故全量构建与快路径都可调。返回删除统计。
 */
async function slimRuntime(root) {
  let dirsRemoved = 0;
  let filesRemoved = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SLIM_DIR_NAMES.has(e.name)) {
          await rm(p, { recursive: true, force: true });
          dirsRemoved++;
        } else {
          await walk(p);
        }
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        if (dot >= 0 && SLIM_FILE_EXTS.has(e.name.slice(dot))) {
          await rm(p, { force: true });
          filesRemoved++;
        }
      }
    }
  }
  await walk(root);
  log(`运行时瘦身：删除 ${dirsRemoved} 个目录 + ${filesRemoved} 个文件`);
}

// 注：曾尝试删未用 provider SDK（botocore/azure/grpc…）瘦身，但 smokeTest 证明不可行——
// pr-agent 的 git_providers/__init__ **启动即 eager 导入全部 provider**（CodeCommit→boto3、
// AzureDevOps→azure），删了 `import pr_agent` 直接崩。故这些 SDK 必须保留，不做 provider 裁剪。

/**
 * 构建期冒烟（CI 安全网）：用嵌入式解释器端到端验证瘦身后运行时仍完好——pr-agent 可导入、
 * shim 补丁链路在位、pr-agent 实际依赖的 stdlib C 扩展/纯 py 模块都在。任一项失败即 fail()
 * 让构建红，**过度裁剪在 CI 直接挡下、不会出包**。
 */
function smokeTest(pythonExe) {
  // (0) 拆分铁律：单独 import meebox_pragent_shim 不应把 pr_agent 拉进 sys.modules（顶层禁 eager
  //     import pr_agent，否则拖慢每次 python 启动）。fresh 解释器里验。
  const lazy = pythonStdout(
    pythonExe,
    'import sys, meebox_pragent_shim; assert "pr_agent" not in sys.modules, "shim 顶层 eager 加载了 pr_agent"; print("LAZY_OK")',
  );
  if (!lazy.includes('LAZY_OK')) fail(`冒烟未通过（shim 惰性加载，输出：${lazy.slice(0, 200)}）`);
  // shim 生效校验：get_pr_labels 被 sitecustomize 的补丁打成返回 []（未打补丁会抛 NotImplementedError）。
  const code = [
    'import os',
    "os.environ.setdefault('OPENAI_API_KEY', 'sk-smoke-test')",
    'import pr_agent',
    'from pr_agent.algo.utils import load_yaml',
    'import pr_agent.git_providers.local_git_provider as lgp',
    'inst = object.__new__(lgp.LocalGitProvider)',
    'assert lgp.LocalGitProvider.get_pr_labels(inst) == [], "shim get_pr_labels 未生效"',
    // pr-agent 实际用到的关键 stdlib（含 C 扩展）：删 stdlib / 误删依赖在此暴露。
    'import ssl, json, asyncio, hashlib, sqlite3, ctypes, lzma, bz2, zlib, decimal, socket, importlib.metadata',
    // litellm 实际 completion 路径（mock_response，不走网络）——验证「删 lazy provider SDK」后核心
    // 评审链路不破：若误删了 litellm 共享路径需要的依赖，这里会 ImportError 失败。
    'import litellm',
    "r = litellm.completion(model='gpt-3.5-turbo', messages=[{'role':'user','content':'hi'}], mock_response='MEEBOX_PONG')",
    "assert 'MEEBOX_PONG' in str(r), 'litellm mock completion 异常'",
    'print("MEEBOX_SMOKE_OK")',
  ].join('\n');
  const out = pythonStdout(pythonExe, code);
  if (!out.includes('MEEBOX_SMOKE_OK')) fail(`冒烟未通过（输出：${out.slice(0, 300)}）`);
  log('冒烟 OK：pr_agent 可导入 + shim 补丁生效 + 关键 stdlib + litellm completion 路径完好');
}

async function main() {
  configureProxy();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const { repo, tag, pythonMajorMinor: mm, variant } = manifest.pythonBuildStandalone;
  const prAgentVersion = manifest.prAgent.version;
  const { triple, pythonRel } = hostTarget();
  const pythonExe = join(VENDOR_DIR, ...pythonRel);

  // 守卫：shim 的 monkeypatch 依赖 pr-agent 特定版本的内部实现，runtime.py 里用
  // _EXPECTED_PRAGENT_VERSION 做运行期版本守卫。这里在构建期强制它与 manifest pin 的版本
  // 一致——升级 pr-agent 时必须同步两处 + 重新验证 patch，否则直接 fail 不让出包。
  const shimSrc = await readFile(SHIM_RUNTIME, 'utf8');
  const shimVer = /_EXPECTED_PRAGENT_VERSION\s*=\s*["']([^"']+)["']/.exec(shimSrc)?.[1];
  if (!shimVer) fail(`meebox_pragent_shim/runtime.py 未找到 _EXPECTED_PRAGENT_VERSION 常量`);
  if (shimVer !== prAgentVersion)
    fail(
      `shim 版本(${shimVer}) ≠ manifest pr-agent(${prAgentVersion})；升级 pr-agent 时同步 ` +
        `runtime.py 的 _EXPECTED_PRAGENT_VERSION 并重新验证 monkeypatch`,
    );

  const versionKey = `pbs:${tag} py:${mm} triple:${triple} pr-agent:${prAgentVersion}`;
  const versionFile = join(VENDOR_DIR, 'VERSION');

  // 幂等：VERSION 命中且解释器在位 → 跳过
  if (!FORCE && existsSync(versionFile) && existsSync(pythonExe)) {
    const prev = JSON.parse(await readFile(versionFile, 'utf8'));
    if (prev.key === versionKey) {
      // 整体跳过，但始终重新同步 shim + 补 .secrets.toml 占位：本地改了 sitecustomize.py
      // 或修了占位逻辑后跑一次 prepare:pragent 即生效，无需 --force 全量重建（重下
      // CPython + 重装 pr-agent）。
      const sp = await syncShim(pythonExe);
      await ensureSecretsPlaceholders(sp);
      // 瘦身幂等：已删则跳过，故快路径也跑——已组装的旧 vendor 跑一次 prepare:pragent 即变瘦。
      await slimRuntime(VENDOR_DIR);
      smokeTest(pythonExe);
      log(`已就绪，跳过重建（${versionKey}）；已重新同步 shim + 瘦身 + 冒烟 → ${sp}。--force 可强制全量重建。`);
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
  const tarPath = join(tmpdir(), `meebox-${asset.name}`);
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

  // 6. 注入 shim（薄加载器 sitecustomize.py + meebox_pragent_shim 包）
  const sitePackages = await syncShim(pythonExe);
  log(`已注入 shim（sitecustomize.py + meebox_pragent_shim/）→ ${sitePackages}`);
  // 7. 组装期补空 .secrets.toml 占位，烤进 vendor（只读安装目录运行期也无需再写）
  await ensureSecretsPlaceholders(sitePackages);
  log('已写入 pr_agent/settings(_prod)/.secrets.toml 空占位');

  // 7. 瘦身（B）+ 冒烟（CI 安全网）+ 写 VERSION
  await slimRuntime(VENDOR_DIR);
  smokeTest(pythonExe);
  await writeFile(
    versionFile,
    `${JSON.stringify({ key: versionKey, asset: asset.name, sha256: actualSha, builtOn: `${process.platform}/${process.arch}` }, null, 2)}\n`,
  );
  log(`完成 → ${VENDOR_DIR}`);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
