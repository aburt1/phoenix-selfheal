# 🔥 PHOENIX — a self-healing software loop

An app that **crashes, files its own GitHub issue, and gets fixed by a Claude agent** —
visualised live on a neon mission-control dashboard. A working demo of building app
*ecosystems* the agentic way: you steer the macro (detect → report → repair), the micro
takes care of itself.

```
   ┌──────────┐  crash   ┌──────────┐ telemetry ┌──────────┐
   │   APP    │ ───────▶ │ DATABASE │ ────────▶ │  GITHUB  │  real issue, labeled self-heal
   │  login   │          │ error_log│           │  issue # │
   └────▲─────┘          └──────────┘           └────┬─────┘
        │ heals                                      │
   ┌────┴─────┐  commit  ┌──────────┐  diagnoses ┌───┴──────┐
   │ RESTORED │ ◀─[you]─ │  PATCH   │ ◀───────── │  CLAUDE  │  /phoenix-heal
   │  online  │   PR     │  + diff  │  & proposes│  agent   │
   └──────────┘          └──────────┘            └──────────┘
```

Everything across the loop is **real**: a real exception, a real row in a real SQLite DB, a
**real GitHub issue**, a real Claude diagnosis, a real file edit, and — when *you* approve it
— a **real pull request**. The dashboard is just a live window onto the machinery.

---

## Run it (30 seconds)

```bash
git clone https://github.com/aburt1/phoenix-selfheal && cd phoenix-selfheal && ./start.sh
```

Needs **Node 22+**. For the full GitHub loop, have the **[`gh` CLI](https://cli.github.com)**
authenticated (`gh auth login`) — otherwise the GitHub stage is simulated and everything else
still works. **Forks just work**: the repo target is read from your `git origin`, so issues and
PRs land on *your* copy. No `npm install` — there are zero dependencies.

---

## The demo (~5 min)

1. **SIGN IN** → the login throws a real `TypeError`. Crash → DB row → a **real GitHub issue**
   appears (click through to it).
2. **Dispatch the agent** — run **`/phoenix-heal`** in Claude Code (or click *auto-diagnose*
   on the dashboard). It diagnoses for real, **heals the running app**, and **comments the
   proposed fix** on the issue. App is back to `SYSTEM ONLINE`.
3. **COMMIT FIX** → you hit the button; it opens a **real PR** that closes the issue. (Semi-
   automatic on purpose — the agent proposes, *you* commit.)
4. **RE-ARM ↺** → re-injects the bug so you can run it again.
5. **CLEAN UP 🧹** → closes all demo issues/PRs and deletes branches so nothing sticks
   (or run `scripts/cleanup.sh`).

---

## What's actually real

| Stage | Real? | How |
|---|---|---|
| Crash | ✅ | A genuine exception thrown in `healer/login-rule.js`. |
| Database | ✅ | A row written to `error_log` via `node:sqlite`. |
| GitHub issue | ✅ | Opened on your repo through the `gh` CLI. |
| Diagnosis + fix | ✅ | Claude reads the issue, edits the real source file. |
| Pull request | ✅ | Opened on commit, from an isolated worktree off `main`. |

---

## Build this yourself

Five small pieces, each a real, observable stage:

| Piece | Role |
|---|---|
| [`healer/login-rule.js`](healer/login-rule.js) | The service with the bug. The agent rewrites this file. |
| [`server.js`](server.js) | HTTP + SSE. Runs the rule, logs to SQLite, files the issue, streams the pipeline. Zero deps. |
| [`github.js`](github.js) | All GitHub ops via the `gh` CLI — issues, comments, PRs, cleanup. |
| [`public/`](public/) | The dashboard (vanilla JS + SVG + WebAudio, no framework). |
| [`.claude/skills/phoenix-heal/`](.claude/skills/phoenix-heal/SKILL.md) | The agent — a Claude routine that diagnoses, heals, and comments. |

**The one idea to copy:** make *detect → report → repair* three **separate, observable
stages**, and let each one leave a **real artifact** (a DB row, an issue, a PR). The issue is
the hinge — it's a durable, addressable unit of work an agent can pick up later.

Endpoints: `POST /api/login` (crash→issue) · `POST /api/heal` (diagnose + propose) ·
`POST /api/commit` (open PR) · `POST /api/cleanup` · `POST /api/reset` · `GET /events` (SSE).

---

## Why this works — and how it scales

The loop is just three primitives:

1. **Detection** — the system notices its own failure (here, a thrown error; in production, a
   crash reporter or an alert).
2. **A durable queue** — the failure becomes an *addressable unit of work*. A GitHub issue is
   perfect: persistent, labelable, linkable, and it can trigger automation.
3. **An agent with context + access** — something that can read the failure, the code, and the
   history, then propose a real change against the repo.

Keep a **human gate** on the irreversible step (the commit) and the loop is *maintainable*, not
runaway. That's the whole trick — the rest is wiring.

**Scaling to real systems** keeps the exact same shape, you just swap the parts:

| Toy here | Production |
|---|---|
| `try/catch` in the app | Sentry / crash reporter / SLO alert |
| `gh issue create` | the same — or your tracker's API |
| `/phoenix-heal` skill, run by hand | a scheduled / webhook-triggered agent on the issue label |
| **Commit fix** button | a PR opened for **human review** before merge |
| one seeded bug | many error classes, each with a triage + repair routine |

The agent doesn't manage the micro of the app. You steer the macro — the ecosystem that
detects, reports, and repairs — and let it close its own loop.

---

*Inspired by a much larger self-healing system (Glicko). The micro takes care of itself when
the macro is an agent.*
