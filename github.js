// ───────────────────────────────────────────────────────────────────────────
// PHOENIX · GitHub integration
//
// Talks to the real GitHub REST API using a token from $GITHUB_TOKEN, or falls
// back to the locally-authenticated `gh` CLI token. If neither is available the
// app still runs — the pipeline just simulates the GitHub stage instead.
// ───────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';

const REPO = process.env.PHOENIX_REPO || 'aburt1/phoenix-selfheal';
const API = 'https://api.github.com';

let cachedToken;
function token() {
  if (cachedToken !== undefined) return cachedToken;
  if (process.env.GITHUB_TOKEN) return (cachedToken = process.env.GITHUB_TOKEN);
  try { cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || null; }
  catch { cachedToken = null; }
  return cachedToken;
}

export function githubConfigured() { return !!token(); }
export function repoSlug() { return REPO; }

async function gh(path, { method = 'GET', body } = {}) {
  const t = token();
  if (!t) throw new Error('no github token');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'phoenix-selfheal',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`github ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export async function ensureLabels() {
  const labels = [
    { name: 'self-heal', color: 'ff8c2b', description: 'Picked up by the Phoenix self-heal agent' },
    { name: 'auto-filed', color: '8b7bff', description: 'Filed automatically by app telemetry' },
  ];
  for (const l of labels) { try { await gh(`/repos/${REPO}/labels`, { method: 'POST', body: l }); } catch {} }
}

export async function createIssue({ title, body }) {
  const issue = await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: { title, body, labels: ['self-heal', 'auto-filed', 'bug'] },
  });
  return { number: issue.number, url: issue.html_url };
}

export async function listOpenSelfHeal() {
  const issues = await gh(`/repos/${REPO}/issues?state=open&labels=self-heal&per_page=20`);
  return issues.filter((i) => !i.pull_request).map((i) => ({ number: i.number, url: i.html_url, title: i.title }));
}

export async function closeIssue(number, comment) {
  if (comment) { try { await gh(`/repos/${REPO}/issues/${number}/comments`, { method: 'POST', body: { body: comment } }); } catch {} }
  try { await gh(`/repos/${REPO}/issues/${number}`, { method: 'PATCH', body: { state: 'closed' } }); } catch {}
}

export async function latestPr() {
  try {
    const prs = await gh(`/repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=1`);
    if (prs[0]) return { number: prs[0].number, url: prs[0].html_url, state: prs[0].merged_at ? 'merged' : prs[0].state };
  } catch {}
  return null;
}
