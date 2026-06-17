// ───────────────────────────────────────────────────────────────────────────
// PHOENIX · SELF-HEAL MISSION CONTROL — backend
//
// Zero npm dependencies. Pure Node built-ins so the demo never breaks on stage.
//
// The real loop (semi-automatic — a human gates the commit):
//   POST /api/login   → run the LIVE auth rule. On crash: crash → telemetry (real DB
//                       row) → REAL GitHub issue, streamed over SSE.
//   POST /api/heal    → agent diagnoses + PROPOSES: heals the working tree and
//                       comments the patch on the issue. Does NOT commit.
//   POST /api/commit  → the human commit gate: open a real PR with the fix.
//   POST /api/cleanup → wipe all GitHub artifacts (issues, PRs, branches).
//   POST /api/reset   → re-arm the fault (revert the file). Local only, instant.
//   GET  /events      → Server-Sent Events stream the whole show drives.
// ───────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { githubConfigured, repoSlug, createIssue, commentIssue, commitFix, cleanup, listOpenSelfHeal, latestPr, ensureLabels } from './github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const RULE_FILE = join(__dirname, 'healer', 'login-rule.js');
const PORT = process.env.PORT || 4178;

// The exact lines we swap. Matched verbatim so the patch always lands.
const BUG_LINE   = '  const role = user.account.role;        // PHOENIX-BUG';
const FIXED_LINE = '  const role = user.role;                // PHOENIX-FIXED';

// The operator the login screen authenticates. Note: NO `account` key — that's the bug.
const OPERATOR = { id: 7, name: 'ada.lovelace', role: 'operator' };

// ── Real database (node:sqlite when available, in-memory fallback otherwise) ──
let db = null;
const mem = [];
try {
  const { DatabaseSync } = await import('node:sqlite');
  await mkdir(join(__dirname, 'db'), { recursive: true });
  db = new DatabaseSync(join(__dirname, 'db', 'phoenix.db'));
  db.prepare(`CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, level TEXT, message TEXT, file TEXT, line INTEGER,
    stack TEXT, issue INTEGER, status TEXT
  )`).run();
  console.log('[phoenix] database: node:sqlite → db/phoenix.db');
} catch (err) {
  console.log('[phoenix] database: in-memory fallback (node:sqlite unavailable)');
}

