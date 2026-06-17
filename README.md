# 🔥 PHOENIX — a self-healing software loop

> A live demo of **agentic engineering**: an app that crashes, files its own GitHub
> issue, and is fixed by a Claude routine that opens a real PR — all visualised on a
> neon mission-control dashboard as it happens.

The point isn't the login page. The point is the **macro loop**: you don't babysit the
micro of an app when you can build an ecosystem around it that detects, reports, and
repairs itself. This is that idea, made real and watchable.

```
   ┌──────────┐   crash    ┌──────────┐  telemetry  ┌──────────┐
   │   APP    │ ─────────▶ │ DATABASE │ ──────────▶ │  GITHUB  │
   │  login   │            │ error_log│   (real)    │  issue # │
   └────▲─────┘            └──────────┘             └────┬─────┘
        │                                                │ labeled `self-heal`
        │ heals (re-reads fixed file)                    ▼
   ┌────┴─────┐   PR merged ┌──────────┐  diagnoses  ┌──────────┐
   │ RESTORED │ ◀────────── │  PATCH   │ ◀────────── │  CLAUDE  │
   │  online  │             │  diff    │   & fixes   │ /heal    │
   └──────────┘             └──────────┘             └──────────┘
```

Everything across that loop is **real**: a real thrown exception, a real row in a real
SQLite database, a **real GitHub issue**, a real Claude diagnosis, a real file edit, and a
**real pull request**. The dashboard is just a live window onto the machinery.

---

## The loop, step by step

1. **Crash.** You click *Sign In*. The auth rule (`healer/login-rule.js`) reads a field that
   no longer exists (`user.account.role`) and throws a `TypeError`. The login screen shatters.
2. **Telemetry → database.** The error is written to a real `error_log` table (`node:sqlite`).
3. **GitHub issue.** The backend opens a **real GitHub issue** on this repo, labeled
   `self-heal`, with the stack trace. The dashboard shows the live issue number + link.
4. **The agent.** You run the **`/phoenix-heal` skill** in Claude Code. It reads the issue,
   genuinely diagnoses the bug, fixes the source, and opens a **real PR** that closes the
   issue — streaming every step back to the dashboard so the board lights up from its work.
5. **Restored.** The running app re-reads the now-fixed file, the next login succeeds, and
   the loop closes. Confetti. `SYSTEM ONLINE`.

The healing agent is a **Claude routine** — a reusable skill you trigger. Semi-automatic by
design: you stay in the loop, but the diagnosis and fix are real Claude work, not a script.

---

## Run it

```bash
node server.js          # zero npm dependencies — pure Node built-ins
# open http://localhost:4178
```

- **GitHub mode** is automatic if the [`gh` CLI](https://cli.github.com) is authenticated
  (`gh auth status`) or `GITHUB_TOKEN` is set. Without it, the GitHub stage is faithfully
  simulated so the app still runs anywhere.
- Point it at your own repo with `PHOENIX_REPO=owner/name node server.js`.

### Demo script (~5 min)

1. Open the dashboard. Status reads `DEGRADED · FAULT ARMED` — the bug is live.
2. Click **SIGN IN**. Watch crash → database → a real issue appear (click through to GitHub).
3. In Claude Code, run **`/phoenix-heal`**. Watch the agent work on the board in real time,
   then open a PR. The app heals itself. Show the real issue + PR on GitHub.
4. Hit **RE-ARM ↺** to reset the fault and run it again.

> Toggle **SIMULATE** to run a fully self-contained local heal (no GitHub / no skill) — handy
> as a bulletproof fallback when there's no network on stage.

---

## How it's built

| Piece | What it does |
|---|---|
| [`server.js`](server.js) | HTTP + SSE server. Runs the live auth rule, logs to SQLite, files the issue, streams the pipeline. Zero dependencies. |
| [`github.js`](github.js) | Real GitHub REST integration (token from `gh` or `$GITHUB_TOKEN`). Issues, labels, PRs. |
| [`healer/login-rule.js`](healer/login-rule.js) | The **real source file with the bug**. The agent rewrites this in place. |
| [`public/`](public/) | The neon mission-control dashboard (vanilla JS, SVG, WebAudio — no framework). |
| [`.claude/skills/phoenix-heal/`](.claude/skills/phoenix-heal/SKILL.md) | The **self-heal agent** — the Claude routine that diagnoses, fixes, and opens the PR. |

### Endpoints

| Route | Purpose |
|---|---|
| `POST /api/login` | Run the auth rule; on crash, drive crash → telemetry → issue. |
| `POST /api/agent-event` | The skill streams its real progress here → the dashboard. |
| `POST /api/heal` | Local *simulated* heal (the `SIMULATE` fallback). |
| `POST /api/reset` | Re-arm the fault for another run; closes open self-heal issues. |
| `GET /events` | Server-Sent Events the dashboard renders. |
| `GET /api/github` · `GET /api/state` | Repo/issue/PR status and health. |

---

*Built as a demo of building app ecosystems the agentic way. Inspired by a much larger
self-healing system (Glicko). The micro takes care of itself when the macro is an agent.*
