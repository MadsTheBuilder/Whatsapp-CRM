# DEPLOYMENT PLAN — server + local Ollama on an always-on mini-PC, with a dev→prod update flow

> **Type: Deployment plan.** Ops/infra, not an app-code change. Nothing in `src/` changes; this is install + env + hosting + a git push/pull update loop.

## Context

Today the whole system (Express server + brain + Ollama) runs on the dev laptop.
When the laptop is off, the brain sees nothing and the company number sends no
updates. The goal is to move the **exact same code, unchanged**, onto a spare
mini-PC at home that stays on 24/7, keep the LLM **local on that same box**
(free, no per-token cost), and keep developing on the laptop — pushing finished
features to the mini-PC over git.

Nothing in the app code needs to change. This is entirely: install runtime +
Ollama on the mini-PC, set env, expose the server publicly so 360dialog webhooks
reach it, and wire a `git pull && restart` update path. The LLM call is already a
URL swap ([src/claude.ts:10](../src/claude.ts#L10)) and the Ollama JSON path
already exists ([src/claude.ts:52](../src/claude.ts#L52)).

**Key facts that shape this plan:**
- Server is one process: `npm start` → `tsx src/server.ts`
  ([package.json:9](../package.json#L9)).
- Reminders run in-process via `setInterval`
  ([src/server.ts:63](../src/server.ts#L63)) — so "keep the one process alive" is
  the entire always-on requirement; no separate cron.
- No git remote exists yet (`git remote -v` empty) — must create one for the push/pull flow.
- Home internet has no fixed public URL, so 360dialog can't POST to the mini-PC
  directly → a **Cloudflare Tunnel** gives a stable HTTPS URL without port-forwarding.

---

## Part A — One-time setup on the mini-PC

### 1. Install the runtime
- Node.js LTS (v20+), git, and Ollama.
- `ollama pull <model>` for the model named in `MODEL` (the local test model, e.g.
  a gemma/llama tag). Also pull `REPLY_MODEL`'s model if you set one — the reply
  call can use a bigger model ([src/claude.ts:39](../src/claude.ts#L39)).
- Confirm Ollama serves on `http://localhost:11434` (its default).

### 2. Clone the repo and install deps
- `git clone <remote> fourthspace && cd fourthspace && npm install`.

### 3. Create the production `.env` on the mini-PC (never commit it)
Copy from [.env.example](../.env.example) and set:
- **LLM → local Ollama:** `LLM_BASE_URL=http://localhost:11434/v1`, `MODEL=<pulled tag>`,
  `OPENROUTER_API_KEY=` blank (unused on the Ollama path), `REPLY_MODEL=<optional bigger tag>`.
  This is the whole "LLM stays local" step — the server calls Ollama over localhost,
  same box, no tunnel, no API cost.
- **Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (same project as dev).
- **360dialog (company number):** `DIALOG360_API_KEY`, `DIALOG360_API_URL`, `DIALOG360_VERIFY_TOKEN`.
- **Agent pipe:** `AGENT_PIPE=dialog360` (the second 360dialog number decided earlier),
  `AGENT_DIALOG360_VERIFY_TOKEN` if using a per-number token.
- **`COMPANY_BOT_NUMBER`** = the bot's own E.164 (loop guard).
- **`PORT=3000`** (or any free port; the tunnel maps to it).

### 4. Keep the server process alive across crashes and reboots
- Run under **PM2** (`npm i -g pm2`, `pm2 start "npm start" --name fourthspace`,
  `pm2 save`, `pm2 startup`) so it restarts on crash and on machine reboot.
- Rationale: reminders + webhooks all live in this one process; if it dies the
  whole product goes dark until manual restart. PM2 removes that.

### 5. Expose the server publicly for 360dialog webhooks
- Install `cloudflared` and create a **named Cloudflare Tunnel** to `http://localhost:3000`.
  Gives a stable HTTPS URL, no port-forwarding, survives IP changes, auto-starts as a service.
- (A named tunnel — not the throwaway quick tunnel — so the URL is stable and you
  don't have to re-point 360dialog after every restart.)

### 6. Point 360dialog at the tunnel URL
- Company webhook → `https://<tunnel>/company-webhook` (confirm the exact path
  `companyRouter` serves in [src/company.ts](../src/company.ts)).
- Agent (second) number webhook → `https://<tunnel>/agent-webhook`
  ([src/pipe/dialog360.ts:155](../src/pipe/dialog360.ts#L155)).
- Both GET handshakes reuse `DIALOG360_VERIFY_TOKEN`.

### 7. Seed the agent's `agents` row
- The agent's read_number must exist in the `agents` table or every inbound message
  is dropped as "unregistered" ([src/pipe/dialog360.ts:119-123](../src/pipe/dialog360.ts#L119-L123)).
- Seed via `POST /api/agents { agent_id, read_number, send_number, name }` or a SQL insert.

---

## Part B — Dev→prod update flow (push a finished feature)

### One-time
1. Create a **private GitHub repo** and `git remote add origin <url>` on the dev laptop; push `master`.
2. On the mini-PC the clone already tracks `origin` (Part A step 2).
3. Add a tiny **deploy script** on the mini-PC — `deploy.sh`:
   ```
   git pull origin master && npm install && pm2 restart fourthspace
   ```
   (`npm install` is cheap when deps are unchanged; keep it so new dependencies land.)

### Every time you ship a feature
On the **dev laptop**:
1. Build + test the feature locally (Ollama local, `AGENT_PIPE=baileys` is fine for dev).
2. `npm run typecheck` and `npm run test:logic` must pass
   ([package.json:14-15](../package.json#L14-L15)).
3. Commit and `git push origin master`.

On the **mini-PC** (or triggered remotely — see below):
4. Run `./deploy.sh` → pulls, installs, restarts. `pm2 logs fourthspace` to watch it come up.

### Making the update painless (pick one, optional)
- **Manual (simplest):** SSH into the mini-PC and run `./deploy.sh`. Zero extra infra.
- **One-command from the laptop:** an SSH alias so `deploy-prod` on the laptop runs
  `ssh mini 'cd fourthspace && ./deploy.sh'`.
- **Auto (later):** a GitHub Actions self-hosted runner or webhook that runs `deploy.sh`
  on push. Skip until the manual flow feels slow — YAGNI.

### Guardrails
- **`.env` and `baileys_auth` are never in git** — they live only on each machine.
  Confirm `.gitignore` covers `.env` and `baileys_auth/` before the first push
  (else prod secrets leak / dev keys clobber prod).
- **Dev and prod share one Supabase project** → a schema migration pushed from dev
  takes effect for prod immediately. Apply migrations deliberately (e.g. migration 008),
  not as a side effect of a feature push.
- **Rollback:** `git checkout <last-good-sha> && pm2 restart fourthspace` on the mini-PC.
  Git history is the rollback — the reason to use push/pull over file copy.

---

## Why this shape (and what was rejected)

- **LLM stays local on the mini-PC**, not cloud API and not tunneled-to-laptop.
  Tunneling the LLM back to the laptop was rejected — it re-creates the laptop
  dependency. Cloud LLM API is the alternative if the mini-PC can't run the model
  fast enough; it's a pure env swap (`LLM_BASE_URL` + `OPENROUTER_API_KEY`) with no
  code change, so you can fall back to it anytime.
- **One process, kept alive by PM2** — matches the in-process reminder design; no
  extra scheduler to deploy.
- **Cloudflare Tunnel** over port-forwarding — stable HTTPS, no router config, no
  static-IP requirement.
- **git push/pull** over file copy — version history on prod = trivial rollback.

---

## Verification (end to end, on the mini-PC after Part A)

1. **Process up:** `pm2 status` shows `fourthspace` online; `pm2 logs` shows
   `[server] company-webhook listening` and `[server] agent pipe: dialog360`.
2. **LLM local reachable:** `curl http://localhost:11434/api/tags` lists the pulled
   model. One real card exercises the Ollama JSON path
   ([src/claude.ts:52](../src/claude.ts#L52)) — watch for a clean structured card, not prose.
3. **Tunnel + webhook handshake:** 360dialog webhook config verifies (GET returns the
   challenge). `curl "https://<tunnel>/agent-webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=42"`
   returns `42`.
4. **Live card:** send a lead message to the agent's second 360dialog number →
   `pm2 logs` shows `[agent] in <lead> → <agentId>` → a card DMs to the agent's
   send_number. Confirms read-lane + brain + local LLM + company-number send all work
   with the laptop off.
5. **Reboot test:** reboot the mini-PC; `pm2 status` shows the process back up
   automatically (proves the always-on requirement).
6. **Update flow:** push a trivial change from the laptop, run `./deploy.sh` on the
   mini-PC, confirm `pm2 logs` shows the restart and the change is live.
