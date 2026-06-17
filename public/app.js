/* ═══════════════════════════════════════════════════════════════════════════
   PHOENIX · client — drives the show from the /events SSE stream
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const $ = (s) => document.querySelector(s);
const NC = { cyan: '#2de2ff', red: '#ff3b5c', amber: '#ffb13b', green: '#2bffb0', violet: '#8b7bff' };
const SVGNS = 'http://www.w3.org/2000/svg';

// ── Board topology ───────────────────────────────────────────────────────────
const NODES = [
  { id: 'app',      x: 150, y: 130, icon: '🔐', label: 'APP',      sub: 'login-service', color: NC.cyan },
  { id: 'db',       x: 500, y: 130, icon: '🗄️', label: 'DATABASE', sub: 'error_log',     color: NC.cyan },
  { id: 'github',   x: 850, y: 130, icon: '🐙', label: 'GITHUB',   sub: 'issues',        color: NC.violet },
  { id: 'agent',    x: 850, y: 410, icon: '🤖', label: 'CLAUDE',   sub: 'self-heal',     color: NC.amber },
  { id: 'patch',    x: 500, y: 410, icon: '🔧', label: 'PATCH',    sub: 'code rewrite',  color: NC.amber },
  { id: 'restored', x: 150, y: 410, icon: '🟢', label: 'RESTORED', sub: 'system green',  color: NC.green },
];
const WIRES = [['app', 'db'], ['db', 'github'], ['github', 'agent'], ['agent', 'patch'], ['patch', 'restored']];

const nodeEls = {};
const wireEls = {};
let packet, loopWire;

function svg(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function nodeById(id) { return NODES.find((n) => n.id === id); }

function buildBoard() {
  const root = svg('svg', { viewBox: '0 0 1000 540', preserveAspectRatio: 'xMidYMid meet' });

  const gWires = svg('g', {});
  const drawWire = (a, b, extra = '') => {
    const A = nodeById(a), B = nodeById(b);
    return svg('path', { d: `M ${A.x} ${A.y} L ${B.x} ${B.y}`, class: `wire ${extra}` });
  };
  for (const [a, b] of WIRES) { const p = drawWire(a, b); wireEls[`${a}-${b}`] = p; gWires.appendChild(p); }
  loopWire = drawWire('restored', 'app', 'loop'); wireEls['restored-app'] = loopWire; gWires.appendChild(loopWire);
  root.appendChild(gWires);

  // packet (above wires, below nodes)
  packet = svg('g', { class: 'packet' });
  packet.appendChild(svg('circle', { class: 'halo', r: 12 }));
  packet.appendChild(svg('circle', { class: 'core', r: 4.5 }));
  packet.style.display = 'none';
  root.appendChild(packet);

  // nodes
  for (const n of NODES) {
    const g = svg('g', { class: 'node idle', 'data-id': n.id });
    g.appendChild(svg('rect', { class: 'node-box', x: n.x - 88, y: n.y - 52, width: 176, height: 104, rx: 14 }));
    const emoji = svg('text', { class: 'node-emoji', x: n.x, y: n.y - 12 }); emoji.textContent = n.icon;
    const label = svg('text', { class: 'node-label', x: n.x, y: n.y + 22 }); label.textContent = n.label;
    const sub = svg('text', { class: 'node-sub', x: n.x, y: n.y + 40 }); sub.textContent = n.sub;
    g.append(emoji, label, sub);
    nodeEls[n.id] = g;
    root.appendChild(g);
  }
  $('#board').appendChild(root);
}

function setNode(id, state, color) {
  const g = nodeEls[id]; if (!g) return;
  g.classList.remove('idle', 'active');
  if (state === 'idle') { g.classList.add('idle'); g.removeAttribute('data-c'); g.style.removeProperty('--nc'); return; }
  if (state === 'active') g.classList.add('active');
  g.setAttribute('data-c', '1');
  g.style.setProperty('--nc', color || nodeById(id).color);
}

function travel(fromId, toId, color, done) {
  const path = wireEls[`${fromId}-${toId}`];
  if (!path) { done && done(); return; }
  path.classList.add('flow');
  const len = path.getTotalLength();
  packet.style.setProperty('--pc', color);
  packet.classList.add('on');
  packet.style.display = '';
  const dur = 680, t0 = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - t0) / dur);
    const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
    const pt = path.getPointAtLength(e * len);
    packet.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
    if (t < 1) requestAnimationFrame(frame);
    else {
      packet.style.display = 'none';
      packet.classList.remove('on');
      path.classList.remove('flow'); path.classList.add('done');
      done && done();
    }
  }
  requestAnimationFrame(frame);
}

function resetBoard() {
  for (const n of NODES) setNode(n.id, 'idle');
  for (const k in wireEls) wireEls[k].classList.remove('flow', 'done');
  packet.style.display = 'none';
}

// ── Device views ─────────────────────────────────────────────────────────────
function showView(name) {
  for (const v of ['login', 'terminal', 'success']) $(`#${v}View`).hidden = (v !== name);
}

// ── Status pill ──────────────────────────────────────────────────────────────
const STATUS = {
  boot:     ['boot', 'INITIALIZING'],
  online:   ['online', 'SYSTEM ONLINE'],
  fault:    ['fault', 'SYSTEM FAULT'],
  healing:  ['healing', 'SELF-HEALING…'],
  degraded: ['degraded', 'DEGRADED · FAULT ARMED'],
};
function setStatus(key) {
  const [state, text] = STATUS[key];
  $('#status').dataset.state = state;
  $('#statusText').textContent = text;
}

// ── Console log ──────────────────────────────────────────────────────────────
let errCount = 0, eventCount = 0;
const TAGS = {
  crash: 'FAULT', telemetry: 'DB', issue: 'GITHUB', agent_boot: 'AGENT', agent_log: 'AGENT',
  patch: 'PATCH', verify: 'VERIFY', healed: 'HEALED', login_ok: 'AUTH', reset: 'RESET',
};
function makeSpan(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
function pushLog(ev) {
  if (!ev.log) return;
  eventCount++;
  const log = $('#log');
  const line = document.createElement('div');
  line.className = `log-line t-${ev.type}`;
  const time = new Date(ev.ts || Date.now()).toLocaleTimeString('en-GB', { hour12: false });
  line.append(makeSpan('log-time', time), makeSpan('log-tag', TAGS[ev.type] || '·'), makeSpan('log-text', ev.log));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  $('#consoleMeta').textContent = `error_log · ${errCount} rows · ${eventCount} events`;
  while (log.children.length > 120) log.removeChild(log.firstChild);
}

// ── Terminal ─────────────────────────────────────────────────────────────────
let termCursor;
function termReset(issue) {
  const body = $('#termBody'); body.replaceChildren();
  $('#termIssue').textContent = issue ? `issue #${issue}` : '';
  $('#diff').hidden = true;
  termCursor = document.createElement('span'); termCursor.className = 'term-cursor';
  body.appendChild(termCursor);
}
function termLine(text) {
  const body = $('#termBody');
  const line = document.createElement('div'); line.className = 'term-line'; line.textContent = text;
  body.insertBefore(line, termCursor);
  body.appendChild(termCursor);
  body.scrollTop = body.scrollHeight;
}
function showDiff(before, after, file) {
  $('#diffHead').textContent = file;
  $('#diffDel').textContent = before;
  $('#diffAdd').textContent = after;
  $('#diff').hidden = false;
  $('#termBody').scrollTop = $('#termBody').scrollHeight;
}

// ── Agent dock (shown after a REAL issue is filed, awaiting the skill) ────────
function showAgentDock(issueNum, url) {
  removeDock();
  const dock = document.createElement('div');
  dock.className = 'agent-dock'; dock.id = 'agentDock';
  const t = document.createElement('div'); t.className = 'dock-title';
  t.textContent = `🐙 issue #${issueNum} filed · awaiting agent`;
  const hint = document.createElement('div'); hint.className = 'dock-hint';
  hint.appendChild(document.createTextNode('run '));
  const code = document.createElement('code'); code.textContent = '/phoenix-heal'; hint.appendChild(code);
  hint.appendChild(document.createTextNode(' in Claude Code'));
  const row = document.createElement('div'); row.className = 'dock-row';
  if (url) {
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'dock-link'; a.textContent = 'view issue ↗'; row.appendChild(a);
  }
  const sim = document.createElement('button'); sim.className = 'dock-sim'; sim.textContent = '▸ simulate locally';
  sim.onclick = () => { fetch('/api/heal', { method: 'POST' }); removeDock(); };
  row.appendChild(sim);
  dock.append(t, hint, row);
  $('.device-panel').appendChild(dock);
}
function removeDock() { const d = $('#agentDock'); if (d) d.remove(); }

function setSuccessLinks(ev) {
  const sl = $('#successLinks'); sl.replaceChildren();
  if (ev.url) {
    const a = document.createElement('a'); a.href = ev.url; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'slink'; a.textContent = `issue #${ev.issue} ↗`; sl.appendChild(a);
  }
  if (ev.prUrl) {
    const m = String(ev.prUrl).match(/\/pull\/(\d+)/);
    const a = document.createElement('a'); a.href = ev.prUrl; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'slink pr'; a.textContent = `PR ${m ? '#' + m[1] : ''} ↗`; sl.appendChild(a);
  }
}

// The human commit gate: a button that actually opens the PR.
function renderCommitGate(ev) {
  const row = $('#commitRow'); row.replaceChildren();
  if (ev.committed || ev.prUrl) return;
  const btn = document.createElement('button');
  btn.className = 'commit-btn';
  btn.textContent = '⬆ COMMIT FIX → open PR';
  btn.onclick = () => { btn.disabled = true; btn.textContent = 'committing…'; fetch('/api/commit', { method: 'POST' }); };
  row.appendChild(btn);
}

// ═══ Event handlers ══════════════════════════════════════════════════════════
const handlers = {
  hello(ev) {
    setStatus(ev.healthy ? 'online' : 'degraded');
    errCount = ev.errors || 0;
    const g = ev.github || {};
    const chip = $('#repoChip');
    if (g.repo) { chip.hidden = false; chip.textContent = (g.configured ? '🐙 ' : '🐙 sim · ') + g.repo; chip.href = 'https://github.com/' + g.repo; }
  },

  crash(ev) {
    setStatus('fault');
    setNode('app', 'active', NC.red);
    $('#loginCard').classList.add('crash');
    $('#faultMsg').textContent = ev.message;
    $('#faultStack').textContent = ev.stack;
    $('#fault').hidden = false;
    sfx.crash();
    shockwave($('.device-panel'), NC.red);
  },

  telemetry(ev) {
    errCount++;
    setNode('db', 'done', NC.cyan);
    travel('app', 'db', NC.cyan);
    sfx.blip();
  },

  issue(ev) {
    setNode('github', 'done', NC.violet);
    travel('db', 'github', NC.violet);
    if (!$('#autoHeal').checked) showAgentDock(ev.issue, ev.url);
    const fl = $('#faultLink'); fl.replaceChildren();
    if (ev.url) {
      const a = document.createElement('a'); a.href = ev.url; a.target = '_blank'; a.rel = 'noopener';
      a.className = 'fault-link-a'; a.textContent = `🐙 issue #${ev.issue} filed → view on GitHub ↗`;
      fl.appendChild(a);
    } else { fl.textContent = `🐙 issue #${ev.issue} filed (simulated)`; }
    sfx.blip();
  },

  agent_boot(ev) {
    setStatus('healing');
    removeDock();
    setNode('agent', 'active', NC.amber);
    travel('github', 'agent', NC.amber);
    termReset(ev.issue);
    showView('terminal');
    sfx.boot();
  },

  agent_log(ev) { termLine(ev.line); sfx.tick(); },

  patch(ev) {
    setNode('agent', 'done', NC.amber);
    setNode('patch', 'active', NC.amber);
    travel('agent', 'patch', NC.amber);
    showDiff(ev.before, ev.after, `${ev.file}:${ev.line}`);
    sfx.patch();
  },

  verify(ev) {
    setNode('patch', 'done', ev.ok ? NC.green : NC.red);
    termLine(ev.ok ? `✓ verified — token ${ev.token}` : '✗ verification failed');
  },

  healed(ev) {
    setNode('patch', 'done', NC.green);
    setNode('restored', 'done', NC.green);
    setNode('app', 'done', NC.green);
    loopWire.classList.add('flow');
    setTimeout(() => { loopWire.classList.remove('flow'); loopWire.classList.add('done'); }, 800);
    travel('patch', 'restored', NC.green);
    $('#token').textContent = ev.token || '';
    $('#okIssue').textContent = ev.issue ? `#${ev.issue}` : '';
    $('#successSub').textContent = ev.committed
      ? `system restored · issue #${ev.issue} closed`
      : `fix applied & commented on issue #${ev.issue} · awaiting commit`;
    setSuccessLinks(ev);
    renderCommitGate(ev);
    removeDock();
    setTimeout(() => { showView('success'); setStatus('online'); sfx.heal(); confetti(); }, 750);
  },

  committed(ev) {
    $('#successSub').textContent = `committed · PR raised · issue #${ev.issue} closes on merge`;
    setSuccessLinks(ev);
    $('#commitRow').replaceChildren();
    setStatus('online'); sfx.heal(); confetti();
  },

  cleanup(ev) {
    $('#successLinks').replaceChildren();
    $('#commitRow').replaceChildren();
    sfx.blip();
  },

  login_ok(ev) {
    setStatus('online');
    $('#token').textContent = ev.token || '';
    $('#okIssue').textContent = '—';
    showView('success'); confetti(); sfx.heal();
  },

  reset(ev) {
    setStatus('degraded');
    resetBoard();
    removeDock();
    $('#loginCard').classList.remove('crash');
    $('#fault').hidden = true;
    $('#faultLink').replaceChildren();
    $('#successLinks').replaceChildren();
    showView('login');
    sfx.reset();
  },
};

// ═══ SSE wiring ══════════════════════════════════════════════════════════════
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    pushLog(ev);
    const h = handlers[ev.type];
    if (h) h(ev);
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}

// ═══ Controls ════════════════════════════════════════════════════════════════
function wireControls() {
  $('#signin').onclick = () => {
    sfx.unlock();
    const body = { autoHeal: $('#autoHeal').checked, speed: parseFloat($('#speed').value) };
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  };
  $('#reset').onclick = () => fetch('/api/reset', { method: 'POST' });
  $('#cleanup').onclick = (e) => {
    const b = e.currentTarget; b.disabled = true; const orig = b.textContent; b.textContent = 'cleaning…';
    fetch('/api/cleanup', { method: 'POST' }).catch(() => {}).finally(() => setTimeout(() => { b.disabled = false; b.textContent = orig; }, 1400));
  };
  $('#speed').oninput = (e) => { $('#speedVal').textContent = parseFloat(e.target.value).toFixed(1) + '×'; };
  $('#mute').onclick = (e) => {
    sfx.muted = !sfx.muted;
    e.target.textContent = sfx.muted ? '🔇' : '🔊';
    e.target.classList.toggle('muted', sfx.muted);
  };
}

// ═══ Sound (WebAudio, synthesized) ═══════════════════════════════════════════
const sfx = (() => {
  let actx = null;
  const api = { muted: false };
  function ctx() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  api.unlock = ctx;
  function tone(freq, dur, { type = 'sine', gain = .08, at = 0, glide = null } = {}) {
    const ac = ctx(); if (!ac || api.muted) return;
    const t = ac.currentTime + at;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + .012);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + .03);
  }
  function noise(dur, gain) {
    const ac = ctx(); if (!ac || api.muted) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    const s = ac.createBufferSource(); s.buffer = buf;
    const g = ac.createGain(); g.gain.value = gain;
    s.connect(g).connect(ac.destination); s.start();
  }
  api.crash = () => { noise(.45, .16); tone(440, .55, { type: 'sawtooth', gain: .11, glide: 70 }); };
  api.blip  = () => tone(760, .12, { type: 'square', gain: .045 });
  api.boot  = () => { tone(330, .12, { type: 'triangle', gain: .06 }); tone(660, .16, { type: 'triangle', gain: .05, at: .1 }); };
  api.tick  = () => tone(1500, .035, { type: 'square', gain: .015 });
  api.patch = () => { tone(880, .08, { type: 'square', gain: .05 }); tone(1180, .1, { type: 'square', gain: .05, at: .09 }); };
  api.heal  = () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, .55, { type: 'triangle', gain: .065, at: i * .085 })); tone(1568, .7, { type: 'sine', gain: .035, at: .32 }); };
  api.reset = () => tone(320, .32, { type: 'sawtooth', gain: .06, glide: 120 });
  return api;
})();

// ═══ Confetti + shockwave (canvas) ═══════════════════════════════════════════
const canvas = $('#fx'), cx = canvas.getContext('2d');
function sizeCanvas() { canvas.width = innerWidth; canvas.height = innerHeight; }
addEventListener('resize', sizeCanvas); sizeCanvas();

let particles = [];
function confetti() {
  const cols = [NC.green, NC.cyan, NC.amber, '#ffffff', NC.violet];
  const ox = innerWidth * 0.72, oy = innerHeight * 0.42;
  const wasEmpty = particles.length === 0;
  for (let i = 0; i < 150; i++) {
    const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 11;
    particles.push({
      x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4,
      g: .16 + Math.random() * .12, life: 1, dl: .006 + Math.random() * .01,
      s: 2 + Math.random() * 4, col: cols[(Math.random() * cols.length) | 0], rot: Math.random() * 6,
    });
  }
  if (wasEmpty) requestAnimationFrame(tick);
}
function tick() {
  cx.clearRect(0, 0, canvas.width, canvas.height);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= .99; p.life -= p.dl; p.rot += .2;
    cx.globalAlpha = Math.max(0, p.life);
    cx.fillStyle = p.col;
    cx.shadowBlur = 12; cx.shadowColor = p.col;
    cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
    cx.fillRect(-p.s, -p.s, p.s * 2, p.s * 2);
    cx.restore();
  }
  cx.globalAlpha = 1; cx.shadowBlur = 0;
  if (particles.length) requestAnimationFrame(tick);
  else cx.clearRect(0, 0, canvas.width, canvas.height);
}
function shockwave(el, color) {
  const r = el.getBoundingClientRect();
  const w = document.createElement('div');
  Object.assign(w.style, {
    position: 'fixed', left: r.left + r.width / 2 + 'px', top: r.top + r.height / 2 + 'px',
    width: '10px', height: '10px', borderRadius: '50%', border: `2px solid ${color}`,
    transform: 'translate(-50%,-50%)', pointerEvents: 'none', zIndex: 56, opacity: '.9',
    transition: 'all .6s cubic-bezier(.2,.8,.3,1)',
  });
  document.body.appendChild(w);
  requestAnimationFrame(() => { w.style.width = '520px'; w.style.height = '520px'; w.style.opacity = '0'; });
  setTimeout(() => w.remove(), 650);
}

// ═══ Boot ════════════════════════════════════════════════════════════════════
buildBoard();
wireControls();
connect();
