---
name: phoenix-heal
description: Self-heal routine for the Phoenix demo. Picks up the open `self-heal`-labeled GitHub issue, diagnoses the bug from the stack trace, fixes the source, opens a real PR that closes the issue, and streams live progress to the running dashboard. Trigger when the user says "heal", "fix the issue", "run the self-heal agent", or "/phoenix-heal".
---

# Phoenix · self-heal agent

You are the self-healing agent for the **Phoenix** demo. A running app filed a real
GitHub issue when it crashed. Your job: read that issue, **actually diagnose** the bug,
fix it, open a real PR, and narrate your work to the live dashboard so the operator
watches the loop close on screen.

Work from the repo root (the folder containing `server.js` and `healer/login-rule.js`).
The dashboard listens on `http://localhost:4178` (override with `$PHOENIX_URL`).

## Telemetry helper

Stream each step to the dashboard so the board lights up from your *real* actions.
Every event is best-effort — never let a failed POST stop the heal.

```bash
PHX="${PHOENIX_URL:-http://localhost:4178}"
phx() { curl -s "$PHX/api/agent-event" -H 'content-type: application/json' -d "$1" >/dev/null 2>&1 || true; }
```

## Steps

1. **Find the issue.** Confirm you're in the Phoenix repo, then:
   ```bash
   gh issue list --label self-heal --state open --json number,title,url --limit 1
   ```
   Capture `NUM` and `ISSUE_URL`. If there are none, tell the operator there's nothing to
   heal and stop. Announce yourself:
   ```bash
   phx "{\"type\":\"agent_boot\",\"issue\":$NUM,\"log\":\"Phoenix Agent dispatched → issue #$NUM\"}"
   ```

2. **Read the issue and the code — diagnose for real.** Run `gh issue view $NUM` to get the
   stack trace. Open the file it points at (`healer/login-rule.js`). Genuinely reason about
   the failure: the operator object has no `account` field, so `user.account.role` throws
   `TypeError: Cannot read properties of undefined (reading 'role')`; the field was flattened
   to `user.role` in a refactor. Stream your real findings as you go (one line per `phx` call,
   with a short `sleep 0.4` between them so it's watchable):
   ```bash
   phx "{\"type\":\"agent_log\",\"line\":\"reading issue #$NUM …\",\"log\":\"reading issue #$NUM\"}"
   phx "{\"type\":\"agent_log\",\"line\":\"stack → healer/login-rule.js — undefined read of 'role'\",\"log\":\"tracing stack\"}"
   phx "{\"type\":\"agent_log\",\"line\":\"user.account is undefined; field is now flat user.role\",\"log\":\"root cause found\"}"
   ```
   Adapt these lines to what you actually find — don't fabricate. If the bug differs from the
   expectation, fix what's really there.

3. **Apply the fix to the working tree** (this is what heals the live app — the server
   re-reads the file on the next login). Change the buggy line to the correct one and flip
   the marker comment, e.g. `const role = user.account.role;        // PHOENIX-BUG` →
   `const role = user.role;                // PHOENIX-FIXED`. Then announce the patch:
   ```bash
   phx "{\"type\":\"patch\",\"file\":\"healer/login-rule.js\",\"line\":17,\"before\":\"const role = user.account.role;\",\"after\":\"const role = user.role;\",\"log\":\"patch applied → healer/login-rule.js\"}"
   ```

4. **Verify the fix really works** before claiming victory:
   ```bash
   node -e "import('./healer/login-rule.js?'+Date.now()).then(m=>{const r=m.authenticate({id:7,name:'ada.lovelace',role:'operator'},'hunter2');console.log('VERIFIED',r.token)})"
   ```
   Then stream the verify event with the real token:
   ```bash
   phx "{\"type\":\"verify\",\"ok\":true,\"token\":\"$TOKEN\",\"log\":\"re-ran auth — login verified, token $TOKEN\"}"
   ```

5. **Open a real PR — without disturbing the live app's working tree.** Build the PR branch
   in an isolated git worktree off `origin/main` so the running demo keeps its healed state:
   ```bash
   git fetch origin main
   BR="self-heal/issue-$NUM"
   WT="$(mktemp -d)/phx-$NUM"
   git worktree add -B "$BR" "$WT" origin/main
   # apply the same one-line fix inside the worktree:
   #   user.account.role  → user.role     (and PHOENIX-BUG → PHOENIX-FIXED)
   (cd "$WT" && \
     perl -0pi -e 's/const role = user\.account\.role;\s*\/\/ PHOENIX-BUG/const role = user.role;                \/\/ PHOENIX-FIXED/' healer/login-rule.js && \
     git add healer/login-rule.js && \
     git commit -m "fix(auth): use flat user.role to resolve login crash (closes #$NUM)" && \
     git push -u origin "$BR")
   PR_URL="$(cd "$WT" && gh pr create \
     --title "fix(auth): resolve TypeError reading 'role' (#$NUM)" \
     --body "Closes #$NUM

   ## Root cause
   \`user.account\` was removed when the user object was flattened; \`user.account.role\`
   throws \`TypeError: Cannot read properties of undefined (reading 'role')\`.

   ## Fix
   Read the role from the flat field: \`const role = user.role;\`

   — Opened automatically by the \`/phoenix-heal\` agent. 🔥" \
     --head "$BR" | tail -1)"
   git worktree remove "$WT" --force
   ```

6. **Close the loop.** Comment on the issue with the PR link and close it, then tell the
   dashboard the system is restored (include the real PR url so it renders the link):
   ```bash
   gh issue comment $NUM --body "🔧 Self-healed by the Phoenix agent. Fix raised in $PR_URL and verified locally."
   gh issue close $NUM
   phx "{\"type\":\"healed\",\"issue\":$NUM,\"url\":\"$ISSUE_URL\",\"prUrl\":\"$PR_URL\",\"token\":\"$TOKEN\",\"log\":\"issue #$NUM resolved — PR raised, system restored ✓\"}"
   ```

7. **Report back** to the operator in chat: the issue number, the PR url, the one-line diff,
   and confirm the dashboard shows **SYSTEM ONLINE**. Keep it tight.

## Notes
- Leave `origin/main` on the buggy baseline (don't merge the PR) so the demo stays repeatable
  — each run branches from the same baseline and produces a clean PR. Merge manually only when
  you want to show the full close.
- Everything here is real: a real issue, a real diagnosis, a real file edit, a real PR. The
  dashboard is just a live window onto your work.
