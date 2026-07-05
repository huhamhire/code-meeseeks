// Assemble the pr-agent embedded runtime into apps/desktop/vendor/pragent/.
//
// Flow:
//   1. Read pragent-runtime.json (pinned PBS tag + python major.minor + pr-agent version)
//   2. Resolve the install_only asset from the GitHub release by tag + major.minor + host platform triple
//   3. Download tar.gz + its .sha256 sidecar, verify integrity
//   4. Clear vendor/pragent → extract (yields vendor/pragent/python/...)
//   5. pip install pr-agent==<ver> with the embedded interpreter (into its own isolated site-packages)
//   6. Copy the shim (sitecustomize.py thin loader + meebox_pragent_shim package) into site-packages
//   7. Write VERSION, run an `import pr_agent` smoke test
//
// Design: zero system binary dependencies (no curl / system tar).
//   - Networking via node fetch; honor HTTP(S)_PROXY env through undici ProxyAgent (Node's built-in
//     fetch does not read the proxy by default, so intranet/proxy environments time out on the GitHub CDN — patched here).
//   - Extraction via node-tar (cross-platform, no system tar).
// Idempotent: skip when VERSION matches the expected one (unless --force). Requires Node 22+.
//
// Optional env: GITHUB_TOKEN / GH_TOKEN (avoid API rate limiting, recommended in CI); HTTP(S)_PROXY / ALL_PROXY
//   (applied to all requests automatically); MEEBOX_PRAGENT_FORCE=1 is equivalent to --force.

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
// Shim sources live in pragent-shim/: thin loader sitecustomize.py + domain-split package meebox_pragent_shim/.
const SHIM_DIR = join(__dirname, 'pragent-shim');
const SHIM_PKG_NAME = 'meebox_pragent_shim';
const SHIM_LOADER = join(SHIM_DIR, 'sitecustomize.py');
const SHIM_RUNTIME = join(SHIM_DIR, SHIM_PKG_NAME, 'runtime.py'); // where _EXPECTED_PRAGENT_VERSION lives
const UA = 'meebox-runtime-assembler';

const FORCE = process.argv.includes('--force') || process.env.MEEBOX_PRAGENT_FORCE === '1';

function log(msg) {
  console.log(`[pragent-runtime] ${msg}`);
}

function fail(msg) {
  console.error(`[pragent-runtime] ERROR: ${msg}`);
  process.exit(1);
}

// Get an explicitly passed proxy: `--proxy <url>` or `--proxy=<url>`. Takes priority over env vars.
function getProxyArg() {
  const i = process.argv.indexOf('--proxy');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith('--proxy='));
  return eq ? eq.slice('--proxy='.length) : null;
}

// Route fetch through a proxy (Node 22 fetch has no built-in proxy support, needs undici ProxyAgent routing).
// Source priority: --proxy arg > HTTPS_PROXY/HTTP_PROXY/ALL_PROXY env. Direct connection if none.
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
    log(`via proxy ${proxy}`);
  }
}

/** Host platform → PBS triple + interpreter's relative path segments inside the archive. */
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
  fail(`unsupported host platform ${platform}/${arch} (initial release win x64 only; mac arm64 later)`);
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

/** Fetch all assets of a release (paginate assets_url, follow Link: rel=next). */
async function listReleaseAssets(repo, tag) {
  const relUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const relRes = await fetch(relUrl, { headers: ghHeaders() });
  if (!relRes.ok) fail(`failed to fetch release ${relUrl}: HTTP ${relRes.status}`);
  const release = await relRes.json();
  const assets = [];
  let url = `${release.assets_url}?per_page=100`;
  while (url) {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) fail(`failed to fetch assets ${url}: HTTP ${res.status}`);
    assets.push(...(await res.json()));
    url = parseNextLink(res.headers.get('link'));
  }
  return assets;
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) fail(`download failed ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) fail(`fetch failed ${url}: HTTP ${res.status}`);
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

/** Run one command in the embedded interpreter, fail on failure (return boolean only when allowFail). */
function runPython(pythonExe, args, { allowFail = false } = {}) {
  const r = spawnSync(pythonExe, args, { stdio: 'inherit' });
  if (r.error) {
    if (allowFail) return false;
    fail(`execution failed ${pythonExe} ${args.join(' ')}: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) fail(`non-zero exit (${r.status}) ${pythonExe} ${args.join(' ')}`);
  return r.status === 0;
}

