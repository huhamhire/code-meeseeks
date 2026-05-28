#!/usr/bin/env node
// Bitbucket Server REST v1 only-read probe.
//
// 用法:
//   $env:BB_URL='https://code.fineres.com'
//   $env:BB_TOKEN='<pat>'
//   node tools/probes/bitbucket-server-probe.mjs [--verbose]
//
// 覆盖端点:
//   GET /application-properties                                  ← ping + 版本
//   GET /dashboard/pull-requests?role=REVIEWER&state=OPEN        ← 当前用户待 review PR
//   GET /projects/{p}/repos/{r}/pull-requests/{prId}             ← PR 详情
//   GET .../pull-requests/{prId}/diff                            ← diff
//   GET .../pull-requests/{prId}/changes                         ← 改动文件列表
//   GET .../pull-requests/{prId}/activities                      ← 活动 (含 comments)
//
// 不做任何写入。token 仅从环境变量读取，绝不写入日志或文件。

const BB_URL = process.env.BB_URL;
const BB_TOKEN = process.env.BB_TOKEN;

if (!BB_URL || !BB_TOKEN) {
  console.error('需要环境变量 BB_URL 和 BB_TOKEN');
  process.exit(2);
}

const VERBOSE = process.argv.includes('--verbose');

async function call(path, { accept = 'application/json' } = {}) {
  const t0 = performance.now();
  let res, text;
  try {
    res = await fetch(`${BB_URL}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${BB_TOKEN}`, Accept: accept },
    });
    text = await res.text();
  } catch (e) {
    return {
      path,
      status: 0,
      elapsed: Math.round(performance.now() - t0),
      networkError: e.message,
    };
  }
  const elapsed = Math.round(performance.now() - t0);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { path, status: res.status, elapsed, body, raw: text };
}

function summarize(label, r, extract) {
  if (r.networkError) {
    console.log(`[NET] ${r.elapsed}ms  ${label}\n  ${r.networkError}`);
    return null;
  }
  const ok = r.status >= 200 && r.status < 300;
  const tag = ok ? 'OK ' : 'ERR';
  console.log(
    `[${tag}] ${String(r.status).padStart(3)} ${String(r.elapsed).padStart(5)}ms  ${label}`,
  );
  if (!ok) {
    const preview = (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 400);
    console.log(`  body: ${preview}`);
    return null;
  }
  if (extract) {
    try {
      const line = extract(r.body);
      if (line !== undefined) console.log(`  ${line}`);
    } catch (e) {
      console.log(`  (extract failed: ${e.message})`);
    }
  }
  if (VERBOSE) {
    const dump = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
    console.log(dump.slice(0, 4000));
    if (dump.length > 4000) console.log(`  ...(truncated, full ${dump.length} bytes)`);
  }
  return r.body;
}

async function main() {
  console.log(`probe target: ${BB_URL}\n`);

  // 1. ping
  const ping = summarize(
    'GET /application-properties',
    await call('/rest/api/1.0/application-properties'),
    (b) => `server: ${b.version} (${b.displayName}), build ${b.buildNumber}`,
  );
  if (!ping) process.exit(1);

  // 2. dashboard PRs as REVIEWER
  const dash = summarize(
    'GET /dashboard/pull-requests?role=REVIEWER&state=OPEN&limit=50',
    await call('/rest/api/1.0/dashboard/pull-requests?role=REVIEWER&state=OPEN&limit=50'),
    (b) =>
      `pending as reviewer: size=${b.size} returned=${b.values?.length ?? 0} isLastPage=${b.isLastPage}`,
  );
  if (!dash) process.exit(1);

  const prs = dash.values ?? [];
  if (!prs.length) {
    console.log('\n当前账号没有 reviewer 待处理 PR — 后续端点跳过，建议指定一个具体 PR 重跑');
    process.exit(0);
  }

  console.log('\n  待处理 PR 列表（前 10 条）:');
  for (const pr of prs.slice(0, 10)) {
    const r = pr.toRef?.repository;
    const author = pr.author?.user?.displayName ?? pr.author?.user?.name ?? '?';
    console.log(`    #${pr.id} [${r?.project?.key}/${r?.slug}] author=${author}  ${pr.title}`);
  }

  // 3-6. Probe first PR
  const target = prs[0];
  const projectKey = target.toRef.repository.project.key;
  const repoSlug = target.toRef.repository.slug;
  const prId = target.id;
  const base = `/rest/api/1.0/projects/${projectKey}/repos/${repoSlug}/pull-requests/${prId}`;

  console.log(`\n  深探目标: ${projectKey}/${repoSlug} #${prId} — ${target.title}\n`);

  summarize(
    `GET ${base}`,
    await call(base),
    (b) =>
      `state=${b.state} draft=${b.draft ?? false} reviewers=${(b.reviewers ?? []).length} fromRef=${b.fromRef?.displayId} toRef=${b.toRef?.displayId} updated=${new Date(b.updatedDate).toISOString()}`,
  );

  summarize(`GET ${base}/diff (JSON)`, await call(`${base}/diff`), (b) => {
    if (b && typeof b === 'object' && Array.isArray(b.diffs)) {
      const fileCount = b.diffs.length;
      const hunkCount = b.diffs.reduce((n, d) => n + (d.hunks?.length ?? 0), 0);
      const lineCount = b.diffs.reduce(
        (n, d) =>
          n +
          (d.hunks?.reduce(
            (m, h) => m + (h.segments?.reduce((k, s) => k + (s.lines?.length ?? 0), 0) ?? 0),
            0,
          ) ?? 0),
        0,
      );
      return `JSON diff: ${fileCount} files, ${hunkCount} hunks, ${lineCount} lines  truncated=${b.truncated ?? false}`;
    }
    if (typeof b === 'string') {
      return `text diff (Accept fallback): ${b.length} bytes, ${b.split('\n').length} lines`;
    }
    return `unknown shape: ${typeof b}`;
  });

  summarize(
    `GET ${base}/changes?limit=50`,
    await call(`${base}/changes?limit=50`),
    (b) => `changes: size=${b.size} returned=${b.values?.length ?? 0} isLastPage=${b.isLastPage}`,
  );

  summarize(`GET ${base}/activities?limit=50`, await call(`${base}/activities?limit=50`), (b) => {
    const acts = b.values ?? [];
    const commented = acts.filter((a) => a.action === 'COMMENTED');
    const inline = commented.filter((a) => a.commentAnchor);
    const summary = commented.length - inline.length;
    const types = [...new Set(acts.map((a) => a.action))].join(',');
    return `activities: total=${b.size} commented=${commented.length} (inline=${inline.length}, summary=${summary})  actions=[${types}]`;
  });

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
