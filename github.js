// ───────────────────────────────────────────────────────────────────────────
// PHOENIX · GitHub integration (via the `gh` CLI)
//
// Everything goes through the locally-authenticated `gh` CLI — robust, no token
// juggling, and works even where the sandbox blocks Node's fetch. If `gh` isn't
// authenticated the app still runs; the GitHub stage just gets simulated.
//
// The repo's `main` stays on the BUGGY baseline on purpose. Each "commit" opens a
// PR from an isolated worktree off origin/main, so runs are repeatable and the
// `cleanup` primitive can wipe every artifact back to zero.
// ───────────────────────────────────────────────────────────────────────────

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

// Target repo: $PHOENIX_REPO, else derived from the git `origin` remote, so a fork
// "just works" — issues/PRs land on whoever cloned it.
function detectRepo() {
  if (process.env.PHOENIX_REPO) return process.env.PHOENIX_REPO;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {}
  return 'aburt1/phoenix-selfheal';
}
const REPO = detectRepo();

async function gh(args, opts = {}) {
  const { stdout } = await run('gh', args, { cwd: ROOT, maxBuffer: 8 << 20, ...opts });
  return stdout.trim();
}
async function git(args, opts = {}) {
  const { stdout } = await run('git', args, { cwd: ROOT, maxBuffer: 8 << 20, ...opts });
  return stdout.trim();
}

let configured;
export function githubConfigured() {
  if (configured !== undefined) return configured;
  try { execFileSync('gh', ['auth', 'token'], { stdio: 'ignore' }); configured = true; }
  catch { configured = false; }
  return configured;
}
export function repoSlug() { return REPO; }

export async function ensureLabels() {
  const labels = [
    ['self-heal', 'ff8c2b', 'Picked up by the Phoenix self-heal agent'],
    ['auto-filed', '8b7bff', 'Filed automatically by app telemetry'],
  ];
  for (const [name, color, desc] of labels) {
    try { await gh(['label', 'create', name, '--repo', REPO, '--color', color, '--description', desc, '--force']); } catch {}
  }
}

export async function createIssue({ title, body }) {
  const url = await gh(['issue', 'create', '--repo', REPO, '--title', title, '--body', body,
    '--label', 'self-heal', '--label', 'auto-filed', '--label', 'bug']);
  const m = url.match(/\/issues\/(\d+)/);
  return { number: m ? Number(m[1]) : null, url };
}

export async function commentIssue(number, body) {
  await gh(['issue', 'comment', String(number), '--repo', REPO, '--body', body]);
}

export async function closeIssue(number, comment) {
  if (comment) { try { await commentIssue(number, comment); } catch {} }
  try { await gh(['issue', 'close', String(number), '--repo', REPO]); } catch {}
}

export async function listOpenSelfHeal() {
  try {
    const out = await gh(['issue', 'list', '--repo', REPO, '--label', 'self-heal', '--state', 'open', '--json', 'number,url,title', '--limit', '50']);
    return JSON.parse(out || '[]');
  } catch { return []; }
}

export async function latestPr() {
  try {
    const out = await gh(['pr', 'list', '--repo', REPO, '--state', 'all', '--sort', 'created', '--json', 'number,url,state', '--limit', '1']);
    return JSON.parse(out || '[]')[0] || null;
  } catch { return null; }
}

// Open (or refresh) a real PR with the fix, built in an isolated worktree off
// origin/main so the live app's working tree is never disturbed.
export async function commitFix({ issue, file, bugLine, fixedLine, title, body }) {
  await git(['fetch', 'origin', 'main']);
  const branch = `self-heal/issue-${issue}`;
  const wt = join(tmpdir(), `phx-${issue}-${process.pid}-${Math.floor(performance.now())}`);
  await git(['worktree', 'add', '-B', branch, wt, 'origin/main']);
  try {
    const target = join(wt, file);
    const txt = (await readFile(target, 'utf8')).replace(bugLine, fixedLine);
    await writeFile(target, txt);
    await run('git', ['add', file], { cwd: wt });
    await run('git', ['-c', 'user.name=Phoenix Agent', '-c', 'user.email=phoenix@selfheal.local', 'commit', '-m', title], { cwd: wt });
    await run('git', ['push', '-u', 'origin', branch, '--force'], { cwd: wt });
    let url;
    try {
      url = (await run('gh', ['pr', 'create', '--repo', REPO, '--head', branch, '--title', title, '--body', body], { cwd: wt })).stdout.trim();
    } catch {
      // PR already exists for this branch — fetch its URL
      url = (await gh(['pr', 'list', '--repo', REPO, '--head', branch, '--json', 'url', '--jq', '.[0].url'])) || `https://github.com/${REPO}/pulls`;
    }
    return { url, branch };
  } finally {
    try { await git(['worktree', 'remove', wt, '--force']); } catch {}
  }
}

// Wipe every demo artifact: close all open PRs (+ delete their branches), close
// all open issues, and delete any leftover self-heal/* branches.
export async function cleanup() {
  const result = { prs: 0, issues: 0, branches: 0 };
  try {
    const prs = JSON.parse(await gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--json', 'number', '--limit', '100']) || '[]');
    for (const pr of prs) { try { await gh(['pr', 'close', String(pr.number), '--repo', REPO, '--delete-branch']); result.prs++; } catch {} }
  } catch {}
  try {
    const issues = JSON.parse(await gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--json', 'number', '--limit', '100']) || '[]');
    for (const i of issues) { try { await gh(['issue', 'close', String(i.number), '--repo', REPO]); result.issues++; } catch {} }
  } catch {}
  try {
    const out = await git(['ls-remote', '--heads', 'origin', 'self-heal/*']);
    for (const line of out.split('\n').filter(Boolean)) {
      const br = line.split('\t')[1]?.replace('refs/heads/', '');
      if (br) { try { await git(['push', 'origin', '--delete', br]); result.branches++; } catch {} }
    }
  } catch {}
  return result;
}
