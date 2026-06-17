// ───────────────────────────────────────────────────────────────────────────
// PHOENIX · SELF-HEAL MISSION CONTROL — backend
//
// Zero npm dependencies. Pure Node built-ins so the demo never breaks on stage.
//
// The real loop:
//   POST /api/login  → runs the LIVE auth rule (cache-busted import). If it throws,
//                      it drives the pipeline over SSE: crash → telemetry (real DB
//                      row) → GitHub issue (simulated) → [agent → patch → verify →
//                      healed]. The patch REWRITES healer/login-rule.js on disk.
//   POST /api/heal   → dispatches the agent manually (when auto-dispatch is off).
//   POST /api/reset  → re-injects the fault (reverts the file) for a repeatable demo.
//   GET  /events     → Server-Sent Events stream the whole show drives.
// ───────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { githubConfigured, repoSlug, createIssue, listOpenSelfHeal, closeIssue, latestPr, ensureLabels } from './github.js';

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

async function healSteps() {
  const issue = lastIssue ?? ++issueCounter;

  // 4 · AGENT WAKES
  broadcast({ type: 'agent_boot', node: 'agent', issue,
    log: `Phoenix Agent dispatched → issue #${issue}` });
  await sleep(750);

  const diagnosis = [
    'booting phoenix-agent runtime …',
    'authenticating to issue tracker … ok',
    `pulling issue #${issue} — TypeError reading 'role'`,
    'reproducing failure locally … reproduced ✗',
    'tracing stack → healer/login-rule.js:15',
    'reading source … `const role = user.account.role;`',
    'inspecting object shape … `user.account` is undefined',
    'git blame → field flattened to `user.role` (refactor a1b2c3d)',
    'root cause: stale field reference after schema refactor',
    'synthesizing patch …',
  ];
  for (const line of diagnosis) {
    broadcast({ type: 'agent_log', node: 'agent', line, log: line });
    await sleep(360);
  }
  await sleep(300);

  // 5 · PATCH — rewrite the real file on disk
  const before = 'const role = user.account.role;';
  const after = 'const role = user.role;';
  let text = await ruleText();
  text = text.replace(BUG_LINE, FIXED_LINE);
  await writeFile(RULE_FILE, text, 'utf8');
  broadcast({ type: 'patch', node: 'patch', file: 'healer/login-rule.js', line: 15, before, after,
    log: `patch applied → healer/login-rule.js:15` });
  await sleep(1150);

  // 6 · VERIFY — actually re-run the patched code
  let ok = false, token = null;
  try { const r = await runRule(); ok = r.ok; token = r.token; } catch { ok = false; }
  broadcast({ type: 'verify', node: 'patch', ok, token,
    log: ok ? `re-ran auth suite — login verified, token ${token}` : 'verification FAILED' });
  await sleep(850);

  // 7 · HEALED
  if (lastErrorId) updateErrorStatus(lastErrorId, 'RESOLVED');
  broadcast({ type: 'healed', node: 'restored', issue, token, url: lastIssueUrl, prUrl: lastPrUrl,
    log: `issue #${issue} resolved — system restored ✓` });
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
      if (autoHeal) { await sleep(600); await healSteps(); }
    } catch (e) {
      broadcast({ type: 'agent_log', node: 'agent', line: `orchestrator error: ${e.message}`, log: e.message });
    } finally {
      running = false;
    }
  })();
  return { accepted: true, healthy: false };
}

async function doHeal() {
  if (running) return { accepted: false, reason: 'busy' };
  if (await isHealthy()) return { accepted: false, reason: 'already healthy' };
  running = true;
  (async () => { try { await healSteps(); } finally { running = false; } })();
  return { accepted: true };
}

async function doReset() {
  running = false;
  let text = await ruleText();
  text = text.replace(FIXED_LINE, BUG_LINE);
  await writeFile(RULE_FILE, text, 'utf8');
  lastPrUrl = null;
  // best-effort: close any open self-heal issues so the repo stays tidy between runs
  if (githubConfigured()) {
    try {
      const open = await listOpenSelfHeal();
      for (const i of open) await closeIssue(i.number, '🔁 Re-armed for another demo run — closing.');
    } catch {}
  }
  broadcast({ type: 'reset', node: 'app', log: 'fault re-armed — login-rule.js reverted to buggy state' });
  return { ok: true };
}

// The /phoenix-heal skill streams its REAL progress here so the dashboard lights
// up from the agent's actual work (boot → diagnose → patch → PR → healed).
const AGENT_EVENTS = new Set(['agent_boot', 'agent_log', 'patch', 'verify', 'healed']);
function doAgentEvent(body) {
  if (!body || !AGENT_EVENTS.has(body.type)) return { accepted: false, reason: 'bad event type' };
  if (body.type === 'healed') {
    if (body.prUrl) lastPrUrl = body.prUrl;
    if (lastErrorId) updateErrorStatus(lastErrorId, 'RESOLVED');
  }
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