function pythonStdout(pythonExe, code) {
  const r = spawnSync(pythonExe, ['-c', code], { encoding: 'utf8' });
  if (r.status !== 0) fail(`python -c failed: ${r.stderr || r.error?.message || ''}`);
  return r.stdout.trim();
}

/**
 * Copy the shim into the embedded interpreter's site-packages (CPython auto-imports sitecustomize via site at startup):
 * thin loader sitecustomize.py + domain-split package meebox_pragent_shim/. It is very lightweight, so it reruns even when
 * the idempotent path skips the whole rebuild — editing the shim locally then running prepare:pragent once takes effect, no --force full rebuild needed.
 * Clear the old package directory before copying the whole thing, to avoid stale modules left behind after renames/deletions. Returns the site-packages path.
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
 * Write an empty `.secrets.toml` placeholder into pr_agent/settings(_prod)/ at assemble time, baked into vendor.
 * pr-agent prints two WARNINGs every time it cannot find this file at startup; we pass secrets via env and do not use secrets.toml.
 *
 * Why not patch at runtime (the former ipc.ts ensureEmbeddedSecrets): when installed into a read-only directory like `C:\Program Files\…`,
 * writing site-packages at runtime fails on permissions → the placeholder cannot be created → the warnings persist.
 * Writing at assemble time ships with the package, so a read-only runtime does not matter. Like the shim, it is also filled on the "skip rebuild" fast path,
 * so rerunning prepare:pragent fixes an old vendor without a --force full rebuild.
 */
async function ensureSecretsPlaceholders(sitePackages) {
  const body = '# meebox placeholder empty file: suppress the pr-agent startup warning about a missing .secrets.toml\n';
  for (const sub of ['settings', 'settings_prod']) {
    const dir = join(sitePackages, 'pr_agent', sub);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.secrets.toml'), body);
  }
}

// ── Runtime slimming (B): delete directories/files not needed at runtime, to reduce the installer's small-file count (on Windows upgrades,
//    deleting old + writing new masses of small files is extremely slow and scanned one-by-one by Defender, dragging the installer into a false "app cannot be closed").
//    Take a conservative general set: purely unused at runtime, safe to delete without affecting pr-agent / shim. Accuracy is backstopped by smokeTest.
// Directory names (deleted wholesale at any level): stdlib test suites / bytecode caches / GUI(tkinter,turtledemo) /
//    interactive(idlelib) / historical migration(lib2to3) / pip bootstrap not used at runtime(ensurepip) / doc data(pydoc_data).
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
// File extensions: bytecode (regenerable at runtime from source) + type stubs (used only for type checking).
const SLIM_FILE_EXTS = new Set(['.pyc', '.pyo', '.pyi']);

/**
 * Recursively slim root: delete SLIM_DIR_NAMES directories wholesale, delete SLIM_FILE_EXTS files. Idempotent (skip if already deleted),
 * so callable from both full builds and the fast path. Returns deletion stats.
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
  log(`runtime slimming: removed ${dirsRemoved} directories + ${filesRemoved} files`);
}

// Note: an attempt to slim by deleting unused provider SDKs (botocore/azure/grpc…) proved infeasible per smokeTest —
// pr-agent's git_providers/__init__ **eagerly imports all providers at startup** (CodeCommit→boto3,
// AzureDevOps→azure), so deleting them crashes `import pr_agent` outright. These SDKs must be kept; no provider trimming.

/**
 * Build-time smoke test (CI safety net): use the embedded interpreter to verify end-to-end that the slimmed runtime is still intact — pr-agent imports,
 * the shim patch chain is in place, and the stdlib C extensions / pure-py modules pr-agent actually depends on are all present. Any failure calls fail()
 * to turn the build red, so **over-trimming is blocked directly in CI and never ships**.
 */
