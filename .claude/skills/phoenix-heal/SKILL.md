---
name: phoenix-heal
description: Self-heal routine for the Phoenix demo. Picks up the open `self-heal`-labeled GitHub issue, diagnoses the bug, fixes the running app, and comments the proposed patch on the issue — streaming live progress to the dashboard. It does NOT commit; the human hits "Commit fix" on the dashboard to open the PR. Trigger on "heal", "fix the issue", "run the self-heal agent", or "/phoenix-heal".
---

# Phoenix · self-heal agent (propose, don't commit)

A running app filed a real GitHub issue when it crashed. Your job: read it, **actually
diagnose** the bug, fix the running app, and **comment the proposed fix on the issue** —
narrating to the live dashboard. Stop there. Committing is the human's call (the **Commit
fix** button on the dashboard opens the PR). This is semi-automatic by design.

Work from the repo root (folder with `server.js` and `healer/login-rule.js`). The dashboard
listens on `http://localhost:4178` (override with `$PHOENIX_URL`).

## Telemetry helper

```bash
PHX="${PHOENIX_URL:-http://localhost:4178}"
phx() { curl -s "$PHX/api/agent-event" -H 'content-type: application/json' -d "$1" >/dev/null 2>&1 || true; }
```

## Steps

1. **Find the issue.**
   ```bash
   gh issue list --label self-heal --state open --json number,title,url --limit 1
   ```
   Capture `NUM` and `ISSUE_URL`. If none, say so and stop. Then:
   ```bash
   phx "{\"type\":\"agent_boot\",\"issue\":$NUM,\"log\":\"Phoenix Agent dispatched → issue #$NUM\"}"
   ```

2. **Diagnose for real.** `gh issue view $NUM` for the trace, open `healer/login-rule.js`,
   and reason it out: the operator object has no `account` field, so `user.account.role`
   throws; the field was flattened to `user.role`. Stream your real findings (one `phx`
   per line, `sleep 0.4` between):
   ```bash
   phx "{\"type\":\"agent_log\",\"line\":\"reading issue #$NUM …\",\"log\":\"reading issue #$NUM\"}"
   phx "{\"type\":\"agent_log\",\"line\":\"user.account is undefined; field is now flat user.role\",\"log\":\"root cause found\"}"
   ```

3. **Fix the running app** (edit the working tree — the server re-reads the file on the next
   login): `const role = user.account.role;  // PHOENIX-BUG` → `const role = user.role;  // PHOENIX-FIXED`.
   ```bash
   phx "{\"type\":\"patch\",\"file\":\"healer/login-rule.js\",\"line\":17,\"before\":\"const role = user.account.role;\",\"after\":\"const role = user.role;\",\"log\":\"patch applied to working tree\"}"
   ```

4. **Verify it really works:**
   ```bash
   node -e "import('./healer/login-rule.js?'+Date.now()).then(m=>{const r=m.authenticate({id:7,name:'ada.lovelace',role:'operator'},'hunter2');console.log('VERIFIED',r.token)})"
   ```
   ```bash
   phx "{\"type\":\"verify\",\"ok\":true,\"token\":\"$TOKEN\",\"log\":\"re-ran auth — verified $TOKEN\"}"
   ```

5. **Comment the proposed fix on the issue — do NOT commit.**
   ```bash
   gh issue comment $NUM --body "🔧 **Phoenix agent — proposed fix**

   \`\`\`diff
   - const role = user.account.role;
   + const role = user.role;
   \`\`\`

   Root cause: \`user.account\` was removed in a refactor. Applied to the running app and
   verified locally. Hit **Commit fix** on the dashboard to raise the PR."
   ```

6. **Tell the dashboard the fix is proposed** (awaiting commit — `committed:false`):
   ```bash
   phx "{\"type\":\"healed\",\"issue\":$NUM,\"url\":\"$ISSUE_URL\",\"committed\":false,\"token\":\"$TOKEN\",\"log\":\"fix applied & commented on issue #$NUM — awaiting commit\"}"
   ```

7. **Report back** in chat: issue number, the one-line diff, and a reminder that the app is
   healed locally and the issue now has the proposed fix — the operator can hit **Commit fix**
   on the dashboard (or run `gh`/the PR step manually) to open the PR. Keep it tight.

## Notes
- You **propose**; the human **commits**. Don't open the PR here unless explicitly asked.
- Everything is real: a real issue, a real diagnosis, a real file edit, a real comment.
- `RE-ARM` on the dashboard reverts the bug for another run; `CLEAN UP` wipes the GitHub
  artifacts. Leave `main` on the buggy baseline so runs stay repeatable.