function insertError(row) {
  if (db) {
    const stmt = db.prepare(
      `INSERT INTO error_log (ts, level, message, file, line, stack, issue, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(row.ts, row.level, row.message, row.file, row.line, row.stack, row.issue, row.status);
    return Number(info.lastInsertRowid);
  }
  const id = mem.length + 1;
  mem.push({ id, ...row });
  return id;
}
function updateErrorStatus(id, status) {
  if (db) db.prepare('UPDATE error_log SET status = ? WHERE id = ?').run(status, id);
  else { const r = mem.find((m) => m.id === id); if (r) r.status = status; }
}
function countErrors() {
  if (db) return db.prepare('SELECT COUNT(*) AS c FROM error_log').get().c;
  return mem.length;
}

// ── Server-Sent Events fan-out ──────────────────────────────────────────────
const clients = new Set();
function broadcast(ev) {
  const payload = JSON.stringify({ ...ev, ts: ev.ts ?? new Date().toISOString() });
  for (const res of clients) { try { res.write(`data: ${payload}\n\n`); } catch {} }
}

// ── Live rule state ─────────────────────────────────────────────────────────
async function ruleText() { return readFile(RULE_FILE, 'utf8'); }
async function isHealthy() { return (await ruleText()).includes('PHOENIX-FIXED'); }

let SPEED = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));

let issueCounter = 41; // fallback number when GitHub isn't configured
let running = false;
let lastIssue = null;
let lastIssueUrl = null;
let lastPrUrl = null;
let lastErrorId = null;

// Run the live auth rule fresh from disk (cache-busted so a patched file re-evaluates).
async function runRule() {
  const mod = await import(new URL(`./healer/login-rule.js?v=${Date.now()}`, import.meta.url).href);
  return mod.authenticate({ ...OPERATOR }, 'hunter2');
}

// ── Pipeline stages ─────────────────────────────────────────────────────────
async function crashToIssue() {
  const ts = new Date().toISOString();
  const message = "TypeError: Cannot read properties of undefined (reading 'role')";
  const file = 'healer/login-rule.js';
  const line = 15;
  const stack = [
    message,
    `    at authenticate (${file}:${line}:30)`,
    '    at runRule (server.js:108)',
    '    at loginHandler (server.js:241)',
  ].join('\n');

  // 1 · CRASH
  broadcast({ type: 'crash', node: 'app', message, file, line, stack,
    log: `runtime exception in authenticate() — ${message}` });
  await sleep(950);

  // 2 · TELEMETRY → real DB row
  const issue = ++issueCounter;
  const errId = insertError({ ts, level: 'ERROR', message, file, line, stack, issue, status: 'OPEN' });
  lastIssue = issue; lastErrorId = errId;
  broadcast({ type: 'telemetry', node: 'db', errorId: errId, table: 'error_log',
    sql: `INSERT INTO error_log (level, file, line, status)\n  VALUES ('ERROR', '${file}', ${line}, 'OPEN');`,
    row: { id: errId, level: 'ERROR', file, line, status: 'OPEN' },
    log: `telemetry persisted — error_log#${errId} committed to phoenix.db` });
  await sleep(1050);

  // 3 · GITHUB ISSUE — real if a token is configured, simulated otherwise
  const issueTitle = `[self-heal] ${message}`;
  const issueBody = [
    'Filed automatically by Phoenix app telemetry. 🔥',
    '',
    '**Service:** `login-service`',
    `**Where:** \`${file}:${line}\``,
    `**Error:** \`${message}\``,
    '',
    '```',
    stack,
    '```',
    '',
    '---',
    'This issue is labeled `self-heal`. Run the `/phoenix-heal` skill in Claude Code to',
    'diagnose and fix it — the agent will open a PR that closes this issue.',
  ].join('\n');

  let issueNum = issue, issueUrl = null, real = false;
  if (githubConfigured()) {
    try {
      const created = await createIssue({ title: issueTitle, body: issueBody });
      issueNum = created.number; issueUrl = created.url; real = true;
    } catch (e) {
      broadcast({ type: 'agent_log', node: 'github', line: `github issue create failed: ${e.message}`, log: `github error: ${e.message}` });
    }
  }
  lastIssue = issueNum; lastIssueUrl = issueUrl;
  broadcast({ type: 'issue', node: 'github', issue: issueNum, url: issueUrl, real,
    labels: ['self-heal', 'auto-filed', 'bug'],
    log: real ? `opened REAL issue #${issueNum} → ${issueUrl}` : `opened issue #${issueNum} (simulated — no GitHub token)` });
  await sleep(900);
}

// The agent DIAGNOSES and PROPOSES a fix: it heals the running app (working tree)
// and comments the patch on the issue — but does NOT commit. Committing is a human
// decision, gated behind the dashboard's "Commit fix" button (semi-automatic).
async function proposeFix() {
  const issue = lastIssue ?? ++issueCounter;

  // AGENT WAKES
  broadcast({ type: 'agent_boot', node: 'agent', issue, log: `Phoenix Agent dispatched → issue #${issue}` });
  await sleep(750);

  const diagnosis = [
    'booting phoenix-agent runtime …',
    `pulling issue #${issue} — TypeError reading 'role'`,
    'reproducing failure locally … reproduced ✗',
    'tracing stack → healer/login-rule.js',
    'reading source … `const role = user.account.role;`',
    'inspecting object shape … `user.account` is undefined',
    'root cause: field flattened to `user.role` in a refactor',
    'synthesizing patch …',
  ];
  for (const line of diagnosis) {
    broadcast({ type: 'agent_log', node: 'agent', line, log: line });
    await sleep(340);
  }
  await sleep(250);

  // PATCH — fix the live working tree (this heals the running app)
  const before = 'const role = user.account.role;';
  const after = 'const role = user.role;';
  await writeFile(RULE_FILE, (await ruleText()).replace(BUG_LINE, FIXED_LINE), 'utf8');
  broadcast({ type: 'patch', node: 'patch', file: 'healer/login-rule.js', line: 15, before, after,
    log: `patch applied to working tree → healer/login-rule.js` });
  await sleep(1000);

  // VERIFY — actually re-run the patched code
  let ok = false, token = null;
  try { const r = await runRule(); ok = r.ok; token = r.token; } catch { ok = false; }
  broadcast({ type: 'verify', node: 'patch', ok, token,
    log: ok ? `re-ran auth — login verified, token ${token}` : 'verification FAILED' });
  await sleep(700);

  // COMMENT the proposed fix on the issue (no commit — that's the human's call)
  if (githubConfigured() && lastIssueUrl) {
    const comment = [
      '🔧 **Phoenix agent — proposed fix**', '',
      '```diff', `- ${before}`, `+ ${after}`, '```', '',
      'Root cause: `user.account` was removed in a refactor, so `user.account.role` throws.',
      'Applied to the running app and verified locally. Hit **Commit fix** on the dashboard to raise the PR.',
    ].join('\n');
    try { await commentIssue(issue, comment); } catch {}
  }

  // HEALED locally — fix proposed, awaiting commit
  if (lastErrorId) updateErrorStatus(lastErrorId, 'PROPOSED');
  broadcast({ type: 'healed', node: 'restored', issue, token, url: lastIssueUrl, committed: false,
    log: `fix applied locally & commented on issue #${issue} — awaiting commit` });
}

// ── Request handlers ────────────────────────────────────────────────────────
async function doLogin({ autoHeal = true, speed = 1 } = {}) {
  if (running) return { accepted: false, reason: 'busy' };
  SPEED = Math.min(3, Math.max(0.4, Number(speed) || 1));

  if (await isHealthy()) {
    const r = await runRule();
    broadcast({ type: 'login_ok', node: 'app', token: r.token, user: r.user,
      log: `login succeeded for ${r.user} — token ${r.token}` });
    return { accepted: true, healthy: true };
  }

  running = true;
  (async () => {
    try {
      await crashToIssue();
      if (autoHeal) { await sleep(600); await proposeFix(); }
    } catch (e) {
      broadcast({ type: 'agent_log', node: 'agent', line: `orchestrator error: ${e.message}`, log: e.message });
    } finally {
      running = false;
    }
  })();
  return { accepted: true, healthy: false };
}

// Diagnose + propose the fix (heal locally, comment on the issue). No commit.
async function doHeal() {
  if (running) return { accepted: false, reason: 'busy' };
  if (await isHealthy()) return { accepted: false, reason: 'already healthy' };
  running = true;
  (async () => { try { await proposeFix(); } finally { running = false; } })();
  return { accepted: true };
}

// The human commit gate: actually open the PR with the fix.
async function doCommit() {
  if (running) return { accepted: false, reason: 'busy' };
  if (!githubConfigured()) return { accepted: false, reason: 'no github' };
  if (!lastIssue) return { accepted: false, reason: 'nothing to commit' };
  running = true;
  (async () => {
    try {
      broadcast({ type: 'agent_log', node: 'agent', line: `committing fix for issue #${lastIssue} …`, log: `committing fix for issue #${lastIssue}` });
      const title = `fix(auth): resolve TypeError reading 'role' (#${lastIssue})`;
      const body = [
        `Closes #${lastIssue}`, '',
        'Root cause: `user.account` was removed in a refactor; `user.account.role` throws.',
        'Fix: read the flat field `user.role`.', '',
        '— Committed from the Phoenix dashboard 🔥',
      ].join('\n');
      const pr = await commitFix({ issue: lastIssue, file: 'healer/login-rule.js', bugLine: BUG_LINE, fixedLine: FIXED_LINE, title, body });
      lastPrUrl = pr.url;
      if (lastErrorId) updateErrorStatus(lastErrorId, 'RESOLVED');
      try { await commentIssue(lastIssue, `🚀 Fix committed — PR raised: ${pr.url}`); } catch {}
      broadcast({ type: 'committed', node: 'agent', issue: lastIssue, url: lastIssueUrl, prUrl: pr.url,
        log: `committed — PR raised ${pr.url}` });
    } catch (e) {
      broadcast({ type: 'agent_log', node: 'agent', line: `commit failed: ${e.message}`, log: `commit failed: ${e.message}` });
    } finally {
      running = false;
    }
  })();
  return { accepted: true };
}

// Wipe every GitHub artifact so nothing sticks between demos.
async function doCleanup() {
  if (!githubConfigured()) return { accepted: false, reason: 'no github' };
  broadcast({ type: 'agent_log', node: 'github', line: 'cleaning up GitHub artifacts …', log: 'cleanup started' });
  const r = await cleanup();
  lastPrUrl = null;
  broadcast({ type: 'cleanup', node: 'github', result: r,
    log: `cleanup done — closed ${r.issues} issue(s), ${r.prs} PR(s), deleted ${r.branches} branch(es)` });
  return { accepted: true, ...r };
}

// Re-arm: revert the working tree to the buggy baseline. Local only → instant & reliable.
async function doReset() {
  running = false;
  lastPrUrl = null; lastIssue = null; lastIssueUrl = null; lastErrorId = null;
  await writeFile(RULE_FILE, (await ruleText()).replace(FIXED_LINE, BUG_LINE), 'utf8');
  broadcast({ type: 'reset', node: 'app', log: 'fault re-armed — login-rule.js reverted to buggy state' });
  return { ok: true };
}

// The /phoenix-heal skill streams its REAL progress here so the dashboard lights
// up from the agent's actual work (boot → diagnose → patch → PR → healed).
const AGENT_EVENTS = new Set(['agent_boot', 'agent_log', 'patch', 'verify', 'healed', 'committed']);
function doAgentEvent(body) {
  if (!body || !AGENT_EVENTS.has(body.type)) return { accepted: false, reason: 'bad event type' };
  if (body.prUrl) lastPrUrl = body.prUrl;
  if (body.issue) lastIssue = body.issue;
  if (body.type === 'committed' && lastErrorId) updateErrorStatus(lastErrorId, 'RESOLVED');
  broadcast({ node: 'agent', ...body });
  return { accepted: true };
}

async function doGithub() {
  const configured = githubConfigured();
  let openIssues = [], pr = null;
  if (configured) {
    try { openIssues = await listOpenSelfHeal(); } catch {}
    try { pr = await latestPr(); } catch {}
  }
  return { configured, repo: repoSlug(), openIssues, latestPr: pr };
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = normalize(join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', healthy: await isHealthy(), errors: countErrors(), github: { configured: githubConfigured(), repo: repoSlug() } })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/api/login' && req.method === 'POST') return sendJson(res, await doLogin(await readJsonBody(req)));
  if (p === '/api/heal' && req.method === 'POST') return sendJson(res, await doHeal());
  if (p === '/api/commit' && req.method === 'POST') return sendJson(res, await doCommit());
  if (p === '/api/cleanup' && req.method === 'POST') return sendJson(res, await doCleanup());
  if (p === '/api/reset' && req.method === 'POST') return sendJson(res, await doReset());
  if (p === '/api/agent-event' && req.method === 'POST') return sendJson(res, doAgentEvent(await readJsonBody(req)));
  if (p === '/api/github' && req.method === 'GET') return sendJson(res, await doGithub());
  if (p === '/api/state' && req.method === 'GET') return sendJson(res, { healthy: await isHealthy(), errors: countErrors() });

  return serveStatic(p, res);
});

server.listen(PORT, () => {
  console.log(`\n  🔥  PHOENIX self-heal mission control`);
  console.log(`      http://localhost:${PORT}`);
  console.log(`      github: ${githubConfigured() ? `LIVE → ${repoSlug()}` : 'simulated (no token)'}\n`);
  if (githubConfigured()) ensureLabels().catch(() => {});
});