function smokeTest(pythonExe) {
  // (0) Split rule: importing meebox_pragent_shim alone must not pull pr_agent into sys.modules (no eager
  //     import pr_agent at the top level, else it slows every python startup). Verified in a fresh interpreter.
  const lazy = pythonStdout(
    pythonExe,
    'import sys, meebox_pragent_shim; assert "pr_agent" not in sys.modules, "shim eager-loaded pr_agent at the top level"; print("LAZY_OK")',
  );
  if (!lazy.includes('LAZY_OK')) fail(`smoke test failed (shim lazy loading, output: ${lazy.slice(0, 200)})`);
  // Shim effectiveness check: get_pr_labels is patched by sitecustomize to return [] (unpatched it throws NotImplementedError).
  const code = [
    'import os',
    "os.environ.setdefault('OPENAI_API_KEY', 'sk-smoke-test')",
    'import pr_agent',
    'from pr_agent.algo.utils import load_yaml',
    'import pr_agent.git_providers.local_git_provider as lgp',
    'inst = object.__new__(lgp.LocalGitProvider)',
    'assert lgp.LocalGitProvider.get_pr_labels(inst) == [], "shim get_pr_labels not in effect"',
    // Key stdlib pr-agent actually uses (incl. C extensions): deleting stdlib / accidentally deleting deps surfaces here.
    'import ssl, json, asyncio, hashlib, sqlite3, ctypes, lzma, bz2, zlib, decimal, socket, importlib.metadata',
    // litellm's real completion path (mock_response, no network) — verifies the core review chain is not broken after
    // "deleting lazy provider SDKs": if a dependency needed by litellm's shared path was deleted, this fails with ImportError.
    'import litellm',
    "r = litellm.completion(model='gpt-3.5-turbo', messages=[{'role':'user','content':'hi'}], mock_response='MEEBOX_PONG')",
    "assert 'MEEBOX_PONG' in str(r), 'litellm mock completion failed'",
    'print("MEEBOX_SMOKE_OK")',
  ].join('\n');
  const out = pythonStdout(pythonExe, code);
  if (!out.includes('MEEBOX_SMOKE_OK')) fail(`smoke test failed (output: ${out.slice(0, 300)})`);
  log('smoke test OK: pr_agent importable + shim patch active + key stdlib + litellm completion path intact');
}

async function main() {
  configureProxy();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const { repo, tag, pythonMajorMinor: mm, variant } = manifest.pythonBuildStandalone;
  const prAgentVersion = manifest.prAgent.version;
  const { triple, pythonRel } = hostTarget();
  const pythonExe = join(VENDOR_DIR, ...pythonRel);

  // Guard: the shim's monkeypatch depends on a specific pr-agent version's internals, and runtime.py uses
  // _EXPECTED_PRAGENT_VERSION as a runtime version guard. Here we enforce at build time that it matches the manifest-pinned version —
  // upgrading pr-agent must sync both places + re-verify the patch, otherwise fail outright and block shipping.
  const shimSrc = await readFile(SHIM_RUNTIME, 'utf8');
  const shimVer = /_EXPECTED_PRAGENT_VERSION\s*=\s*["']([^"']+)["']/.exec(shimSrc)?.[1];
  if (!shimVer) fail(`meebox_pragent_shim/runtime.py: _EXPECTED_PRAGENT_VERSION constant not found`);
  if (shimVer !== prAgentVersion)
    fail(
      `shim version(${shimVer}) ≠ manifest pr-agent(${prAgentVersion}); when upgrading pr-agent, sync ` +
        `runtime.py's _EXPECTED_PRAGENT_VERSION and re-verify the monkeypatch`,
    );

  const versionKey = `pbs:${tag} py:${mm} triple:${triple} pr-agent:${prAgentVersion}`;
  const versionFile = join(VENDOR_DIR, 'VERSION');

  // Idempotent: VERSION hit and interpreter present → skip
  if (!FORCE && existsSync(versionFile) && existsSync(pythonExe)) {
    const prev = JSON.parse(await readFile(versionFile, 'utf8'));
    if (prev.key === versionKey) {
      // Skip overall, but always re-sync the shim + fill the .secrets.toml placeholder: editing sitecustomize.py locally
      // or fixing the placeholder logic takes effect after running prepare:pragent once, no --force full rebuild needed (re-download
      // CPython + reinstall pr-agent).
      const sp = await syncShim(pythonExe);
      await ensureSecretsPlaceholders(sp);
      // Slimming is idempotent: skip if already deleted, so the fast path runs it too — an already-assembled old vendor slims after one prepare:pragent.
      await slimRuntime(VENDOR_DIR);
      smokeTest(pythonExe);
      log(`ready, skipping rebuild (${versionKey}); re-synced shim + slimmed + smoke tested → ${sp}. Use --force to force a full rebuild.`);
      return;
    }
    log(`VERSION mismatch (old: ${prev.key}), rebuilding.`);
  }

  // 1+2. Resolve the asset
  log(`resolving ${triple} ${variant} (py ${mm}) asset from release ${repo}@${tag}…`);
  const assets = await listReleaseAssets(repo, tag);
  const mmEsc = mm.replace(/\./g, '\\.');
  const assetRe = new RegExp(`^cpython-${mmEsc}\\.\\d+\\+${tag}-${triple}-${variant}\\.tar\\.gz$`);
  const asset = assets.find((a) => assetRe.test(a.name));
  if (!asset) fail(`no asset matching ${assetRe} found in release ${tag}`);
  const shaAsset = assets.find((a) => a.name === `${asset.name}.sha256`);
  log(`matched asset ${asset.name}`);

  // 3. Download to a temp file + verify
  const tarPath = join(tmpdir(), `meebox-${asset.name}`);
  log('downloading archive…');
  await downloadToFile(asset.browser_download_url, tarPath);
  const actualSha = await sha256File(tarPath);
  if (shaAsset) {
    const sidecar = await fetchText(shaAsset.browser_download_url);
    const expected = (sidecar.trim().match(/[a-f0-9]{64}/i) ?? [])[0]?.toLowerCase();
    if (!expected) fail(`no sha256 parsed from sidecar: ${sidecar.slice(0, 80)}`);
    if (expected !== actualSha) fail(`sha256 mismatch! expected ${expected} actual ${actualSha}`);
    log(`sha256 verified (${actualSha.slice(0, 12)}…)`);
  } else {
    log(`WARN: no .sha256 sidecar, recording actual value only ${actualSha.slice(0, 12)}… (unverified)`);
  }

  // 4. Clear + extract (node-tar, no system tar dependency)
  log(`clearing ${VENDOR_DIR} and extracting…`);
  await rm(VENDOR_DIR, { recursive: true, force: true });
  await mkdir(VENDOR_DIR, { recursive: true });
  await tarExtract({ file: tarPath, cwd: VENDOR_DIR });
  await rm(tarPath, { force: true });
  if (!existsSync(pythonExe)) fail(`interpreter not found after extraction ${pythonExe}`);

  // 5. pip install pr-agent (into the embedded interpreter's own site-packages)
  log('ensuring pip…');
  runPython(pythonExe, ['-m', 'ensurepip', '--upgrade'], { allowFail: true });
  log(`pip install pr-agent==${prAgentVersion} (many dependencies, takes several minutes)…`);
  runPython(pythonExe, [
    '-m',
    'pip',
    'install',
    '--no-input',
    '--no-warn-script-location',
    `pr-agent==${prAgentVersion}`,
  ]);

  // 6. Inject the shim (thin loader sitecustomize.py + meebox_pragent_shim package)
  const sitePackages = await syncShim(pythonExe);
  log(`injected shim (sitecustomize.py + meebox_pragent_shim/) → ${sitePackages}`);
  // 7. Fill the empty .secrets.toml placeholder at assemble time, baked into vendor (no runtime write needed even in a read-only install dir)
  await ensureSecretsPlaceholders(sitePackages);
  log('wrote empty pr_agent/settings(_prod)/.secrets.toml placeholder');

  // 7. Slim (B) + smoke test (CI safety net) + write VERSION
  await slimRuntime(VENDOR_DIR);
  smokeTest(pythonExe);
  await writeFile(
    versionFile,
    `${JSON.stringify({ key: versionKey, asset: asset.name, sha256: actualSha, builtOn: `${process.platform}/${process.arch}` }, null, 2)}\n`,
  );
  log(`done → ${VENDOR_DIR}`);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
